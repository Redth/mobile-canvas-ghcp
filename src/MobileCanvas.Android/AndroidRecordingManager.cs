using System.Collections.Concurrent;
using System.Diagnostics;
using MobileCanvas.Contracts;
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
internal sealed class AndroidRecordingManager(AndroidEmulatorBackend backend, ILogger logger) : IAsyncDisposable
{
	private readonly ConcurrentDictionary<string, ActiveRecording> _recordings =
		new(StringComparer.OrdinalIgnoreCase);

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

		if (_recordings.ContainsKey(deviceId))
			throw new InvalidOperationException($"A recording is already active for '{deviceId}'.");

		var serial = await backend.RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);

		var outputPath = string.IsNullOrWhiteSpace(request.OutputPath)
			? CreateDefaultPath()
			: Path.GetFullPath(request.OutputPath);
		Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);

		var devicePath = $"/sdcard/mobile-canvas-recording-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}.mp4";
		var size = await ResolveRecordingSizeAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var process = StartScreenRecord(serial, devicePath, request.TimeoutSeconds, size);

		var recording = new ActiveRecording(process, serial, devicePath, outputPath, request.TimeoutSeconds);
		if (!_recordings.TryAdd(deviceId, recording))
		{
			AndroidVideoEncoder.TryKill(process);
			process.Dispose();
			throw new InvalidOperationException($"A recording is already active for '{deviceId}'.");
		}

		// screenrecord fails fast on a bad path or an unsupported resolution, so a short settle
		// window turns a silent no-op into an actionable error.
		await Task.Delay(500, cancellationToken).ConfigureAwait(false);
		if (process.HasExited)
		{
			_recordings.TryRemove(deviceId, out _);
			var detail = await ReadStandardErrorAsync(process).ConfigureAwait(false);
			var exitCode = process.ExitCode;
			process.Dispose();
			throw new InvalidOperationException(
				$"screenrecord exited before it started (code {exitCode}). {detail}".TrimEnd());
		}

		recording.TimeoutTask = StopAfterTimeoutAsync(deviceId, request.TimeoutSeconds);
		return ToStatus(deviceId, recording, isRecording: true);
	}

	public async Task<RecordingStatus> StopAsync(string deviceId, CancellationToken cancellationToken)
	{
		if (!_recordings.TryRemove(deviceId, out var recording))
			throw new InvalidOperationException($"No recording is active for '{deviceId}'.");

		await recording.TimeoutCancellation.CancelAsync().ConfigureAwait(false);

		try
		{
			// screenrecord only writes the MP4 moov atom when it is interrupted, so it must be
			// signalled on the device. Killing the host-side adb alone can leave an unplayable file.
			await backend.RunAdbAsync(
				recording.Serial,
				["shell", "pkill", "-INT", "screenrecord"],
				cancellationToken).ConfigureAwait(false);

			try
			{
				await recording.Process.WaitForExitAsync(cancellationToken)
					.WaitAsync(TimeSpan.FromSeconds(15), cancellationToken)
					.ConfigureAwait(false);
			}
			catch (TimeoutException)
			{
				AndroidVideoEncoder.TryKill(recording.Process);
				logger.LogWarning("screenrecord did not stop within 15 seconds for {DeviceId}.", deviceId);
			}

			// The encoder flushes asynchronously after the signal, so pulling immediately can capture
			// a truncated file.
			await WaitForStableFileAsync(recording, cancellationToken).ConfigureAwait(false);
			await PullAsync(recording, cancellationToken).ConfigureAwait(false);
		}
		finally
		{
			recording.Process.Dispose();
			recording.TimeoutCancellation.Dispose();

			try
			{
				await backend.RunAdbAsync(
					recording.Serial,
					["shell", "rm", "-f", recording.DevicePath],
					CancellationToken.None).ConfigureAwait(false);
			}
			catch (Exception exception)
			{
				logger.LogDebug(exception, "Could not remove the on-device recording {Path}.", recording.DevicePath);
			}
		}

		return ToStatus(deviceId, recording, isRecording: false);
	}

	/// <summary>
	/// Stops a recording without surfacing failures, for paths such as shutdown where the recording
	/// is incidental to what the caller asked for.
	/// </summary>
	public async Task StopQuietlyAsync(string deviceId)
	{
		if (!_recordings.ContainsKey(deviceId))
			return;

		try
		{
			await StopAsync(deviceId, CancellationToken.None).ConfigureAwait(false);
		}
		catch (Exception exception)
		{
			logger.LogWarning(exception, "Failed to stop the recording for {DeviceId}.", deviceId);
		}
	}

	public RecordingStatus GetStatus(string deviceId) =>
		_recordings.TryGetValue(deviceId, out var recording) && !recording.Process.HasExited
			? ToStatus(deviceId, recording, isRecording: true)
			: new RecordingStatus { DeviceId = deviceId };

	public async ValueTask DisposeAsync()
	{
		foreach (var deviceId in _recordings.Keys.ToArray())
			await StopQuietlyAsync(deviceId).ConfigureAwait(false);
	}

	/// <summary>
	/// Picks an explicit <c>--size</c> for screenrecord.
	/// </summary>
	/// <remarks>
	/// Left to itself, screenrecord silently falls back to a 720x1280 default when the display
	/// exceeds what the on-device encoder advertises. On a tall modern AVD (1344x2992) that is a
	/// different aspect ratio, so the recording comes out visibly stretched. Deriving the size from
	/// the real display keeps the aspect ratio, and capping the long edge keeps it inside the AVC
	/// level limits that caused the fallback in the first place. Returning null on any failure means
	/// a device we cannot measure simply records the way it did before.
	/// </remarks>
	private async Task<(int Width, int Height)?> ResolveRecordingSizeAsync(
		string deviceId,
		CancellationToken cancellationToken)
	{
		const int MaxLongEdge = 1920;

		try
		{
			var display = await backend.GetDisplayAsync(deviceId, cancellationToken).ConfigureAwait(false);
			var width = display.PixelWidth;
			var height = display.PixelHeight;
			if (width <= 0 || height <= 0)
				return null;

			var longEdge = Math.Max(width, height);
			if (longEdge > MaxLongEdge)
			{
				var factor = (double)MaxLongEdge / longEdge;
				width = (int)Math.Round(width * factor);
				height = (int)Math.Round(height * factor);
			}

			// The encoder needs even dimensions for the same chroma-subsampling reason the live
			// stream does.
			width -= width % 2;
			height -= height % 2;

			return width >= 2 && height >= 2 ? (width, height) : null;
		}
		catch (Exception exception) when (exception is not OperationCanceledException)
		{
			logger.LogDebug(exception, "Could not resolve a recording size for {DeviceId}.", deviceId);
			return null;
		}
	}

	private Process StartScreenRecord(
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

		return Process.Start(startInfo)
			?? throw new InvalidOperationException("Failed to start screenrecord.");
	}

	private async Task WaitForStableFileAsync(ActiveRecording recording, CancellationToken cancellationToken)
	{
		long previous = -1;

		for (var attempt = 0; attempt < 10; attempt++)
		{
			var output = await backend.RunAdbAsync(
				recording.Serial,
				["shell", "stat", "-c", "%s", recording.DevicePath],
				cancellationToken).ConfigureAwait(false);

			if (!long.TryParse(output?.Trim(), out var size))
				return;

			if (size > 0 && size == previous)
				return;

			previous = size;
			await Task.Delay(250, cancellationToken).ConfigureAwait(false);
		}
	}

	private async Task PullAsync(ActiveRecording recording, CancellationToken cancellationToken)
	{
		var output = await backend.RunAdbAsync(
			recording.Serial,
			["pull", recording.DevicePath, recording.OutputPath],
			cancellationToken).ConfigureAwait(false);

		if (output is null || !File.Exists(recording.OutputPath))
		{
			throw new InvalidOperationException(
				$"The recording could not be copied from the emulator to '{recording.OutputPath}'.");
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
			await StopQuietlyAsync(deviceId).ConfigureAwait(false);
		}
		catch (OperationCanceledException) when (recording.TimeoutCancellation.IsCancellationRequested)
		{
			// Stopped manually before the timeout elapsed.
		}
		catch (Exception exception)
		{
			logger.LogError(exception, "Timed recording stop failed for {DeviceId}.", deviceId);
		}
	}

	private static async Task<string> ReadStandardErrorAsync(Process process)
	{
		try
		{
			var text = await process.StandardError.ReadToEndAsync().ConfigureAwait(false);
			return text.Trim();
		}
		catch (Exception)
		{
			return "";
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
		Process process,
		string serial,
		string devicePath,
		string outputPath,
		int timeoutSeconds)
	{
		public Process Process { get; } = process;
		public string Serial { get; } = serial;
		public string DevicePath { get; } = devicePath;
		public string OutputPath { get; } = outputPath;
		public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;
		public int TimeoutSeconds { get; } = timeoutSeconds;
		public CancellationTokenSource TimeoutCancellation { get; } = new();
		public Task? TimeoutTask { get; set; }
	}
}
