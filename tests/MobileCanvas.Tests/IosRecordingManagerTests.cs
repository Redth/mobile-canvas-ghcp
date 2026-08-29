using MobileCanvas.Contracts;
using MobileCanvas.Core;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

public sealed class IosRecordingManagerTests
{
	private const string DeviceId = "ios:test";

	[Fact]
	public async Task ConcurrentStopsShareOneFinalization()
	{
		using var fixture = new IosRecordingFixture();
		fixture.Platform.Process.AutoExitOnInterrupt = false;
		await fixture.StartAsync();

		var first = fixture.Manager.StopAsync(DeviceId, CancellationToken.None);
		await fixture.Platform.Process.InterruptObserved.Task;
		var second = fixture.Manager.StopAsync(DeviceId, CancellationToken.None);
		fixture.Platform.CompleteRecording();

		var results = await Task.WhenAll(first, second);

		Assert.Same(results[0], results[1]);
		Assert.Equal(1, fixture.Platform.InterruptCalls);
	}

	[Fact]
	public async Task FailedValidationRetainsOwnershipForRetry()
	{
		using var fixture = new IosRecordingFixture();
		fixture.Platform.WriteFileOnInterrupt = false;
		await fixture.StartAsync();

		await Assert.ThrowsAsync<InvalidOperationException>(
			() => fixture.Manager.StopAsync(DeviceId, CancellationToken.None));

		Assert.True(fixture.Manager.GetStatus(DeviceId).IsRecording);
		Assert.Equal(0, fixture.Platform.Process.DisposeCalls);
		fixture.Platform.WriteRecordingFile();

		var completed = await fixture.Manager.StopAsync(DeviceId, CancellationToken.None);

		Assert.False(completed.IsRecording);
		Assert.Equal(1, fixture.Platform.InterruptCalls);
		Assert.Equal(1, fixture.Platform.Process.DisposeCalls);
	}

	[Fact]
	public async Task FailedInterruptIsRetried()
	{
		using var fixture = new IosRecordingFixture();
		fixture.Platform.FailInterruptAttempts = 1;
		await fixture.StartAsync();

		await Assert.ThrowsAsync<IOException>(
			() => fixture.Manager.StopAsync(DeviceId, CancellationToken.None));

		Assert.True(fixture.Manager.GetStatus(DeviceId).IsRecording);
		Assert.Equal(0, fixture.Platform.Process.DisposeCalls);

		var completed = await fixture.Manager.StopAsync(DeviceId, CancellationToken.None);

		Assert.False(completed.IsRecording);
		Assert.Equal(2, fixture.Platform.InterruptCalls);
	}

	[Fact]
	public async Task TimeoutJoinsManualStop()
	{
		using var fixture = new IosRecordingFixture();
		fixture.Platform.Process.AutoExitOnInterrupt = false;
		await fixture.StartAsync();

		fixture.TimeoutDelay.Fire();
		await fixture.Platform.Process.InterruptObserved.Task;
		var manualStop = fixture.Manager.StopAsync(DeviceId, CancellationToken.None);
		fixture.Platform.CompleteRecording();

		var completed = await manualStop;

		Assert.False(completed.IsRecording);
		Assert.Equal(1, fixture.Platform.InterruptCalls);
	}

	[Fact]
	public async Task RepeatStopReturnsCachedCompletedStatus()
	{
		using var fixture = new IosRecordingFixture();
		await fixture.StartAsync();

		var first = await fixture.Manager.StopAsync(DeviceId, CancellationToken.None);
		var second = await fixture.Manager.StopAsync(DeviceId, CancellationToken.None);

		Assert.Same(first, second);
		Assert.Same(first, fixture.Manager.GetStatus(DeviceId));
		Assert.Equal(1, fixture.Platform.InterruptCalls);
	}

	[Fact]
	public async Task CallerCancellationDoesNotCancelSharedFinalization()
	{
		using var fixture = new IosRecordingFixture();
		fixture.Platform.Process.AutoExitOnInterrupt = false;
		await fixture.StartAsync();
		using var cancellation = new CancellationTokenSource();

		var canceledWaiter = fixture.Manager.StopAsync(DeviceId, cancellation.Token);
		await fixture.Platform.Process.InterruptObserved.Task;
		cancellation.Cancel();
		await Assert.ThrowsAnyAsync<OperationCanceledException>(() => canceledWaiter);

		fixture.Platform.CompleteRecording();
		var completed = await fixture.Manager.StopAsync(DeviceId, CancellationToken.None);

		Assert.False(completed.IsRecording);
		Assert.Equal(1, fixture.Platform.InterruptCalls);
	}

	[Fact]
	public async Task ExplicitAbandonCleansFailedFinalization()
	{
		using var fixture = new IosRecordingFixture();
		fixture.Platform.Process.AutoExitOnInterrupt = false;
		fixture.Platform.WriteEmptyFileOnInterrupt = true;
		await fixture.StartAsync();

		var finalization = fixture.Manager.StopAsync(DeviceId, CancellationToken.None);
		await fixture.Platform.Process.InterruptObserved.Task;
		Assert.True(File.Exists(fixture.Platform.OutputPath));

		await fixture.Manager.AbandonAsync(DeviceId);
		await Assert.ThrowsAnyAsync<OperationCanceledException>(() => finalization);

		Assert.False(File.Exists(fixture.Platform.OutputPath));
		Assert.Equal(1, fixture.Platform.Process.DisposeCalls);
		await Assert.ThrowsAsync<InvalidOperationException>(
			() => fixture.Manager.StopAsync(DeviceId, CancellationToken.None));
	}

	private sealed class IosRecordingFixture : IDisposable
	{
		public IosRecordingFixture()
		{
			Directory = System.IO.Directory.CreateTempSubdirectory("mobile-canvas-ios-recording-tests-");
			TimeoutDelay = new ControlledTimeoutDelay();
			Platform = new FakeIosRecordingPlatform();
			Manager = new IosRecordingManager(
				Platform,
				TimeoutDelay.DelayAsync,
				TimeSpan.FromSeconds(1));
		}

		public DirectoryInfo Directory { get; }
		public ControlledTimeoutDelay TimeoutDelay { get; }
		public FakeIosRecordingPlatform Platform { get; }
		public IosRecordingManager Manager { get; }

		public Task<RecordingStatus> StartAsync() =>
			Manager.StartAsync(
				DeviceId,
				"test-udid",
				new RecordingStartRequest
				{
					OutputPath = Path.Combine(Directory.FullName, "recording.mp4"),
					TimeoutSeconds = 10,
				},
				CancellationToken.None);

		public void Dispose()
		{
			Manager.DisposeAsync().AsTask().GetAwaiter().GetResult();
			Directory.Delete(recursive: true);
		}
	}

	private sealed class FakeIosRecordingPlatform : IIosRecordingPlatform
	{
		public FakeRecordingProcess Process { get; } = new();
		public string OutputPath { get; private set; } = "";
		public bool WriteFileOnInterrupt { get; set; } = true;
		public bool WriteEmptyFileOnInterrupt { get; set; }
		public int FailInterruptAttempts;
		public int InterruptCalls { get; private set; }

		public IRecordingProcess StartRecording(string udid, string outputPath)
		{
			OutputPath = outputPath;
			return Process;
		}

		public Task SendInterruptAsync(int processId, CancellationToken cancellationToken)
		{
			InterruptCalls++;
			if (Interlocked.Decrement(ref FailInterruptAttempts) >= 0)
				throw new IOException("kill failed");
			if (WriteFileOnInterrupt)
				WriteRecordingFile();
			Process.ObserveInterrupt();
			return Task.CompletedTask;
		}

		public void CompleteRecording()
		{
			WriteRecordingFile();
			Process.Exit();
		}

		public void WriteRecordingFile() =>
			File.WriteAllBytes(OutputPath, WriteEmptyFileOnInterrupt ? [] : [1, 2, 3]);
	}

	private sealed class ControlledTimeoutDelay
	{
		private readonly TaskCompletionSource _timeout =
			new(TaskCreationOptions.RunContinuationsAsynchronously);

		public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
		{
			if (delay == TimeSpan.FromSeconds(10))
				return _timeout.Task.WaitAsync(cancellationToken);
			return Task.CompletedTask;
		}

		public void Fire() => _timeout.TrySetResult();
	}

	private sealed class FakeRecordingProcess : IRecordingProcess
	{
		private readonly TaskCompletionSource _exit =
			new(TaskCreationOptions.RunContinuationsAsynchronously);
		private volatile bool _hasExited;

		public bool AutoExitOnInterrupt { get; set; } = true;
		public TaskCompletionSource InterruptObserved { get; } =
			new(TaskCreationOptions.RunContinuationsAsynchronously);
		public bool HasExited => _hasExited;
		public int ExitCode => 0;
		public int Id => 43;
		public int DisposeCalls { get; private set; }
		public int KillCalls { get; private set; }

		public void ObserveInterrupt()
		{
			InterruptObserved.TrySetResult();
			if (AutoExitOnInterrupt)
				Exit();
		}

		public void Exit()
		{
			_hasExited = true;
			_exit.TrySetResult();
		}

		public void Dispose() => DisposeCalls++;

		public void Kill()
		{
			KillCalls++;
			Exit();
		}

		public Task<string> ReadStandardErrorAsync() => Task.FromResult("");

		public Task WaitForExitAsync(CancellationToken cancellationToken) =>
			_exit.Task.WaitAsync(cancellationToken);
	}
}
