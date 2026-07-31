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
		public Task<ILiveVideoSession> OpenVideoStreamAsync(string deviceId, StreamOptions options, CancellationToken cancellationToken = default) =>
			throw new NotSupportedException();
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
