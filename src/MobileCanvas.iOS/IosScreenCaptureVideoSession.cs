using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using MobileCanvas.Contracts;
using MobileCanvas.Core;

namespace MobileCanvas.iOS;

/// <summary>
/// Live H.264 capture of an iOS Simulator device screen through ScreenCaptureKit.
/// </summary>
/// <remarks>
/// This replaces idb's video path, which produced a stream that could not be repaired on the
/// client: idb emitted a single IDR for an entire session with frame reordering enabled, so any
/// decode divergence was permanent, and it never exceeded ~28 FPS. The helper drives VideoToolbox
/// directly at ~59 FPS with one keyframe per second and no reordering.
///
/// The helper crops to the exact device screen using Simulator.app's <c>iOSContentGroup</c>
/// accessibility element, so the emitted frames match idb's geometry contract: the video is the
/// device screen and nothing else. That keeps the existing client-side coordinate mapping correct
/// with no changes.
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

	public static async Task<IosScreenCaptureVideoSession> StartAsync(
		string helperPath,
		ScreencapWindow window,
		StreamOptions options,
		DisplayGeometry display,
		Action release,
		CancellationToken cancellationToken)
	{		var startInfo = new ProcessStartInfo(helperPath)
		{
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			UseShellExecute = false,
		};
		startInfo.ArgumentList.Add("capture");
		startInfo.ArgumentList.Add("--window-id");
		startInfo.ArgumentList.Add(window.WindowId.ToString());
		startInfo.ArgumentList.Add("--fps");
		startInfo.ArgumentList.Add(options.FramesPerSecond.ToString());
		startInfo.ArgumentList.Add("--bitrate");
		startInfo.ArgumentList.Add(((int)Math.Max(500_000, options.AverageBitrate)).ToString());

		// Scale is a view-resolution control, so it clamps the encoded height rather than changing
		// the crop. The capture is already limited by how large Simulator.app draws the window, so
		// scaling up would only upsample.
		if (options.Scale is > 0 and < 0.999 && window.CaptureHeightPixels > 0)
		{
			var maxHeight = (int)Math.Round(window.CaptureHeightPixels * options.Scale);
			startInfo.ArgumentList.Add("--max-height");
			startInfo.ArgumentList.Add(Math.Max(64, maxHeight).ToString());
		}

		var process = new Process { StartInfo = startInfo };
		if (!process.Start())
		{
			process.Dispose();
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
					Source = "screencapturekit",
				},
				release);
			session.StartStderrPump();
			return session;
		}
		catch
		{
			ScreenCaptureHelper.TryKill(process);
			process.Dispose();
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
