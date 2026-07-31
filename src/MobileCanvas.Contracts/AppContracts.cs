namespace MobileCanvas.Contracts;

/// <summary>
/// One application installed on a device, normalized across platforms.
/// </summary>
/// <remarks>
/// iOS and Android name the same idea differently -- a bundle identifier versus a package name -- so
/// <see cref="BundleId"/> carries whichever the platform uses and is the handle every other app
/// operation takes. Fields a platform cannot answer are left null rather than guessed: Android has no
/// cheap way to read an app's display label, since that lives in the APK's compiled resources.
/// </remarks>
public sealed record InstalledApp
{
	/// <summary>Bundle identifier on iOS, package name on Android.</summary>
	public string BundleId { get; init; } = "";

	/// <summary>Display name, when the platform can report one without unpacking the app.</summary>
	public string? Name { get; init; }

	/// <summary>Marketing version: <c>CFBundleShortVersionString</c> on iOS, <c>versionName</c> on Android.</summary>
	public string? Version { get; init; }

	/// <summary>Build number: <c>CFBundleVersion</c> on iOS, <c>versionCode</c> on Android.</summary>
	public string? Build { get; init; }

	/// <summary>Either <see cref="AppKinds.User"/> or <see cref="AppKinds.System"/>.</summary>
	public string Kind { get; init; } = AppKinds.User;

	/// <summary>Whether the app currently has a process.</summary>
	public bool Running { get; init; }

	/// <summary>Process ID when running, so a caller can tell a relaunch from an attach.</summary>
	public int? ProcessId { get; init; }

	/// <summary>Where the installed bundle lives on the device.</summary>
	public string? Path { get; init; }

	/// <summary>
	/// The app's writable data directory. Populated on iOS, where a simulator's container is a real
	/// path on the host; null on Android, where the sandbox is only reachable through adb.
	/// </summary>
	public string? DataContainer { get; init; }
}

public static class AppKinds
{
	public const string User = "user";
	public const string System = "system";
}

/// <summary>
/// Filters for listing apps. Every supplied term must match; omitted terms are ignored.
/// </summary>
public sealed record AppQuery
{
	/// <summary>Matched against bundle ID and display name.</summary>
	public string? Text { get; init; }

	/// <summary>
	/// Includes the platform's built-in apps. Off by default because they outnumber a developer's own
	/// apps by roughly eighty to one on Android and are almost never what a caller is looking for.
	/// </summary>
	public bool IncludeSystem { get; init; }

	public int Limit { get; init; } = 100;
}

public sealed record AppListResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public string DeviceId { get; init; } = "";
	public string Platform { get; init; } = "";
	public InstalledApp[] Apps { get; init; } = [];

	/// <summary>Total matches, which can exceed <see cref="AppQuery.Limit"/>.</summary>
	public int Total { get; init; }
}

public sealed record AppLaunchRequest
{
	public string BundleId { get; init; } = "";

	/// <summary>Arguments passed to the app process, where the platform supports them.</summary>
	public string[] Arguments { get; init; } = [];

	/// <summary>Terminates the app first, so a launch is a cold start rather than a foreground bring-up.</summary>
	public bool Relaunch { get; init; }
}

public sealed record AppInstallRequest
{
	/// <summary>Host path to a <c>.app</c> bundle on iOS or an <c>.apk</c> on Android.</summary>
	public string Path { get; init; } = "";
}

/// <summary>
/// Outcome of an app lifecycle call, naming the operation so a log or transcript reads unambiguously
/// when several are chained.
/// </summary>
public sealed record AppOperationResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public bool Success { get; init; } = true;
	public string DeviceId { get; init; } = "";

	/// <summary>
	/// The app the operation acted on. Null only after an install that could not be attributed to a
	/// package -- an Android reinstall adds no new package, so there is nothing to tell it apart.
	/// </summary>
	public string? BundleId { get; init; } = "";
	public string Operation { get; init; } = "";

	/// <summary>Process ID of a freshly launched app, when the platform reports one.</summary>
	public int? ProcessId { get; init; }

	/// <summary>Anything the platform said that a caller may want, such as an install path.</summary>
	public string? Detail { get; init; }
}

public static class AppOperations
{
	public const string Launch = "launch";
	public const string Terminate = "terminate";
	public const string Install = "install";
	public const string Uninstall = "uninstall";
}
