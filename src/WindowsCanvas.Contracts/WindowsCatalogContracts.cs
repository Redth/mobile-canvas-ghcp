namespace WindowsCanvas.Contracts;

/// <summary>
/// One launchable app as the canvas sees it. Friendly names are a display and search field only:
/// two vendors ship a "Settings" and a machine can hold three builds of the same tool, so identity
/// is the opaque <see cref="Id"/> and the provenance beneath it.
/// </summary>
public sealed record WindowsCatalogEntry
{
	public string Id { get; init; } = "";
	public string DisplayName { get; init; } = "";

	/// <summary><c>packaged</c> or <c>desktop</c>.</summary>
	public string Kind { get; init; } = WindowsCatalogKinds.Desktop;

	/// <summary>
	/// Every source that reported this app, in the order they were consulted. An app registered in
	/// both AppsFolder and the Start Menu is one entry with two provenances rather than two entries
	/// that look like different apps.
	/// </summary>
	public WindowsLaunchProvenance[] Provenance { get; init; } = [];

	public string? AppUserModelId { get; init; }
	public string? PackageFamilyName { get; init; }

	/// <summary>Absolute executable resolved from a shortcut or App Paths, when there is one.</summary>
	public string? ExecutablePath { get; init; }
	public string? Publisher { get; init; }

	/// <summary>
	/// Other catalog entries that share this entry's friendly name. Search returns them instead of
	/// silently picking the first match, because picking one is how automation launches the wrong
	/// build of the app under test.
	/// </summary>
	public string[] AmbiguousWith { get; init; } = [];
}

/// <summary>Where a launchable app came from, and how the helper would start it again.</summary>
public sealed record WindowsLaunchProvenance
{
	public string Source { get; init; } = "";
	public string LaunchMethod { get; init; } = "";
	public string? ParsingName { get; init; }
	public string? ShortcutPath { get; init; }
	public string? RegistryKey { get; init; }
	public string? Arguments { get; init; }
	public string? WorkingDirectory { get; init; }
}

public sealed record WindowsCatalogQuery
{
	/// <summary>Substring matched against display name, AUMID, package family, and executable.</summary>
	public string? Text { get; init; }

	public int Limit { get; init; } = 100;

	/// <summary>Return only entries whose friendly name is shared with another entry.</summary>
	public bool AmbiguousOnly { get; init; }
}

public sealed record WindowsCatalogResult
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;
	public WindowsCatalogEntry[] Entries { get; init; } = [];

	/// <summary>How many entries matched before <see cref="WindowsCatalogQuery.Limit"/> was applied.</summary>
	public int TotalMatches { get; init; }

	public bool Truncated { get; init; }

	/// <summary>
	/// Which sources answered, so an incomplete catalog is visible rather than being read as
	/// "this app is not installed". A machine with no packaged apps and a machine whose Shell
	/// enumeration failed must not look the same.
	/// </summary>
	public WindowsCatalogSourceState[] Sources { get; init; } = [];
}

public sealed record WindowsCatalogSourceState
{
	public string Name { get; init; } = "";
	public bool Supported { get; init; }
	public int Count { get; init; }
	public string? Detail { get; init; }
}
