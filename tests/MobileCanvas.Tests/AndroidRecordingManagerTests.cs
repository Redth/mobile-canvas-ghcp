using MobileCanvas.Android;
using MobileCanvas.Contracts;
using MobileCanvas.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace MobileCanvas.Tests;

public sealed class AndroidRecordingManagerTests
{
	private const string DeviceId = "android:test";

	[Fact]
	public async Task ConcurrentStopsShareOneFinalization()
	{
		using var fixture = new AndroidRecordingFixture();
		fixture.Platform.BlockPull();
		await fixture.StartAsync();

		var first = fixture.Manager.StopAsync(DeviceId, CancellationToken.None);
		await fixture.Platform.PullStarted.Task;
		var second = fixture.Manager.StopAsync(DeviceId, CancellationToken.None);
		fixture.Platform.ReleasePull();

		var results = await Task.WhenAll(first, second);

		Assert.Same(results[0], results[1]);
		Assert.Equal(1, fixture.Platform.InterruptCalls);
		Assert.Equal(1, fixture.Platform.PullCalls);
	}

	[Fact]
	public async Task FailedPullRetainsOwnershipForRetry()
	{
		using var fixture = new AndroidRecordingFixture();
		fixture.Platform.FailPullAttempts = 1;
		await fixture.StartAsync();

		await Assert.ThrowsAsync<IOException>(
			() => fixture.Manager.StopAsync(DeviceId, CancellationToken.None));

		Assert.True(fixture.Manager.GetStatus(DeviceId).IsRecording);
		Assert.Equal(0, fixture.Platform.RemoveCalls);
		Assert.Equal(0, fixture.Platform.Process.DisposeCalls);

		var completed = await fixture.Manager.StopAsync(DeviceId, CancellationToken.None);

		Assert.False(completed.IsRecording);
		Assert.Equal(1, fixture.Platform.InterruptCalls);
		Assert.Equal(2, fixture.Platform.PullCalls);
		Assert.Equal(1, fixture.Platform.RemoveCalls);
		Assert.Equal(1, fixture.Platform.Process.DisposeCalls);
	}

	[Fact]
	public async Task FailedInterruptIsRetried()
	{
		using var fixture = new AndroidRecordingFixture();
		fixture.Platform.FailInterruptAttempts = 1;
		await fixture.StartAsync();

		await Assert.ThrowsAsync<InvalidOperationException>(
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
		using var fixture = new AndroidRecordingFixture();
		fixture.Platform.Process.AutoExitOnInterrupt = false;
		await fixture.StartAsync();

		fixture.TimeoutDelay.Fire();
		await fixture.Platform.Process.InterruptObserved.Task;
		var manualStop = fixture.Manager.StopAsync(DeviceId, CancellationToken.None);
		fixture.Platform.Process.Exit();

		var completed = await manualStop;
		await fixture.Platform.PullStarted.Task;

		Assert.False(completed.IsRecording);
		Assert.Equal(1, fixture.Platform.InterruptCalls);
		Assert.Equal(1, fixture.Platform.PullCalls);
	}

	[Fact]
	public async Task RepeatStopReturnsCachedCompletedStatus()
	{
		using var fixture = new AndroidRecordingFixture();
		await fixture.StartAsync();

		var first = await fixture.Manager.StopAsync(DeviceId, CancellationToken.None);
		var second = await fixture.Manager.StopAsync(DeviceId, CancellationToken.None);

		Assert.Same(first, second);
		Assert.Same(first, fixture.Manager.GetStatus(DeviceId));
		Assert.Equal(1, fixture.Platform.InterruptCalls);
		Assert.Equal(1, fixture.Platform.PullCalls);
	}

	[Fact]
	public async Task CallerCancellationDoesNotCancelSharedFinalization()
	{
		using var fixture = new AndroidRecordingFixture();
		fixture.Platform.Process.AutoExitOnInterrupt = false;
		await fixture.StartAsync();
		using var cancellation = new CancellationTokenSource();

		var canceledWaiter = fixture.Manager.StopAsync(DeviceId, cancellation.Token);
		await fixture.Platform.Process.InterruptObserved.Task;
		cancellation.Cancel();
		await Assert.ThrowsAnyAsync<OperationCanceledException>(() => canceledWaiter);

		fixture.Platform.Process.Exit();
		var completed = await fixture.Manager.StopAsync(DeviceId, CancellationToken.None);

		Assert.False(completed.IsRecording);
		Assert.Equal(1, fixture.Platform.InterruptCalls);
		Assert.Equal(1, fixture.Platform.PullCalls);
	}

	[Fact]
	public async Task ExplicitAbandonCleansFailedFinalization()
	{
		using var fixture = new AndroidRecordingFixture();
		fixture.Platform.BlockPull();
		fixture.Platform.WriteBeforePullGate = true;
		fixture.Platform.WriteEmptyPull = true;
		await fixture.StartAsync();

		var finalization = fixture.Manager.StopAsync(DeviceId, CancellationToken.None);
		await fixture.Platform.PullStarted.Task;
		Assert.Single(Directory.GetFiles(fixture.Directory.FullName, "*.partial"));

		await fixture.Manager.AbandonAsync(DeviceId);
		await Assert.ThrowsAnyAsync<OperationCanceledException>(() => finalization);

		Assert.Empty(Directory.GetFiles(fixture.Directory.FullName, "*.partial"));
		Assert.Equal(1, fixture.Platform.RemoveCalls);
		Assert.Equal(1, fixture.Platform.Process.DisposeCalls);
		await Assert.ThrowsAsync<InvalidOperationException>(
			() => fixture.Manager.StopAsync(DeviceId, CancellationToken.None));
	}

	private sealed class AndroidRecordingFixture : IDisposable
	{
		public AndroidRecordingFixture()
		{
			Directory = System.IO.Directory.CreateTempSubdirectory("mobile-canvas-android-recording-tests-");
			TimeoutDelay = new ControlledTimeoutDelay();
			Platform = new FakeAndroidRecordingPlatform();
			Manager = new AndroidRecordingManager(
				Platform,
				NullLogger.Instance,
				TimeoutDelay.DelayAsync,
				TimeSpan.FromSeconds(1));
		}

		public DirectoryInfo Directory { get; }
		public ControlledTimeoutDelay TimeoutDelay { get; }
		public FakeAndroidRecordingPlatform Platform { get; }
		public AndroidRecordingManager Manager { get; }

		public Task<RecordingStatus> StartAsync() =>
			Manager.StartAsync(
				DeviceId,
				new RecordingStartRequest
				{
					OutputPath = Path.Combine(Directory.FullName, "recording.mp4"),
					TimeoutSeconds = 10,
				},
				CancellationToken.None);

		public void Dispose()
		{
			Platform.ReleasePull();
			Manager.DisposeAsync().AsTask().GetAwaiter().GetResult();
			Directory.Delete(recursive: true);
		}
	}

	private sealed class FakeAndroidRecordingPlatform : IAndroidRecordingPlatform
	{
		private TaskCompletionSource _pullGate = CompletedGate();

		public FakeRecordingProcess Process { get; } = new();
		public TaskCompletionSource PullStarted { get; } =
			new(TaskCreationOptions.RunContinuationsAsynchronously);
		public int FailPullAttempts;
		public int FailInterruptAttempts;
		public bool WriteBeforePullGate { get; set; }
		public bool WriteEmptyPull { get; set; }
		public int InterruptCalls { get; private set; }
		public int PullCalls { get; private set; }
		public int RemoveCalls { get; private set; }

		public void BlockPull() =>
			_pullGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

		public void ReleasePull() => _pullGate.TrySetResult();

		public Task<string> RequireSerialAsync(string deviceId, CancellationToken cancellationToken) =>
			Task.FromResult("emulator-5554");

		public Task<(int Width, int Height)> GetDisplaySizeAsync(
			string deviceId,
			CancellationToken cancellationToken) =>
			Task.FromResult((1080, 1920));

		public IRecordingProcess StartScreenRecord(
			string serial,
			string devicePath,
			int timeoutSeconds,
			(int Width, int Height)? size) =>
			Process;

		public async Task<string?> RunAdbAsync(
			string serial,
			IReadOnlyList<string> arguments,
			CancellationToken cancellationToken)
		{
			if (arguments.Count >= 2 && arguments[0] == "shell" && arguments[1] == "pkill")
			{
				InterruptCalls++;
				if (Interlocked.Decrement(ref FailInterruptAttempts) >= 0)
					return null;
				Process.ObserveInterrupt();
				return "";
			}

			if (arguments.Count >= 2 && arguments[0] == "shell" && arguments[1] == "stat")
				return "128";

			if (arguments.Count >= 1 && arguments[0] == "pull")
			{
				PullCalls++;
				if (WriteBeforePullGate)
				await WritePullFileAsync(arguments[2], cancellationToken);
				PullStarted.TrySetResult();
				await _pullGate.Task.WaitAsync(cancellationToken);
				if (Interlocked.Decrement(ref FailPullAttempts) >= 0)
					throw new IOException("adb pull failed");

				if (!WriteBeforePullGate)
					await WritePullFileAsync(arguments[2], cancellationToken);
				return "1 file pulled";
			}

			if (arguments.Count >= 2 && arguments[0] == "shell" && arguments[1] == "rm")
			{
				RemoveCalls++;
				return "";
			}

			throw new InvalidOperationException($"Unexpected adb arguments: {string.Join(' ', arguments)}");
		}

		private Task WritePullFileAsync(string path, CancellationToken cancellationToken) =>
			File.WriteAllBytesAsync(path, WriteEmptyPull ? [] : [1, 2, 3], cancellationToken);

		private static TaskCompletionSource CompletedGate()
		{
			var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
			gate.SetResult();
			return gate;
		}
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
		public int Id => 42;
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
