using MobileCanvas.Contracts;
using WindowsCanvas.Contracts;
using WindowsCanvas.Windows;

namespace WindowsCanvas.Tests;

/// <summary>
/// Explicit launch is the one place the product accepts a caller-supplied program, so its
/// validation is tested as a boundary rather than as a formality.
/// </summary>
public sealed class WindowsExecutableLaunchTests : IDisposable
{
	private static readonly CanvasContextKey Panel =
		new("session", "panel", CanvasSurfaces.Windows);

	private readonly string _executable =
		Path.Combine(AppContext.BaseDirectory, "windows-canvas-fixture-app.exe");

	private readonly string _script =
		Path.Combine(AppContext.BaseDirectory, "windows-canvas-fixture-app.cmd");

	public WindowsExecutableLaunchTests()
	{
		File.WriteAllText(_executable, "fixture");
		File.WriteAllText(_script, "fixture");
	}

	public void Dispose()
	{
		File.Delete(_executable);
		File.Delete(_script);
	}

	[Fact]
	public async Task Launch_PassesTheAbsolutePathAndArgumentArrayThrough()
	{
		var service = Service(out var bridge, out var launcher);
		launcher.ProcessId = 100;
		launcher.StartedAt = DateTimeOffset.FromFileTime(Fixtures.MediumStart);
		bridge.Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Fixture window"));

		var session = await service.LaunchExecutableAsync(
			Panel,
			new WindowsExecutableLaunchRequest
			{
				ExecutablePath = _executable,
				Arguments = ["--flag", "value with spaces", "\"quoted\""],
				WorkingDirectory = AppContext.BaseDirectory,
				CorrelationTimeout = 0,
			});

		var call = Assert.Single(launcher.Calls);
		Assert.Equal(_executable, call.Path);
		Assert.Equal(
			new[] { "--flag", "value with spaces", "\"quoted\"" },
			call.Arguments);
		Assert.Equal(Path.GetFullPath(AppContext.BaseDirectory), call.WorkingDirectory);
		Assert.Equal(WindowsSessionOrigins.Executable, session.Origin);
		Assert.Equal(
			WindowsCorrelationReasons.LaunchedProcess,
			Assert.Single(session.Windows).Correlation);
	}

	[Fact]
	public async Task Launch_ReportsTheObservedProcessAsAHintRatherThanAGrant()
	{
		var service = Service(out var bridge, out var launcher);
		launcher.ProcessId = 100;
		launcher.StartedAt = DateTimeOffset.FromFileTime(Fixtures.MediumStart);
		// Nothing on the desktop belongs to the launched process yet.
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 777, "Somebody else", processPath: _executable));

		var session = await service.LaunchExecutableAsync(
			Panel,
			new WindowsExecutableLaunchRequest
			{
				ExecutablePath = _executable,
				CorrelationTimeout = 0,
			});

		var process = Assert.Single(session.Processes);
		Assert.Equal(100, process.ProcessId);
		Assert.True(process.Observed);
		Assert.Empty(session.Windows);
		Assert.Equal(WindowsErrorCodes.LaunchNotCorrelated, session.PendingCode);
	}

	[Theory]
	[InlineData("")]
	[InlineData("   ")]
	[InlineData("fixture-app.exe")]
	[InlineData("./fixture-app.exe")]
	public async Task Launch_RefusesAnythingThatIsNotAnAbsolutePath(string path)
	{
		var service = Service(out _, out var launcher);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.LaunchExecutableAsync(
				Panel,
				new WindowsExecutableLaunchRequest { ExecutablePath = path }));

		Assert.Equal(WindowsErrorCodes.InvalidRequest, failure.Code);
		Assert.Empty(launcher.Calls);
	}

	[Fact]
	public async Task Launch_RefusesAScriptOrShortcutThatWouldNeedAShell()
	{
		var service = Service(out _, out var launcher);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.LaunchExecutableAsync(
				Panel,
				new WindowsExecutableLaunchRequest { ExecutablePath = _script }));

		Assert.Equal(WindowsErrorCodes.InvalidRequest, failure.Code);
		Assert.Contains("not an .exe", failure.Message, StringComparison.Ordinal);
		Assert.Empty(launcher.Calls);
	}

	[Fact]
	public async Task Launch_RefusesAnExecutableThatDoesNotExist()
	{
		var service = Service(out _, out var launcher);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.LaunchExecutableAsync(
				Panel,
				new WindowsExecutableLaunchRequest
				{
					ExecutablePath = Path.Combine(AppContext.BaseDirectory, "not-installed.exe"),
				}));

		Assert.Equal(WindowsErrorCodes.ExecutableNotFound, failure.Code);
		Assert.Equal(404, failure.Status);
		Assert.Empty(launcher.Calls);
	}

	[Fact]
	public async Task Launch_RefusesAWorkingDirectoryThatDoesNotExist()
	{
		var service = Service(out _, out var launcher);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.LaunchExecutableAsync(
				Panel,
				new WindowsExecutableLaunchRequest
				{
					ExecutablePath = _executable,
					WorkingDirectory = Path.Combine(AppContext.BaseDirectory, "no-such-directory"),
				}));

		Assert.Equal(WindowsErrorCodes.WorkingDirectoryNotFound, failure.Code);
		Assert.Empty(launcher.Calls);
	}

	[Fact]
	public async Task Launch_RefusesAQuotedPathThatWouldSmuggleACommandLine()
	{
		var service = Service(out _, out var launcher);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.LaunchExecutableAsync(
				Panel,
				new WindowsExecutableLaunchRequest
				{
					ExecutablePath = $"\"{_executable}\" --and-then-some",
				}));

		Assert.Equal(WindowsErrorCodes.InvalidRequest, failure.Code);
		Assert.Empty(launcher.Calls);
	}

	[Theory]
	[InlineData("\\\\fileserver\\share\\payload.exe")]
	[InlineData("//fileserver/share/payload.exe")]
	[InlineData("\\\\?\\C:\\Windows\\System32\\notepad.exe")]
	[InlineData("\\\\.\\pipe\\payload.exe")]
	public async Task Launch_RefusesUncAndDeviceNamespaces(string path)
	{
		var service = Service(out _, out var launcher);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.LaunchExecutableAsync(
				Panel,
				new WindowsExecutableLaunchRequest { ExecutablePath = path }));

		Assert.Equal(WindowsErrorCodes.InvalidRequest, failure.Code);
		Assert.Empty(launcher.Calls);
	}

	[Fact]
	public async Task Launch_RefusesAnAlternateDataStream()
	{
		var service = Service(out _, out var launcher);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.LaunchExecutableAsync(
				Panel,
				new WindowsExecutableLaunchRequest
				{
					ExecutablePath = $"{_executable}:hidden.exe",
				}));

		Assert.Equal(WindowsErrorCodes.InvalidRequest, failure.Code);
		Assert.Empty(launcher.Calls);
	}

	[Fact]
	public async Task Launch_RefusesAUncWorkingDirectory()
	{
		var service = Service(out _, out var launcher);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.LaunchExecutableAsync(
				Panel,
				new WindowsExecutableLaunchRequest
				{
					ExecutablePath = _executable,
					WorkingDirectory = "\\\\fileserver\\share",
				}));

		Assert.Equal(WindowsErrorCodes.InvalidRequest, failure.Code);
		Assert.Empty(launcher.Calls);
	}

	[Fact]
	public async Task Launch_StartsNothingWhenTheHostIsNotWindows()
	{
		var launcher = new FakeProcessLauncher();
		var service = new WindowsAppService(
			new UnsupportedWindowsNativeBridge(),
			new FakeWindowController(),
			launcher);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.LaunchExecutableAsync(
				Panel,
				new WindowsExecutableLaunchRequest
				{
					ExecutablePath = _executable,
					CorrelationTimeout = 0,
				}));

		Assert.Equal(WindowsErrorCodes.PlatformUnsupported, failure.Code);
		Assert.Empty(launcher.Calls);
	}

	private static WindowsAppService Service(
		out FakeWindowsNativeBridge bridge,
		out FakeProcessLauncher launcher)
	{
		bridge = new FakeWindowsNativeBridge();
		launcher = new FakeProcessLauncher();
		return new WindowsAppService(bridge, new FakeWindowController(), launcher);
	}
}
