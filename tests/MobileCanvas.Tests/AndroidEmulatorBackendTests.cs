using MobileCanvas.Android;
using MobileCanvas.Contracts;
using MobileCanvas.Core;
using Microsoft.Extensions.Logging.Abstractions;

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

	[Theory]
	[InlineData("Pixel 8 Pro", "Pixel_8_Pro")]
	[InlineData("foo/bar", "foo_bar")]
	[InlineData("///", "mobile_canvas_avd")]
	public void SanitizeAvdName_ProducesSafeStableNames(string name, string expected)
	{
		Assert.Equal(expected, AndroidEmulatorBackend.SanitizeAvdName(name));
	}

	[Fact]
	public void CreateArguments_UseTheCanonicalPackageWithoutForce()
	{
		var arguments = AndroidEmulatorBackend.BuildCreateArguments(
			"foo_bar",
			"system-images;android-35;google_apis;arm64-v8a",
			"pixel_8");

		Assert.Equal(
			new[]
			{
				"create",
				"avd",
				"--name",
				"foo_bar",
				"--package",
				"system-images;android-35;google_apis;arm64-v8a",
				"--device",
				"pixel_8",
			},
			arguments);
	}

	[Theory]
	[InlineData(
		"system-images/android-35/google_apis/arm64-v8a/",
		"system-images;android-35;google_apis;arm64-v8a")]
	[InlineData(
		@"system-images\android-35\google_apis\arm64-v8a\",
		"system-images;android-35;google_apis;arm64-v8a")]
	[InlineData(
		" system-images;android-35;google_apis;arm64-v8a ",
		"system-images;android-35;google_apis;arm64-v8a")]
	public void RuntimeIdNormalization_UsesTheAvdManagerPackageId(string runtimeId, string expected)
	{
		Assert.Equal(expected, AndroidEmulatorBackend.ToSystemImagePackage(runtimeId));
	}

	[Fact]
	public void InstalledSystemImages_AreCreatableWithoutAnExistingAvd()
	{
		var root = Directory.CreateTempSubdirectory("mobile-canvas-sdk-").FullName;
		var olderImage = Path.Combine(
			root,
			"system-images",
			"android-35",
			"google_apis",
			"arm64-v8a");
		var newerImage = Path.Combine(
			root,
			"system-images",
			"android-36.1",
			"google_apis",
			"arm64-v8a");
		Directory.CreateDirectory(olderImage);
		Directory.CreateDirectory(newerImage);
		File.WriteAllText(Path.Combine(olderImage, "source.properties"), "Pkg.Revision=1\n");
		File.WriteAllText(Path.Combine(newerImage, "package.xml"), "<repository />\n");

		try
		{
			var installed = AndroidSdkLocator.FindInstalledSystemImages(root);
			Assert.Collection(
				installed,
				runtime =>
				{
					Assert.Equal("system-images;android-36.1;google_apis;arm64-v8a", runtime.PackageId);
					Assert.Equal("36.1", runtime.Version);
				},
				runtime =>
				{
					Assert.Equal("system-images;android-35;google_apis;arm64-v8a", runtime.PackageId);
					Assert.Equal("35", runtime.Version);
					Assert.Equal("google_apis", runtime.Tag);
					Assert.Equal("arm64-v8a", runtime.Architecture);
				});
		}
		finally
		{
			Directory.Delete(root, recursive: true);
		}
	}

	[Fact]
	public void InstalledSystemImages_IgnoreInterruptedDirectoriesWithoutPackageMetadata()
	{
		var root = Directory.CreateTempSubdirectory("mobile-canvas-sdk-").FullName;
		var partialImage = Path.Combine(
			root,
			"system-images",
			"android-35",
			"google_apis",
			"arm64-v8a");
		Directory.CreateDirectory(partialImage);

		try
		{
			Assert.Empty(AndroidSdkLocator.FindInstalledSystemImages(root));
		}
		finally
		{
			Directory.Delete(root, recursive: true);
		}
	}

	[Fact]
	public void RuntimeCatalog_MapsInstalledImagesToCanonicalPackageIds()
	{
		var runtimes = AndroidEmulatorBackend.BuildRuntimes(
			[
				new DeviceTarget
				{
					RuntimeId = @"system-images\android-35\google_apis\arm64-v8a",
					RuntimeName = "API 35 (Google APIs)",
					OsVersion = "35",
					Architecture = "arm64-v8a",
				},
			],
			[
				new AndroidSystemImage(
					"system-images;android-35;google_apis;arm64-v8a",
					"35",
					"google_apis",
					"arm64-v8a"),
			]);

		var runtime = Assert.Single(runtimes);
		Assert.Equal("system-images;android-35;google_apis;arm64-v8a", runtime.Id);
		Assert.Equal("35", runtime.Version);
		Assert.Equal(["arm64-v8a"], runtime.SupportedArchitectures);
		Assert.True(runtime.IsAvailable);
	}

	[Fact]
	public void RuntimeCatalog_MarksConfiguredButUninstalledImagesUnavailable()
	{
		var runtimes = AndroidEmulatorBackend.BuildRuntimes(
			[
				new DeviceTarget
				{
					RuntimeId = "system-images/android-34/google_apis/x86_64/",
					RuntimeName = "API 34 (Google APIs)",
					OsVersion = "34",
					Architecture = "x86_64",
				},
			],
			[]);

		var runtime = Assert.Single(runtimes);
		Assert.Equal("system-images;android-34;google_apis;x86_64", runtime.Id);
		Assert.False(runtime.IsAvailable);
	}

	[Fact]
	public async Task CreateAsync_RejectsAnUninstalledRuntimeBeforeLaunchingAvdManager()
	{
		using var sdk = new AndroidSdkFixture();
		var runner = new RecordingProcessRunner((request, _) =>
			throw new InvalidOperationException($"Unexpected process request: {request.FileName}"));
		await using var backend = new AndroidEmulatorBackend(
			runner,
			NullLogger<AndroidEmulatorBackend>.Instance,
			new AndroidSdkLocator(sdk.Root));

		var exception = await Assert.ThrowsAsync<ArgumentException>(() =>
			backend.CreateAsync(new CreateDeviceRequest
			{
				Name = "missing runtime",
				RuntimeId = "system-images;android-34;google_apis;arm64-v8a",
				DeviceTypeId = "pixel_8",
			}));

		Assert.Contains("is not installed", exception.Message, StringComparison.Ordinal);
		Assert.Empty(runner.Calls);
	}

	[Fact]
	public async Task CreateAsync_MapsAnExistingAvdCollisionWithoutDeletingIt()
	{
		using var sdk = new AndroidSdkFixture();
		var runner = new RecordingProcessRunner((request, _) =>
		{
			var arguments = GetAvdManagerArguments(request);
			if (arguments.SequenceEqual(["list", "device", "-c"]))
				return new ProcessResult(0, "pixel_8\n", "");

			Assert.Equal("create", arguments[0]);
			return new ProcessResult(1, "", "Android Virtual Device 'existing_device' already exists.");
		});
		await using var backend = new AndroidEmulatorBackend(
			runner,
			NullLogger<AndroidEmulatorBackend>.Instance,
			new AndroidSdkLocator(sdk.Root));

		var exception = await Assert.ThrowsAsync<ProcessExecutionException>(() =>
			backend.CreateAsync(new CreateDeviceRequest
			{
				Name = "existing/device",
				RuntimeId = "system-images/android-35/google_apis/arm64-v8a/",
				DeviceTypeId = "pixel_8",
			}));

		Assert.Contains("already exists", exception.Message, StringComparison.Ordinal);
		var call = Assert.Single(
			runner.Calls,
			call => GetAvdManagerArguments(call.Request).FirstOrDefault() == "create");
		Assert.Equal(
			new[]
			{
				"create",
				"avd",
				"--name",
				"existing_device",
				"--package",
				sdk.RuntimeId,
				"--device",
				"pixel_8",
			},
			GetAvdManagerArguments(call.Request));
	}

	[Fact]
	public async Task CreateAsync_RollsBackWithAnIndependentTokenWhenLookupIsCancelled()
	{
		using var sdk = new AndroidSdkFixture();
		using var requestCancellation = new CancellationTokenSource();
		var cleanupToken = CancellationToken.None;
		var runner = new RecordingProcessRunner((request, token) =>
		{
			var arguments = GetAvdManagerArguments(request);
			if (arguments.SequenceEqual(["list", "device", "-c"]))
				return new ProcessResult(0, "pixel_8\n", "");

			if (arguments.FirstOrDefault() == "create")
			{
				requestCancellation.Cancel();
				return new ProcessResult(0, "", "");
			}

			if (arguments.FirstOrDefault() == "delete")
			{
				cleanupToken = token;
				return new ProcessResult(0, "", "");
			}

			token.ThrowIfCancellationRequested();
			throw new InvalidOperationException($"Unexpected process request: {request.FileName}");
		});
		await using var backend = new AndroidEmulatorBackend(
			runner,
			NullLogger<AndroidEmulatorBackend>.Instance,
			new AndroidSdkLocator(sdk.Root));

		var exception = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
			backend.CreateAsync(
				new CreateDeviceRequest
				{
					Name = "cancelled lookup",
					RuntimeId = sdk.RuntimeId,
					DeviceTypeId = "pixel_8",
				},
				requestCancellation.Token));

		Assert.Equal(requestCancellation.Token, exception.CancellationToken);
		Assert.True(cleanupToken.CanBeCanceled);
		Assert.False(cleanupToken.IsCancellationRequested);
		Assert.NotEqual(requestCancellation.Token, cleanupToken);
		Assert.Equal(
			new[] { "delete", "avd", "--name", "cancelled_lookup" },
			GetAvdManagerArguments(runner.Calls[^1].Request));
	}

	private static IReadOnlyList<string> GetAvdManagerArguments(ProcessRequest request)
	{
		if (request.Environment is null)
			return request.Arguments;

		return [.. request.Environment
			.Where(pair => pair.Key.StartsWith("MOBILE_CANVAS_AVD_ARG_", StringComparison.Ordinal))
			.OrderBy(pair => int.Parse(pair.Key["MOBILE_CANVAS_AVD_ARG_".Length..]))
			.Select(pair => pair.Value!)];
	}

	private sealed class RecordingProcessRunner(
		Func<ProcessRequest, CancellationToken, ProcessResult> run) : IProcessRunner
	{
		public List<(ProcessRequest Request, CancellationToken Token)> Calls { get; } = [];

		public Task<ProcessResult> RunAsync(
			ProcessRequest request,
			CancellationToken cancellationToken = default)
		{
			Calls.Add((request, cancellationToken));
			return Task.FromResult(run(request, cancellationToken));
		}
	}

	private sealed class AndroidSdkFixture : IDisposable
	{
		public AndroidSdkFixture()
		{
			Root = Directory.CreateTempSubdirectory("mobile-canvas-sdk-").FullName;
			CreateTool("platform-tools", Executable("adb"));
			CreateTool("emulator", Executable("emulator"));
			AvdManager = CreateTool("cmdline-tools", "latest", "bin", Script("avdmanager"));
			var systemImage = Path.Combine(
				Root,
				"system-images",
				"android-35",
				"google_apis",
				"arm64-v8a");
			Directory.CreateDirectory(systemImage);
			File.WriteAllText(Path.Combine(systemImage, "source.properties"), "Pkg.Revision=1\n");
		}

		public string Root { get; }
		public string AvdManager { get; }
		public string RuntimeId => "system-images;android-35;google_apis;arm64-v8a";

		public void Dispose() => Directory.Delete(Root, recursive: true);

		private string CreateTool(params string[] segments)
		{
			var path = Path.Combine([Root, .. segments]);
			Directory.CreateDirectory(Path.GetDirectoryName(path)!);
			File.WriteAllText(path, "");
			return path;
		}

		private static string Executable(string name) => OperatingSystem.IsWindows() ? name + ".exe" : name;

		private static string Script(string name) => OperatingSystem.IsWindows() ? name + ".bat" : name;
	}
}
