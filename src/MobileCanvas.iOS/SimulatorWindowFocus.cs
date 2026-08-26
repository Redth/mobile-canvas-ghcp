namespace MobileCanvas.iOS;

/// <summary>
/// Builds the System Events script that brings the selected simulator host app forward.
/// </summary>
/// <remarks>
/// The host apps do not expose a reliable AppleScript dictionary, so Accessibility is the usable
/// lever. Simulator.app has one titled window per device; Device Hub may instead use a compact
/// sidebar layout. The script therefore activates the app by bundle identifier and raises the
/// legacy titled window only when one exists. It deliberately does not drive menus or sidebar UI.
/// </remarks>
internal static class SimulatorWindowFocus
{
	/// <summary>Separator Simulator.app places between the device name and runtime in window titles.</summary>
	private const string TitleSeparator = " \u2013 ";

	/// <summary>Reproduces the window title Simulator.app gives a device, e.g. <c>iPhone 17 – iOS 27.0</c>.</summary>
	public static string BuildWindowTitle(string deviceName, string runtimeName) =>
		$"{deviceName}{TitleSeparator}{runtimeName}";

	/// <summary>
	/// Builds an AppleScript that activates the resolved host and raises the legacy per-device window
	/// when one exists.
	/// </summary>
	public static string BuildScript(
		SimulatorHostInstallation host,
		string deviceName,
		string runtimeName)
	{
		var title = Escape(BuildWindowTitle(deviceName, runtimeName));
		var bundleIdentifier = Escape(host.BundleIdentifier);
		return $"""
			tell application "System Events"
				set hostProcesses to every application process whose bundle identifier is "{bundleIdentifier}"
				if (count of hostProcesses) > 0 then
					tell item 1 of hostProcesses
						set frontmost to true
						if exists window "{title}" then
							perform action "AXRaise" of window "{title}"
						end if
					end tell
				end if
			end tell
			""";
	}

	// Device names are user supplied through `simctl create`, so they can contain quotes.
	private static string Escape(string value) =>
		value
			.Replace("\\", "\\\\", StringComparison.Ordinal)
			.Replace("\"", "\\\"", StringComparison.Ordinal);
}
