using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using MobileCanvas.Contracts;
using MobileCanvas.Core;
using Android.Emulation.Control;
using Grpc.Core;
using Microsoft.Extensions.Logging;

namespace MobileCanvas.Android;

/// <summary>
/// Live H.264 capture of an Android emulator screen.
/// </summary>
/// <remarks>
/// Frames come from the emulator's own <c>streamScreenshot</c> RPC, measured at ~50 FPS with zero
/// drops at every resolution up to full native 1344x2992. They are piped as raw RGBA into
/// <c>mobile-screencap encode</c>, which runs the same VideoToolbox encoder the iOS path uses, so
/// the canvas receives a byte-identical Annex-B stream from both platforms.
///
/// <c>adb exec-out screenrecord</c> was rejected for this: it emits raw Annex-B our decoder already
/// handles, but a live capture contained 1 SPS, 1 PPS, 1 IDR and 184 P-slices -- one keyframe for
/// the whole stream -- which is the same unrecoverable-picture flaw that disqualified idb on iOS.
/// </remarks>
internal sealed class AndroidLiveVideoSession : ILiveVideoSession
{
	private readonly Process _encoder;
	private readonly AsyncServerStreamingCall<Image> _frames;
	private readonly CancellationTokenSource _pumpCancellation = new();
	private readonly ILogger _logger;
	private Task? _pump;
	private bool _disposed;

	private AndroidLiveVideoSession(
		Process encoder,
		AsyncServerStreamingCall<Image> frames,
		StreamDescriptor descriptor,
		ILogger logger)
	{
		_encoder = encoder;
		_frames = frames;
		_logger = logger;
		Descriptor = descriptor;
	}

	public StreamDescriptor Descriptor { get; }

	public static async Task<AndroidLiveVideoSession> StartAsync(
		EmulatorConnection connection,
		StreamOptions options,
		DisplayGeometry display,
		ILogger logger,
		CancellationToken cancellationToken)
	{
		if (AndroidVideoEncoder.Path is not { } encoderPath)
		{
			throw new DeviceCapabilityException(
				"The mobile-screencap helper was not found, so live video is unavailable. " +
				"The canvas will fall back to screenshot polling.");
		}

		var fps = Math.Clamp(options.FramesPerSecond, 1, 60);
		var (requestWidth, requestHeight) = ResolveRequestSize(display, options.Scale);

		var format = new ImageFormat
		{
			// RGBA8888 costs more loopback bandwidth than RGB888 but converts to the encoder's BGRA
			// input in a single vImage permute instead of a channel-expanding pass.
			Format = ImageFormat.Types.ImgFormat.Rgba8888,
			Width = (uint)requestWidth,
			Height = (uint)requestHeight,
		};

		var frames = connection.Client.streamScreenshot(format, connection.Metadata, cancellationToken: cancellationToken);

		Process? encoder = null;
		try
		{
			// The emulator adjusts the requested size to preserve aspect ratio, so the true frame
			// dimensions have to come from the first frame rather than from what we asked for.
			var first = await ReadFirstFrameAsync(frames, cancellationToken).ConfigureAwait(false);
			var width = (int)first.Format.Width;
			var height = (int)first.Format.Height;

			if (width <= 0 || height <= 0)
				throw new InvalidOperationException("The emulator reported a zero-sized frame.");

			// The emulator preserves aspect ratio when it adjusts the requested size, so it can land on
			// an odd number, which H.264 chroma subsampling cannot represent. The helper crops the
			// extra row and column. The descriptor still reports the device's own geometry, matching
			// iOS: the canvas maps pointer input in points and letterboxes on the device aspect ratio,
			// so a sub-pixel crop of the transport frame is invisible to it.
			encoder = StartEncoder(encoderPath, width, height, fps, options.AverageBitrate);
			var ready = await WaitForReadyAsync(encoder, cancellationToken).ConfigureAwait(false);

			var session = new AndroidLiveVideoSession(
				encoder,
				frames,
				new StreamDescriptor
				{
					FramesPerSecond = ready,
					Scale = options.Scale,
					Display = display,
					Source = "emulator-grpc",
				},
				logger);

			session.StartPump(first);
			return session;
		}
		catch
		{
			if (encoder is not null)
			{
				AndroidVideoEncoder.TryKill(encoder);
				encoder.Dispose();
			}

			frames.Dispose();
			throw;
		}
	}

	/// <summary>
	/// Turns the view-resolution control into a server-side capture size. Scaling on the emulator is
	/// the cheap place to do it: frame rate stayed pinned near 50 FPS at every resolution, so this is
	/// purely a bandwidth and encode-cost trade.
	/// </summary>
	private static (int Width, int Height) ResolveRequestSize(DisplayGeometry display, double scale)
	{
		var effective = scale is > 0 and <= 1 ? scale : 1;
		var width = (int)Math.Round(display.PixelWidth * effective);
		var height = (int)Math.Round(display.PixelHeight * effective);

		// H.264 chroma subsampling requires even dimensions, and the emulator rounds to a multiple of
		// four anyway, so ask for something it will not have to adjust much.
		width = Math.Max(64, width - (width % 4));
		height = Math.Max(64, height - (height % 4));
		return (width, height);
	}

	private static async Task<Image> ReadFirstFrameAsync(
		AsyncServerStreamingCall<Image> frames,
		CancellationToken cancellationToken)
	{
		using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		timeout.CancelAfter(TimeSpan.FromSeconds(15));

		try
		{
			if (await frames.ResponseStream.MoveNext(timeout.Token).ConfigureAwait(false))
				return frames.ResponseStream.Current;
		}
		catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
		{
			throw new TimeoutException("The emulator did not produce a frame within 15 seconds.");
		}

		throw new InvalidOperationException("The emulator closed the screenshot stream before sending a frame.");
	}

	private static Process StartEncoder(string encoderPath, int width, int height, int fps, double bitrate)
	{
		var startInfo = new ProcessStartInfo(encoderPath)
		{
			UseShellExecute = false,
			CreateNoWindow = true,
			RedirectStandardInput = true,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
		};

		startInfo.ArgumentList.Add("encode");
		startInfo.ArgumentList.Add("--width");
		startInfo.ArgumentList.Add(width.ToString());
		startInfo.ArgumentList.Add("--height");
		startInfo.ArgumentList.Add(height.ToString());
		startInfo.ArgumentList.Add("--pixel-format");
		startInfo.ArgumentList.Add("rgba8888");
		startInfo.ArgumentList.Add("--fps");
		startInfo.ArgumentList.Add(fps.ToString());
		startInfo.ArgumentList.Add("--bitrate");
		startInfo.ArgumentList.Add(((int)Math.Max(500_000, bitrate)).ToString());

		return Process.Start(startInfo)
			?? throw new InvalidOperationException($"Could not start {AndroidVideoEncoder.ExecutableName}.");
	}

	/// <summary>
	/// The helper reports startup as newline-delimited JSON on stderr so stdout stays a byte-exact
	/// Annex-B stream.
	/// </summary>
	private static async Task<int> WaitForReadyAsync(Process encoder, CancellationToken cancellationToken)
	{
		using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		timeout.CancelAfter(TimeSpan.FromSeconds(10));

		try
		{
			while (true)
			{
				var line = await encoder.StandardError.ReadLineAsync(timeout.Token).ConfigureAwait(false);
				if (line is null)
					throw new InvalidOperationException($"{AndroidVideoEncoder.ExecutableName} exited before it was ready.");

				if (string.IsNullOrWhiteSpace(line) || line[0] != '{')
					continue;

				using var document = JsonDocument.Parse(line);
				if (!document.RootElement.TryGetProperty("type", out var type))
					continue;

				switch (type.GetString())
				{
					case "ready":
						return document.RootElement.TryGetProperty("fps", out var fps) ? fps.GetInt32() : 60;
					case "error":
						var message = document.RootElement.TryGetProperty("message", out var text)
							? text.GetString()
							: null;
						throw new InvalidOperationException(message ?? $"{AndroidVideoEncoder.ExecutableName} failed to start.");
				}
			}
		}
		catch (JsonException)
		{
			throw new InvalidOperationException($"{AndroidVideoEncoder.ExecutableName} produced unreadable startup output.");
		}
		catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
		{
			throw new TimeoutException($"{AndroidVideoEncoder.ExecutableName} did not become ready within 10 seconds.");
		}
	}

	/// <summary>
	/// Copies emulator frames into the encoder for the life of the session, and drains the helper's
	/// stderr so it never blocks on a full pipe.
	/// </summary>
	private void StartPump(Image firstFrame)
	{
		var token = _pumpCancellation.Token;

		_ = Task.Run(async () =>
		{
			try
			{
				while (!token.IsCancellationRequested)
				{
					var line = await _encoder.StandardError.ReadLineAsync(token).ConfigureAwait(false);
					if (line is null)
						break;
				}
			}
			catch (Exception)
			{
				// Session shutting down, or the helper closed its pipe.
			}
		}, token);

		_pump = Task.Run(async () =>
		{
			var input = _encoder.StandardInput.BaseStream;
			var expectedSequence = firstFrame.Seq;

			try
			{
				await WriteFrameAsync(input, firstFrame, token).ConfigureAwait(false);

				while (await _frames.ResponseStream.MoveNext(token).ConfigureAwait(false))
				{
					var frame = _frames.ResponseStream.Current;

					// `seq` is contiguous, so drops are detectable rather than inferred. Losing frames
					// is survivable (the encoder just sees a longer gap) but it is worth reporting,
					// because it usually means a software-rendered AVD.
					if (frame.Seq != expectedSequence + 1 && frame.Seq != 0)
						_logger.LogDebug("Emulator dropped {Count} frame(s).", frame.Seq - expectedSequence - 1);

					expectedSequence = frame.Seq;

					// A mid-stream size change (rotation, fold) invalidates the encoder's fixed frame
					// size. Stopping cleanly makes the host reopen the stream instead of feeding the
					// encoder misaligned bytes, which would look like corruption.
					if (frame.Format.Width != firstFrame.Format.Width ||
						frame.Format.Height != firstFrame.Format.Height)
					{
						_logger.LogInformation("Emulator frame size changed; ending the stream so it can be reopened.");
						break;
					}

					await WriteFrameAsync(input, frame, token).ConfigureAwait(false);
				}
			}
			catch (Exception exception) when (exception is OperationCanceledException or IOException or RpcException)
			{
				// Normal shutdown: the session was disposed, the helper exited, or the emulator closed
				// the stream. Cancelling streamScreenshot surfaces as a wrapped IOException inside an
				// RpcException rather than a clean OperationCanceledException.
			}
			catch (Exception exception)
			{
				_logger.LogWarning(exception, "Android video pump stopped unexpectedly.");
			}
			finally
			{
				try
				{
					await input.FlushAsync(CancellationToken.None).ConfigureAwait(false);
					_encoder.StandardInput.Close();
				}
				catch (Exception)
				{
					// The helper is already gone.
				}
			}
		}, token);
	}

	private static async Task WriteFrameAsync(Stream input, Image frame, CancellationToken cancellationToken)
	{
		// Protobuf renames a field that collides with its message name, so `Image.image` is `Image_`.
		foreach (var segment in frame.Image_.Memory.ToArray().Chunk(256 * 1024))
			await input.WriteAsync(segment, cancellationToken).ConfigureAwait(false);
	}

	public async IAsyncEnumerable<ReadOnlyMemory<byte>> ReadAsync(
		[EnumeratorCancellation] CancellationToken cancellationToken = default)
	{
		ObjectDisposedException.ThrowIf(_disposed, this);

		var stream = _encoder.StandardOutput.BaseStream;
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
		await _pumpCancellation.CancelAsync().ConfigureAwait(false);

		try
		{
			_frames.Dispose();
		}
		catch (Exception)
		{
			// Cancelling an in-flight server stream can surface as a transport error.
		}

		if (_pump is not null)
		{
			try
			{
				await _pump.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
			}
			catch (Exception)
			{
				// The pump is wedged on a write to a dead helper; killing it below unblocks it.
			}
		}

		AndroidVideoEncoder.TryKill(_encoder);
		_encoder.Dispose();
		_pumpCancellation.Dispose();
	}
}
