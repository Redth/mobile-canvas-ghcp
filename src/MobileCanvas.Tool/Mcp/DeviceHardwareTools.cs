using System.ComponentModel;
using MobileCanvas.Contracts;
using ModelContextProtocol.Server;

namespace MobileCanvas.Tool;

/// <summary>
/// Simulates the hardware conditions an app has to cope with -- somewhere else in the world, a
/// nearly flat battery, a slow connection -- without needing any of them to be true.
/// </summary>
[McpServerToolType]
public sealed class DeviceHardwareTools(DeviceHostClient client)
{
	[McpServerTool(Name = "mobile_device_hardware_get", Title = "Read simulated hardware state", Destructive = false, ReadOnly = true, OpenWorld = false)]
	[Description(
		"Read the simulated battery and network state. The 'unreadable' list names what this platform "
		+ "will not report, which is the difference between a value that is absent and one that is zero.")]
	public Task<HardwareState> GetHardwareState(
		[Description("Provider-qualified device ID.")] string deviceId,
		CancellationToken cancellationToken = default) =>
		client.GetHardwareStateAsync(deviceId, cancellationToken);

	[McpServerTool(Name = "mobile_device_location_set", Title = "Set the simulated location", OpenWorld = false)]
	[Description(
		"Move the device to a latitude and longitude, to exercise location-dependent behaviour without "
		+ "going there. Neither platform can read a location back, so confirm it through the app under "
		+ "test rather than by reading the device. On Android the fix only reaches an app that is "
		+ "already listening for location: the emulator pushes the position to live listeners rather "
		+ "than storing it, and reports success either way, so set the location after the app has "
		+ "started requesting it.")]
	public Task<OperationResult> SetLocation(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Latitude, between -90 and 90.")] double latitude,
		[Description("Longitude, between -180 and 180.")] double longitude,
		CancellationToken cancellationToken = default) =>
		client.SetLocationAsync(
			deviceId,
			new DeviceLocationRequest { Latitude = latitude, Longitude = longitude },
			cancellationToken);

	[McpServerTool(Name = "mobile_device_location_clear", Title = "Clear the simulated location", OpenWorld = false)]
	[Description(
		"Return an iOS simulator to the host's real position. An Android emulator cannot do this -- it "
		+ "has no position of its own to return to -- and says so.")]
	public Task<OperationResult> ClearLocation(
		[Description("Provider-qualified device ID.")] string deviceId,
		CancellationToken cancellationToken = default) =>
		client.ClearLocationAsync(deviceId, cancellationToken);

	[McpServerTool(Name = "mobile_device_battery_set", Title = "Simulate a battery state", OpenWorld = false)]
	[Description(
		"Simulate a charge level or charging state, to reach low-power behaviour and charging-only "
		+ "code paths. On iOS this is a status bar override, so it is also how a screenshot gets a "
		+ "fixed battery indicator.")]
	public Task<HardwareState> SetBattery(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Charge percentage, 0 to 100.")] int? level = null,
		[Description("One of charging, discharging, or full.")] string? state = null,
		CancellationToken cancellationToken = default) =>
		client.SetBatteryAsync(
			deviceId,
			new BatteryRequest { Level = level, State = state },
			cancellationToken);

	[McpServerTool(Name = "mobile_device_network_set", Title = "Simulate network conditions", OpenWorld = false)]
	[Description(
		"Slow the connection down, to exercise timeouts, spinners and retry paths. Real only on an "
		+ "Android emulator: an iOS simulator shares the host's network, so this only changes what its "
		+ "status bar shows, and the result reports that as networkIsIndicatorOnly. Profiles, slowest "
		+ "first: gsm, gprs, edge, umts, hsdpa, lte, full.")]
	public Task<HardwareState> SetNetwork(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Network profile name.")] string? profile = null,
		[Description("Added round-trip latency in milliseconds; 0 removes it. Android only.")]
		int? latencyMs = null,
		CancellationToken cancellationToken = default) =>
		client.SetNetworkAsync(
			deviceId,
			new NetworkRequest { Profile = profile, LatencyMs = latencyMs },
			cancellationToken);
}
