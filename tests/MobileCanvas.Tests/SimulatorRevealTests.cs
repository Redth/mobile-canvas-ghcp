using MobileCanvas.Core;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

public sealed class SimulatorRevealTests
{
	private const string DeviceId = "ios:core-simulator:ABCD-1234";

	private const string DevicesJson = """
	{
	  "runtimes": [{
	    "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
	    "name": "iOS 18.6",
	    "version": "18.6",
	    "isAvailable": true,
	    "supportedArchitectures": ["arm64"],
	    "supportedDeviceTypes": [{
	      "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"
	    }]
	  }],
	  "devicetypes": [{
	    "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
	    "name": "iPhone 16 Pro",
	    "productFamily": "iPhone"
	  }],
	  "devices": {
	    "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [{
	      "name": "UI Test iPhone",
	      "udid": "ABCD-1234",
	      "state": "Booted",
	      "isAvailable": true,
	      "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"
	    }]
	  }
	}
	""";

	[Fact]
	public void BuildWindowTitle_MatchesSimulatorsEnDashFormat()
	{
		Assert.Equal(
			"iPhone 17 \u2013 iOS 27.0",
			SimulatorWindowFocus.BuildWindowTitle("iPhone 17", "iOS 27.0"));
	}

	[Fact]
	public void BuildScript_RaisesTheDeviceWindowWithoutDrivingMenus()
	{
		var script = SimulatorWindowFocus.BuildScript(
			CreateHost(SimulatorHostLayout.Simulator),
			"iPhone 17",
			"iOS 27.0");

		Assert.Contains("bundle identifier is \"com.apple.iphonesimulator\"", script);
		Assert.Contains("exists window \"iPhone 17 \u2013 iOS 27.0\"", script);
		Assert.Contains("perform action \"AXRaise\" of window \"iPhone 17 \u2013 iOS 27.0\"", script);
		// Opening menus steals keyboard and mouse focus, so a missing window is left alone.
		Assert.DoesNotContain("menu", script, StringComparison.OrdinalIgnoreCase);
	}

	[Fact]
	public void BuildScript_EscapesQuotesInDeviceNames()
	{
		var script = SimulatorWindowFocus.BuildScript(
			CreateHost(SimulatorHostLayout.Simulator),
			"My \"Test\" Phone",
			"iOS 27.0");

		Assert.Contains("window \"My \\\"Test\\\" Phone \u2013 iOS 27.0\"", script);
		Assert.DoesNotContain("window \"My \"Test\"", script);
	}

	[Fact]
	public void BuildScript_ActivatesDeviceHubWithoutAssumingItsWindowLayout()
	{
		var script = SimulatorWindowFocus.BuildScript(
			CreateHost(SimulatorHostLayout.DeviceHub),
			"iPhone 17",
			"iOS 27.0");

		Assert.Contains("bundle identifier is \"com.apple.dt.Devices\"", script);
		Assert.Contains("set frontmost to true", script);
		Assert.Contains("exists window \"iPhone 17 \u2013 iOS 27.0\"", script);
		Assert.DoesNotContain("menu", script, StringComparison.OrdinalIgnoreCase);
	}

	[Fact]
	public async Task RevealAsync_LaunchesLegacySimulatorWithTheDevice()
	{
		var (root, developerDirectory, appPath) = CreateXcode(SimulatorHostLayout.Simulator);
		try
		{
			var runner = new ScriptedProcessRunner(DevicesJson, developerDirectory);
			await using var backend = new IosSimulatorBackend(runner);

			await backend.RevealAsync(DeviceId, CancellationToken.None);

			var open = Assert.Single(runner.Requests, request => request.FileName == "open");
			Assert.Equal([appPath, "--args", "-CurrentDeviceUDID", "ABCD-1234"], open.Arguments);
			var script = Assert.Single(runner.Requests, request => request.FileName == "osascript");
			Assert.Contains("com.apple.iphonesimulator", script.Arguments[1]);
		}
		finally
		{
			Directory.Delete(root, recursive: true);
		}
	}

	[Fact]
	public async Task RevealAsync_LaunchesAndActivatesDeviceHub()
	{
		var (root, developerDirectory, appPath) = CreateXcode(SimulatorHostLayout.DeviceHub);
		try
		{
			var runner = new ScriptedProcessRunner(DevicesJson, developerDirectory);
			await using var backend = new IosSimulatorBackend(runner);

			await backend.RevealAsync(DeviceId, CancellationToken.None);

			var open = Assert.Single(runner.Requests, request => request.FileName == "open");
			Assert.Equal(
				["-a", appPath, "devices://device/open?id=ABCD-1234"],
				open.Arguments);
			var script = Assert.Single(runner.Requests, request => request.FileName == "osascript");
			Assert.Equal("-e", script.Arguments[0]);
			Assert.Equal(
				SimulatorWindowFocus.BuildScript(
					CreateHost(SimulatorHostLayout.DeviceHub),
					"UI Test iPhone",
					"iOS 18.6"),
				script.Arguments[1]);
		}
		finally
		{
			Directory.Delete(root, recursive: true);
		}
	}

	[Fact]
	public async Task RevealAsync_SucceedsWhenAccessibilityIsUnavailable()
	{
		var (root, developerDirectory, _) = CreateXcode(SimulatorHostLayout.DeviceHub);
		try
		{
			var runner = new ScriptedProcessRunner(DevicesJson, developerDirectory)
			{
				OsascriptThrows = true,
			};
			await using var backend = new IosSimulatorBackend(runner);

			var device = await backend.RevealAsync(DeviceId, CancellationToken.None);

			// Reveal already brought the host app forward, so denied Accessibility must not fail it.
			Assert.Equal("ABCD-1234", device.NativeId);
		}
		finally
		{
			Directory.Delete(root, recursive: true);
		}
	}

	private static SimulatorHostInstallation CreateHost(SimulatorHostLayout layout) =>
		layout == SimulatorHostLayout.DeviceHub
			? new("", "/Xcode.app/Contents/Applications/DeviceHub.app", "com.apple.dt.Devices", "Device Hub", layout)
			: new("", "/Xcode.app/Contents/Developer/Applications/Simulator.app", "com.apple.iphonesimulator", "Simulator", layout);

	private static (string Root, string DeveloperDirectory, string AppPath) CreateXcode(
		SimulatorHostLayout layout)
	{
		var root = Directory.CreateTempSubdirectory("mobile-canvas-reveal-").FullName;
		var developerDirectory = Path.Combine(root, "Xcode.app", "Contents", "Developer");
		var appPath = layout == SimulatorHostLayout.DeviceHub
			? Path.Combine(root, "Xcode.app", "Contents", "Applications", "DeviceHub.app")
			: Path.Combine(developerDirectory, "Applications", "Simulator.app");
		Directory.CreateDirectory(appPath);
		return (root, developerDirectory, appPath);
	}

	private sealed class ScriptedProcessRunner(
		string devicesJson,
		string developerDirectory) : IProcessRunner
	{
		public bool OsascriptThrows { get; init; }
		public List<ProcessRequest> Requests { get; } = [];

		public Task<ProcessResult> RunAsync(
			ProcessRequest request,
			CancellationToken cancellationToken = default)
		{
			Requests.Add(request);
			if (request.FileName == "xcrun" && request.Arguments.Contains("list"))
				return Task.FromResult(new ProcessResult(0, devicesJson, ""));
			if (request.FileName == "xcode-select")
				return Task.FromResult(new ProcessResult(0, developerDirectory, ""));
			if (request.FileName == "osascript" && OsascriptThrows)
				throw new InvalidOperationException("osascript is unavailable.");
			return Task.FromResult(new ProcessResult(0, "", ""));
		}
	}
}
