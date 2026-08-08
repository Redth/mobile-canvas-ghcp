using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using MobileCanvas.Contracts;
using MobileCanvas.Core;

namespace MobileCanvas.iOS;

/// <summary>
/// Live H.264 capture of an iOS Simulator device screen through the native capture helper.
/// </summary>
/// <remarks>
/// The primary command attaches directly to CoreSimulator's IOSurface. ScreenCaptureKit remains a
/// fallback for private-framework changes, and idb remains the final fallback in the backend.
/// Both native commands share the same VideoToolbox encoder and Annex-B wire format.
/// </remarks>
internal sealed class IosScreenCaptureVideoSession : ILiveVideoSession
{
	private readonly Process _process;
	private readonly Action _release;
	private readonly CancellationTokenSource _stderrPump = new();
	private bool _disposed;

	private IosScreenCaptureVideoSession(Process process, StreamDescriptor descriptor, Action release)
	{
		_process = process;
		Descriptor = descriptor;
		_release = release;
	}

	public StreamDescriptor Descriptor { get; }

	public static Task<IosScreenCaptureVideoSession> StartFramebufferAsync(
		string helperPath,
		string nativeId,
		StreamOptions options,
		DisplayGeometry display,
		Action release,
		CancellationToken cancellationToken) =>
		StartProcessAsync(
			CreateFramebufferStartInfo(helperPath, nativeId, options, display),
			options,
			display,
			"framebuffer",
			sourceDetail: null,
			release,
			cancellationToken);

	public static async Task<IosScreenCaptureVideoSession> StartAsync(
		string helperPath,
		ScreencapWindow window,
		StreamOptions options,
		DisplayGeometry display,
		Action release,
		CancellationToken cancellationToken,
		string? sourceDetail = null) =>
		await StartProcessAsync(
			CreateScreenCaptureStartInfo(helperPath, window, options),
			options,
			display,
			"screencapturekit",
			sourceDetail,
			release,
			cancellationToken).ConfigureAwait(false);

	internal static ProcessStartInfo CreateFramebufferStartInfo(
		string helperPath,
		string nativeId,
		StreamOptions options,
		DisplayGeometry display)
	{
		var startInfo = CreateStartInfo(helperPath);
		startInfo.ArgumentList.Add("framebuffer");
		startInfo.ArgumentList.Add("--udid");
		startInfo.ArgumentList.Add(nativeId);
		AddEncodingOptions(startInfo, options);
		// CoreSimulator keeps the IOSurface in native portrait geometry even when the guest is
		// landscape. Use the panel's long side so scaling stays consistent after the client rotates
		// that portrait-shaped source into the reported display orientation.
		AddScaleOption(startInfo, options.Scale, Math.Max(display.PixelWidth, display.PixelHeight));
		return startInfo;
	}

	internal static ProcessStartInfo CreateScreenCaptureStartInfo(
		string helperPath,
		ScreencapWindow window,
		StreamOptions options)
	{
		var startInfo = CreateStartInfo(helperPath);
		startInfo.ArgumentList.Add("capture");
		startInfo.ArgumentList.Add("--window-id");
		startInfo.ArgumentList.Add(window.WindowId.ToString());
		AddEncodingOptions(startInfo, options);

		// The capture is already limited by how large Simulator.app draws the window, so scaling up
		// would only upsample.
		AddScaleOption(startInfo, options.Scale, window.CaptureHeightPixels);
		return startInfo;
	}

	private static ProcessStartInfo CreateStartInfo(string helperPath) =>
		new(helperPath)
		{
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			UseShellExecute = false,
		};

	private static void AddEncodingOptions(ProcessStartInfo startInfo, StreamOptions options)
	{
		startInfo.ArgumentList.Add("--fps");
		startInfo.ArgumentList.Add(options.FramesPerSecond.ToString());
		startInfo.ArgumentList.Add("--bitrate");
		var bitrate = (int)Math.Clamp(options.AverageBitrate, 500_000, int.MaxValue);
		startInfo.ArgumentList.Add(bitrate.ToString());
	}

	private static void AddScaleOption(ProcessStartInfo startInfo, double scale, int sourceHeight)
	{
		// Scale is a view-resolution control, so it clamps encoded height without changing the
		// device-space geometry used for input.
		if (scale is > 0 and < 0.999 && sourceHeight > 0)
		{
			var maxHeight = (int)Math.Round(sourceHeight * scale);
			startInfo.ArgumentList.Add("--max-height");
			startInfo.ArgumentList.Add(Math.Max(64, maxHeight).ToString());
		}
	}

	private static async Task<IosScreenCaptureVideoSession> StartProcessAsync(
		ProcessStartInfo startInfo,
		StreamOptions options,
		DisplayGeometry display,
		string source,
		string? sourceDetail,
		Action release,
		CancellationToken cancellationToken)
	{
		var process = new Process { StartInfo = startInfo };
		if (!process.Start())
		{
			process.Dispose();
			release();
			throw new InvalidOperationException($"Could not start {ScreenCaptureHelper.ExecutableName}.");
		}

		try
		{
			var ready = await WaitForReadyAsync(process, cancellationToken).ConfigureAwait(false);
			var session = new IosScreenCaptureVideoSession(
				process,
				new StreamDescriptor
				{
					FramesPerSecond = ready.FramesPerSecond,
					Scale = options.Scale,
					Display = display,
					Source = source,
					SourceDetail = sourceDetail,
				},
				release);
			session.StartStderrPump();
			return session;
		}
		catch
		{
			ScreenCaptureHelper.TryKill(process);
			process.Dispose();
			release();
			throw;
		}
	}

	/// <summary>
	/// The helper reports startup as newline-delimited JSON on stderr so stdout stays a byte-exact
	/// Annex-B stream.
	/// </summary>
	private static async Task<ReadyEvent> WaitForReadyAsync(Process process, CancellationToken cancellationToken)
	{
		using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		timeout.CancelAfter(TimeSpan.FromSeconds(15));

		try
		{
			while (true)
			{
				var line = await process.StandardError.ReadLineAsync(timeout.Token).ConfigureAwait(false);
				if (line is null)
				{
					throw new InvalidOperationException(
						$"{ScreenCaptureHelper.ExecutableName} exited before producing a frame.");
				}

				if (!TryParse(line, out var type, out var document))
					continue;

				using (document)
				{
					switch (type)
					{
						case "ready":
							return new ReadyEvent(
								document!.RootElement.TryGetProperty("fps", out var fps) ? fps.GetInt32() : 60,
								document.RootElement.TryGetProperty("width", out var width) ? width.GetInt32() : 0,
								document.RootElement.TryGetProperty("height", out var height) ? height.GetInt32() : 0);
						case "error":
							var message = document!.RootElement.TryGetProperty("message", out var text)
								? text.GetString()
								: null;
							throw new InvalidOperationException(
								message ?? $"{ScreenCaptureHelper.ExecutableName} failed to start.");
					}
				}
			}
		}
		catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
		{
			throw new TimeoutException(
				$"{ScreenCaptureHelper.ExecutableName} did not start capturing within 15 seconds.");
		}
	}

	private static bool TryParse(string line, out string type, out JsonDocument? document)
	{
		type = "";
		document = null;
		if (string.IsNullOrWhiteSpace(line) || line[0] != '{')
			return false;
		try
		{
			var parsed = JsonDocument.Parse(line);
			if (!parsed.RootElement.TryGetProperty("type", out var typeElement))
			{
				parsed.Dispose();
				return false;
			}
			type = typeElement.GetString() ?? "";
			document = parsed;
			return true;
		}
		catch (JsonException)
		{
			return false;
		}
	}

	/// <summary>
	/// Drains stderr for the lifetime of the session. Without this the helper eventually blocks on
	/// a full stderr pipe and stops emitting frames.
	/// </summary>
	private void StartStderrPump()
	{
		_ = Task.Run(async () =>
		{
			try
			{
				while (!_stderrPump.IsCancellationRequested)
				{
					var line = await _process.StandardError.ReadLineAsync(_stderrPump.Token).ConfigureAwait(false);
					if (line is null)
						break;
				}
			}
			catch (OperationCanceledException)
			{
				// Session is shutting down.
			}
			catch (IOException)
			{
				// The helper exited and closed the pipe.
			}
		});
	}

	public async IAsyncEnumerable<ReadOnlyMemory<byte>> ReadAsync(
		[EnumeratorCancellation] CancellationToken cancellationToken = default)
	{
		ObjectDisposedException.ThrowIf(_disposed, this);
		var stream = _process.StandardOutput.BaseStream;
		var buffer = new byte[64 * 1024];

		while (!cancellationToken.IsCancellationRequested)
		{
			int read;
			try
			{
				read = await stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
			}
			catch (IOException)
			{
				yield break;
			}

			if (read == 0)
				yield break;

			yield return buffer.AsMemory(0, read).ToArray();
		}
	}

	public async ValueTask DisposeAsync()
	{
		if (_disposed)
			return;
		_disposed = true;

		await _stderrPump.CancelAsync().ConfigureAwait(false);
		try
		{
			ScreenCaptureHelper.TryKill(_process);
			await _process.WaitForExitAsync(new CancellationTokenSource(TimeSpan.FromSeconds(3)).Token)
				.ConfigureAwait(false);
		}
		catch (OperationCanceledException)
		{
			// The helper is wedged; the kill above already signalled it.
		}
		finally
		{
			_process.Dispose();
			_stderrPump.Dispose();
			_release();
		}
	}

	private readonly record struct ReadyEvent(int FramesPerSecond, int Width, int Height);
}
