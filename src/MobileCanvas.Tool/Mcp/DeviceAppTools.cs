using System.ComponentModel;
using MobileCanvas.Contracts;
using ModelContextProtocol.Server;

namespace MobileCanvas.Tool;

/// <summary>
/// Inspects and drives the apps installed on a device, so an agent can open the thing it wants to
/// work on instead of shelling out to <c>adb</c> or <c>simctl</c> by hand.
/// </summary>
[McpServerToolType]
public sealed class DeviceAppTools(DeviceHostClient client)
{
	[McpServerTool(Name = "mobile_device_app_list", Title = "List installed apps", Destructive = false, ReadOnly = true, OpenWorld = false)]
	[Description(
		"List the apps installed on a device, with bundle ID (iOS) or package name (Android), version, "
		+ "and whether each is running. Built-in system apps are excluded unless includeSystem is set, "
		+ "because they outnumber a developer's own apps many times over.")]
	public Task<AppListResult> List(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Filter by bundle ID or display name; substring and case-insensitive.")]
		string? text = null,
		[Description("Include the platform's built-in apps.")] bool includeSystem = false,
		[Description("Maximum number of apps to return.")] int limit = 100,
		CancellationToken cancellationToken = default) =>
		client.ListAppsAsync(
			deviceId,
			new AppQuery { Text = text, IncludeSystem = includeSystem, Limit = limit },
			cancellationToken);

	[McpServerTool(Name = "mobile_device_app_launch", Title = "Launch app", Destructive = false, OpenWorld = false)]
	[Description(
		"Launch an app by bundle ID (iOS) or package name (Android). Prefer this over tapping a home "
		+ "screen icon: it does not depend on where the icon sits or whether it is on the first page.")]
	public Task<AppOperationResult> Launch(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Bundle ID on iOS, package name on Android.")] string bundleId,
		[Description("Stop the app first, so this is a cold start rather than a bring-to-front.")]
		bool relaunch = false,
		CancellationToken cancellationToken = default) =>
		client.LaunchAppAsync(
			deviceId,
			new AppLaunchRequest { BundleId = bundleId, Relaunch = relaunch },
			cancellationToken);

	[McpServerTool(Name = "mobile_device_app_terminate", Title = "Terminate app", Destructive = false, OpenWorld = false)]
	[Description("Stop a running app. Its data is left alone; only the process ends.")]
	public Task<AppOperationResult> Terminate(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Bundle ID on iOS, package name on Android.")] string bundleId,
		CancellationToken cancellationToken = default) =>
		client.TerminateAppAsync(deviceId, bundleId, cancellationToken);

	[McpServerTool(Name = "mobile_device_app_install", Title = "Install app", Destructive = false, OpenWorld = false)]
	[Description(
		"Install an app from a host path: a .app bundle on iOS, an .apk on Android. Use this to put a "
		+ "freshly built app on the device without leaving the session.")]
	public Task<AppOperationResult> Install(
		[Description("Host path to a .app bundle (iOS) or .apk file (Android).")] string path,
		[Description("Provider-qualified device ID.")] string deviceId,
		CancellationToken cancellationToken = default) =>
		client.InstallAppAsync(deviceId, new AppInstallRequest { Path = path }, cancellationToken);

	[McpServerTool(Name = "mobile_device_app_uninstall", Title = "Uninstall app", Destructive = true, OpenWorld = false)]
	[Description(
		"Uninstall an app and delete its data. This is destructive and cannot be undone, so it requires "
		+ "confirm to be set.")]
	public Task<AppOperationResult> Uninstall(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Bundle ID on iOS, package name on Android.")] string bundleId,
		[Description("Must be true; the app's data is deleted with it.")] bool confirm = false,
		CancellationToken cancellationToken = default) =>
		client.UninstallAppAsync(deviceId, bundleId, confirm, cancellationToken);
}
