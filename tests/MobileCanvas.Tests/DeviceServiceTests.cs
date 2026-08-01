using System.Text.Json;
using MobileCanvas.Contracts;
using MobileCanvas.Core;

namespace MobileCanvas.Tests;

public sealed class DeviceServiceTests
{
	[Fact]
	public async Task SelectAndGetSelected_ReturnsDeployableTarget()
	{
		var backend = new FakeBackend();
		var service = new DeviceService([backend]);

		var selected = await service.SelectAsync("session", "instance", FakeBackend.Device.Id);
		var resolved = await service.GetSelectedAsync("session", "instance");

		Assert.Equal(FakeBackend.Device.Udid, selected.Udid);
		Assert.Equal(selected, resolved);
	}

	[Fact]
	public async Task GetSelection_WithoutSelection_ReportsNoSelectionInsteadOfNull()
	{
		var service = new DeviceService([new FakeBackend()]);

		var selection = await service.GetSelectionAsync("session", "never-selected");

		Assert.NotNull(selection);
		Assert.False(selection.HasSelection);
		Assert.Null(selection.Device);
		Assert.Equal(MobileCanvasProtocol.Version, selection.SchemaVersion);
	}

	[Fact]
	public async Task GetSelection_AfterSelect_CarriesDeviceAndSurvivesSerialization()
	{
		var service = new DeviceService([new FakeBackend()]);
		await service.SelectAsync("session", "instance", FakeBackend.Device.Id);

		var selection = await service.GetSelectionAsync("session", "instance");
		var json = JsonSerializer.Serialize(selection, DeviceJsonContext.Default.DeviceSelection);
		var roundTripped = JsonSerializer.Deserialize(json, DeviceJsonContext.Default.DeviceSelection);

		Assert.True(selection.HasSelection);
		Assert.Contains("\"hasSelection\":true", json, StringComparison.Ordinal);
		Assert.Equal(FakeBackend.Device.Udid, roundTripped!.Device!.Udid);
	}

	[Fact]
	public async Task GetSelection_WhenSelectedDeviceDisappears_ClearsSelection()
	{
		var backend = new FakeBackend();
		var service = new DeviceService([backend]);
		await service.SelectAsync("session", "instance", FakeBackend.Device.Id);

		backend.IsDeleted = true;
		var selection = await service.GetSelectionAsync("session", "instance");

		Assert.False(selection.HasSelection);
		Assert.Null(selection.Device);
	}

	[Theory]
	[InlineData("erase")]
	[InlineData("delete")]
	public async Task DestructiveOperations_RequireExplicitConfirmation(string operation)
	{
		var service = new DeviceService([new FakeBackend()]);

		var exception = operation == "erase"
			? await Assert.ThrowsAsync<InvalidOperationException>(
				() => service.EraseAsync(FakeBackend.Device.Id, confirm: false))
			: await Assert.ThrowsAsync<InvalidOperationException>(
				() => service.DeleteAsync(FakeBackend.Device.Id, confirm: false));

		Assert.Contains("explicit confirmation", exception.Message);
	}

	[Fact]
	public async Task ListApps_HidesSystemAppsUnlessAsked()
	{
		var service = new DeviceService([new FakeBackend()]);

		var user = await service.ListAppsAsync(FakeBackend.Device.Id, new AppQuery());
		var all = await service.ListAppsAsync(FakeBackend.Device.Id, new AppQuery { IncludeSystem = true });

		Assert.Equal(2, user.Total);
		Assert.All(user.Apps, app => Assert.Equal(AppKinds.User, app.Kind));
		Assert.Equal(3, all.Total);
	}

	[Fact]
	public async Task ListApps_MatchesNameAndBundleIdCaseInsensitively()
	{
		var service = new DeviceService([new FakeBackend()]);

		var byName = await service.ListAppsAsync(FakeBackend.Device.Id, new AppQuery { Text = "notes" });
		var byBundle = await service.ListAppsAsync(FakeBackend.Device.Id, new AppQuery { Text = "example.timer" });

		Assert.Equal("com.example.notes", Assert.Single(byName.Apps).BundleId);
		Assert.Equal("com.example.timer", Assert.Single(byBundle.Apps).BundleId);
	}

	[Fact]
	public async Task ListApps_ReportsTotalBeyondTheLimit()
	{
		var service = new DeviceService([new FakeBackend()]);

		var result = await service.ListAppsAsync(
			FakeBackend.Device.Id,
			new AppQuery { IncludeSystem = true, Limit = 1 });

		// A caller that sees one result needs to know two more were hidden, or it will believe the
		// filter was more precise than it was.
		Assert.Single(result.Apps);
		Assert.Equal(3, result.Total);
	}

	[Fact]
	public async Task Uninstall_RequiresConfirmation()
	{
		var backend = new FakeBackend();
		var service = new DeviceService([backend]);

		var exception = await Assert.ThrowsAsync<InvalidOperationException>(
			() => service.UninstallAppAsync(FakeBackend.Device.Id, "com.example.notes", confirm: false));

		Assert.Contains("explicit confirmation", exception.Message);
		Assert.Null(backend.LastUninstalledBundleId);
	}

	[Fact]
	public async Task Launch_RejectsAnEmptyBundleId()
	{
		var service = new DeviceService([new FakeBackend()]);

		await Assert.ThrowsAsync<ArgumentException>(
			() => service.LaunchAppAsync(FakeBackend.Device.Id, new AppLaunchRequest { BundleId = "  " }));
	}

	[Fact]
	public async Task Install_RejectsAPathThatDoesNotExist()
	{
		var service = new DeviceService([new FakeBackend()]);
		var missing = Path.Combine(Path.GetTempPath(), $"mobile-canvas-missing-{Guid.NewGuid():N}.apk");

		// Caught here so the error names the path the caller passed, rather than surfacing whatever the
		// platform installer says about a file it never found.
		var exception = await Assert.ThrowsAsync<FileNotFoundException>(
			() => service.InstallAppAsync(FakeBackend.Device.Id, new AppInstallRequest { Path = missing }));

		Assert.Contains(missing, exception.Message);
	}

	[Fact]
	public async Task Install_PassesAnAbsolutePathToTheBackend()
	{
		var backend = new FakeBackend();
		var service = new DeviceService([backend]);
		var file = Path.Combine(Path.GetTempPath(), $"mobile-canvas-{Guid.NewGuid():N}.apk");
		await File.WriteAllTextAsync(file, "not really an apk");

		try
		{
			// A relative path is resolved against the host's working directory, which is not the
			// directory the caller was in by the time it reaches a platform tool.
			var relative = Path.GetRelativePath(Directory.GetCurrentDirectory(), file);
			await service.InstallAppAsync(FakeBackend.Device.Id, new AppInstallRequest { Path = relative });

			Assert.Equal(file, backend.LastInstalledPath);
		}
		finally
		{
			File.Delete(file);
		}
	}

	[Fact]
	public async Task ReadLog_RejectsALevelThatIsNotOne()
	{
		var service = new DeviceService([new FakeBackend()]);

		// A misspelled level would otherwise filter nothing and read as "no matching lines", which
		// looks exactly like a healthy app.
		var exception = await Assert.ThrowsAsync<ArgumentException>(
			() => service.ReadLogAsync(FakeBackend.Device.Id, new LogQuery { MinimumLevel = "warn" }));

		Assert.Contains("warning", exception.Message);
	}

	[Fact]
	public async Task ReadLog_PassesTheQueryToTheBackend()
	{
		var backend = new FakeBackend();
		var service = new DeviceService([backend]);

		// Level and time window filter on the device, so they have to survive the trip down.
		await service.ReadLogAsync(
			FakeBackend.Device.Id,
			new LogQuery { MinimumLevel = LogLevels.Error, Since = TimeSpan.FromMinutes(2) });

		Assert.Equal(LogLevels.Error, backend.LastLogQuery?.MinimumLevel);
		Assert.Equal(TimeSpan.FromMinutes(2), backend.LastLogQuery?.Since);
	}

	[Fact]
	public async Task ReadLog_FiltersOnMessageText()
	{
		var service = new DeviceService([new FakeBackend()]);

		var result = await service.ReadLogAsync(FakeBackend.Device.Id, new LogQuery { Text = "DATABASE" });

		Assert.Equal("database failed", Assert.Single(result.Entries).Message);
	}

	[Fact]
	public async Task ReadLog_KeepsTheNewestEntriesWhenOverTheLimit()
	{
		var service = new DeviceService([new FakeBackend()]);

		var result = await service.ReadLogAsync(FakeBackend.Device.Id, new LogQuery { Limit = 2 });

		// A log is trimmed from the front: the last thing that happened is the reason to read one.
		Assert.Equal(["2", "3"], result.Entries.Select(entry => entry.Timestamp));
		Assert.Equal(3, result.Total);
	}

	[Fact]
	public async Task ListCrashes_FiltersOnNameAndBundleId()
	{
		var service = new DeviceService([new FakeBackend()]);

		Assert.Equal("c1", Assert.Single((await service.ListCrashesAsync(
			FakeBackend.Device.Id, new CrashQuery { Text = "notes" })).Crashes).Id);
		Assert.Equal("c2", Assert.Single((await service.ListCrashesAsync(
			FakeBackend.Device.Id, new CrashQuery { Text = "Timer" })).Crashes).Id);
	}

	[Fact]
	public async Task ListCrashes_ReportsTotalBeyondTheLimit()
	{
		var service = new DeviceService([new FakeBackend()]);

		var result = await service.ListCrashesAsync(FakeBackend.Device.Id, new CrashQuery { Limit = 1 });

		Assert.Single(result.Crashes);
		Assert.Equal(2, result.Total);
	}

	[Fact]
	public async Task GetCrash_RejectsAnEmptyId()
	{
		var service = new DeviceService([new FakeBackend()]);

		await Assert.ThrowsAsync<ArgumentException>(
			() => service.GetCrashAsync(FakeBackend.Device.Id, "  "));
	}

	[Fact]
	public async Task GetCrash_TrimsTheIdBeforePassingItDown()
	{
		var backend = new FakeBackend();
		var service = new DeviceService([backend]);

		// The ID names a file on iOS, and a padded one would not resolve.
		await service.GetCrashAsync(FakeBackend.Device.Id, " c1 ");

		Assert.Equal("c1", backend.LastCrashId);
	}

	[Theory]
	[InlineData("", "/tmp/out.bin")]
	[InlineData("  ", "/tmp/out.bin")]
	[InlineData("databases/notes.db", "")]
	[InlineData("databases/notes.db", "  ")]
	public async Task PullFile_RequiresBothPaths(string devicePath, string hostPath)
	{
		var service = new DeviceService([new FakeBackend()]);

		await Assert.ThrowsAsync<ArgumentException>(() => service.PullFileAsync(
			FakeBackend.Device.Id,
			new FileTransferRequest { DevicePath = devicePath, HostPath = hostPath }));
	}

	[Fact]
	public async Task PullFile_ResolvesTheHostPathBeforePassingItDown()
	{
		var backend = new FakeBackend();
		var service = new DeviceService([backend]);

		// A platform tool runs in its own working directory, so a relative path would land elsewhere --
		// and the path in the result has to be one the caller can hand to another tool.
		await service.PullFileAsync(
			FakeBackend.Device.Id,
			new FileTransferRequest { DevicePath = "databases/notes.db", HostPath = "notes.db" });

		Assert.Equal(Path.GetFullPath("notes.db"), backend.LastPull?.HostPath);
	}

	[Fact]
	public async Task PushFile_FailsWhenTheSourceDoesNotExist()
	{
		var service = new DeviceService([new FakeBackend()]);

		// adb push reports a missing source on stdout and still exits zero, so catching it here is what
		// keeps a typo from looking like a successful push.
		await Assert.ThrowsAsync<FileNotFoundException>(() => service.PushFileAsync(
			FakeBackend.Device.Id,
			new FileTransferRequest
			{
				DevicePath = "files/seed.db",
				HostPath = Path.Combine(Path.GetTempPath(), $"missing-{Guid.NewGuid():N}.db"),
			}));
	}

	[Fact]
	public async Task PushFile_ResolvesAnExistingSource()
	{
		var backend = new FakeBackend();
		var service = new DeviceService([backend]);
		var source = Path.Combine(Path.GetTempPath(), $"seed-{Guid.NewGuid():N}.db");
		await File.WriteAllTextAsync(source, "seed");

		try
		{
			await service.PushFileAsync(
				FakeBackend.Device.Id,
				new FileTransferRequest { DevicePath = "files/seed.db", HostPath = source });

			Assert.Equal(Path.GetFullPath(source), backend.LastPush?.HostPath);
		}
		finally
		{
			File.Delete(source);
		}
	}

	[Fact]
	public async Task DeleteFile_RequiresAPath()
	{
		var service = new DeviceService([new FakeBackend()]);

		await Assert.ThrowsAsync<ArgumentException>(() => service.DeleteFileAsync(
			FakeBackend.Device.Id,
			new FileMutationRequest { Path = "  " }));
	}

	[Fact]
	public async Task DeleteFile_CarriesRecursiveThrough()
	{
		var backend = new FakeBackend();
		var service = new DeviceService([backend]);

		await service.DeleteFileAsync(
			FakeBackend.Device.Id,
			new FileMutationRequest { Path = "files/cache", Recursive = true });

		Assert.True(backend.LastMutation?.Recursive);
		Assert.Equal("files/cache", backend.LastMutation?.Path);
	}

	[Fact]
	public async Task CreateDirectory_RequiresAPath()
	{
		var service = new DeviceService([new FakeBackend()]);

		await Assert.ThrowsAsync<ArgumentException>(() => service.CreateDirectoryAsync(
			FakeBackend.Device.Id,
			new FileMutationRequest { Path = "" }));
	}

	[Fact]
	public async Task ListFiles_PassesTheQueryThroughUntouched()
	{
		var backend = new FakeBackend();
		var service = new DeviceService([backend]);

		// The path is device-side, so the host must not resolve it -- "files" on the device is not
		// "files" here, and iOS reads a simulator's storage through this same host filesystem.
		await service.ListFilesAsync(
			FakeBackend.Device.Id,
			new FileQuery { BundleId = "com.example.notes", Path = "databases" });

		Assert.Equal("databases", backend.LastFileQuery?.Path);
		Assert.Equal("com.example.notes", backend.LastFileQuery?.BundleId);
	}

	[Theory]
	[InlineData("")]
	[InlineData("  ")]
	[InlineData("allow")]
	public async Task ChangePermission_RejectsAnActionThatIsNotOneOfTheThree(string action)
	{
		var service = new DeviceService([new FakeBackend()]);

		var error = await Assert.ThrowsAsync<ArgumentException>(() => service.ChangePermissionAsync(
			FakeBackend.Device.Id,
			new PermissionChangeRequest { BundleId = "com.example.notes", Permission = "camera", Action = action }));

		// The message has to name the alternatives: a caller who guessed "allow" has no other way to
		// learn the vocabulary, and the platform tools accept a wrong verb without complaint.
		Assert.Contains(PermissionActions.Grant, error.Message, StringComparison.Ordinal);
		Assert.Contains(PermissionActions.Revoke, error.Message, StringComparison.Ordinal);
		Assert.Contains(PermissionActions.Reset, error.Message, StringComparison.Ordinal);
	}

	[Theory]
	[InlineData("")]
	[InlineData("   ")]
	public async Task ChangePermission_RequiresABundleAndAPermission(string blank)
	{
		var service = new DeviceService([new FakeBackend()]);

		await Assert.ThrowsAsync<ArgumentException>(() => service.ChangePermissionAsync(
			FakeBackend.Device.Id,
			new PermissionChangeRequest { BundleId = blank, Permission = "camera" }));

		await Assert.ThrowsAsync<ArgumentException>(() => service.ChangePermissionAsync(
			FakeBackend.Device.Id,
			new PermissionChangeRequest { BundleId = "com.example.notes", Permission = blank }));
	}

	[Fact]
	public async Task ChangePermission_NamesTheKnownPermissionsWhenNoneIsGiven()
	{
		var service = new DeviceService([new FakeBackend()]);

		var error = await Assert.ThrowsAsync<ArgumentException>(() => service.ChangePermissionAsync(
			FakeBackend.Device.Id,
			new PermissionChangeRequest { BundleId = "com.example.notes", Permission = "" }));

		Assert.Contains(DevicePermissions.Camera, error.Message, StringComparison.Ordinal);
	}

	[Fact]
	public async Task ChangePermission_NormalisesTheActionBeforePassingItDown()
	{
		var backend = new FakeBackend();
		var service = new DeviceService([backend]);

		// A caller typing " Grant " means grant, and the backend switches on an exact string.
		await service.ChangePermissionAsync(
			FakeBackend.Device.Id,
			new PermissionChangeRequest
			{
				BundleId = "com.example.notes",
				Permission = " camera ",
				Action = " Grant ",
			});

		Assert.Equal(PermissionActions.Grant, backend.LastPermissionChange?.Action);
		Assert.Equal("camera", backend.LastPermissionChange?.Permission);
	}

	[Fact]
	public async Task ChangePermission_LetsAPlatformSpecificNameThrough()
	{
		var backend = new FakeBackend();
		var service = new DeviceService([backend]);

		// The canonical list cannot cover every permission either platform has, so a name it does not
		// know still reaches the backend -- which is the only layer that can say whether it is real.
		await service.ChangePermissionAsync(
			FakeBackend.Device.Id,
			new PermissionChangeRequest
			{
				BundleId = "com.example.notes",
				Permission = "android.permission.BODY_SENSORS",
			});

		Assert.Equal("android.permission.BODY_SENSORS", backend.LastPermissionChange?.Permission);
	}

	[Fact]
	public async Task UpdateSettings_RejectsAnAppearanceThatIsNeitherLightNorDark()
	{
		var service = new DeviceService([new FakeBackend()]);

		var error = await Assert.ThrowsAsync<ArgumentException>(() => service.UpdateSettingsAsync(
			FakeBackend.Device.Id,
			new DeviceSettingsRequest { Appearance = "auto" }));

		// 'auto' is a real value on Android, but it names a rule rather than an appearance, so a
		// caller who set it would not know what they were actually looking at.
		Assert.Contains(DeviceAppearances.Dark, error.Message, StringComparison.Ordinal);
	}

	[Theory]
	[InlineData(0)]
	[InlineData(-1)]
	[InlineData(11)]
	public async Task UpdateSettings_RejectsAFontScaleThatWouldMakeTheDeviceUnusable(double scale)
	{
		var service = new DeviceService([new FakeBackend()]);

		// `settings put system font_scale 0` is accepted by Android and renders text invisibly small,
		// leaving a device nothing can be read on and no obvious way back.
		await Assert.ThrowsAsync<ArgumentException>(() => service.UpdateSettingsAsync(
			FakeBackend.Device.Id,
			new DeviceSettingsRequest { FontScale = scale }));
	}

	[Fact]
	public async Task UpdateSettings_RejectsARequestThatChangesNothing()
	{
		var service = new DeviceService([new FakeBackend()]);

		// Every field unset would run the platform tool with no arguments, which on iOS reads back the
		// current value and reports it as a change that was made.
		await Assert.ThrowsAsync<ArgumentException>(() => service.UpdateSettingsAsync(
			FakeBackend.Device.Id,
			new DeviceSettingsRequest()));
	}

	[Theory]
	[InlineData(91, 0)]
	[InlineData(-91, 0)]
	[InlineData(0, 181)]
	[InlineData(0, -181)]
	[InlineData(double.NaN, 0)]
	public async Task SetLocation_RejectsACoordinateThatIsNotOnEarth(double latitude, double longitude)
	{
		var service = new DeviceService([new FakeBackend()]);

		// simctl takes coordinates that are not even numbers without complaint and exits zero, so a
		// typo would otherwise look like a fix that was applied.
		await Assert.ThrowsAsync<ArgumentException>(() => service.SetLocationAsync(
			FakeBackend.Device.Id,
			new DeviceLocationRequest { Latitude = latitude, Longitude = longitude }));
	}

	[Fact]
	public async Task SetLocation_AcceptsTheEdgesOfTheRange()
	{
		var backend = new FakeBackend();
		var service = new DeviceService([backend]);

		await service.SetLocationAsync(
			FakeBackend.Device.Id,
			new DeviceLocationRequest { Latitude = -90, Longitude = 180 });

		Assert.Equal(-90, backend.LastLocation?.Latitude);
		Assert.Equal(180, backend.LastLocation?.Longitude);
	}

	[Theory]
	[InlineData(-1)]
	[InlineData(101)]
	public async Task SetBattery_RejectsALevelThatIsNotAPercentage(int level)
	{
		var service = new DeviceService([new FakeBackend()]);

		await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => service.SetBatteryAsync(
			FakeBackend.Device.Id,
			new BatteryRequest { Level = level }));
	}

	[Fact]
	public async Task SetBattery_RejectsAStateNeitherPlatformHas()
	{
		var service = new DeviceService([new FakeBackend()]);

		var error = await Assert.ThrowsAsync<ArgumentException>(() => service.SetBatteryAsync(
			FakeBackend.Device.Id,
			new BatteryRequest { State = "charged" }));

		// 'charged' is simctl's own word, and the shared vocabulary uses Android's. The message has to
		// name the alternatives, because the platform tool would accept one of them and not the other.
		Assert.Contains(BatteryStates.Full, error.Message, StringComparison.Ordinal);
	}

	[Fact]
	public async Task SetBattery_RejectsARequestThatChangesNothing()
	{
		var service = new DeviceService([new FakeBackend()]);

		// `status_bar override` with no flags is an error simctl reports on stderr while exiting zero.
		await Assert.ThrowsAsync<ArgumentException>(() => service.SetBatteryAsync(
			FakeBackend.Device.Id,
			new BatteryRequest()));
	}

	[Fact]
	public async Task SetNetwork_RejectsANegativeLatency()
	{
		var service = new DeviceService([new FakeBackend()]);

		await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => service.SetNetworkAsync(
			FakeBackend.Device.Id,
			new NetworkRequest { LatencyMs = -1 }));
	}

	[Fact]
	public async Task SetNetwork_TreatsZeroLatencyAsARealChange()
	{
		var backend = new FakeBackend();
		var service = new DeviceService([backend]);

		// Zero is how a delay is removed, so it cannot be read as "nothing to do".
		await service.SetNetworkAsync(FakeBackend.Device.Id, new NetworkRequest { LatencyMs = 0 });

		Assert.Equal(0, backend.LastNetwork?.LatencyMs);
	}

	private sealed class FakeBackend : IDeviceBackend
	{
		public static DeviceTarget Device { get; } = new()
		{
			Id = "ios:core-simulator:ABCD",
			Platform = DevicePlatforms.Ios,
			Provider = "core-simulator",
			NativeId = "ABCD",
			Udid = "ABCD",
			Name = "Test iPhone",
			State = DeviceStates.Booted,
			IsAvailable = true,
		};

		public string Platform => DevicePlatforms.Ios;
		public bool IsDeleted { get; set; }
		public Task<DeviceCatalog> GetCatalogAsync(CancellationToken cancellationToken = default) =>
			Task.FromResult(new DeviceCatalog { Devices = [Device] });
		public Task<DeviceTarget[]> ListDevicesAsync(CancellationToken cancellationToken = default) =>
			Task.FromResult(new[] { Device });
		public Task<DeviceTarget> GetDeviceAsync(string deviceId, CancellationToken cancellationToken = default) =>
			deviceId == Device.Id && !IsDeleted
				? Task.FromResult(Device)
				: throw new DeviceNotFoundException(deviceId);
		public Task<DisplayGeometry> GetDisplayAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(new DisplayGeometry());
		public Task<DeviceTarget> CreateAsync(CreateDeviceRequest request, CancellationToken cancellationToken = default) =>
			Task.FromResult(Device);
		public Task<DeviceTarget> BootAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(Device);
		public Task<DeviceTarget> ShutdownAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(Device);
		public Task<DeviceTarget> RestartAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(Device);
		public Task<DeviceTarget> EraseAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(Device);
		public Task DeleteAsync(string deviceId, CancellationToken cancellationToken = default) => Task.CompletedTask;
		public Task<DeviceTarget> RevealAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(Device);
		public Task TapAsync(string deviceId, TapRequest request, CancellationToken cancellationToken = default) =>
			Task.CompletedTask;
		public Task TouchAsync(string deviceId, TouchRequest request, CancellationToken cancellationToken = default) =>
			Task.CompletedTask;
		public Task SwipeAsync(string deviceId, SwipeRequest request, CancellationToken cancellationToken = default) =>
			Task.CompletedTask;
		public Task TypeTextAsync(string deviceId, string text, CancellationToken cancellationToken = default) =>
			Task.CompletedTask;
		public Task PressKeyAsync(string deviceId, ulong keyCode, CancellationToken cancellationToken = default) =>
			Task.CompletedTask;
		public Task PressButtonAsync(string deviceId, string button, CancellationToken cancellationToken = default) =>
			Task.CompletedTask;
		public Task RotateAsync(string deviceId, string orientation, CancellationToken cancellationToken = default) =>
			Task.CompletedTask;
		public Task<byte[]> ScreenshotAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(Array.Empty<byte>());

		public InstalledApp[] Apps { get; set; } =
		[
			new() { BundleId = "com.example.notes", Name = "Notes", Kind = AppKinds.User },
			new() { BundleId = "com.example.timer", Name = "Timer", Kind = AppKinds.User },
			new() { BundleId = "com.apple.Preferences", Name = "Settings", Kind = AppKinds.System },
		];

		public string? LastLaunchedBundleId { get; private set; }
		public string? LastUninstalledBundleId { get; private set; }
		public string? LastInstalledPath { get; private set; }

		public Task<InstalledApp[]> ListAppsAsync(string deviceId, bool includeSystem, CancellationToken cancellationToken = default) =>
			Task.FromResult(includeSystem ? Apps : [.. Apps.Where(app => app.Kind == AppKinds.User)]);
		public Task<AppOperationResult> LaunchAppAsync(string deviceId, AppLaunchRequest request, CancellationToken cancellationToken = default)
		{
			LastLaunchedBundleId = request.BundleId;
			return Task.FromResult(new AppOperationResult
			{
				DeviceId = deviceId,
				BundleId = request.BundleId,
				Operation = AppOperations.Launch,
				ProcessId = 4242,
			});
		}
		public Task<AppOperationResult> TerminateAppAsync(string deviceId, string bundleId, CancellationToken cancellationToken = default) =>
			Task.FromResult(new AppOperationResult { DeviceId = deviceId, BundleId = bundleId, Operation = AppOperations.Terminate });
		public Task<AppOperationResult> InstallAppAsync(string deviceId, AppInstallRequest request, CancellationToken cancellationToken = default)
		{
			LastInstalledPath = request.Path;
			return Task.FromResult(new AppOperationResult { DeviceId = deviceId, Operation = AppOperations.Install, Detail = request.Path });
		}
		public Task<AppOperationResult> UninstallAppAsync(string deviceId, string bundleId, CancellationToken cancellationToken = default)
		{
			LastUninstalledBundleId = bundleId;
			return Task.FromResult(new AppOperationResult { DeviceId = deviceId, BundleId = bundleId, Operation = AppOperations.Uninstall });
		}
		public LogEntry[] LogEntries { get; set; } =
		[
			new() { Timestamp = "1", Level = LogLevels.Debug, Source = "App", Message = "starting up" },
			new() { Timestamp = "2", Level = LogLevels.Info, Source = "App", Message = "ready" },
			new() { Timestamp = "3", Level = LogLevels.Error, Source = "App", Message = "database failed" },
		];

		public CrashReport[] Crashes { get; set; } =
		[
			new() { Id = "c1", Name = "Notes", BundleId = "com.example.notes", Timestamp = "1", Kind = "crash" },
			new() { Id = "c2", Name = "Timer", BundleId = "com.example.timer", Timestamp = "2", Kind = "anr" },
		];

		public LogQuery? LastLogQuery { get; private set; }
		public string? LastCrashId { get; private set; }

		public Task<LogEntry[]> ReadLogAsync(string deviceId, LogQuery query, CancellationToken cancellationToken = default)
		{
			LastLogQuery = query;
			return Task.FromResult(LogEntries);
		}
		public Task<CrashReport[]> ListCrashesAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(Crashes);
		public Task<CrashDetailResult> GetCrashAsync(string deviceId, string crashId, CancellationToken cancellationToken = default)
		{
			LastCrashId = crashId;
			return Task.FromResult(new CrashDetailResult
			{
				DeviceId = deviceId,
				Report = Crashes.First(crash => crash.Id == crashId),
				Content = "stack trace",
			});
		}

		public PermissionChangeRequest? LastPermissionChange { get; private set; }
		public DeviceSettingsRequest? LastSettingsChange { get; private set; }

		public Task<PermissionListResult> ListPermissionsAsync(string deviceId, string bundleId, CancellationToken cancellationToken = default) =>
			Task.FromResult(new PermissionListResult
			{
				DeviceId = deviceId,
				BundleId = bundleId,
				Permissions = [new() { Name = "camera", PlatformName = "camera", Granted = true }],
				Total = 1,
			});
		public Task<PermissionChangeResult> ChangePermissionAsync(string deviceId, PermissionChangeRequest request, CancellationToken cancellationToken = default)
		{
			LastPermissionChange = request;
			return Task.FromResult(new PermissionChangeResult
			{
				DeviceId = deviceId,
				BundleId = request.BundleId,
				Permission = request.Permission,
				Action = request.Action,
			});
		}
		public Task<AppOperationListResult> ListAppOperationsAsync(string deviceId, string bundleId, CancellationToken cancellationToken = default) =>
			Task.FromResult(new AppOperationListResult { DeviceId = deviceId, BundleId = bundleId });
		public Task<AppOperationChangeResult> ChangeAppOperationAsync(string deviceId, AppOperationChangeRequest request, CancellationToken cancellationToken = default)
		{
			LastAppOperation = request;
			return Task.FromResult(new AppOperationChangeResult
			{
				DeviceId = deviceId,
				BundleId = request.BundleId,
				Operation = request.Operation,
				Mode = request.Mode,
			});
		}
		public Task<PresentationState> GetPresentationAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(new PresentationState { DeviceId = deviceId });
		public Task<PresentationState> SetPresentationAsync(string deviceId, PresentationRequest request, CancellationToken cancellationToken = default)
		{
			LastPresentation = request;
			return Task.FromResult(new PresentationState { DeviceId = deviceId, Enabled = request.Enabled ?? true });
		}
		public Task<DeviceSettings> GetSettingsAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(new DeviceSettings { DeviceId = deviceId, Appearance = DeviceAppearances.Light });		public Task<DeviceSettings> UpdateSettingsAsync(string deviceId, DeviceSettingsRequest request, CancellationToken cancellationToken = default)
		{
			LastSettingsChange = request;
			return Task.FromResult(new DeviceSettings { DeviceId = deviceId, Appearance = request.Appearance });
		}

		public DeviceLocationRequest? LastLocation { get; private set; }
		public BatteryRequest? LastBattery { get; private set; }
		public NetworkRequest? LastNetwork { get; private set; }
		public bool LocationCleared { get; private set; }

		public Task<HardwareState> GetHardwareStateAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(new HardwareState { DeviceId = deviceId, Platform = DevicePlatforms.Ios });
		public Task SetLocationAsync(string deviceId, DeviceLocationRequest request, CancellationToken cancellationToken = default)
		{
			LastLocation = request;
			return Task.CompletedTask;
		}
		public Task ClearLocationAsync(string deviceId, CancellationToken cancellationToken = default)
		{
			LocationCleared = true;
			return Task.CompletedTask;
		}
		public Task<HardwareState> SetBatteryAsync(string deviceId, BatteryRequest request, CancellationToken cancellationToken = default)
		{
			LastBattery = request;
			return Task.FromResult(new HardwareState
			{
				DeviceId = deviceId,
				Platform = DevicePlatforms.Ios,
				BatteryLevel = request.Level,
				BatteryState = request.State,
			});
		}
		public Task<HardwareState> SetNetworkAsync(string deviceId, NetworkRequest request, CancellationToken cancellationToken = default)
		{
			LastNetwork = request;
			return Task.FromResult(new HardwareState
			{
				DeviceId = deviceId,
				Platform = DevicePlatforms.Ios,
				LatencyMs = request.LatencyMs,
			});
		}

		public PushNotificationRequest? LastPushNotification { get; private set; }
		public SmsRequest? LastSms { get; private set; }
		public CallRequest? LastCall { get; private set; }
		public BiometricRequest? LastBiometric { get; private set; }
		public string? LastClipboard { get; private set; }
		public MediaRequest? LastMedia { get; private set; }

		public Task SendPushNotificationAsync(string deviceId, PushNotificationRequest request, CancellationToken cancellationToken = default)
		{
			LastPushNotification = request;
			return Task.CompletedTask;
		}

		public Task SendSmsAsync(string deviceId, SmsRequest request, CancellationToken cancellationToken = default)
		{
			LastSms = request;
			return Task.CompletedTask;
		}

		public Task<CallStateResult> GetCallsAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(new CallStateResult { DeviceId = deviceId, Platform = DevicePlatforms.Android });

		public Task<CallStateResult> ChangeCallAsync(string deviceId, CallRequest request, CancellationToken cancellationToken = default)
		{
			LastCall = request;
			return Task.FromResult(new CallStateResult { DeviceId = deviceId, Platform = DevicePlatforms.Android });
		}

		public Task<BiometricResult> SendBiometricAsync(string deviceId, BiometricRequest request, CancellationToken cancellationToken = default)
		{
			LastBiometric = request;
			return Task.FromResult(new BiometricResult
			{
				DeviceId = deviceId,
				Platform = DevicePlatforms.Ios,
				Action = request.Action,
			});
		}

		public Task<ClipboardResult> GetClipboardAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(new ClipboardResult
			{
				DeviceId = deviceId,
				Platform = DevicePlatforms.Ios,
				Text = LastClipboard ?? "",
			});

		public Task<ClipboardResult> SetClipboardAsync(string deviceId, string text, CancellationToken cancellationToken = default)
		{
			LastClipboard = text;
			return GetClipboardAsync(deviceId, cancellationToken);
		}

		public Task<MediaResult> AddMediaAsync(string deviceId, MediaRequest request, CancellationToken cancellationToken = default)
		{
			LastMedia = request;
			return Task.FromResult(new MediaResult
			{
				DeviceId = deviceId,
				Platform = DevicePlatforms.Ios,
				Added = request.HostPaths,
			});
		}

		public Task<ILiveVideoSession> OpenVideoStreamAsync(string deviceId, StreamOptions options, CancellationToken cancellationToken = default) =>
			throw new NotSupportedException();

		public FileQuery? LastFileQuery { get; private set; }
		public FileTransferRequest? LastPull { get; private set; }
		public FileTransferRequest? LastPush { get; private set; }

		public Task<FileListResult> ListFilesAsync(string deviceId, FileQuery query, CancellationToken cancellationToken = default)
		{
			LastFileQuery = query;
			return Task.FromResult(new FileListResult
			{
				DeviceId = deviceId,
				Path = query.Path,
				Files =
				[
					new() { Name = "notes.db", Path = "databases/notes.db", Size = 4096, Modified = "2026-07-31 14:21" },
				],
				Total = 1,
			});
		}
		public Task<FileTransferResult> PullFileAsync(string deviceId, FileTransferRequest request, CancellationToken cancellationToken = default)
		{
			LastPull = request;
			return Task.FromResult(new FileTransferResult
			{
				DeviceId = deviceId,
				Operation = FileOperations.Pull,
				DevicePath = request.DevicePath,
				HostPath = request.HostPath,
			});
		}
		public Task<FileTransferResult> PushFileAsync(string deviceId, FileTransferRequest request, CancellationToken cancellationToken = default)
		{
			LastPush = request;
			return Task.FromResult(new FileTransferResult
			{
				DeviceId = deviceId,
				Operation = FileOperations.Push,
				DevicePath = request.DevicePath,
				HostPath = request.HostPath,
			});
		}

		public FileMutationRequest? LastMutation { get; private set; }

		public AppOperationChangeRequest? LastAppOperation { get; private set; }

		public PresentationRequest? LastPresentation { get; private set; }

		public Task<FileMutationResult> DeleteFileAsync(string deviceId, FileMutationRequest request, CancellationToken cancellationToken = default)
		{
			LastMutation = request;
			return Task.FromResult(new FileMutationResult
			{
				DeviceId = deviceId,
				Operation = FileOperations.Delete,
				Path = request.Path,
			});
		}

		public Task<FileMutationResult> CreateDirectoryAsync(string deviceId, FileMutationRequest request, CancellationToken cancellationToken = default)
		{
			LastMutation = request;
			return Task.FromResult(new FileMutationResult
			{
				DeviceId = deviceId,
				Operation = FileOperations.MakeDirectory,
				Path = request.Path,
			});
		}

		public Task<RecordingStatus> StartRecordingAsync(string deviceId, RecordingStartRequest request, CancellationToken cancellationToken = default) =>
			Task.FromResult(new RecordingStatus());
		public Task<RecordingStatus> StopRecordingAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(new RecordingStatus());
		public Task<RecordingStatus> GetRecordingStatusAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(new RecordingStatus());
		public Task<UiSnapshot> GetUiSnapshotAsync(string deviceId, bool includeRaw, CancellationToken cancellationToken = default) =>
			Task.FromResult(new UiSnapshot { DeviceId = deviceId });
	}
}
