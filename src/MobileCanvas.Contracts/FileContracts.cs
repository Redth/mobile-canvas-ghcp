namespace MobileCanvas.Contracts;

/// <summary>
/// One entry in a device directory listing.
/// </summary>
public sealed record DeviceFile
{
	public string Name { get; init; } = "";

	/// <summary>
	/// Path to pass back to a pull or a listing: relative to the app's data container when the query
	/// named an app, and a device path otherwise.
	/// </summary>
	public string Path { get; init; } = "";

	public bool IsDirectory { get; init; }

	/// <summary>Size in bytes; zero for a directory.</summary>
	public long Size { get; init; }

	/// <summary>Last modified time as the platform reports it, when it reports one.</summary>
	public string? Modified { get; init; }
}

/// <summary>
/// Names a place on the device: inside one app's data container, or an absolute device path.
/// </summary>
/// <remarks>
/// Two addressing modes rather than one because the interesting files are the ones an app wrote, and
/// those live where nothing else can reach them -- behind <c>run-as</c> on Android and inside a
/// container whose directory name is a GUID on iOS. Naming the app instead of that path is both
/// shorter and stable across reinstalls.
/// </remarks>
public sealed record FileQuery
{
	/// <summary>
	/// Scopes <see cref="Path"/> to this app's data container. Omit to address the device itself.
	/// </summary>
	public string? BundleId { get; init; }

	/// <summary>
	/// Relative to the app's data container when <see cref="BundleId"/> is set, absolute otherwise.
	/// </summary>
	public string Path { get; init; } = "";
}

public sealed record FileListResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public string DeviceId { get; init; } = "";
	public string Platform { get; init; } = "";

	/// <summary>The directory that was listed, echoed back as it was resolved.</summary>
	public string Path { get; init; } = "";

	public DeviceFile[] Files { get; init; } = [];
	public int Total { get; init; }
}

/// <summary>
/// Copies a file between the host and a device.
/// </summary>
public sealed record FileTransferRequest
{
	/// <summary>Scopes <see cref="DevicePath"/> to this app's data container.</summary>
	public string? BundleId { get; init; }

	/// <summary>
	/// Relative to the app's data container when <see cref="BundleId"/> is set, absolute otherwise.
	/// </summary>
	public string DevicePath { get; init; } = "";

	/// <summary>Path on this machine: the source of a push, the destination of a pull.</summary>
	public string HostPath { get; init; } = "";
}

public sealed record FileTransferResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public bool Success { get; init; } = true;
	public string DeviceId { get; init; } = "";
	public string DevicePath { get; init; } = "";
	public string HostPath { get; init; } = "";

	/// <summary>Bytes transferred, so a caller can tell an empty file from a failed copy.</summary>
	public long Size { get; init; }

	/// <summary>One of the <see cref="FileOperations"/> values.</summary>
	public string Operation { get; init; } = "";
}

public static class FileOperations
{
	public const string Push = "push";
	public const string Pull = "pull";
}
