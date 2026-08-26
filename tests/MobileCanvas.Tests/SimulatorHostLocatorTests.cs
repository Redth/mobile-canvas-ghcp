using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

public sealed class SimulatorHostLocatorTests
{
	[Fact]
	public void Resolve_PrefersXcode27DeviceHub()
	{
		var (root, developerDirectory) = CreateXcode();
		try
		{
			var contents = Directory.GetParent(developerDirectory)!.FullName;
			var deviceHub = Path.Combine(contents, "Applications", "DeviceHub.app");
			var simulator = Path.Combine(developerDirectory, "Applications", "Simulator.app");
			Directory.CreateDirectory(deviceHub);
			Directory.CreateDirectory(simulator);

			var host = SimulatorHostLocator.Resolve(developerDirectory);

			Assert.Equal(SimulatorHostLayout.DeviceHub, host.Layout);
			Assert.Equal(deviceHub, host.AppPath);
			Assert.Equal("com.apple.dt.Devices", host.BundleIdentifier);
			Assert.Equal(
				["-a", deviceHub, "devices://device/open?id=ABCD-1234"],
				host.BuildOpenArguments("ABCD-1234"));
		}
		finally
		{
			Directory.Delete(root, recursive: true);
		}
	}

	[Fact]
	public void Resolve_FallsBackToLegacySimulator()
	{
		var (root, developerDirectory) = CreateXcode();
		try
		{
			var simulator = Path.Combine(developerDirectory, "Applications", "Simulator.app");
			Directory.CreateDirectory(simulator);

			var host = SimulatorHostLocator.Resolve(developerDirectory);

			Assert.Equal(SimulatorHostLayout.Simulator, host.Layout);
			Assert.Equal(simulator, host.AppPath);
			Assert.Equal("com.apple.iphonesimulator", host.BundleIdentifier);
			Assert.Equal(
				[simulator, "--args", "-CurrentDeviceUDID", "ABCD-1234"],
				host.BuildOpenArguments("ABCD-1234"));
		}
		finally
		{
			Directory.Delete(root, recursive: true);
		}
	}

	[Fact]
	public void Resolve_WhenNeitherAppExists_ExplainsBothLayouts()
	{
		var (root, developerDirectory) = CreateXcode();
		try
		{
			var exception = Assert.Throws<DirectoryNotFoundException>(
				() => SimulatorHostLocator.Resolve(developerDirectory));

			Assert.Contains("DeviceHub.app", exception.Message, StringComparison.Ordinal);
			Assert.Contains("Simulator.app", exception.Message, StringComparison.Ordinal);
			Assert.Contains("DEVELOPER_DIR", exception.Message, StringComparison.Ordinal);
		}
		finally
		{
			Directory.Delete(root, recursive: true);
		}
	}

	private static (string Root, string DeveloperDirectory) CreateXcode()
	{
		var root = Directory.CreateTempSubdirectory("mobile-canvas-simulator-host-").FullName;
		var developerDirectory = Path.Combine(root, "Xcode.app", "Contents", "Developer");
		Directory.CreateDirectory(developerDirectory);
		return (root, developerDirectory);
	}
}
