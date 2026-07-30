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
		public Task<ILiveVideoSession> OpenVideoStreamAsync(string deviceId, StreamOptions options, CancellationToken cancellationToken = default) =>
			throw new NotSupportedException();
		public Task<RecordingStatus> StartRecordingAsync(string deviceId, RecordingStartRequest request, CancellationToken cancellationToken = default) =>
			Task.FromResult(new RecordingStatus());
		public Task<RecordingStatus> StopRecordingAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(new RecordingStatus());
		public Task<RecordingStatus> GetRecordingStatusAsync(string deviceId, CancellationToken cancellationToken = default) =>
			Task.FromResult(new RecordingStatus());
	}
}
