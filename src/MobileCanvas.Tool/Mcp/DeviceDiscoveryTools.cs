using System.ComponentModel;
using MobileCanvas.Contracts;
using ModelContextProtocol.Server;

namespace MobileCanvas.Tool;

[McpServerToolType]
public sealed class DeviceDiscoveryTools(DeviceHostClient client)
{
	[McpServerTool(
		Name = "mobile_device_catalog",
		Title = "Get device catalog",
		ReadOnly = true,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description("Get installed runtimes and system images, device types, devices, capabilities, and dependency diagnostics for every supported platform.")]
	public Task<DeviceCatalog> GetCatalog(CancellationToken cancellationToken = default) =>
		client.GetCatalogAsync(cancellationToken);

	[McpServerTool(
		Name = "mobile_device_list",
		Title = "List virtual devices",
		ReadOnly = true,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description("List local mobile virtual devices across iOS simulators and Android emulators, running ones first, with exact deployment identifiers.")]
	public Task<DeviceTarget[]> ListDevices(CancellationToken cancellationToken = default) =>
		client.ListDevicesAsync(cancellationToken);

	[McpServerTool(
		Name = "mobile_device_get",
		Title = "Get virtual device",
		ReadOnly = true,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description("Get one virtual device and its native UDID, state, runtime, display, and capabilities.")]
	public Task<DeviceTarget> GetDevice(
		[Description("Provider-qualified device ID from mobile_device_list.")] string deviceId,
		CancellationToken cancellationToken = default) =>
		client.GetDeviceAsync(deviceId, cancellationToken);

	[McpServerTool(
		Name = "mobile_device_get_selected",
		Title = "Get selected canvas device",
		ReadOnly = true,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description("Get the device selected by one canvas panel, including the UDID suitable for deployment commands. Returns hasSelection=false when the canvas has not chosen a device yet.")]
	public Task<DeviceSelection> GetSelected(
		[Description("Copilot session ID that owns the canvas.")] string sessionId,
		[Description("Stable canvas instance ID.")] string instanceId,
		CancellationToken cancellationToken = default) =>
		client.GetSelectionAsync(new CanvasContextKey(sessionId, instanceId), cancellationToken);

	[McpServerTool(
		Name = "mobile_device_select",
		Title = "Select canvas device",
		Destructive = false,
		Idempotent = true,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description("Select a virtual device for one canvas panel and return its complete deployment target record.")]
	public Task<DeviceTarget> Select(
		[Description("Copilot session ID that owns the canvas.")] string sessionId,
		[Description("Stable canvas instance ID.")] string instanceId,
		[Description("Provider-qualified device ID from mobile_device_list.")] string deviceId,
		CancellationToken cancellationToken = default) =>
		client.SelectAsync(
			new CanvasContextKey(sessionId, instanceId),
			deviceId,
			cancellationToken);
}
