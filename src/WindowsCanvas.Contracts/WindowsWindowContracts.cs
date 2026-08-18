namespace WindowsCanvas.Contracts;

/// <summary>
/// A top-level window the canvas could attach to. The identifier is minted per canvas panel and
/// means nothing anywhere else: it is a capability handed to one panel, not a name for a window.
/// </summary>
public sealed record WindowsWindowCandidate
{
	public string Id { get; init; } = "";
	public string Title { get; init; } = "";
	public string? ProcessName { get; init; }
	public string? ProcessPath { get; init; }
	public string? AppUserModelId { get; init; }
	public string? PackageFamilyName { get; init; }
	public WindowsWindowBounds? Bounds { get; init; }
	public bool Minimized { get; init; }
	public bool Cloaked { get; init; }

	/// <summary>Whether this window belongs to a session the canvas already controls.</summary>
	public bool Attached { get; init; }

	/// <summary>The session that already owns it, when one does.</summary>
	public string? SessionId { get; init; }

	/// <summary>
	/// Whether attaching is offered. A window in another Windows session, at a higher integrity
	/// level, or whose owning process the helper could not identify stays visible and explicitly
	/// unattachable rather than being quietly correlated into somebody's session.
	/// </summary>
	public bool Attachable { get; init; }

	/// <summary>Why <see cref="Attachable"/> is false, from <see cref="WindowsErrorCodes"/>.</summary>
	public string? UnattachableCode { get; init; }
	public string? UnattachableDetail { get; init; }

	public string IntegrityLevel { get; init; } = WindowsIntegrityLevels.Unknown;
	public bool Elevated { get; init; }

	/// <summary>
	/// Raw operating-system identity, for diagnostics only. No endpoint accepts these values as
	/// input: a caller that could name an HWND could name a window it was never granted.
	/// </summary>
	public WindowsWindowDiagnostics? Diagnostics { get; init; }
}

public sealed record WindowsWindowDiagnostics
{
	public long NativeHandle { get; init; }
	public int ProcessId { get; init; }
	public DateTimeOffset? ProcessStartedAt { get; init; }
	public uint WindowsSessionId { get; init; }
	public string? ClassName { get; init; }
	public string IdentityAccess { get; init; } = WindowsIdentityAccess.Denied;
}

public sealed record WindowsWindowBounds
{
	public int Left { get; init; }
	public int Top { get; init; }
	public int Width { get; init; }
	public int Height { get; init; }
}

public sealed record WindowsWindowCandidateList
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;
	public WindowsWindowCandidate[] Windows { get; init; } = [];
	public bool Truncated { get; init; }
}

/// <summary>
/// A window the canvas is authorized to drive, because launching or attaching positively
/// correlated it with the app session that owns it.
/// </summary>
public sealed record WindowsAuthorizedWindow
{
	public string Id { get; init; } = "";
	public string Title { get; init; } = "";
	public WindowsWindowBounds? Bounds { get; init; }
	public bool Minimized { get; init; }
	public bool Cloaked { get; init; }
	public bool Selected { get; init; }

	/// <summary>Which correlation rule proved this window belongs to the session.</summary>
	public string Correlation { get; init; } = "";

	public string IntegrityLevel { get; init; } = WindowsIntegrityLevels.Unknown;
	public bool Elevated { get; init; }
	public WindowsWindowDiagnostics? Diagnostics { get; init; }
}

/// <summary>How a window was proven to belong to an app session.</summary>
public static class WindowsCorrelationReasons
{
	/// <summary>The window's process is the exact process identity the launch produced.</summary>
	public const string LaunchedProcess = "launchedProcess";

	/// <summary>The window's process identity matches one the session already owns.</summary>
	public const string SameProcess = "sameProcess";

	/// <summary>The window declares the packaged app identity the session was created for.</summary>
	public const string AppUserModelId = "appUserModelId";

	/// <summary>The window belongs to the same MSIX package family as the session's app.</summary>
	public const string PackageFamily = "packageFamily";

	/// <summary>The window is owned by a window the session already owns, in the same process.</summary>
	public const string OwnedDialog = "ownedDialog";

	/// <summary>The user attached this exact window.</summary>
	public const string Attached = "attached";
}

public sealed record WindowsAuthorizedWindowList
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;
	public string SessionId { get; init; } = "";
	public WindowsAuthorizedWindow[] Windows { get; init; } = [];
	public string? SelectedWindowId { get; init; }
}
