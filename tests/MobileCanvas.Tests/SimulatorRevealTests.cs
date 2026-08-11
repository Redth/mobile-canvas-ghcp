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
		var script = SimulatorWindowFocus.BuildScript("iPhone 17", "iOS 27.0");

		Assert.Contains("exists window \"iPhone 17 \u2013 iOS 27.0\"", script);
		Assert.Contains("perform action \"AXRaise\" of window \"iPhone 17 \u2013 iOS 27.0\"", script);
		// Opening menus steals keyboard and mouse focus, so a missing window is left alone.
		Assert.DoesNotContain("menu", script, StringComparison.OrdinalIgnoreCase);
	}

	[Fact]
	public void BuildScript_EscapesQuotesInDeviceNames()
	{
		var script = SimulatorWindowFocus.BuildScript("My \"Test\" Phone", "iOS 27.0");

		Assert.Contains("window \"My \\\"Test\\\" Phone \u2013 iOS 27.0\"", script);
		Assert.DoesNotContain("window \"My \"Test\"", script);
	}

	[Fact]
	public async Task RevealAsync_LaunchesSimulatorWithTheDeviceWhenItIsNotRunning()
	{
		var runner = new ScriptedProcessRunner(DevicesJson) { SimulatorRunning = false };
		await using var backend = new IosSimulatorBackend(runner);

		await backend.RevealAsync(DeviceId, CancellationToken.None);

		var open = Assert.Single(runner.Requests, request => request.FileName == "open");
		Assert.Equal(["-a", "Simulator", "--args", "-CurrentDeviceUDID", "ABCD-1234"], open.Arguments);
		// `--args` already selects the device on launch, so no Accessibility work is needed.
		Assert.DoesNotContain(runner.Requests, request => request.FileName == "osascript");
	}

	[Fact]
	public async Task RevealAsync_FocusesTheWindowWhenSimulatorIsAlreadyRunning()
	{
		var runner = new ScriptedProcessRunner(DevicesJson) { SimulatorRunning = true };
		await using var backend = new IosSimulatorBackend(runner);

		await backend.RevealAsync(DeviceId, CancellationToken.None);

		var script = Assert.Single(runner.Requests, request => request.FileName == "osascript");
		Assert.Equal("-e", script.Arguments[0]);
		Assert.Equal(
			SimulatorWindowFocus.BuildScript("UI Test iPhone", "iOS 18.6"),
			script.Arguments[1]);
	}

	[Fact]
	public async Task RevealAsync_SucceedsWhenAccessibilityIsUnavailable()
	{
		var runner = new ScriptedProcessRunner(DevicesJson)
		{
			SimulatorRunning = true,
			OsascriptThrows = true,
		};
		await using var backend = new IosSimulatorBackend(runner);

		var device = await backend.RevealAsync(DeviceId, CancellationToken.None);

		// Reveal already brought Simulator.app forward, so a denied permission must not fail the call.
		Assert.Equal("ABCD-1234", device.NativeId);
	}

	private sealed class ScriptedProcessRunner(string devicesJson) : IProcessRunner
	{
		public bool SimulatorRunning { get; init; }
		public bool OsascriptThrows { get; init; }
		public List<ProcessRequest> Requests { get; } = [];

		public Task<ProcessResult> RunAsync(
			ProcessRequest request,
			CancellationToken cancellationToken = default)
		{
			Requests.Add(request);
			if (request.FileName == "xcrun" && request.Arguments.Contains("list"))
				return Task.FromResult(new ProcessResult(0, devicesJson, ""));
			if (request.FileName == "pgrep")
				return Task.FromResult(new ProcessResult(SimulatorRunning ? 0 : 1, "", ""));
			if (request.FileName == "osascript" && OsascriptThrows)
				throw new InvalidOperationException("osascript is unavailable.");
			return Task.FromResult(new ProcessResult(0, "", ""));
		}
	}
}
