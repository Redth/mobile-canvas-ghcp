using System.Collections.Concurrent;
using System.Diagnostics;
using MobileCanvas.Contracts;
using MobileCanvas.Core;

namespace MobileCanvas.iOS;

internal sealed class IosRecordingManager : IAsyncDisposable
{
	private static readonly TimeSpan StartSettleDelay = TimeSpan.FromMilliseconds(500);
	private static readonly TimeSpan ProcessExitTimeout = TimeSpan.FromSeconds(15);

	private readonly IIosRecordingPlatform _platform;
	private readonly Func<TimeSpan, CancellationToken, Task> _delayAsync;
	private readonly TimeSpan _processExitTimeout;
	private readonly ConcurrentDictionary<string, ActiveRecording> _recordings =
		new(StringComparer.OrdinalIgnoreCase);
	private readonly ConcurrentDictionary<string, SemaphoreSlim> _startGates =
		new(StringComparer.OrdinalIgnoreCase);

	public IosRecordingManager(IProcessRunner processRunner)
		: this(new IosRecordingPlatform(processRunner))
	{
	}

	internal IosRecordingManager(
		IIosRecordingPlatform platform,
		Func<TimeSpan, CancellationToken, Task>? delayAsync = null,
		TimeSpan? processExitTimeout = null)
	{
		_platform = platform;
		_delayAsync = delayAsync ?? Task.Delay;
		_processExitTimeout = processExitTimeout ?? ProcessExitTimeout;
	}

	public async Task<RecordingStatus> StartAsync(
		string deviceId,
		string udid,
		RecordingStartRequest request,
		CancellationToken cancellationToken)
	{
		if (request.TimeoutSeconds is < 1 or > 3600)
		{
			throw new ArgumentOutOfRangeException(
				nameof(request),
				"Recording timeout must be between 1 and 3600 seconds.");
		}

		var startGate = _startGates.GetOrAdd(deviceId, static _ => new SemaphoreSlim(1, 1));
		await startGate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			if (_recordings.TryGetValue(deviceId, out var existing) && !existing.Finalizer.IsCompleted)
				throw new InvalidOperationException($"A recording is already active for '{deviceId}'.");

			var outputPath = string.IsNullOrWhiteSpace(request.OutputPath)
				? CreateDefaultPath()
				: Path.GetFullPath(request.OutputPath);
			Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
			var temporaryPath = CreateTemporaryPath(outputPath);
			var process = _platform.StartRecording(udid, temporaryPath);
			var recording = new ActiveRecording(
				process,
				temporaryPath,
				outputPath,
				DateTimeOffset.UtcNow,
				request.TimeoutSeconds);
			_recordings[deviceId] = recording;

			await _delayAsync(StartSettleDelay, cancellationToken).ConfigureAwait(false);
			if (process.HasExited)
			{
				_recordings.TryRemove(new KeyValuePair<string, ActiveRecording>(deviceId, recording));
				var exitCode = process.ExitCode;
				process.Dispose();
				File.Delete(temporaryPath);
				throw new InvalidOperationException(
					$"simctl screen recording exited before it started (code {exitCode}).");
			}

			recording.TimeoutTask = StopAfterTimeoutAsync(deviceId, recording);
			return ToStatus(deviceId, recording, isRecording: true);
		}
		finally
		{
			startGate.Release();
		}
	}

	public Task<RecordingStatus> StopAsync(string deviceId, CancellationToken cancellationToken)
	{
		if (!_recordings.TryGetValue(deviceId, out var recording))
			throw new InvalidOperationException($"No recording is active for '{deviceId}'.");

		return recording.Finalizer.FinalizeAsync(
			token => FinalizeAsync(deviceId, recording, token),
			cancellationToken);
	}

	public async Task FinalizeOrAbandonAsync(string deviceId)
	{
		if (!_recordings.TryGetValue(deviceId, out var recording) || recording.Finalizer.IsCompleted)
			return;

		try
		{
			await StopAsync(deviceId, CancellationToken.None).ConfigureAwait(false);
			return;
		}
		catch (Exception exception)
		{
			Trace.TraceError(
				"Failed to finalize recording for {0}; abandoning it: {1}",
				deviceId,
				exception);
		}

		await AbandonAsync(deviceId, recording).ConfigureAwait(false);
	}

	internal async Task AbandonAsync(string deviceId)
	{
		if (_recordings.TryGetValue(deviceId, out var recording))
			await AbandonAsync(deviceId, recording).ConfigureAwait(false);
	}

	public RecordingStatus GetStatus(string deviceId)
	{
		if (!_recordings.TryGetValue(deviceId, out var recording))
			return new RecordingStatus { DeviceId = deviceId };
		return recording.Finalizer.CompletedStatus ?? ToStatus(deviceId, recording, isRecording: true);
	}

	public async ValueTask DisposeAsync()
	{
		foreach (var deviceId in _recordings.Keys.ToArray())
			await FinalizeOrAbandonAsync(deviceId).ConfigureAwait(false);

		foreach (var gate in _startGates.Values)
			gate.Dispose();
		_startGates.Clear();
	}

	private async Task<RecordingStatus> FinalizeAsync(
		string deviceId,
		ActiveRecording recording,
		CancellationToken cancellationToken)
	{
		await recording.TimeoutCancellation.CancelAsync().ConfigureAwait(false);

		if (!recording.Process.HasExited)
		{
			if (!recording.StopSignalSent)
			{
				await _platform.SendInterruptAsync(recording.Process.Id, cancellationToken)
					.ConfigureAwait(false);
				recording.StopSignalSent = true;
			}

			await recording.Process.WaitForExitAsync(cancellationToken)
				.WaitAsync(_processExitTimeout, cancellationToken)
				.ConfigureAwait(false);
		}

		ValidateRecording(recording.TemporaryPath);
		File.Move(recording.TemporaryPath, recording.OutputPath, overwrite: true);
		var completed = ToStatus(deviceId, recording, isRecording: false);
		recording.Process.Dispose();
		recording.TimeoutCancellation.Dispose();
		return completed;
	}

	private async Task AbandonAsync(string deviceId, ActiveRecording recording)
	{
		await recording.Finalizer.AbandonAsync(async () =>
		{
			await recording.TimeoutCancellation.CancelAsync().ConfigureAwait(false);
			recording.Process.Kill();
			recording.Process.Dispose();
			recording.TimeoutCancellation.Dispose();
			try
			{
				File.Delete(recording.TemporaryPath);
			}
			catch (Exception exception)
			{
				Trace.TraceError(
					"Could not remove temporary recording {0}: {1}",
					recording.TemporaryPath,
					exception);
			}
			_recordings.TryRemove(new KeyValuePair<string, ActiveRecording>(deviceId, recording));
		}).ConfigureAwait(false);
	}

	private async Task StopAfterTimeoutAsync(string deviceId, ActiveRecording recording)
	{
		try
		{
			await _delayAsync(
				TimeSpan.FromSeconds(recording.TimeoutSeconds),
				recording.TimeoutCancellation.Token).ConfigureAwait(false);
			if (_recordings.TryGetValue(deviceId, out var current) && ReferenceEquals(current, recording))
			{
				await recording.Finalizer.FinalizeAsync(
					token => FinalizeAsync(deviceId, recording, token),
					CancellationToken.None).ConfigureAwait(false);
			}
		}
		catch (OperationCanceledException) when (recording.TimeoutCancellation.IsCancellationRequested)
		{
		}
		catch (Exception exception)
		{
			Trace.TraceError("Timed recording finalization failed for {0}: {1}", deviceId, exception);
		}
	}

	private static void ValidateRecording(string path)
	{
		if (!File.Exists(path) || new FileInfo(path).Length == 0)
			throw new InvalidOperationException($"The finalized recording '{path}' is empty or missing.");
	}

	private static string CreateTemporaryPath(string outputPath) =>
		Path.Combine(
			Path.GetDirectoryName(outputPath)!,
			$".{Path.GetFileName(outputPath)}.{Guid.NewGuid():N}.partial");

	private static string CreateDefaultPath()
	{
		var directory = Path.Combine(
			Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
			".mobile-canvas",
			"artifacts",
			"recordings");
		Directory.CreateDirectory(directory);
		return Path.Combine(directory, $"ios-{DateTimeOffset.Now:yyyyMMdd-HHmmss}.mp4");
	}

	private static RecordingStatus ToStatus(
		string deviceId,
		ActiveRecording recording,
		bool isRecording) => new()
	{
		DeviceId = deviceId,
		IsRecording = isRecording,
		OutputPath = recording.OutputPath,
		StartedAt = recording.StartedAt,
		TimeoutSeconds = recording.TimeoutSeconds,
	};

	private sealed class ActiveRecording(
		IRecordingProcess process,
		string temporaryPath,
		string outputPath,
		DateTimeOffset startedAt,
		int timeoutSeconds)
	{
		public IRecordingProcess Process { get; } = process;
		public string TemporaryPath { get; } = temporaryPath;
		public string OutputPath { get; } = outputPath;
		public DateTimeOffset StartedAt { get; } = startedAt;
		public int TimeoutSeconds { get; } = timeoutSeconds;
		public CancellationTokenSource TimeoutCancellation { get; } = new();
		public RecordingFinalizer Finalizer { get; } = new();
		public bool StopSignalSent { get; set; }
		public Task? TimeoutTask { get; set; }
	}
}

internal interface IIosRecordingPlatform
{
	IRecordingProcess StartRecording(string udid, string outputPath);
	Task SendInterruptAsync(int processId, CancellationToken cancellationToken);
}

internal sealed class IosRecordingPlatform(IProcessRunner processRunner) : IIosRecordingPlatform
{
	public IRecordingProcess StartRecording(string udid, string outputPath)
	{
		var startInfo = new ProcessStartInfo
		{
			FileName = "xcrun",
			UseShellExecute = false,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			CreateNoWindow = true,
		};
		foreach (var argument in new[]
		{
			"simctl", "io", udid, "recordVideo", "--codec=h264", "--force", outputPath,
		})
		{
			startInfo.ArgumentList.Add(argument);
		}

		var process = Process.Start(startInfo)
			?? throw new InvalidOperationException("Failed to start simctl screen recording.");
		process.OutputDataReceived += (_, _) => { };
		process.ErrorDataReceived += (_, _) => { };
		process.BeginOutputReadLine();
		process.BeginErrorReadLine();
		return new SystemRecordingProcess(process);
	}

	public async Task SendInterruptAsync(int processId, CancellationToken cancellationToken)
	{
		var arguments = new[] { "-INT", processId.ToString() };
		var result = await processRunner.RunAsync(
			new ProcessRequest("kill", arguments),
			cancellationToken).ConfigureAwait(false);
		if (result.ExitCode != 0)
			throw new ProcessExecutionException("kill", arguments, result);
	}
}
