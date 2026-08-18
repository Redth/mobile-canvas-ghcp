namespace WindowsCanvas.Contracts;

/// <summary>
/// The exact payloads <c>windows-app-helper.exe</c> writes. They are separate from the public
/// contracts on purpose: the helper reports raw window handles and process identity that the host
/// needs to correlate windows, and none of that may leak into an authorization-bearing input.
/// </summary>
public sealed record WindowsHelperEnvelope
{
	public int SchemaVersion { get; init; }
	public bool Ok { get; init; }
	public string? HelperVersion { get; init; }
	public WindowsHelperErrorDetail? Error { get; init; }
}

public sealed record WindowsHelperErrorDetail
{
	public string Code { get; init; } = "";
	public string Message { get; init; } = "";
	public string? Hresult { get; init; }
}

public sealed record WindowsHelperFeature
{
	public bool Available { get; init; }
	public string? Hresult { get; init; }
}

public sealed record WindowsHelperCaptureFeature
{
	public bool Available { get; init; }
	public uint MinimumBuild { get; init; }
	public uint ReportedBuild { get; init; }
	public string? Hresult { get; init; }
}

public sealed record WindowsHelperSignature
{
	public bool Valid { get; init; }

	/// <summary><c>valid</c>, <c>unsigned</c>, or <c>invalid</c>.</summary>
	public string Status { get; init; } = "";
	public string? Hresult { get; init; }
}

public sealed record WindowsHelperOperatingSystem
{
	public string Family { get; init; } = "";
	public uint Major { get; init; }
	public uint Minor { get; init; }
	public uint Build { get; init; }
	public string NativeArchitecture { get; init; } = "";
}

/// <summary>
/// The Windows logon session the helper itself runs in. Every window the host is allowed to touch
/// has to belong to this session, so it is reported once instead of being assumed.
/// </summary>
public sealed record WindowsHelperSession
{
	public uint Id { get; init; }
	public bool Interactive { get; init; }
	public string IntegrityLevel { get; init; } = WindowsIntegrityLevels.Unknown;
	public uint IntegrityValue { get; init; }
}

public sealed record WindowsHelperFeatures
{
	public WindowsHelperFeature? ShellAppCatalog { get; init; }
	public WindowsHelperFeature? UiAutomation { get; init; }
	public WindowsHelperCaptureFeature? WindowsGraphicsCapture { get; init; }
	public WindowsHelperFeature? MediaFoundationH264 { get; init; }
	public WindowsHelperFeature? SendInput { get; init; }
	public WindowsHelperSignature? AuthenticodeSignature { get; init; }
}

public sealed record WindowsHelperCapabilities
{
	public int SchemaVersion { get; init; }
	public bool Ok { get; init; }
	public string HelperVersion { get; init; } = "";
	public string Architecture { get; init; } = "";
	public WindowsHelperOperatingSystem? Os { get; init; }
	public WindowsHelperSession? Session { get; init; }
	public WindowsHelperFeatures? Features { get; init; }
}

/// <summary>One catalog source the helper tried, and whether this machine let it read anything.</summary>
public sealed record WindowsHelperCatalogSource
{
	public string Name { get; init; } = "";
	public bool Supported { get; init; }
	public int Count { get; init; }
	public string? Hresult { get; init; }

	/// <summary>Why an unsupported source is unsupported, in words a user can act on.</summary>
	public string? Detail { get; init; }
}

public sealed record WindowsHelperCatalogEntry
{
	/// <summary>
	/// Deterministic opaque identity for this launchable app. The helper derives it from the
	/// launch provenance rather than from the display name, so the same app keeps the same ID
	/// across host restarts and two apps that merely share a friendly name never collide.
	/// </summary>
	public string Id { get; init; } = "";
	public string DisplayName { get; init; } = "";
	public string Source { get; init; } = "";
	public string Kind { get; init; } = "";
	public string LaunchMethod { get; init; } = "";
	public string? AppUserModelId { get; init; }
	public string? PackageFamilyName { get; init; }
	public string? ExecutablePath { get; init; }
	public string? Arguments { get; init; }
	public string? WorkingDirectory { get; init; }
	public string? ParsingName { get; init; }
	public string? ShortcutPath { get; init; }
	public string? RegistryKey { get; init; }
	public string? Publisher { get; init; }
}

public sealed record WindowsHelperCatalog
{
	public int SchemaVersion { get; init; }
	public bool Ok { get; init; }
	public string HelperVersion { get; init; } = "";
	public bool Truncated { get; init; }
	public WindowsHelperCatalogSource[] Sources { get; init; } = [];
	public WindowsHelperCatalogEntry[] Entries { get; init; } = [];
}

public sealed record WindowsHelperBounds
{
	public int Left { get; init; }
	public int Top { get; init; }
	public int Width { get; init; }
	public int Height { get; init; }
}

public sealed record WindowsHelperWindow
{
	public long Handle { get; init; }
	public int ProcessId { get; init; }

	/// <summary>
	/// Process creation time as a Windows FILETIME. Paired with the PID it is what makes a process
	/// identity unique: Windows reuses process IDs, and a reused one must never inherit a grant.
	/// </summary>
	public long ProcessStartFileTime { get; init; }
	public uint SessionId { get; init; }
	public string Title { get; init; } = "";
	public string ClassName { get; init; } = "";
	public WindowsHelperBounds? Bounds { get; init; }
	public bool Visible { get; init; }
	public bool Minimized { get; init; }
	public bool Cloaked { get; init; }
	public bool ToolWindow { get; init; }
	public long OwnerHandle { get; init; }
	public string? ProcessPath { get; init; }
	public string? AppUserModelId { get; init; }
	public string? PackageFamilyName { get; init; }
	public string? PackageFullName { get; init; }
	public string IntegrityLevel { get; init; } = WindowsIntegrityLevels.Unknown;
	public uint IntegrityValue { get; init; }
	public bool Elevated { get; init; }

	/// <summary>
	/// How much of the owning process the helper could read: <c>full</c>, <c>limited</c> when only
	/// the PID-level query succeeded, or <c>denied</c>. A window the helper cannot identify is
	/// never correlated into a session automatically.
	/// </summary>
	public string IdentityAccess { get; init; } = WindowsIdentityAccess.Denied;
}

public sealed record WindowsHelperWindowList
{
	public int SchemaVersion { get; init; }
	public bool Ok { get; init; }
	public string HelperVersion { get; init; } = "";
	public bool Truncated { get; init; }
	public WindowsHelperSession? Session { get; init; }
	public WindowsHelperWindow[] Windows { get; init; } = [];
}

public sealed record WindowsHelperLaunch
{
	public int SchemaVersion { get; init; }
	public bool Ok { get; init; }
	public string HelperVersion { get; init; } = "";
	public WindowsHelperCatalogEntry? Entry { get; init; }

	/// <summary>
	/// Process the shell reported starting, when it reported one at all. Packaged activation often
	/// reports nothing, which is why this is a correlation hint and not a grant.
	/// </summary>
	public int ProcessId { get; init; }
	public long ProcessStartFileTime { get; init; }
	public string LaunchMethod { get; init; } = "";
}

public static class WindowsIdentityAccess
{
	public const string Full = "full";
	public const string Limited = "limited";
	public const string Denied = "denied";
}

/// <summary>
/// Windows integrity levels, lowest first. Automation may only drive a target at or below the
/// host's own level; anything higher is reported as elevated and left alone.
/// </summary>
public static class WindowsIntegrityLevels
{
	public const string Unknown = "unknown";
	public const string Untrusted = "untrusted";
	public const string Low = "low";
	public const string Medium = "medium";
	public const string High = "high";
	public const string System = "system";
}

public static class WindowsCatalogSources
{
	public const string AppsFolder = "appsFolder";
	public const string StartMenuShortcuts = "startMenuShortcuts";
	public const string AppPaths = "appPaths";
}

public static class WindowsCatalogKinds
{
	public const string Packaged = "packaged";
	public const string Desktop = "desktop";
}

public static class WindowsLaunchMethods
{
	public const string ShellItem = "shellItem";
	public const string Shortcut = "shortcut";
	public const string Executable = "executable";
}
