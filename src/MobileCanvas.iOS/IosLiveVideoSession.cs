using System.Runtime.CompilerServices;
using MobileCanvas.Contracts;
using MobileCanvas.Core;
using Grpc.Core;
using Idb;

namespace MobileCanvas.iOS;

internal sealed class IosLiveVideoSession : ILiveVideoSession
{
	private readonly AsyncDuplexStreamingCall<VideoStreamRequest, VideoStreamResponse> _call;
	private readonly string _outputPath;
	private readonly Action _release;
	private bool _disposed;

	private IosLiveVideoSession(
		AsyncDuplexStreamingCall<VideoStreamRequest, VideoStreamResponse> call,
		string outputPath,
		StreamDescriptor descriptor,
		Action release)
	{
		_call = call;
		_outputPath = outputPath;
		Descriptor = descriptor;
		_release = release;
	}

	public StreamDescriptor Descriptor { get; }

	public static async Task<IosLiveVideoSession> StartAsync(
		IdbCompanionSession companion,
		StreamOptions options,
		DisplayGeometry display,
		Action release,
		CancellationToken cancellationToken)
		=> await StartAsync(companion, options, display, release, null, cancellationToken)
			.ConfigureAwait(false);

	public static async Task<IosLiveVideoSession> StartAsync(
		IdbCompanionSession companion,
		StreamOptions options,
		DisplayGeometry display,
		Action release,
		string? fallbackReason,
		CancellationToken cancellationToken)
	{
		Validate(options);
		var outputPath = Path.Combine(
			Path.GetTempPath(),
			$"mobile-canvas-stream-{Environment.ProcessId}-{Guid.NewGuid():N}.h264");
		var call = companion.Client.video_stream(cancellationToken: cancellationToken);
		try
		{
			await call.RequestStream.WriteAsync(new VideoStreamRequest
			{
				Start = new VideoStreamRequest.Types.Start
				{
					FilePath = outputPath,
					Fps = (ulong)options.FramesPerSecond,
					Format = VideoStreamRequest.Types.Format.H264,
					CompressionQuality = options.CompressionQuality,
					ScaleFactor = options.Scale,
					AvgBitrate = options.AverageBitrate,
					KeyFrameRate = options.KeyFrameRate,
				},
			}, cancellationToken).ConfigureAwait(false);

			var deadline = DateTimeOffset.UtcNow.AddSeconds(10);
			while (!File.Exists(outputPath) || new System.IO.FileInfo(outputPath).Length == 0)
			{
				cancellationToken.ThrowIfCancellationRequested();
				if (DateTimeOffset.UtcNow >= deadline)
					throw new TimeoutException("idb_companion did not produce an H.264 frame within 10 seconds.");
				await Task.Delay(20, cancellationToken).ConfigureAwait(false);
			}

			return new IosLiveVideoSession(
				call,
				outputPath,
				new StreamDescriptor
				{
					FramesPerSecond = options.FramesPerSecond,
					Scale = options.Scale,
					Display = display,
					Source = "idb",
					SourceDetail = fallbackReason,
				},
				release);
		}
		catch
		{
			call.Dispose();
			if (File.Exists(outputPath))
				File.Delete(outputPath);
			throw;
		}
	}

	public async IAsyncEnumerable<ReadOnlyMemory<byte>> ReadAsync(
		[EnumeratorCancellation] CancellationToken cancellationToken = default)
	{
		ObjectDisposedException.ThrowIf(_disposed, this);
		await using var stream = new FileStream(
			_outputPath,
			FileMode.Open,
			FileAccess.Read,
			FileShare.ReadWrite | FileShare.Delete,
			bufferSize: 64 * 1024,
			useAsync: true);
		var buffer = new byte[64 * 1024];
		var idleSpins = 0;

		while (!cancellationToken.IsCancellationRequested)
		{
			var read = await stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
			if (read == 0)
			{
				// idb appends to the file as it encodes, so the only way to notice a new frame is to
				// re-read. Spin briefly with no delay first because frames arrive in bursts, then back
				// off so an idle screen does not keep a core busy.
				if (idleSpins++ < 4)
				{
					await Task.Yield();
					continue;
				}

				await Task.Delay(idleSpins < 40 ? 2 : 15, cancellationToken).ConfigureAwait(false);
				continue;
			}

			idleSpins = 0;
			yield return buffer.AsMemory(0, read).ToArray();
		}
	}

	public async ValueTask DisposeAsync()
	{
		if (_disposed)
			return;
		_disposed = true;
		try
		{
			await _call.RequestStream.WriteAsync(new VideoStreamRequest
			{
				Stop = new VideoStreamRequest.Types.Stop(),
			}).ConfigureAwait(false);
			await _call.RequestStream.CompleteAsync().ConfigureAwait(false);
		}
		catch (RpcException exception) when (
			exception.StatusCode is StatusCode.Cancelled or StatusCode.Unavailable ||
			(exception.StatusCode == StatusCode.Internal &&
			 exception.Message.Contains("PROTOCOL_ERROR", StringComparison.Ordinal)))
		{
			// The Swift server may close the stream before acknowledging Stop.
		}
		finally
		{
			_call.Dispose();
			if (File.Exists(_outputPath))
				File.Delete(_outputPath);
			_release();
		}
	}

	private static void Validate(StreamOptions options)
	{
		if (options.FramesPerSecond is not (15 or 30 or 60))
			throw new ArgumentOutOfRangeException(
				nameof(options),
				"FramesPerSecond must be 15, 30, or 60.");
		if (options.Scale is < 0.1 or > 1)
			throw new ArgumentOutOfRangeException(nameof(options), "Scale must be between 0.1 and 1.");
		if (options.CompressionQuality is < 0 or > 1)
			throw new ArgumentOutOfRangeException(
				nameof(options),
				"CompressionQuality must be between 0 and 1.");
	}
}
