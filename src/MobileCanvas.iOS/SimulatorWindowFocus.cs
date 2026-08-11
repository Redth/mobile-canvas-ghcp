namespace MobileCanvas.iOS;

/// <summary>
/// Builds the System Events script that brings a Simulator.app device window forward.
/// </summary>
/// <remarks>
/// <c>open -a Simulator --args -CurrentDeviceUDID &lt;udid&gt;</c> only delivers <c>--args</c> when
/// <c>open</c> actually launches Simulator.app. If it is already running the flag is ignored, so a
/// reveal neither raises the requested window nor re-attaches a device that is booted but detached.
/// Simulator.app advertises AppleScript support, but Apple Events to it time out (-1712), so
/// Accessibility is the only usable lever. This deliberately stops at raising an existing window:
/// driving the File &gt; Open Simulator menu would also re-attach a detached device, but opening
/// menus steals keyboard and mouse focus from whatever the user is doing. When there is no window
/// to raise the reveal simply leaves Simulator.app frontmost.
/// </remarks>
public static class SimulatorWindowFocus
{
	/// <summary>Separator Simulator.app places between the device name and runtime in window titles.</summary>
	private const string TitleSeparator = " \u2013 ";

	/// <summary>Reproduces the window title Simulator.app gives a device, e.g. <c>iPhone 17 – iOS 27.0</c>.</summary>
	public static string BuildWindowTitle(string deviceName, string runtimeName) =>
		$"{deviceName}{TitleSeparator}{runtimeName}";

	/// <summary>
	/// Builds an AppleScript that raises <paramref name="deviceName"/>'s window when Simulator.app
	/// is showing one, and does nothing otherwise.
	/// </summary>
	public static string BuildScript(string deviceName, string runtimeName)
	{
		var title = Escape(BuildWindowTitle(deviceName, runtimeName));
		return $"""
			tell application "System Events"
				tell process "Simulator"
					if exists window "{title}" then
						set frontmost to true
						perform action "AXRaise" of window "{title}"
					end if
				end tell
			end tell
			""";
	}

	// Device names are user supplied through `simctl create`, so they can contain quotes.
	private static string Escape(string value) =>
		value
			.Replace("\\", "\\\\", StringComparison.Ordinal)
			.Replace("\"", "\\\"", StringComparison.Ordinal);
}
