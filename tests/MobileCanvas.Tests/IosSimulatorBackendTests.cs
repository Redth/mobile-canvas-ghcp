using MobileCanvas.Contracts;
using MobileCanvas.Core;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

public sealed class IosSimulatorBackendTests
{
	private const string CatalogJson = """
		{
		  "runtimes": [{
		    "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
		    "name": "iOS 18.6",
		    "version": "18.6",
		    "isAvailable": true
		  }],
		  "devicetypes": [{
		    "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
		    "name": "iPhone 16 Pro"
		  }],
		  "devices": {
		    "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [{
		      "name": "Test iPhone",
		      "udid": "ABCD-1234",
		      "state": "Shutdown",
		      "isAvailable": true,
		      "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"
		    }]
		  }
		}
		""";
	private const string BootedCatalogJson = """
		{
		  "runtimes": [{
		    "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
		    "name": "iOS 18.6",
		    "version": "18.6",
		    "isAvailable": true
		  }],
		  "devicetypes": [{
		    "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
		    "name": "iPhone 16 Pro"
		  }],
		  "devices": {
		    "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [{
		      "name": "Test iPhone",
		      "udid": "ABCD-1234",
		      "state": "Booted",
		      "isAvailable": true,
		      "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"
		    }]
		  }
		}
		""";

	[Fact]
	public void MissingXcodeDiagnostic_IsConciseAndLinksToTheSetupGuide()
	{
		var diagnostics = IosSimulatorBackend.BuildXcodeUnavailableDiagnostics();
		var check = Assert.Single(diagnostics.Checks);
		var action = Assert.Single(check.Actions);

		Assert.False(diagnostics.Ready);
		Assert.False(diagnostics.Available);
		Assert.Equal(DevicePlatforms.Ios, diagnostics.Platform);
		Assert.Equal("iOS requires Xcode.", check.Message);
		Assert.Equal(DiagnosticActionTypes.OpenUrl, action.Type);
		Assert.Equal("Learn more", action.Label);
		Assert.Equal(
			"https://github.com/Redth/mobile-canvas-ghcp/blob/main/docs/ios-setup.md",
			action.Target);
	}

	[Fact]
	public void SimctlFailureDiagnostic_IsNonFatalAndLinksToTheSetupGuide()
	{
		var diagnostics = IosSimulatorBackend.BuildSimctlUnavailableDiagnostics();
		var check = Assert.Single(diagnostics.Checks);

		Assert.False(diagnostics.Available);
		Assert.False(diagnostics.Ready);
		Assert.Equal("iOS Simulator is unavailable.", check.Message);
		Assert.Equal(DiagnosticActionTypes.OpenUrl, Assert.Single(check.Actions).Type);
	}

	[Fact]
	public async Task GetCatalogAsync_WithoutFullXcode_DoesNotInvokeSimctl()
	{
		if (!OperatingSystem.IsMacOS())
			return;

		var commandLineTools = Directory.CreateTempSubdirectory("mobile-canvas-command-line-tools-");
		try
		{
			var runner = new RecordingProcessRunner();
			await using var backend = new IosSimulatorBackend(
				runner,
				_ => Task.FromResult(commandLineTools.FullName));

			var catalog = await backend.GetCatalogAsync();

			Assert.Empty(catalog.Devices);
			Assert.Empty(catalog.Runtimes);
			Assert.Empty(catalog.DeviceTypes);
			Assert.False(Assert.Single(catalog.Diagnostics).Ready);
			Assert.Empty(runner.Requests);
		}
		finally
		{
			commandLineTools.Delete(recursive: true);
		}
	}

	[Fact]
	public async Task GetCatalogAsync_WithFullXcode_LoadsSimulators()
	{
		if (!OperatingSystem.IsMacOS())
			return;

		var root = Directory.CreateTempSubdirectory("mobile-canvas-xcode-");
		try
		{
			var developerDirectory = Path.Combine(root.FullName, "Xcode.app", "Contents", "Developer");
			Directory.CreateDirectory(Path.Combine(developerDirectory, "Applications", "Simulator.app"));
			var runner = new RecordingProcessRunner();
			await using var backend = new IosSimulatorBackend(
				runner,
				_ => Task.FromResult(developerDirectory));

			var catalog = await backend.GetCatalogAsync();

			Assert.Equal("ABCD-1234", Assert.Single(catalog.Devices).NativeId);
			var request = Assert.Single(
				runner.Requests,
				request => request.FileName == "xcrun");
			Assert.Equal(["simctl", "list", "--json"], request.Arguments);
		}
		finally
		{
			root.Delete(recursive: true);
		}
	}

	[Fact]
	public async Task GetCatalogAsync_WhenSimctlFails_ReturnsUnavailableDiagnostics()
	{
		if (!OperatingSystem.IsMacOS())
			return;

		var root = Directory.CreateTempSubdirectory("mobile-canvas-xcode-failure-");
		try
		{
			var developerDirectory = Path.Combine(root.FullName, "Xcode.app", "Contents", "Developer");
			Directory.CreateDirectory(Path.Combine(developerDirectory, "Applications", "Simulator.app"));
			var runner = new RecordingProcessRunner
			{
				SimctlResult = new ProcessResult(69, "", "You have not agreed to the Xcode license."),
			};
			await using var backend = new IosSimulatorBackend(
				runner,
				_ => Task.FromResult(developerDirectory));

			var catalog = await backend.GetCatalogAsync();

			Assert.Empty(catalog.Devices);
			Assert.False(Assert.Single(catalog.Diagnostics).Available);
		}
		finally
		{
			root.Delete(recursive: true);
		}
	}

	[Fact]
	public async Task GetDisplayAsync_UsesOrientationObservedBeforeThisProcessStarted()
	{
		if (!OperatingSystem.IsMacOS())
			return;

		var root = Directory.CreateTempSubdirectory("mobile-canvas-xcode-orientation-");
		try
		{
			var developerDirectory = Path.Combine(root.FullName, "Xcode.app", "Contents", "Developer");
			Directory.CreateDirectory(Path.Combine(developerDirectory, "Applications", "Simulator.app"));
			var runner = new RecordingProcessRunner
			{
				Handler = request => request.Arguments switch
				{
					["simctl", "list", "--json"] => new ProcessResult(0, BootedCatalogJson, ""),
					["simctl", "io", "ABCD-1234", "enumerate"] => new ProcessResult(0, """
						Connected Screens:
						    (1) LCD:
						        Pixel Size: {1125, 2436}
						        Preferred UI Scale: 3
						        UI Orientation: Landscape Right
						""", ""),
					["simctl", "list", "devicetypes", "--json"] => new ProcessResult(
						0,
						"""{"devicetypes":[]}""",
						""),
					_ => throw new InvalidOperationException(
						$"Unexpected process request: {request.FileName} {string.Join(' ', request.Arguments)}"),
				},
			};
			await using var backend = new IosSimulatorBackend(
				runner,
				_ => Task.FromResult(developerDirectory));

			var display = await backend.GetDisplayAsync("ios:core-simulator:ABCD-1234");

			Assert.Equal("landscape-right", display.Orientation);
			Assert.Equal(2436, display.PixelWidth);
			Assert.Equal(1125, display.PixelHeight);
		}
		finally
		{
			root.Delete(recursive: true);
		}
	}

	[Fact]
	public void OrientationCache_ExpiresInFavorOfAuthoritativeState()
	{
		var authoritative = new DisplayGeometry
		{
			PixelWidth = 2436,
			PixelHeight = 1125,
			PointWidth = 812,
			PointHeight = 375,
			Scale = 3,
			Orientation = "landscape-right",
		};

		var reconciled = IosSimulatorBackend.ReconcileOrientation(
			authoritative,
			"portrait",
			TimeSpan.FromMinutes(1));

		Assert.Same(authoritative, reconciled.Display);
		Assert.False(reconciled.RetainCache);
	}

	[Fact]
	public void OrientationCache_IsDiscardedWhenSimctlHasReconciled()
	{
		var authoritative = new DisplayGeometry
		{
			PixelWidth = 2436,
			PixelHeight = 1125,
			PointWidth = 812,
			PointHeight = 375,
			Scale = 3,
			Orientation = "landscape-left",
		};

		var reconciled = IosSimulatorBackend.ReconcileOrientation(
			authoritative,
			"landscape-left",
			TimeSpan.Zero);

		Assert.Same(authoritative, reconciled.Display);
		Assert.False(reconciled.RetainCache);
	}

	private sealed class RecordingProcessRunner : IProcessRunner
	{
		public ProcessResult SimctlResult { get; init; } = new(0, CatalogJson, "");
		public Func<ProcessRequest, ProcessResult>? Handler { get; init; }
		public List<ProcessRequest> Requests { get; } = [];

		public Task<ProcessResult> RunAsync(
			ProcessRequest request,
			CancellationToken cancellationToken = default)
		{
			Requests.Add(request);
			if (Handler is not null)
				return Task.FromResult(Handler(request));
			return Task.FromResult(
				request.FileName == "xcrun"
					? SimctlResult
					: new ProcessResult(0, "", ""));
		}
	}
}
