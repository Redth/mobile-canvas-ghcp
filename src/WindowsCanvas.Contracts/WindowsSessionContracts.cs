namespace WindowsCanvas.Contracts;

/// <summary>
/// One attached app, scoped to one canvas panel. Launching or attaching creates it and authorizes
/// control of the windows it positively correlates; nothing else on the desktop is included, and
/// the grant dies with the session rather than surviving in a reused handle.
/// </summary>
public sealed record WindowsAppSession
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;
	public string Id { get; init; } = "";

	/// <summary>Best available friendly name: the catalog entry, or the attached window's app.</summary>
	public string DisplayName { get; init; } = "";

	/// <summary><c>catalog</c>, <c>executable</c>, or <c>attach</c>.</summary>
	public string Origin { get; init; } = "";

	public string? CatalogEntryId { get; init; }
	public string? AppUserModelId { get; init; }
	public string? PackageFamilyName { get; init; }
	public string? ExecutablePath { get; init; }

	public DateTimeOffset CreatedAt { get; init; }

	/// <summary>
	/// Process identities the session has positively observed. A PID alone is not one of them:
	/// Windows reuses process IDs, so the creation time travels with it.
	/// </summary>
	public WindowsProcessIdentity[] Processes { get; init; } = [];

	public WindowsAuthorizedWindow[] Windows { get; init; } = [];
	public string? SelectedWindowId { get; init; }

	/// <summary>
	/// Set when a launch succeeded but no window could yet be proven to belong to it. The session
	/// exists, controls nothing, and the caller is told to attach a window explicitly rather than
	/// having one guessed for it.
	/// </summary>
	public string? PendingCode { get; init; }
	public string? PendingDetail { get; init; }
}

public sealed record WindowsProcessIdentity
{
	public int ProcessId { get; init; }
	public DateTimeOffset? StartedAt { get; init; }
	public string? ProcessPath { get; init; }

	/// <summary>
	/// True while this identity is only a launch hint. An explicit executable launch reports the
	/// process it started immediately, but that is not authorization: a window is authorized when
	/// it appears and matches, not when a process starts.
	/// </summary>
	public bool Observed { get; init; }
}

/// <summary>The Windows app session a canvas panel currently has selected, if any.</summary>
public sealed record WindowsAppSelection
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;
	public bool HasSelection { get; init; }
	public WindowsAppSession? Session { get; init; }
}

public sealed record WindowsCatalogLaunchRequest
{
	public string EntryId { get; init; } = "";

	/// <summary>How long to wait for a window that can be positively correlated, in seconds.</summary>
	public double CorrelationTimeout { get; init; } = 10;
}

/// <summary>
/// Launch of an app that no Shell, package, shortcut, or App Paths registration can name. It takes
/// an absolute executable path and an argument array only: no command line to be re-parsed, no
/// PATH search, no Shell verb, and no URL. Anything else would turn "launch an app" into "run
/// whatever the caller wrote".
/// </summary>
public sealed record WindowsExecutableLaunchRequest
{
	public string ExecutablePath { get; init; } = "";
	public string[] Arguments { get; init; } = [];
	public string? WorkingDirectory { get; init; }
	public double CorrelationTimeout { get; init; } = 10;
}

public sealed record WindowsAttachRequest
{
	/// <summary>A candidate identifier this panel was handed by a window listing.</summary>
	public string CandidateId { get; init; } = "";
}

public sealed record WindowsSelectWindowRequest
{
	public string WindowId { get; init; } = "";
}

/// <summary>Reveal and restore name a window explicitly, or fall back to the selected one.</summary>
public sealed record WindowsWindowActionRequest
{
	public string? WindowId { get; init; }
}
