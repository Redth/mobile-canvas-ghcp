using System.ComponentModel;
using MobileCanvas.Contracts;
using ModelContextProtocol.Server;

namespace MobileCanvas.Tool;

[McpServerToolType]
public sealed class DeviceLifecycleTools(DeviceHostClient client)
{
	[McpServerTool(
		Name = "mobile_device_create",
		Title = "Create virtual device",
		Destructive = false,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description("Create and boot a hidden iOS simulator or Android emulator from an installed runtime/system image and device type returned by mobile_device_catalog.")]
	public Task<DeviceTarget> Create(
		[Description("Display name for the new device.")] string name,
		[Description("Runtime identifier from the device catalog.")] string runtimeId,
		[Description("Device type identifier from the device catalog.")] string deviceTypeId,
		[Description("Platform provider; currently ios.")] string platform = DevicePlatforms.Ios,
		CancellationToken cancellationToken = default) =>
		client.CreateDeviceAsync(
			new CreateDeviceRequest
			{
				Name = name,
				RuntimeId = runtimeId,
				DeviceTypeId = deviceTypeId,
				Platform = platform,
			},
			cancellationToken: cancellationToken);

	[McpServerTool(
		Name = "mobile_device_boot",
		Title = "Boot virtual device",
		Destructive = false,
		Idempotent = true,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description("Boot a device, wait until it is ready, and return its updated deployment record.")]
	public Task<DeviceTarget> Boot(
		[Description("Provider-qualified device ID.")] string deviceId,
		CancellationToken cancellationToken = default) =>
		client.BootAsync(deviceId, cancellationToken: cancellationToken);

	[McpServerTool(
		Name = "mobile_device_shutdown",
		Title = "Power off virtual device",
		Destructive = false,
		Idempotent = true,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description("Power off a device without deleting or erasing it.")]
	public Task<DeviceTarget> Shutdown(
		[Description("Provider-qualified device ID.")] string deviceId,
		CancellationToken cancellationToken = default) =>
		client.ShutdownAsync(deviceId, cancellationToken: cancellationToken);

	[McpServerTool(
		Name = "mobile_device_restart",
		Title = "Restart virtual device",
		Destructive = false,
		Idempotent = true,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description("Shut down and boot a device, waiting until it is ready.")]
	public Task<DeviceTarget> Restart(
		[Description("Provider-qualified device ID.")] string deviceId,
		CancellationToken cancellationToken = default) =>
		client.RestartAsync(deviceId, cancellationToken: cancellationToken);

	[McpServerTool(
		Name = "mobile_device_reveal",
		Title = "Reveal virtual device",
		Destructive = false,
		Idempotent = true,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description("Show a virtual device window. Reveals an iOS simulator in Simulator.app; restarts a headless Android emulator with its native window.")]
	public Task<DeviceTarget> Reveal(
		[Description("Provider-qualified device ID.")] string deviceId,
		CancellationToken cancellationToken = default) =>
		client.RevealAsync(deviceId, cancellationToken: cancellationToken);

	[McpServerTool(
		Name = "mobile_device_erase",
		Title = "Erase virtual device",
		Destructive = true,
		Idempotent = true,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description("Permanently erase all content and settings from a device. Requires confirm=true.")]
	public Task<DeviceTarget> Erase(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Must be true to authorize permanent data erasure.")] bool confirm,
		CancellationToken cancellationToken = default) =>
		client.EraseAsync(deviceId, confirm, cancellationToken: cancellationToken);

	[McpServerTool(
		Name = "mobile_device_delete",
		Title = "Delete virtual device",
		Destructive = true,
		Idempotent = false,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description("Permanently delete a device. Requires confirm=true.")]
	public async Task<OperationResult> Delete(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Must be true to authorize permanent device deletion.")] bool confirm,
		CancellationToken cancellationToken = default)
	{
		await client.DeleteAsync(deviceId, confirm, cancellationToken).ConfigureAwait(false);
		return new OperationResult { Operation = "delete", DeviceId = deviceId };
	}
}
