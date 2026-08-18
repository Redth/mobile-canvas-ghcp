using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using WindowsCanvas.Contracts;

namespace WindowsCanvas.Windows;

/// <summary>
/// One live Annex-B H.264 stream of an authorized window.
///
/// A stream always ends for a stated reason. Resize, DPI change, and minimize deliberately end it
/// rather than adapting in place: an H.264 decoder cannot be handed frames of a different size, so
/// the honest move is to stop, say why, and let the browser reconnect for a fresh descriptor and
/// keyframe. <see cref="End"/> is what carries that reason once <see cref="ReadAsync"/> completes.
/// </summary>
public interface IWindowsVideoSession : IAsyncDisposable
{
	WindowsStreamDescriptor Descriptor { get; }

	/// <summary>Raw Annex-B bytes. Chunk boundaries carry no meaning.</summary>
	IAsyncEnumerable<ReadOnlyMemory<byte>> ReadAsync(CancellationToken cancellationToken = default);

	/// <summary>Why the stream stopped. Only meaningful after <see cref="ReadAsync"/> completes.</summary>
	WindowsStreamEnd End { get; }
}

/// <summary>
/// Wraps a helper stream so its descriptor and end message carry the opaque window ID and the
/// transform token, neither of which the native helper knows about. The helper reports geometry;
/// only the service knows which panel-scoped identifier that window was granted under.
/// </summary>
internal sealed class WindowsIdentifiedVideoSession(
	IWindowsVideoSession inner,
	WindowsStreamDescriptor descriptor) : IWindowsVideoSession
{
	public WindowsStreamDescriptor Descriptor { get; } = descriptor;

	public WindowsStreamEnd End => inner.End with { WindowId = Descriptor.WindowId };

	public IAsyncEnumerable<ReadOnlyMemory<byte>> ReadAsync(
		CancellationToken cancellationToken = default) => inner.ReadAsync(cancellationToken);

	public ValueTask DisposeAsync() => inner.DisposeAsync();
}

/// <summary>
/// A stream produced by <c>windows-app-helper.exe capture</c>.
///
/// The helper writes newline-delimited JSON to standard error and nothing but Annex-B bytes to
/// standard output, so the two never mix and no framing has to be invented for the byte stream. The
/// first JSON line is the descriptor, which must arrive before the session is considered started;
/// the last is the end reason, which is why standard error is drained for the whole lifetime rather
/// than only at startup.
/// </summary>
internal sealed class ProcessWindowsVideoSession : IWindowsVideoSession
{
	private const int MaximumStatusLineCharacters = 64 * 1024;

	private readonly Process _process;
	private readonly CancellationTokenSource _statusPump = new();
	private readonly Task _pumpTask;
	private WindowsStreamEnd _end;
	private bool _disposed;

	private ProcessWindowsVideoSession(
		Process process,
		WindowsStreamDescriptor descriptor,
		WindowsHelperCapture startup)
	{
		_process = process;
		Descriptor = descriptor;
		_end = new WindowsStreamEnd
		{
			WindowId = descriptor.WindowId,
			Reason = WindowsStreamEndReasons.ClientClosed,
		};
		Startup = startup;
		_pumpTask = Task.Run(PumpAsync);
	}

	public WindowsStreamDescriptor Descriptor { get; }

	/// <summary>The raw helper line the descriptor was built from, for identity verification.</summary>
	public WindowsHelperCapture Startup { get; }

	public WindowsStreamEnd End => _end;

	public static async Task<ProcessWindowsVideoSession> StartAsync(
		string helperPath,
		string request,
		WindowsStreamDescriptor descriptor,
		TimeSpan startupTimeout,
		WindowsHelperWindow window,
		CancellationToken cancellationToken)
	{
		var startInfo = new ProcessStartInfo
		{
			FileName = helperPath,
			UseShellExecute = false,
			RedirectStandardInput = true,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			CreateNoWindow = true,
			StandardErrorEncoding = Encoding.UTF8,
			StandardInputEncoding = ProcessWindowsNativeBridge.HelperInputEncoding,
		};
		startInfo.ArgumentList.Add("capture");
		startInfo.ArgumentList.Add("--json");

		var process = Process.Start(startInfo)
			?? throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.HelperFailed,
				$"Could not start {ProcessWindowsNativeBridge.HelperFileName} capture.");

		try
		{
			using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
			timeout.CancelAfter(startupTimeout);
			await process.StandardInput.WriteAsync(request.AsMemory(), timeout.Token)
				.ConfigureAwait(false);
			await process.StandardInput.FlushAsync(timeout.Token).ConfigureAwait(false);
			process.StandardInput.Close();

			var startup = await ReadStartupAsync(process, timeout.Token, cancellationToken)
				.ConfigureAwait(false);
			WindowsCaptureNormalizer.RequireIdentity(startup, window);
			return new ProcessWindowsVideoSession(
				process,
				WindowsCaptureNormalizer.Descriptor(descriptor, startup),
				startup);
		}
		catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
		{
			Kill(process);
			process.Dispose();
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.HelperTimeout,
				$"{ProcessWindowsNativeBridge.HelperFileName} capture did not produce a stream " +
				$"descriptor within {startupTimeout.TotalSeconds:0} seconds.");
		}
		catch
		{
			Kill(process);
			process.Dispose();
			throw;
		}
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
				break;
			}
			catch (ObjectDisposedException)
			{
				break;
			}

			if (read == 0)
				break;
			yield return buffer.AsMemory(0, read).ToArray();
		}

		// The end reason is on standard error, and the helper writes it before closing standard
		// output. Give the pump a moment to observe it so the browser learns whether to reconnect.
		await WaitForEndAsync().ConfigureAwait(false);
	}

	public async ValueTask DisposeAsync()
	{
		if (_disposed)
			return;
		_disposed = true;

		await _statusPump.CancelAsync().ConfigureAwait(false);
		try
		{
			Kill(_process);
			using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
			await _process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
		}
		catch (OperationCanceledException)
		{
			// The helper is wedged; the kill above already signalled it.
		}
		finally
		{
			_process.Dispose();
			_statusPump.Dispose();
		}
	}

	private async Task WaitForEndAsync()
	{
		try
		{
			await _pumpTask.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
		}
		catch (TimeoutException)
		{
		}
		catch (OperationCanceledException)
		{
		}
	}

	/// <summary>
	/// Drains standard error for the session's whole lifetime. Without this the helper eventually
	/// blocks on a full pipe and stops producing frames, and the end reason would never be read.
	/// </summary>
	private async Task PumpAsync()
	{
		try
		{
			while (!_statusPump.IsCancellationRequested)
			{
				var line = await _process.StandardError.ReadLineAsync(_statusPump.Token)
					.ConfigureAwait(false);
				if (line is null)
					break;
				if (TryParse(line) is not { } status)
					continue;
				if (!status.Type.Equals(WindowsStreamMessageTypes.End, StringComparison.Ordinal))
					continue;
				_end = new WindowsStreamEnd
				{
					WindowId = Descriptor.WindowId,
					Reason = status.Reason ?? WindowsStreamEndReasons.CaptureFailed,
					Detail = status.SourceDetail ?? status.Error?.Message,
					Reconnect = WindowsStreamEndReasons.ShouldReconnect(status.Reason),
				};
			}
		}
		catch (OperationCanceledException)
		{
		}
		catch (IOException)
		{
		}
		catch (ObjectDisposedException)
		{
		}
	}

	private static async Task<WindowsHelperCapture> ReadStartupAsync(
		Process process,
		CancellationToken timeoutToken,
		CancellationToken cancellationToken)
	{
		while (true)
		{
			var line = await process.StandardError.ReadLineAsync(timeoutToken).ConfigureAwait(false);
			if (line is null)
			{
				throw WindowsCanvasException.Gateway(
					WindowsErrorCodes.CaptureFailed,
					$"{ProcessWindowsNativeBridge.HelperFileName} capture exited before it " +
					"produced a stream descriptor.");
			}
			cancellationToken.ThrowIfCancellationRequested();

			var status = TryParse(line);
			if (status is null)
				continue;
			WindowsCaptureNormalizer.RequireOk(status, "capture");
			if (status.Type.Equals(WindowsStreamMessageTypes.Descriptor, StringComparison.Ordinal))
				return status;
		}
	}

	internal static WindowsHelperCapture? TryParse(string line)
	{
		if (string.IsNullOrWhiteSpace(line) ||
			line.Length > MaximumStatusLineCharacters ||
			line[0] != '{')
		{
			return null;
		}
		try
		{
			return JsonSerializer.Deserialize(line, WindowsJsonContext.Default.WindowsHelperCapture);
		}
		catch (JsonException)
		{
			return null;
		}
	}

	private static void Kill(Process process)
	{
		try
		{
			if (!process.HasExited)
				process.Kill(entireProcessTree: true);
		}
		catch (InvalidOperationException)
		{
		}
		catch (SystemException)
		{
		}
	}
}
