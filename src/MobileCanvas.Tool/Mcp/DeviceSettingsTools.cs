using System.ComponentModel;
using MobileCanvas.Contracts;
using ModelContextProtocol.Server;

namespace MobileCanvas.Tool;

/// <summary>
/// Puts a device into the state a test needs -- permissions already answered, dark mode on, text
/// scaled up -- without driving the Settings app to get there.
/// </summary>
[McpServerToolType]
public sealed class DeviceSettingsTools(DeviceHostClient client)
{
	[McpServerTool(Name = "mobile_device_permission_list", Title = "List app permissions", Destructive = false, ReadOnly = true, OpenWorld = false)]
	[Description(
		"Report the permissions an app holds. Granted is null when the platform will not say -- on "
		+ "iOS an app that has never been asked has no record, which is not the same as denied.")]
	public Task<PermissionListResult> ListPermissions(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Bundle ID or Android package name of the app.")] string bundleId,
		CancellationToken cancellationToken = default) =>
		client.ListPermissionsAsync(deviceId, bundleId, cancellationToken);

	[McpServerTool(Name = "mobile_device_permission_set", Title = "Grant or revoke a permission", OpenWorld = false)]
	[Description(
		"Grant, revoke, or reset one permission, so a permission-dependent screen can be reached "
		+ "without answering a system prompt by hand. Reset makes the app ask again next time. Names "
		+ "that work on both platforms: camera, microphone, location, location-always, contacts, "
		+ "calendar, reminders, photos, photos-add, media-library, motion, notifications. A platform's "
		+ "own name also works. The result reports what actually changed, read back from the device.")]
	public Task<PermissionChangeResult> SetPermission(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Bundle ID or Android package name of the app.")] string bundleId,
		[Description("Permission name, canonical or platform-specific.")] string permission,
		[Description("One of grant, revoke, or reset.")] string action = PermissionActions.Grant,
		CancellationToken cancellationToken = default) =>
		client.ChangePermissionAsync(
			deviceId,
			new PermissionChangeRequest { BundleId = bundleId, Permission = permission, Action = action },
			cancellationToken);

	[McpServerTool(Name = "mobile_device_settings_get", Title = "Read device settings", Destructive = false, ReadOnly = true, OpenWorld = false)]
	[Description("Read the device's appearance and accessibility text settings.")]
	public Task<DeviceSettings> GetSettings(
		[Description("Provider-qualified device ID.")] string deviceId,
		CancellationToken cancellationToken = default) =>
		client.GetSettingsAsync(deviceId, cancellationToken);

	[McpServerTool(Name = "mobile_device_settings_set", Title = "Change device settings", OpenWorld = false)]
	[Description(
		"Switch dark mode or scale up text, to check a layout under conditions a user will hit. "
		+ "Settings left unset are left alone. Text size differs by platform: iOS takes a named "
		+ "contentSize such as 'large' or 'accessibility-extra-large', Android takes a numeric "
		+ "fontScale such as 1.3.")]
	public Task<DeviceSettings> SetSettings(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("'light' or 'dark'.")] string? appearance = null,
		[Description("Android text scale, where 1.0 is the default.")] double? fontScale = null,
		[Description("iOS content size category, or 'increment'/'decrement' to step one.")]
		string? contentSize = null,
		[Description("Turn the increase-contrast accessibility setting on or off.")]
		bool? increaseContrast = null,
		CancellationToken cancellationToken = default) =>
		client.UpdateSettingsAsync(
			deviceId,
			new DeviceSettingsRequest
			{
				Appearance = appearance,
				FontScale = fontScale,
				ContentSize = contentSize,
				IncreaseContrast = increaseContrast,
			},
			cancellationToken);
}
