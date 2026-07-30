using System.Collections.Concurrent;
using System.Diagnostics;
using MobileCanvas.Contracts;
using MobileCanvas.Core;

namespace MobileCanvas.iOS;

internal sealed class IosRecordingManager(IProcessRunner processRunner) : IAsyncDisposable
{
	private readonly ConcurrentDictionary<string, ActiveRecording> _recordings =
		new(StringComparer.OrdinalIgnoreCase);

	public async Task<RecordingStatus> StartAsync(
		string deviceId,
		string udid,
		RecordingStartRequest request,
		CancellationToken cancellationToken)
	{
		if (request.TimeoutSeconds is < 1 or > 3600)
			throw new ArgumentOutOfRangeException(
				nameof(request),
				"Recording timeout must be between 1 and 3600 seconds.");
		if (_recordings.TryGetValue(deviceId, out var active) && !active.Process.HasExited)
			throw new InvalidOperationException($"A recording is already active for '{deviceId}'.");

		var outputPath = string.IsNullOrWhiteSpace(request.OutputPath)
			? CreateDefaultPath()
			: Path.GetFullPath(request.OutputPath);
		Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);

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
		var startedAt = DateTimeOffset.UtcNow;
		var recording = new ActiveRecording(process, outputPath, startedAt, request.TimeoutSeconds);
		if (!_recordings.TryAdd(deviceId, recording))
		{
			process.Kill(entireProcessTree: true);
			process.Dispose();
			throw new InvalidOperationException($"A recording is already active for '{deviceId}'.");
		}

		await Task.Delay(500, cancellationToken).ConfigureAwait(false);
		if (process.HasExited)
		{
			_recordings.TryRemove(deviceId, out _);
			var exitCode = process.ExitCode;
			process.Dispose();
			throw new InvalidOperationException(
				$"simctl screen recording exited before it started (code {exitCode}).");
		}

		recording.TimeoutTask = StopAfterTimeoutAsync(deviceId, request.TimeoutSeconds);
		return ToStatus(deviceId, recording, isRecording: true);
	}

	public async Task<RecordingStatus> StopAsync(string deviceId, CancellationToken cancellationToken)
	{
		if (!_recordings.TryRemove(deviceId, out var recording))
			throw new InvalidOperationException($"No recording is active for '{deviceId}'.");

		recording.TimeoutCancellation.Cancel();
		try
		{
			if (!recording.Process.HasExited)
			{
				var arguments = new[] { "-INT", recording.Process.Id.ToString() };
				var result = await processRunner.RunAsync(
					new ProcessRequest("kill", arguments),
					cancellationToken).ConfigureAwait(false);
				if (result.ExitCode != 0)
					throw new ProcessExecutionException("kill", arguments, result);

				try
				{
					await recording.Process.WaitForExitAsync(cancellationToken)
						.WaitAsync(TimeSpan.FromSeconds(15), cancellationToken)
						.ConfigureAwait(false);
				}
				catch (TimeoutException)
				{
					recording.Process.Kill(entireProcessTree: true);
					throw new TimeoutException("simctl did not finalize the recording within 15 seconds.");
				}
			}
		}
		finally
		{
			recording.Process.Dispose();
			recording.TimeoutCancellation.Dispose();
		}

		return ToStatus(deviceId, recording, isRecording: false);
	}

	public RecordingStatus GetStatus(string deviceId)
	{
		if (!_recordings.TryGetValue(deviceId, out var recording) || recording.Process.HasExited)
			return new RecordingStatus { DeviceId = deviceId };
		return ToStatus(deviceId, recording, isRecording: true);
	}

	public async ValueTask DisposeAsync()
	{
		foreach (var deviceId in _recordings.Keys.ToArray())
		{
			try
			{
				await StopAsync(deviceId, CancellationToken.None).ConfigureAwait(false);
			}
			catch (Exception exception)
			{
				Trace.TraceError("Failed to stop recording for {0}: {1}", deviceId, exception);
			}
		}
	}

	private async Task StopAfterTimeoutAsync(string deviceId, int timeoutSeconds)
	{
		if (!_recordings.TryGetValue(deviceId, out var recording))
			return;
		try
		{
			await Task.Delay(
				TimeSpan.FromSeconds(timeoutSeconds),
				recording.TimeoutCancellation.Token).ConfigureAwait(false);
			await StopAsync(deviceId, CancellationToken.None).ConfigureAwait(false);
		}
		catch (OperationCanceledException) when (recording.TimeoutCancellation.IsCancellationRequested)
		{
		}
		catch (Exception exception)
		{
			Trace.TraceError("Timed recording stop failed for {0}: {1}", deviceId, exception);
		}
	}

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
		Process process,
		string outputPath,
		DateTimeOffset startedAt,
		int timeoutSeconds)
	{
		public Process Process { get; } = process;
		public string OutputPath { get; } = outputPath;
		public DateTimeOffset StartedAt { get; } = startedAt;
		public int TimeoutSeconds { get; } = timeoutSeconds;
		public CancellationTokenSource TimeoutCancellation { get; } = new();
		public Task? TimeoutTask { get; set; }
	}
}
