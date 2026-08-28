using MobileCanvas.Android;
using MobileCanvas.Contracts;
using MobileCanvas.Core;

namespace MobileCanvas.Tests;

public sealed class AndroidEmulatorBackendTests
{
	[Fact]
	public void HiddenLaunch_IncludesNoWindow()
	{
		var arguments = AndroidEmulatorBackend.BuildLaunchArguments(
			"Test_Device",
			8555,
			wipeData: false,
			showWindow: false);

		Assert.Contains("-no-window", arguments);
	}

	[Fact]
	public void VisibleLaunch_OmitsNoWindow()
	{
		var arguments = AndroidEmulatorBackend.BuildLaunchArguments(
			"Test_Device",
			8555,
			wipeData: false,
			showWindow: true);

		Assert.DoesNotContain("-no-window", arguments);
	}

	[Fact]
	public void RequiredSdkTools_DoNotRequireAvdManagerOrJava()
	{
		var checks = new[]
		{
			Check("android-sdk", "ok"),
			Check("adb", "ok"),
			Check("emulator", "ok"),
			Check("avdmanager", "warning"),
			Check("java", "warning"),
		};

		Assert.True(AndroidEmulatorBackend.HasRequiredSdkTools(checks));
	}

	[Fact]
	public void RequiredSdkTools_RejectAMissingRuntimeTool()
	{
		var checks = new[]
		{
			Check("android-sdk", "ok"),
			Check("adb", "missing"),
			Check("emulator", "ok"),
			Check("avdmanager", "ok"),
		};

		Assert.False(AndroidEmulatorBackend.HasRequiredSdkTools(checks));
	}

	[Fact]
	public void MissingAndroidSdkDiagnostic_IsConciseAndLinksToTheSetupGuide()
	{
		var diagnostics = AndroidEmulatorBackend.BuildAndroidUnavailableDiagnostics();
		var check = Assert.Single(diagnostics.Checks);
		var action = Assert.Single(check.Actions);

		Assert.False(diagnostics.Ready);
		Assert.False(diagnostics.Available);
		Assert.Equal(DevicePlatforms.Android, diagnostics.Platform);
		Assert.Equal("Android requires the Android SDK.", check.Message);
		Assert.Equal(DiagnosticActionTypes.OpenUrl, action.Type);
		Assert.Equal("Learn more", action.Label);
		Assert.Equal(
			"https://github.com/Redth/mobile-canvas-ghcp/blob/main/docs/android-setup.md",
			action.Target);
	}

	[Fact]
	public void UnavailableAvdManagement_DoesNotDisableExistingEmulators()
	{
		var check = AndroidEmulatorBackend.BuildAvdManagerUnavailableCheck();

		Assert.Equal("warning", check.Status);
		Assert.Contains("Java runtime", check.Message, StringComparison.Ordinal);
		Assert.Contains("Existing emulators remain available", check.Message, StringComparison.Ordinal);
	}

	[Fact]
	public void WindowsAvdManager_UsesCmdWithArgumentsInTheEnvironment()
	{
		var request = AndroidSdkLocator.BuildAvdManagerRequest(
			@"C:\Android SDK\cmdline-tools\latest\bin\avdmanager.bat",
			["create", "avd", "--name", "Test_Device"],
			"no\n",
			windows: true);

		Assert.Equal("cmd.exe", request.FileName);
		Assert.Empty(request.Arguments);
		Assert.Equal(
			"/d /v:off /s /c \"\"%MOBILE_CANVAS_AVDMANAGER%\" "
				+ "\"%MOBILE_CANVAS_AVD_ARG_0%\" \"%MOBILE_CANVAS_AVD_ARG_1%\" "
				+ "\"%MOBILE_CANVAS_AVD_ARG_2%\" \"%MOBILE_CANVAS_AVD_ARG_3%\"\"",
			request.RawArguments);
		Assert.Equal("Test_Device", request.Environment!["MOBILE_CANVAS_AVD_ARG_3"]);
		Assert.Equal("no\n", request.StandardInput);
	}

	[Fact]
	public void WindowsAvdManager_RejectsCommandShellMetacharacters()
	{
		Assert.Throws<ArgumentException>(() => AndroidSdkLocator.BuildAvdManagerRequest(
			@"C:\Android\avdmanager.bat",
			["create", "avd", "--name", "unsafe&command"],
			null,
			windows: true));
	}

	[Fact]
	public async Task WindowsAvdManagerRequest_ExecutesBatchFile()
	{
		if (!OperatingSystem.IsWindows())
			return;

		var directory = Directory.CreateTempSubdirectory("mobile-canvas-avdmanager-");
		try
		{
			var script = Path.Combine(directory.FullName, "avdmanager.bat");
			await File.WriteAllTextAsync(script, "@echo off\r\necho %~1^|%~2\r\n");
			var request = AndroidSdkLocator.BuildAvdManagerRequest(
				script,
				["hello", "world"],
				null,
				windows: true);

			var result = await new SystemProcessRunner().RunAsync(request);

			Assert.Equal(0, result.ExitCode);
			Assert.Equal("hello|world", result.StandardOutput.Trim());
		}
		finally
		{
			directory.Delete(recursive: true);
		}
	}

	private static DependencyCheck Check(string name, string status) =>
		new() { Name = name, Status = status };
}
