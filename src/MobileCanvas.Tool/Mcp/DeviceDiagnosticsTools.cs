using System.ComponentModel;
using MobileCanvas.Contracts;
using ModelContextProtocol.Server;

namespace MobileCanvas.Tool;

/// <summary>
/// Reads what a device recorded about itself -- log output and crash reports -- so an agent can find
/// out why something failed instead of inferring it from the screen.
/// </summary>
[McpServerToolType]
public sealed class DeviceDiagnosticsTools(DeviceHostClient client)
{
	[McpServerTool(Name = "mobile_device_log", Title = "Read device log", Destructive = false, ReadOnly = true, OpenWorld = false)]
	[Description(
		"Read recent log output from a device. Filter to one app with bundleId and to the lines that "
		+ "matter with level, both of which filter on the device rather than afterwards: an idle "
		+ "simulator writes tens of thousands of lines a minute. Levels are verbose, debug, info, "
		+ "warning, error and fatal; Apple's log has no warning rung, so asking iOS for warning yields "
		+ "errors and faults.")]
	public Task<LogResult> Log(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Limit to one app's process, by bundle ID (iOS) or package name (Android).")]
		string? bundleId = null,
		[Description("Drop anything quieter than this: verbose, debug, info, warning, error, fatal.")]
		string? level = null,
		[Description("Filter by message text; substring and case-insensitive.")] string? text = null,
		[Description("How far back to read, in seconds.")] int seconds = 300,
		[Description("Maximum entries to return, newest first.")] int limit = 200,
		CancellationToken cancellationToken = default) =>
		client.ReadLogAsync(
			deviceId,
			new LogQuery
			{
				BundleId = bundleId,
				MinimumLevel = level,
				Text = text,
				Since = TimeSpan.FromSeconds(seconds),
				Limit = limit,
			},
			cancellationToken);

	[McpServerTool(Name = "mobile_device_crashes", Title = "List crash reports", Destructive = false, ReadOnly = true, OpenWorld = false)]
	[Description(
		"List crashes and ANRs the device recorded, newest first. These survive the app that produced "
		+ "them, so this finds failures that happened while nothing was watching. Pass an ID from here "
		+ "to mobile_device_crash_report for the full stack.")]
	public Task<CrashListResult> Crashes(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Filter by process name or bundle ID; substring and case-insensitive.")]
		string? text = null,
		[Description("Maximum reports to return.")] int limit = 25,
		CancellationToken cancellationToken = default) =>
		client.ListCrashesAsync(
			deviceId,
			new CrashQuery { Text = text, Limit = limit },
			cancellationToken);

	[McpServerTool(Name = "mobile_device_crash_report", Title = "Read crash report", Destructive = false, ReadOnly = true, OpenWorld = false)]
	[Description("Read one crash report in full, using an ID from mobile_device_crashes.")]
	public Task<CrashDetailResult> CrashReport(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Crash ID from mobile_device_crashes.")] string crashId,
		CancellationToken cancellationToken = default) =>
		client.GetCrashAsync(deviceId, crashId, cancellationToken);
}
