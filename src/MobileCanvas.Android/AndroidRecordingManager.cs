using System.Collections.Concurrent;
using System.Diagnostics;
using MobileCanvas.Contracts;
using MobileCanvas.Core;
using Microsoft.Extensions.Logging;

namespace MobileCanvas.Android;

/// <summary>
/// Bounded screen recording for Android emulators.
/// </summary>
/// <remarks>
/// Unlike the live view, recording uses the device's own <c>screenrecord</c>. Its one-keyframe-per-
/// stream behaviour -- the flaw that disqualified it as a live transport -- does not matter for a
/// file played back from the start, and in exchange the frames never cross the host at all: the
/// device hardware-encodes straight to an MP4 which is pulled once at the end.
///
/// <c>screenrecord</c> stops on rotation and enforces its own limit, so the requested timeout is
/// passed through as <c>--time-limit</c> as well as being enforced host-side.
/// </remarks>
internal sealed class AndroidRecordingManager : IAsyncDisposable
{
	private static readonly TimeSpan StartSettleDelay = TimeSpan.FromMilliseconds(500);
	private static readonly TimeSpan ProcessExitTimeout = TimeSpan.FromSeconds(15);
	private static readonly TimeSpan StableFilePollDelay = TimeSpan.FromMilliseconds(250);

	private readonly IAndroidRecordingPlatform _platform;
	private readonly ILogger _logger;
	private readonly Func<TimeSpan, CancellationToken, Task> _delayAsync;
	private readonly TimeSpan _processExitTimeout;
	private readonly ConcurrentDictionary<string, ActiveRecording> _recordings =
		new(StringComparer.OrdinalIgnoreCase);
	private readonly ConcurrentDictionary<string, SemaphoreSlim> _startGates =
		new(StringComparer.OrdinalIgnoreCase);

	public AndroidRecordingManager(AndroidEmulatorBackend backend, ILogger logger)
		: this(new AndroidRecordingPlatform(backend), logger)
	{
	}

	internal AndroidRecordingManager(
		IAndroidRecordingPlatform platform,
		ILogger logger,
		Func<TimeSpan, CancellationToken, Task>? delayAsync = null,
		TimeSpan? processExitTimeout = null)
	{
		_platform = platform;
		_logger = logger;
		_delayAsync = delayAsync ?? Task.Delay;
		_processExitTimeout = processExitTimeout ?? ProcessExitTimeout;
	}

	public async Task<RecordingStatus> StartAsync(
		string deviceId,
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

			var serial = await _platform.RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);
			var outputPath = string.IsNullOrWhiteSpace(request.OutputPath)
				? CreateDefaultPath()
				: Path.GetFullPath(request.OutputPath);
			Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);

			var devicePath = $"/sdcard/mobile-canvas-recording-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}.mp4";
			var temporaryPath = CreateTemporaryPath(outputPath);
			var size = await ResolveRecordingSizeAsync(deviceId, cancellationToken).ConfigureAwait(false);
			var process = _platform.StartScreenRecord(serial, devicePath, request.TimeoutSeconds, size);
			var recording = new ActiveRecording(
				process,
				serial,
				devicePath,
				temporaryPath,
				outputPath,
				request.TimeoutSeconds);
			_recordings[deviceId] = recording;

			await _delayAsync(StartSettleDelay, cancellationToken).ConfigureAwait(false);
			if (process.HasExited)
			{
				_recordings.TryRemove(new KeyValuePair<string, ActiveRecording>(deviceId, recording));
				var detail = await process.ReadStandardErrorAsync().ConfigureAwait(false);
				var exitCode = process.ExitCode;
				process.Dispose();
				throw new InvalidOperationException(
					$"screenrecord exited before it started (code {exitCode}). {detail}".TrimEnd());
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

	/// <summary>
	/// Finalizes a recording if possible, then explicitly abandons and cleans it up before its device
	/// is stopped or the backend is disposed.
	/// </summary>
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
			_logger.LogWarning(exception, "Failed to finalize the recording for {DeviceId}; abandoning it.", deviceId);
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
				// screenrecord only writes the MP4 moov atom when interrupted on the device.
				var output = await _platform.RunAdbAsync(
					recording.Serial,
					["shell", "pkill", "-INT", "screenrecord"],
					cancellationToken).ConfigureAwait(false);
				if (output is null)
					throw new InvalidOperationException("Could not interrupt screenrecord on the emulator.");
				recording.StopSignalSent = true;
			}

			await recording.Process.WaitForExitAsync(cancellationToken)
				.WaitAsync(_processExitTimeout, cancellationToken)
				.ConfigureAwait(false);
		}

		await WaitForStableFileAsync(recording, cancellationToken).ConfigureAwait(false);
		await PullAsync(recording, cancellationToken).ConfigureAwait(false);
		ValidateRecording(recording.TemporaryPath);
		File.Move(recording.TemporaryPath, recording.OutputPath, overwrite: true);

		var completed = ToStatus(deviceId, recording, isRecording: false);
		await CleanupAfterSuccessAsync(recording).ConfigureAwait(false);
		return completed;
	}

	private async Task AbandonAsync(string deviceId, ActiveRecording recording)
	{
		await recording.Finalizer.AbandonAsync(async () =>
		{
			await recording.TimeoutCancellation.CancelAsync().ConfigureAwait(false);

			if (!recording.Process.HasExited)
			{
				using var cleanupTimeout = new CancellationTokenSource(_processExitTimeout);
				try
				{
					await _platform.RunAdbAsync(
						recording.Serial,
						["shell", "pkill", "-INT", "screenrecord"],
						cleanupTimeout.Token).ConfigureAwait(false);
				}
				catch (Exception exception)
				{
					_logger.LogDebug(exception, "Could not interrupt screenrecord for {DeviceId}.", deviceId);
				}
				recording.Process.Kill();
			}

			await CleanupOwnedFilesAsync(recording).ConfigureAwait(false);
			recording.Process.Dispose();
			recording.TimeoutCancellation.Dispose();
			_recordings.TryRemove(new KeyValuePair<string, ActiveRecording>(deviceId, recording));
		}).ConfigureAwait(false);
	}

	private async Task CleanupAfterSuccessAsync(ActiveRecording recording)
	{
		recording.Process.Dispose();
		recording.TimeoutCancellation.Dispose();
		await RemoveDeviceFileAsync(recording).ConfigureAwait(false);
	}

	private async Task CleanupOwnedFilesAsync(ActiveRecording recording)
	{
		await RemoveDeviceFileAsync(recording).ConfigureAwait(false);
		try
		{
			File.Delete(recording.TemporaryPath);
		}
		catch (Exception exception)
		{
			_logger.LogDebug(exception, "Could not remove temporary recording {Path}.", recording.TemporaryPath);
		}
	}

	private async Task RemoveDeviceFileAsync(ActiveRecording recording)
	{
		using var cleanupTimeout = new CancellationTokenSource(_processExitTimeout);
		try
		{
			await _platform.RunAdbAsync(
				recording.Serial,
				["shell", "rm", "-f", recording.DevicePath],
				cleanupTimeout.Token).ConfigureAwait(false);
		}
		catch (Exception exception)
		{
			_logger.LogDebug(exception, "Could not remove the on-device recording {Path}.", recording.DevicePath);
		}
	}

	private async Task<(int Width, int Height)?> ResolveRecordingSizeAsync(
		string deviceId,
		CancellationToken cancellationToken)
	{
		const int MaxLongEdge = 1920;

		try
		{
			var display = await _platform.GetDisplaySizeAsync(deviceId, cancellationToken).ConfigureAwait(false);
			var width = display.Width;
			var height = display.Height;
			if (width <= 0 || height <= 0)
				return null;

			var longEdge = Math.Max(width, height);
			if (longEdge > MaxLongEdge)
			{
				var factor = (double)MaxLongEdge / longEdge;
				width = (int)Math.Round(width * factor);
				height = (int)Math.Round(height * factor);
			}

			width -= width % 2;
			height -= height % 2;
			return width >= 2 && height >= 2 ? (width, height) : null;
		}
		catch (Exception exception) when (exception is not OperationCanceledException)
		{
			_logger.LogDebug(exception, "Could not resolve a recording size for {DeviceId}.", deviceId);
			return null;
		}
	}

	private async Task WaitForStableFileAsync(
		ActiveRecording recording,
		CancellationToken cancellationToken)
	{
		long previous = -1;
		for (var attempt = 0; attempt < 10; attempt++)
		{
			var output = await _platform.RunAdbAsync(
				recording.Serial,
				["shell", "stat", "-c", "%s", recording.DevicePath],
				cancellationToken).ConfigureAwait(false);
			if (!long.TryParse(output?.Trim(), out var size))
				throw new InvalidOperationException($"Could not read the size of '{recording.DevicePath}'.");
			if (size > 0 && size == previous)
				return;

			previous = size;
			await _delayAsync(StableFilePollDelay, cancellationToken).ConfigureAwait(false);
		}

		throw new InvalidOperationException($"The recording '{recording.DevicePath}' did not become stable.");
	}

	private async Task PullAsync(ActiveRecording recording, CancellationToken cancellationToken)
	{
		var output = await _platform.RunAdbAsync(
			recording.Serial,
			["pull", recording.DevicePath, recording.TemporaryPath],
			cancellationToken).ConfigureAwait(false);
		if (output is null || !File.Exists(recording.TemporaryPath))
		{
			throw new InvalidOperationException(
				$"The recording could not be copied from the emulator to '{recording.OutputPath}'.");
		}
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
			_logger.LogError(exception, "Timed recording finalization failed for {DeviceId}.", deviceId);
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
		return Path.Combine(directory, $"android-{DateTimeOffset.Now:yyyyMMdd-HHmmss}.mp4");
	}

	private static RecordingStatus ToStatus(string deviceId, ActiveRecording recording, bool isRecording) => new()
	{
		DeviceId = deviceId,
		IsRecording = isRecording,
		OutputPath = recording.OutputPath,
		StartedAt = recording.StartedAt,
		TimeoutSeconds = recording.TimeoutSeconds,
	};

	private sealed class ActiveRecording(
		IRecordingProcess process,
		string serial,
		string devicePath,
		string temporaryPath,
		string outputPath,
		int timeoutSeconds)
	{
		public IRecordingProcess Process { get; } = process;
		public string Serial { get; } = serial;
		public string DevicePath { get; } = devicePath;
		public string TemporaryPath { get; } = temporaryPath;
		public string OutputPath { get; } = outputPath;
		public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;
		public int TimeoutSeconds { get; } = timeoutSeconds;
		public CancellationTokenSource TimeoutCancellation { get; } = new();
		public RecordingFinalizer Finalizer { get; } = new();
		public bool StopSignalSent { get; set; }
		public Task? TimeoutTask { get; set; }
	}
}

internal interface IAndroidRecordingPlatform
{
	Task<string> RequireSerialAsync(string deviceId, CancellationToken cancellationToken);
	Task<(int Width, int Height)> GetDisplaySizeAsync(string deviceId, CancellationToken cancellationToken);
	IRecordingProcess StartScreenRecord(
		string serial,
		string devicePath,
		int timeoutSeconds,
		(int Width, int Height)? size);
	Task<string?> RunAdbAsync(
		string serial,
		IReadOnlyList<string> arguments,
		CancellationToken cancellationToken);
}

internal sealed class AndroidRecordingPlatform(AndroidEmulatorBackend backend) : IAndroidRecordingPlatform
{
	public Task<string> RequireSerialAsync(string deviceId, CancellationToken cancellationToken) =>
		backend.RequireSerialAsync(deviceId, cancellationToken);

	public async Task<(int Width, int Height)> GetDisplaySizeAsync(
		string deviceId,
		CancellationToken cancellationToken)
	{
		var display = await backend.GetDisplayAsync(deviceId, cancellationToken).ConfigureAwait(false);
		return (display.PixelWidth, display.PixelHeight);
	}

	public IRecordingProcess StartScreenRecord(
		string serial,
		string devicePath,
		int timeoutSeconds,
		(int Width, int Height)? size)
	{
		var adb = backend.AdbPath
			?? throw new InvalidOperationException("adb was not found, so recording is unavailable.");
		var startInfo = new ProcessStartInfo(adb)
		{
			UseShellExecute = false,
			CreateNoWindow = true,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
		};
		var arguments = new List<string>
		{
			"-s", serial, "shell", "screenrecord", "--time-limit", timeoutSeconds.ToString(),
		};
		if (size is { } resolved)
		{
			arguments.Add("--size");
			arguments.Add($"{resolved.Width}x{resolved.Height}");
		}
		arguments.Add(devicePath);
		foreach (var argument in arguments)
			startInfo.ArgumentList.Add(argument);

		return new SystemRecordingProcess(
			Process.Start(startInfo)
				?? throw new InvalidOperationException("Failed to start screenrecord."));
	}

	public Task<string?> RunAdbAsync(
		string serial,
		IReadOnlyList<string> arguments,
		CancellationToken cancellationToken) =>
		backend.RunAdbAsync(serial, arguments.ToArray(), cancellationToken);
}
