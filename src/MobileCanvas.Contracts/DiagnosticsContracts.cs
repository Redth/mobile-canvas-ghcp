namespace MobileCanvas.Contracts;

/// <summary>
/// One line of device log output, normalized across platforms.
/// </summary>
public sealed record LogEntry
{
	/// <summary>When the device recorded the line, in the device's own clock.</summary>
	public string Timestamp { get; init; } = "";

	/// <summary>One of the <see cref="LogLevels"/> values, as reported by the device.</summary>
	public string Level { get; init; } = LogLevels.Info;

	/// <summary>The process on iOS, the tag on Android -- whatever names the line's origin.</summary>
	public string Source { get; init; } = "";

	/// <summary>The logged text, with the platform's framing removed.</summary>
	public string Message { get; init; } = "";

	/// <summary>Process ID, when the platform reports one.</summary>
	public int? ProcessId { get; init; }

	/// <summary>Subsystem and category on iOS, which say more than the process name alone.</summary>
	public string? Subsystem { get; init; }
}

/// <summary>
/// Severity rungs, ordered, spanning both platforms' ladders.
/// </summary>
/// <remarks>
/// The two systems do not agree on what rungs exist. Android has Verbose, Debug, Info, Warn, Error and
/// Fatal; Apple's unified log has Debug, Info, Default, Error and Fault -- no warning at all. The names
/// here are Android's, because they are the ones developers say out loud, and the iOS backend maps onto
/// them: Default becomes <see cref="Info"/>, and Fault becomes <see cref="Fatal"/>. Asking iOS for
/// <see cref="Warning"/> therefore yields errors and faults, since it has nothing quieter to offer.
/// </remarks>
public static class LogLevels
{
	public const string Verbose = "verbose";
	public const string Debug = "debug";
	public const string Info = "info";
	public const string Warning = "warning";
	public const string Error = "error";
	public const string Fatal = "fatal";

	/// <summary>Ordered quietest to loudest, so a minimum level can be compared.</summary>
	public static readonly string[] Ordered = [Verbose, Debug, Info, Warning, Error, Fatal];

	/// <summary>Rank of a level, or -1 when the name is not one of ours.</summary>
	public static int Rank(string? level) =>
		level is null ? -1 : Array.FindIndex(Ordered, name => name.Equals(level, StringComparison.OrdinalIgnoreCase));
}

/// <summary>
/// Filters for reading the device log. Every supplied term must match; omitted terms are ignored.
/// </summary>
public sealed record LogQuery
{
	/// <summary>
	/// Limits output to one app's process. Worth using: an idle simulator writes tens of thousands of
	/// lines a minute, almost none of them the caller's.
	/// </summary>
	public string? BundleId { get; init; }

	/// <summary>Drops anything quieter than this rung. See <see cref="LogLevels"/>.</summary>
	public string? MinimumLevel { get; init; }

	/// <summary>Matched against the message text.</summary>
	public string? Text { get; init; }

	/// <summary>
	/// How far back to read. Both platforms keep far more than a caller wants, so this is bounded
	/// rather than optional.
	/// </summary>
	public TimeSpan Since { get; init; } = TimeSpan.FromMinutes(5);

	/// <summary>Most recent entries win, because a caller reading a log wants the newest end of it.</summary>
	public int Limit { get; init; } = 200;
}

public sealed record LogResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public string DeviceId { get; init; } = "";
	public string Platform { get; init; } = "";
	public LogEntry[] Entries { get; init; } = [];

	/// <summary>Total matches, which can exceed <see cref="LogQuery.Limit"/>.</summary>
	public int Total { get; init; }
}

/// <summary>
/// A crash the device recorded, summarized. The full report is fetched separately, because these run
/// to hundreds of lines each and a caller usually wants to pick one first.
/// </summary>
public sealed record CrashReport
{
	/// <summary>Handle for fetching the full report.</summary>
	public string Id { get; init; } = "";

	/// <summary>The process that crashed.</summary>
	public string Name { get; init; } = "";

	/// <summary>The app that crashed, when the platform records it.</summary>
	public string? BundleId { get; init; }

	public string Timestamp { get; init; } = "";

	/// <summary>What kind of failure: a crash, an ANR, a strict-mode violation.</summary>
	public string? Kind { get; init; }
}

public sealed record CrashQuery
{
	/// <summary>Matched against the process name and bundle ID.</summary>
	public string? Text { get; init; }

	public int Limit { get; init; } = 25;
}

public sealed record CrashListResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public string DeviceId { get; init; } = "";
	public string Platform { get; init; } = "";
	public CrashReport[] Crashes { get; init; } = [];
	public int Total { get; init; }
}

public sealed record CrashDetailResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public string DeviceId { get; init; } = "";
	public CrashReport Report { get; init; } = new();

	/// <summary>The report as the platform wrote it.</summary>
	public string Content { get; init; } = "";
}
