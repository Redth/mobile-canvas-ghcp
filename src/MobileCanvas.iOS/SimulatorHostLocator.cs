using MobileCanvas.Core;

namespace MobileCanvas.iOS;

internal enum SimulatorHostLayout
{
	Simulator,
	DeviceHub,
}

internal sealed record SimulatorHostInstallation(
	string DeveloperDirectory,
	string AppPath,
	string BundleIdentifier,
	string DisplayName,
	SimulatorHostLayout Layout)
{
	public string[] BuildOpenArguments(string udid) =>
		Layout == SimulatorHostLayout.Simulator
			? [AppPath, "--args", "-CurrentDeviceUDID", udid]
			: ["-a", AppPath, $"devices://device/open?id={Uri.EscapeDataString(udid)}"];
}

internal static class SimulatorHostLocator
{
	private const string DeviceHubBundleIdentifier = "com.apple.dt.Devices";
	private const string SimulatorBundleIdentifier = "com.apple.iphonesimulator";

	public static async Task<SimulatorHostInstallation> ResolveSelectedAsync(
		IProcessRunner processRunner,
		CancellationToken cancellationToken)
	{
		var developerDirectory = await XcodeDeveloperDirectory.ResolveSelectedAsync(
			processRunner,
			cancellationToken).ConfigureAwait(false);
		return Resolve(developerDirectory);
	}

	public static SimulatorHostInstallation Resolve(string developerDirectory)
	{
		if (TryResolve(developerDirectory, out var installation))
			return installation;

		throw new DirectoryNotFoundException(GetMissingHostMessage(developerDirectory));
	}

	public static bool TryResolve(
		string developerDirectory,
		[System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out SimulatorHostInstallation? installation)
	{
		var fullDeveloperDirectory = Path.GetFullPath(developerDirectory);
		var contentsDirectory = Directory.GetParent(fullDeveloperDirectory)?.FullName;
		if (contentsDirectory is null)
		{
			installation = null;
			return false;
		}

		var deviceHubPath = Path.Combine(contentsDirectory, "Applications", "DeviceHub.app");
		if (Directory.Exists(deviceHubPath))
		{
			installation = new SimulatorHostInstallation(
				fullDeveloperDirectory,
				deviceHubPath,
				DeviceHubBundleIdentifier,
				"Device Hub",
				SimulatorHostLayout.DeviceHub);
			return true;
		}

		var simulatorPath = Path.Combine(fullDeveloperDirectory, "Applications", "Simulator.app");
		if (Directory.Exists(simulatorPath))
		{
			installation = new SimulatorHostInstallation(
				fullDeveloperDirectory,
				simulatorPath,
				SimulatorBundleIdentifier,
				"Simulator",
				SimulatorHostLayout.Simulator);
			return true;
		}

		installation = null;
		return false;
	}

	public static string GetMissingHostMessage(string developerDirectory)
	{
		var fullDeveloperDirectory = Path.GetFullPath(developerDirectory);
		var contentsDirectory = Directory.GetParent(fullDeveloperDirectory)?.FullName
			?? Path.GetFullPath(Path.Combine(fullDeveloperDirectory, ".."));
		var deviceHubPath = Path.Combine(contentsDirectory, "Applications", "DeviceHub.app");
		var simulatorPath = Path.Combine(fullDeveloperDirectory, "Applications", "Simulator.app");
		return $"The simulator host app was not found for the selected Xcode developer directory "
			+ $"'{fullDeveloperDirectory}'. Expected either '{deviceHubPath}' (Xcode 27 and later) or "
			+ $"'{simulatorPath}' (Xcode 26 and earlier). Set DEVELOPER_DIR to a full Xcode "
			+ "installation, or select that installation with xcode-select.";
	}
}
