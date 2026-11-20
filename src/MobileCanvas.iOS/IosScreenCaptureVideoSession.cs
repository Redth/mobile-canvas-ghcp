using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading.Channels;
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
	/// <summary>
	/// Bytes buffered between the stdout pump and the consumer. Once full, the pump stops reading
	/// and the helper skips frames instead of the host accumulating unbounded video.
	/// </summary>
	internal const int OutputBufferCapacity = 4 * 1024 * 1024;

	private readonly Process _process;
	private readonly OutputPump _output;
	private readonly Action _release;
	private readonly CancellationTokenSource _stderrPump = new();
	private bool _disposed;

	private IosScreenCaptureVideoSession(
		Process process,
		OutputPump output,
		StreamDescriptor descriptor,
		Action release)
	{
		_process = process;
		_output = output;
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
		CancellationToken cancellationToken,
		TimeSpan? startupTimeout = null) =>
		StartProcessAsync(
			CreateFramebufferStartInfo(helperPath, nativeId, options, display),
			options,
			display,
			"framebuffer",
			sourceDetail: null,
			release,
			cancellationToken,
			startupTimeout ?? TimeSpan.FromSeconds(15));

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
			cancellationToken,
			TimeSpan.FromSeconds(15)).ConfigureAwait(false);

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
		var sourceHeight = Math.Max(display.PixelWidth, display.PixelHeight);
		if (ResolveFramebufferMaxHeight(options.Scale, sourceHeight) is { } maxHeight)
		{
			startInfo.ArgumentList.Add("--max-height");
			startInfo.ArgumentList.Add(maxHeight.ToString());
		}
		return startInfo;
	}

	/// <summary>
	/// Long-side ceiling for framebuffer video when the caller's scale does not ask for less.
	/// </summary>
	/// <remarks>
	/// Callers such as the Ailoha adapter leave <see cref="StreamOptions.Scale"/> at 1, which encoded
	/// a 1320x2868 panel at full size: roughly 450 KB per keyframe at a one-second keyframe cadence,
	/// even on a static screen. 1920 still exceeds what a side-panel canvas renders.
	/// </remarks>
	internal const int DefaultFramebufferMaxHeight = 1920;

	internal static int? ResolveFramebufferMaxHeight(double scale, int sourceHeight)
	{
		if (sourceHeight <= 0)
			return null;
		var requested = scale is > 0 and < 0.999
			? Math.Max(64, (int)Math.Round(sourceHeight * scale))
			: sourceHeight;
		var capped = Math.Min(requested, DefaultFramebufferMaxHeight);
		return capped < sourceHeight ? capped : null;
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

		// The capture is already limited by how large the simulator host app draws the window, so scaling up
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

	internal static async Task<IosScreenCaptureVideoSession> StartProcessAsync(
		ProcessStartInfo startInfo,
		StreamOptions options,
		DisplayGeometry display,
		string source,
		string? sourceDetail,
		Action release,
		CancellationToken cancellationToken,
		TimeSpan startupTimeout)
	{
		var process = new Process { StartInfo = startInfo };
		if (!process.Start())
		{
			process.Dispose();
			release();
			throw new InvalidOperationException($"Could not start {ScreenCaptureHelper.ExecutableName}.");
		}

		// Drain stdout from the moment the helper starts. It may write video before `ready` reaches
		// stderr, and an unread pipe fills at 64 KB and blocks the helper before it can report ready.
		// The early bytes, including the first keyframe, stay queued for ReadAsync.
		var output = OutputPump.Start(process.StandardOutput.BaseStream);
		try
		{
			var ready = await WaitForReadyAsync(process, startupTimeout, cancellationToken)
				.ConfigureAwait(false);
			var session = new IosScreenCaptureVideoSession(
				process,
				output,
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
			await output.DisposeAsync().ConfigureAwait(false);
			process.Dispose();
			release();
			throw;
		}
	}

	/// <summary>
	/// The helper reports startup as newline-delimited JSON on stderr so stdout stays a byte-exact
	/// Annex-B stream.
	/// </summary>
	private static async Task<ReadyEvent> WaitForReadyAsync(
		Process process,
		TimeSpan startupTimeout,
		CancellationToken cancellationToken)
	{
		using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		timeout.CancelAfter(startupTimeout);

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
				$"{ScreenCaptureHelper.ExecutableName} did not start capturing within "
				+ $"{startupTimeout.TotalSeconds:g} seconds.");
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
		var reader = _output;
		while (await reader.WaitToReadAsync(cancellationToken).ConfigureAwait(false))
		{
			while (reader.TryRead(out var chunk))
				yield return chunk;
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
			await _output.DisposeAsync().ConfigureAwait(false);
			_process.Dispose();
			_stderrPump.Dispose();
			_release();
		}
	}

	private readonly record struct ReadyEvent(int FramesPerSecond, int Width, int Height);

	/// <summary>
	/// Copies the helper's stdout into a byte-bounded queue for the lifetime of the process.
	/// </summary>
	internal sealed class OutputPump : IAsyncDisposable
	{
		private readonly Channel<ReadOnlyMemory<byte>> _channel;
		private readonly object _bufferLock = new();
		private int _bufferedBytes;
		private TaskCompletionSource? _spaceAvailable;
		private readonly CancellationTokenSource _stop = new();
		private Task _pump = Task.CompletedTask;

		private OutputPump()
		{
			// A pipe read can return even one byte. Counting reads would exhaust the startup
			// buffer long before its intended 4 MiB capacity and block the helper before ready.
			_channel = Channel.CreateUnbounded<ReadOnlyMemory<byte>>(
				new UnboundedChannelOptions
				{
					SingleReader = true,
					SingleWriter = true,
				});
		}

		public ValueTask<bool> WaitToReadAsync(CancellationToken cancellationToken) =>
			_channel.Reader.WaitToReadAsync(cancellationToken);

		public bool TryRead(out ReadOnlyMemory<byte> chunk)
		{
			if (!_channel.Reader.TryRead(out chunk))
				return false;

			TaskCompletionSource? spaceAvailable;
			lock (_bufferLock)
			{
				_bufferedBytes -= chunk.Length;
				spaceAvailable = _spaceAvailable;
				_spaceAvailable = null;
			}
			spaceAvailable?.TrySetResult();
			return true;
		}

		private async ValueTask<int> WaitForCapacityAsync(int maximumRead)
		{
			while (true)
			{
				Task wait;
				lock (_bufferLock)
				{
					var remaining = OutputBufferCapacity - _bufferedBytes;
					if (remaining > 0)
						return Math.Min(maximumRead, remaining);
					wait = (_spaceAvailable ??= new(
						TaskCreationOptions.RunContinuationsAsynchronously)).Task;
				}
				await wait.WaitAsync(_stop.Token).ConfigureAwait(false);
			}
		}

		public static OutputPump Start(Stream stream)
		{
			var pump = new OutputPump();
			pump._pump = Task.Run(() => pump.PumpAsync(stream));
			return pump;
		}

		private async Task PumpAsync(Stream stream)
		{
			var buffer = new byte[64 * 1024];
			Exception? failure = null;
			try
			{
				while (true)
				{
					var capacity = await WaitForCapacityAsync(buffer.Length).ConfigureAwait(false);
					var read = await stream.ReadAsync(buffer.AsMemory(0, capacity), _stop.Token)
						.ConfigureAwait(false);
					if (read == 0)
						break;
					lock (_bufferLock)
						_bufferedBytes += read;
					await _channel.Writer.WriteAsync(buffer.AsMemory(0, read).ToArray(), _stop.Token)
						.ConfigureAwait(false);
				}
			}
			catch (OperationCanceledException)
			{
				// Disposed.
			}
			catch (IOException)
			{
				// The helper exited and closed the pipe.
			}
			catch (ObjectDisposedException)
			{
				// The process was disposed underneath the read.
			}
			catch (Exception exception)
			{
				failure = exception;
			}
			finally
			{
				_channel.Writer.TryComplete(failure);
			}
		}

		public async ValueTask DisposeAsync()
		{
			await _stop.CancelAsync().ConfigureAwait(false);
			// Free a writer parked on the byte budget, then wait for cancellation.
			while (TryRead(out _))
			{
			}
			try
			{
				// Pipe reads do not always observe cancellation; the caller has already killed the
				// helper, so EOF normally ends the pump, and a wedged one is abandoned.
				await _pump.WaitAsync(TimeSpan.FromSeconds(3)).ConfigureAwait(false);
			}
			catch (Exception)
			{
				// The pump reports its own failures through the channel.
			}
			_channel.Writer.TryComplete();
			while (TryRead(out _))
			{
			}
			_stop.Dispose();
		}
	}
}
