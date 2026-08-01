using System.ComponentModel;
using MobileCanvas.Contracts;
using ModelContextProtocol.Server;

namespace MobileCanvas.Tool;

/// <summary>
/// Fixes what the status bar shows, and reaches the Android permissions that the runtime permission
/// prompts never cover.
/// </summary>
[McpServerToolType]
public sealed class DevicePresentationTools(DeviceHostClient client)
{
	[McpServerTool(Name = "mobile_device_presentation_get", Title = "Read status bar overrides", Destructive = false, ReadOnly = true, OpenWorld = false)]
	[Description(
		"Report whether the status bar is fixed for screenshots, and with what. On iOS the values "
		+ "themselves come back; on Android only whether it is on, because SystemUI will confirm that "
		+ "and nothing more -- readable says which you got.")]
	public Task<PresentationState> GetPresentation(
		[Description("Provider-qualified device ID.")] string deviceId,
		CancellationToken cancellationToken = default) =>
		client.GetPresentationAsync(deviceId, cancellationToken);

	[McpServerTool(Name = "mobile_device_presentation_set", Title = "Fix the status bar for screenshots", OpenWorld = false)]
	[Description(
		"Pin the clock, battery and signal so a screenshot taken now matches one taken next month -- "
		+ "otherwise every capture carries the wall clock and whatever the battery happened to be. "
		+ "Set enabled false to put the real values back. Fields left unset keep what they were "
		+ "showing, so a second call can adjust one of them. The change is confirmed against the "
		+ "device: both platforms accept these and silently ignore them under conditions this "
		+ "reports rather than hides.")]
	public Task<PresentationState> SetPresentation(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("True to fix the status bar, false to restore the device's own values.")]
		bool? enabled = null,
		[Description("Clock as 24-hour HH:mm, such as 09:41. Redrawn in the device's own format.")]
		string? time = null,
		[Description("Battery percentage, 0 to 100.")] int? batteryLevel = null,
		[Description("Whether to draw the charging bolt.")] bool? batteryCharging = null,
		[Description("Wi-Fi strength, 0 to 4.")] int? wifiBars = null,
		[Description("Cellular strength, 0 to 4.")] int? cellularBars = null,
		[Description("Carrier name beside the signal bars. Sent to both platforms, but iOS cannot "
			+ "report it back so it is absent from the returned overrides, and devices with a notch "
			+ "have no room to draw it at all.")]
		string? carrierName = null,
		[Description("Android only: hide the notification icons. iOS does not draw them here.")]
		bool? hideNotifications = null,
		CancellationToken cancellationToken = default) =>
		client.SetPresentationAsync(
			deviceId,
			new PresentationRequest
			{
				Enabled = enabled,
				Time = time,
				BatteryLevel = batteryLevel,
				BatteryCharging = batteryCharging,
				WifiBars = wifiBars,
				CellularBars = cellularBars,
				CarrierName = carrierName,
				HideNotifications = hideNotifications,
			},
			cancellationToken);

	[McpServerTool(Name = "mobile_device_app_op_list", Title = "List Android app operations", Destructive = false, ReadOnly = true, OpenWorld = false)]
	[Description(
		"Report the app operations an Android app is subject to -- the permissions that never appear "
		+ "in a runtime prompt, such as SYSTEM_ALERT_WINDOW, WRITE_SETTINGS and "
		+ "REQUEST_INSTALL_PACKAGES. uidScoped marks a mode set for the whole uid, which overrides "
		+ "the package's own. Android only; on iOS use permission_list.")]
	public Task<AppOperationListResult> ListAppOperations(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Android package name.")] string bundleId,
		CancellationToken cancellationToken = default) =>
		client.ListAppOperationsAsync(deviceId, bundleId, cancellationToken);

	[McpServerTool(Name = "mobile_device_app_op_set", Title = "Change an Android app operation", OpenWorld = false)]
	[Description(
		"Put one app operation into a mode, to reach behaviour behind a special-access screen without "
		+ "walking Settings to get there. Modes: allow, deny, ignore (refused silently), default. "
		+ "The mode is read back, because appops accepts a change for an operation the app never "
		+ "declared and drops it while reporting success. Android only.")]
	public Task<AppOperationChangeResult> SetAppOperation(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Android package name.")] string bundleId,
		[Description("Operation name, such as SYSTEM_ALERT_WINDOW.")] string operation,
		[Description("One of allow, deny, ignore, or default.")] string mode = AppOperationModes.Allow,
		CancellationToken cancellationToken = default) =>
		client.ChangeAppOperationAsync(
			deviceId,
			new AppOperationChangeRequest { BundleId = bundleId, Operation = operation, Mode = mode },
			cancellationToken);
}
