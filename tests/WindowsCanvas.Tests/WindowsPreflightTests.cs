using WindowsCanvas.Contracts;
using WindowsCanvas.Windows;

namespace WindowsCanvas.Tests;

/// <summary>
/// Preflight is the first thing every Windows endpoint answers, so it has to keep working in the
/// states where nothing else can: the wrong operating system, a missing helper, a helper that will
/// not run, and a host with no desktop.
/// </summary>
public sealed class WindowsPreflightTests
{
	[Fact]
	public async Task NonWindows_ReportsTheProductAsUnsupportedInsteadOfThrowing()
	{
		var service = new WindowsAppService(
			new UnsupportedWindowsNativeBridge(),
			new FakeWindowController(),
			new FakeProcessLauncher());

		var preflight = await service.GetPreflightAsync();

		Assert.False(preflight.Ready);
		Assert.False(preflight.PlatformSupported);
		Assert.Equal(WindowsErrorCodes.PlatformUnsupported, preflight.Code);
		Assert.NotNull(preflight.Detail);
	}

	[Fact]
	public async Task NonWindows_RefusesEveryHelperCallWithOneReadableCode()
	{
		var bridge = new UnsupportedWindowsNativeBridge();

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			bridge.ListWindowsAsync());

		Assert.Equal(WindowsErrorCodes.PlatformUnsupported, failure.Code);
		Assert.Equal(409, failure.Status);
		await Assert.ThrowsAsync<WindowsCanvasException>(() => bridge.GetCatalogAsync());
		await Assert.ThrowsAsync<WindowsCanvasException>(() => bridge.LaunchCatalogEntryAsync("a1"));
	}

	[Fact]
	public async Task MissingHelper_SaysWhichFileIsMissingAndWhere()
	{
		var service = Service(out var bridge);
		bridge.Location = new WindowsHelperLocation
		{
			PlatformSupported = true,
			Present = false,
			Path = "/mobile-canvas/windows-app-helper.exe",
			Detail = "windows-app-helper.exe is missing from /mobile-canvas.",
		};

		var preflight = await service.GetPreflightAsync();

		Assert.False(preflight.Ready);
		Assert.True(preflight.PlatformSupported);
		Assert.Equal(WindowsErrorCodes.HelperMissing, preflight.Code);
		Assert.Equal("/mobile-canvas/windows-app-helper.exe", preflight.HelperPath);
		Assert.Contains("missing", preflight.Detail!, StringComparison.Ordinal);
	}

	[Fact]
	public async Task IncompatibleHelper_IsReportedRatherThanPartiallyBound()
	{
		var service = Service(out var bridge);
		bridge.CapabilitiesFailure = WindowsCanvasException.Conflict(
			WindowsErrorCodes.HelperIncompatible,
			"windows-app-helper.exe reported schema version 9; this host requires 1.");

		var preflight = await service.GetPreflightAsync();

		Assert.False(preflight.Ready);
		Assert.True(preflight.HelperPresent);
		Assert.Equal(WindowsErrorCodes.HelperIncompatible, preflight.Code);
		Assert.Contains("schema version 9", preflight.Detail!, StringComparison.Ordinal);
	}

	[Fact]
	public async Task UnsignedHelper_IsReportedButNotTreatedAsBroken()
	{
		var service = Service(out var bridge);
		bridge.Capabilities = Fixtures.Capabilities(signature: "unsigned");

		var preflight = await service.GetPreflightAsync();

		Assert.True(preflight.Ready);
		Assert.False(preflight.SignatureValid);
		Assert.Equal("unsigned", preflight.SignatureStatus);
		Assert.Equal("1.2.3", preflight.HelperVersion);
		Assert.Equal("x64", preflight.HelperArchitecture);
	}

	[Fact]
	public async Task NonInteractiveSession_IsNotReadyAndSaysWhy()
	{
		var service = Service(out var bridge);
		bridge.Capabilities = Fixtures.Capabilities(interactive: false);

		var preflight = await service.GetPreflightAsync();

		Assert.False(preflight.Ready);
		Assert.Equal(WindowsErrorCodes.SessionNotInteractive, preflight.Code);
		Assert.Contains("interactive", preflight.Detail!, StringComparison.Ordinal);
	}

	[Fact]
	public async Task Preflight_ReportsEveryFeatureTheHelperProbed()
	{
		var service = Service(out _);

		var preflight = await service.GetPreflightAsync();

		Assert.Equal(5, preflight.Features.Length);
		Assert.Contains(
			preflight.Features,
			feature => feature.Name == WindowsFeatureNames.WindowsGraphicsCapture && feature.Available);
		Assert.Equal(Fixtures.InteractiveSession, preflight.Environment!.SessionId);
		Assert.Contains("Windows 10.0", preflight.Environment.OperatingSystem!, StringComparison.Ordinal);
	}

	[Fact]
	public async Task WindowOperations_RefuseAHostWithNoDesktop()
	{
		var service = Service(out var bridge);
		bridge.Windows = new WindowsHelperWindowList
		{
			SchemaVersion = 1,
			Ok = true,
			Session = Fixtures.Session(interactive: false),
		};

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.ListWindowCandidatesAsync(
				new MobileCanvas.Contracts.CanvasContextKey(
					"session",
					"panel",
					MobileCanvas.Contracts.CanvasSurfaces.Windows)));

		Assert.Equal(WindowsErrorCodes.SessionNotInteractive, failure.Code);
	}

	[Fact]
	public async Task StaleHelper_IsCalledOutEvenWhenItStillRuns()
	{
		var service = Service(out var bridge);
		bridge.Capabilities = Fixtures.Capabilities() with { HelperVersion = "0.0.1" };

		var preflight = await service.GetPreflightAsync();

		Assert.True(preflight.Ready);
		Assert.Contains("0.0.1", preflight.Detail!, StringComparison.Ordinal);
		Assert.Contains("Reinstall", preflight.Detail!, StringComparison.Ordinal);
	}

	[Fact]
	public async Task MatchingHelper_ReportsNothingToFix()
	{
		var service = Service(out var bridge);
		var host = typeof(WindowsAppService).Assembly.GetName().Version!;
		bridge.Capabilities = Fixtures.Capabilities() with
		{
			HelperVersion = $"{host.Major}.{host.Minor}.{Math.Max(host.Build, 0)}",
		};

		var preflight = await service.GetPreflightAsync();

		Assert.True(preflight.Ready);
		Assert.Null(preflight.Detail);
	}

	[Fact]
	public async Task DevelopmentHelperVersion_IsNotMistakenForAStaleOne()
	{
		var service = Service(out var bridge);
		bridge.Capabilities = Fixtures.Capabilities() with { HelperVersion = "0.0.0-dev" };

		var preflight = await service.GetPreflightAsync();

		Assert.True(preflight.Ready);
		Assert.Null(preflight.Detail);
	}

	private static WindowsAppService Service(out FakeWindowsNativeBridge bridge)
	{
		bridge = new FakeWindowsNativeBridge();
		return new WindowsAppService(bridge, new FakeWindowController(), new FakeProcessLauncher());
	}
}
