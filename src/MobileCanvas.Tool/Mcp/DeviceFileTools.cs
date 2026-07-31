using System.ComponentModel;
using MobileCanvas.Contracts;
using ModelContextProtocol.Server;

namespace MobileCanvas.Tool;

/// <summary>
/// Reaches the files an app wrote on a device, which are otherwise unreachable: behind
/// <c>run-as</c> on Android, and inside a GUID-named container on iOS.
/// </summary>
[McpServerToolType]
public sealed class DeviceFileTools(DeviceHostClient client)
{
	[McpServerTool(Name = "mobile_device_file_list", Title = "List device files", Destructive = false, ReadOnly = true, OpenWorld = false)]
	[Description(
		"List a directory on a device. With bundleId the path is relative to that app's data container "
		+ "-- where its database, preferences and written files live -- and without it the path is an "
		+ "absolute device path. Prefer bundleId: it is stable across reinstalls, where the container's "
		+ "own path is not.")]
	public Task<FileListResult> List(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Scope the path to this app's data container.")] string? bundleId = null,
		[Description("Directory to list; relative to the app container when bundleId is set.")]
		string? path = null,
		CancellationToken cancellationToken = default) =>
		client.ListFilesAsync(
			deviceId,
			new FileQuery { BundleId = bundleId, Path = path ?? "" },
			cancellationToken);

	[McpServerTool(Name = "mobile_device_file_pull", Title = "Pull file from device", Destructive = false, OpenWorld = false)]
	[Description(
		"Copy a file off the device onto this machine, so it can be opened or inspected here. Use it "
		+ "for the database or log an app wrote. An existing file at the destination is overwritten.")]
	public Task<FileTransferResult> Pull(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("File to copy; relative to the app container when bundleId is set.")] string path,
		[Description("Where to write it on this machine. A directory takes the file's own name.")]
		string output,
		[Description("Scope the path to this app's data container.")] string? bundleId = null,
		CancellationToken cancellationToken = default) =>
		client.PullFileAsync(
			deviceId,
			new FileTransferRequest { BundleId = bundleId, DevicePath = path, HostPath = output },
			cancellationToken);

	[McpServerTool(Name = "mobile_device_file_push", Title = "Push file to device", Destructive = false, OpenWorld = false)]
	[Description(
		"Copy a file from this machine onto the device, so an app can read it. Use it to place a "
		+ "fixture or a seeded database. An existing file at the destination is overwritten.")]
	public Task<FileTransferResult> Push(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("File on this machine to copy.")] string input,
		[Description("Destination; relative to the app container when bundleId is set.")] string path,
		[Description("Scope the path to this app's data container.")] string? bundleId = null,
		CancellationToken cancellationToken = default) =>
		client.PushFileAsync(
			deviceId,
			new FileTransferRequest { BundleId = bundleId, DevicePath = path, HostPath = input },
			cancellationToken);
}
