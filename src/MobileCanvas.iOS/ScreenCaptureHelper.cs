using System.Diagnostics;
using System.Text.Json;
using MobileCanvas.Core;

namespace MobileCanvas.iOS;

/// <summary>
/// A simulator host app device window as reported by the <c>mobile-screencap</c> helper.
/// </summary>
internal sealed record ScreencapWindow
{
	public uint WindowId { get; init; }
	public string DeviceName { get; init; } = "";
	public string? Runtime { get; init; }
	public string? Udid { get; init; }
	public bool UdidAmbiguous { get; init; }
	public double ScreenWidth { get; init; }
	public double ScreenHeight { get; init; }
	public double BackingScale { get; init; } = 2;

	/// <summary>
	/// True when Accessibility resolved the device screen exactly. When false the helper can only
	/// capture the whole window, which includes host-app chrome and the device bezel, so input
	/// coordinates would not line up.
	/// </summary>
	public bool HasExactGeometry { get; init; }

	public int CaptureHeightPixels => (int)Math.Round(ScreenHeight * BackingScale);
}

internal sealed record ScreencapDiagnostics
{
	public bool FramebufferAvailable { get; init; }
	public string FramebufferDetail { get; init; } = "";
	public bool ScreenRecordingGranted { get; init; }
	public bool AccessibilityGranted { get; init; }
	public string Detail { get; init; } = "";
}

/// <summary>
/// Locates and drives the native simulator capture helper.
/// </summary>
/// <remarks>
/// CoreSimulator's IOSurface APIs, ScreenCaptureKit, and VideoToolbox are unreachable from Native
/// AOT .NET, so capture lives in a small executable shipped beside <c>mobile-canvas</c>. Everything
/// here is deliberately tolerant: the caller falls through to the next capture source rather than
/// failing the stream outright.
/// </remarks>
internal static class ScreenCaptureHelper
{
	public const string ExecutableName = NativeHelperLocator.ExecutableName;

	public static string? Path => NativeHelperLocator.Path;

	public static bool IsAvailable => NativeHelperLocator.IsAvailable;

	public static async Task<IReadOnlyList<ScreencapWindow>> ListAsync(CancellationToken cancellationToken)
	{
		if (Path is not { } path)
			return [];

		var output = await RunAsync(path, ["list"], TimeSpan.FromSeconds(15), cancellationToken)
			.ConfigureAwait(false);
		if (output is null)
			return [];

		try
		{
			using var document = JsonDocument.Parse(output);
			if (!document.RootElement.TryGetProperty("windows", out var windows))
				return [];

			var results = new List<ScreencapWindow>();
			foreach (var window in windows.EnumerateArray())
			{
				var screen = window.TryGetProperty("screenRect", out var rect) && rect.ValueKind == JsonValueKind.Object
					? rect
					: default;
				// The helper falls back to the largest AXGroup when the `iOSContentGroup` subrole is
				// missing. That rect can still include chrome or bezel, so only an exact subrole
				// match may be treated as usable geometry; anything else must degrade to idb.
				var source = window.TryGetProperty("screenSource", out var src) ? src.GetString() : null;
				var hasExact = screen.ValueKind == JsonValueKind.Object
					&& string.Equals(source, "accessibility", StringComparison.Ordinal);
				var hasRect = screen.ValueKind == JsonValueKind.Object;

				results.Add(new ScreencapWindow
				{
					WindowId = window.GetProperty("windowId").GetUInt32(),
					DeviceName = window.TryGetProperty("deviceName", out var name) ? name.GetString() ?? "" : "",
					Runtime = window.TryGetProperty("runtime", out var runtime) ? runtime.GetString() : null,
					Udid = window.TryGetProperty("udid", out var udid) ? udid.GetString() : null,
					UdidAmbiguous = window.TryGetProperty("udidAmbiguous", out var ambiguous) && ambiguous.GetBoolean(),
					ScreenWidth = hasRect ? screen.GetProperty("width").GetDouble() : 0,
					ScreenHeight = hasRect ? screen.GetProperty("height").GetDouble() : 0,
					BackingScale = window.TryGetProperty("backingScale", out var scale) ? scale.GetDouble() : 2,
					HasExactGeometry = hasExact,
				});
			}

			return results;
		}
		catch (JsonException)
		{
			return [];
		}
	}

	// Probing costs a helper subprocess, and older helpers start SCShareableContent while doing it.
	// Cache complete success for the host lifetime and re-probe an incomplete fallback periodically,
	// which is what a user actively fixing permissions needs.
	private static readonly SemaphoreSlim ProbeGate = new(1, 1);
	private static readonly TimeSpan DeniedProbeInterval = TimeSpan.FromSeconds(30);
	private static ScreencapDiagnostics? _cachedDiagnostics;
	private static DateTimeOffset _cachedAt;

	public static async Task<ScreencapDiagnostics> GetDiagnosticsAsync(CancellationToken cancellationToken)
	{
		if (TryUseCache(out var cached))
			return cached;

		await ProbeGate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			if (TryUseCache(out var raced))
				return raced;

			var probed = await ProbeAsync(cancellationToken).ConfigureAwait(false);
			_cachedDiagnostics = probed;
			_cachedAt = DateTimeOffset.UtcNow;
			return probed;
		}
		finally
		{
			ProbeGate.Release();
		}
	}

	private static bool TryUseCache(out ScreencapDiagnostics diagnostics)
	{
		diagnostics = default!;
		if (_cachedDiagnostics is not { } cached)
			return false;
		if (cached.ScreenRecordingGranted && cached.AccessibilityGranted)
		{
			diagnostics = cached;
			return true;
		}

		if (DateTimeOffset.UtcNow - _cachedAt >= DeniedProbeInterval)
			return false;
		diagnostics = cached;
		return true;
	}

	private static async Task<ScreencapDiagnostics> ProbeAsync(CancellationToken cancellationToken)
	{
		if (Path is not { } path)
		{
			return new ScreencapDiagnostics
			{
				Detail = $"{ExecutableName} was not found next to mobile-canvas.",
			};
		}

		// This command only preflights TCC state; unlike ScreenCaptureKit discovery, it cannot cause
		// a Screen Recording prompt on a host where direct framebuffer capture already works.
		var output = await RunAsync(
				path,
				["framebuffer-doctor"],
				TimeSpan.FromSeconds(15),
				cancellationToken)
			.ConfigureAwait(false);
		if (!string.IsNullOrWhiteSpace(output))
		{
			var direct = ParseDiagnostics(output);
			if (!string.IsNullOrWhiteSpace(direct.FramebufferDetail))
				return direct;
		}

		// Compatibility with helpers built before direct framebuffer capture was introduced.
		output = await RunAsync(path, ["doctor"], TimeSpan.FromSeconds(15), cancellationToken)
			.ConfigureAwait(false);
		return output is null
			? new ScreencapDiagnostics { Detail = $"{ExecutableName} did not respond." }
			: ParseDiagnostics(output);
	}

	internal static ScreencapDiagnostics ParseDiagnostics(string output)
	{
		try
		{
			using var document = JsonDocument.Parse(output);
			var root = document.RootElement;
			return new ScreencapDiagnostics
			{
				FramebufferAvailable =
					root.TryGetProperty("framebufferAvailable", out var framebuffer)
					&& framebuffer.GetBoolean(),
				FramebufferDetail =
					root.TryGetProperty("framebufferDetail", out var framebufferDetail)
						? framebufferDetail.GetString() ?? ""
						: "",
				ScreenRecordingGranted =
					root.TryGetProperty("screenRecordingGranted", out var recording) && recording.GetBoolean(),
				AccessibilityGranted =
					root.TryGetProperty("accessibilityGranted", out var accessibility) && accessibility.GetBoolean(),
				Detail = root.TryGetProperty("screenRecordingDetail", out var detail) ? detail.GetString() ?? "" : "",
			};
		}
		catch (JsonException)
		{
			return new ScreencapDiagnostics { Detail = "Unreadable helper response." };
		}
	}

	private static async Task<string?> RunAsync(
		string path,
		string[] arguments,
		TimeSpan timeout,
		CancellationToken cancellationToken)
	{
		var startInfo = new ProcessStartInfo(path)
		{
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			UseShellExecute = false,
		};
		foreach (var argument in arguments)
			startInfo.ArgumentList.Add(argument);

		using var process = new Process { StartInfo = startInfo };
		try
		{
			if (!process.Start())
				return null;
		}
		catch (Exception exception) when (exception is System.ComponentModel.Win32Exception or InvalidOperationException)
		{
			return null;
		}

		using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		timeoutSource.CancelAfter(timeout);

		var readTask = process.StandardOutput.ReadToEndAsync(timeoutSource.Token);
		// stderr is redirected but not part of the result, and an undrained pipe eventually blocks
		// the helper mid-write, which would hang the stdout read that is waiting on it.
		var drainTask = process.StandardError.ReadToEndAsync(timeoutSource.Token);
		try
		{
			var text = await readTask.ConfigureAwait(false);
			await drainTask.ConfigureAwait(false);
			await process.WaitForExitAsync(timeoutSource.Token).ConfigureAwait(false);
			return text;
		}
		catch (OperationCanceledException)
		{
			TryKill(process);
			// A caller cancelling (an aborted HTTP request, say) says nothing about permissions.
			// Reporting it as a failed probe would cache a false "denied" result, so propagate
			// instead and let only a genuine timeout report the helper as unresponsive.
			cancellationToken.ThrowIfCancellationRequested();
			return null;
		}
	}

	internal static void TryKill(Process process)
	{
		try
		{
			if (!process.HasExited)
				process.Kill(entireProcessTree: true);
		}
		catch (Exception exception) when (exception is InvalidOperationException or NotSupportedException)
		{
			// The helper already exited.
		}
	}
}
