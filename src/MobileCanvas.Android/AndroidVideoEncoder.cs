using System.Diagnostics;

namespace MobileCanvas.Android;

/// <summary>
/// Locates the <c>mobile-screencap</c> helper, which Android reuses purely as an H.264 encoder.
/// </summary>
/// <remarks>
/// The emulator's <c>streamScreenshot</c> RPC only offers PNG, RGB888, and RGBA8888 -- emulator
/// 36.4.10 ships no RTC/WebRTC service -- so raw frames are pulled over loopback and encoded before
/// they reach the browser. That keeps the canvas decode path, WebSocket framing, and Annex-B parser
/// identical to iOS, and puts ~1-2 Mbps on the wire instead of the 41-577 MiB/s the raw stream costs.
///
/// VideoToolbox is macOS-only, so on other hosts Android degrades to PNG screenshot polling. Nothing
/// else in the Android path is platform specific, so replacing this one piece is what unlocks
/// Windows and Linux later.
/// </remarks>
internal static class AndroidVideoEncoder
{
	public const string ExecutableName = "mobile-screencap";
	private const string PathVariable = "MOBILE_CANVAS_SCREENCAP_PATH";

	private static readonly Lazy<string?> ResolvedPath = new(Resolve, isThreadSafe: true);

	public static string? Path => ResolvedPath.Value;

	public static bool IsAvailable => OperatingSystem.IsMacOS() && ResolvedPath.Value is not null;

	private static string? Resolve()
	{
		if (!OperatingSystem.IsMacOS())
			return null;

		var configured = Environment.GetEnvironmentVariable(PathVariable);
		if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured))
			return configured;

		var baseDirectory = AppContext.BaseDirectory;
		string[] candidates =
		[
			System.IO.Path.Combine(baseDirectory, ExecutableName),
			System.IO.Path.Combine(baseDirectory, "native", ExecutableName),
			System.IO.Path.Combine(baseDirectory, "bin", ExecutableName),
		];

		return candidates.FirstOrDefault(File.Exists);
	}

	public static void TryKill(Process process)
	{
		try
		{
			if (!process.HasExited)
				process.Kill(entireProcessTree: true);
		}
		catch (Exception)
		{
			// The helper already exited.
		}
	}
}
