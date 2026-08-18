using WindowsCanvas.Contracts;

namespace WindowsCanvas.Windows;

/// <summary>
/// The identity of one live window: its handle, the identity of the process that owns it, and the
/// packaged app identity it declares. Windows reuses both handles and process IDs, and one shared
/// frame-host window can be recycled for a different packaged app, so a grant is only ever keyed
/// on all four together.
/// </summary>
internal readonly record struct WindowsWindowKey(
	long Handle,
	int ProcessId,
	long ProcessStartFileTime,
	string? AppUserModelId)
{
	public static WindowsWindowKey Of(WindowsHelperWindow window) =>
		new(
			window.Handle,
			window.ProcessId,
			window.ProcessStartFileTime,
			string.IsNullOrWhiteSpace(window.AppUserModelId)
				? null
				: window.AppUserModelId.Trim().ToLowerInvariant());

	/// <summary>
	/// Whether the operating system told the helper enough about this window to authorize it. A
	/// window whose process creation time could not be read has no identity beyond a reusable
	/// process ID, and one whose integrity is unknown cannot be compared against the host's.
	/// </summary>
	public static bool IsProvable(WindowsHelperWindow window) =>
		window.ProcessStartFileTime != 0
		&& window.IntegrityValue != 0
		&& !window.IdentityAccess.Equals(WindowsIdentityAccess.Denied, StringComparison.Ordinal);
}

internal sealed record WindowsProcessRecord(
	int ProcessId,
	long StartFileTime,
	string? ProcessPath,
	bool SharedHost,
	bool Observed);

internal sealed record WindowsAuthorizedRecord(
	string Id,
	WindowsWindowKey Key,
	string Correlation);

/// <summary>
/// Decides which live windows belong to an app session.
///
/// The rules are deliberately narrow. Exact launch identity and exact process identity are proof;
/// packaged app identity is proof; ownership is proof only when the owner is already authorized
/// and lives in the same process. Nothing else is. A window that cannot be proven stays out of the
/// session and is offered as something the user may attach explicitly, because the alternative is
/// authorizing a window because it looked related.
/// </summary>
internal static class WindowsWindowCorrelator
{
	/// <summary>
	/// Processes that host windows on behalf of other apps. Their process identity says nothing
	/// about which app a window belongs to: every packaged app's frame lives in one
	/// ApplicationFrameHost, so correlating by process there would hand a session every UWP window
	/// on the desktop. Only exact packaged identity may correlate a window hosted this way.
	/// </summary>
	private static readonly string[] SharedHostProcesses =
	[
		"applicationframehost.exe",
		"runtimebroker.exe",
		"systemsettingsbroker.exe",
	];

	public static bool IsSharedHostProcess(string? processPath)
	{
		if (string.IsNullOrWhiteSpace(processPath))
			return false;
		// These are Windows paths even when portable unit tests run on macOS/Linux. Path.GetFileName
		// follows the host OS and therefore treats a backslash as an ordinary character off Windows.
		var trimmed = processPath.Trim().TrimEnd('\\', '/');
		var separator = trimmed.LastIndexOfAny(['\\', '/']);
		var name = separator >= 0 ? trimmed[(separator + 1)..] : trimmed;
		return Array.Exists(
			SharedHostProcesses,
			known => known.Equals(name, StringComparison.OrdinalIgnoreCase));
	}

	/// <summary>A window a person could recognize and choose from a list.</summary>
	public static bool IsCandidate(WindowsHelperWindow window) =>
		window.Visible
		&& !window.ToolWindow
		&& !window.Cloaked
		&& !string.IsNullOrWhiteSpace(window.Title);

	/// <summary>
	/// Why a window belongs to this session, or null when nothing proves that it does.
	/// </summary>
	public static string? Reason(
		WindowsSessionState session,
		WindowsHelperWindow window,
		IReadOnlyDictionary<long, WindowsHelperWindow> liveByHandle,
		IReadOnlyDictionary<long, WindowsAuthorizedRecord> authorizedByHandle)
	{
		if (!WindowsWindowKey.IsProvable(window))
			return null;

		var windowIsShared = IsSharedHostProcess(window.ProcessPath);
		if (!windowIsShared)
		{
			foreach (var process in session.Processes)
			{
				// A zero creation time is "unknown", not a value: two unrelated processes would
				// otherwise match each other simply by both being unreadable.
				if (process.SharedHost ||
					process.StartFileTime == 0 ||
					process.ProcessId != window.ProcessId ||
					process.StartFileTime != window.ProcessStartFileTime)
				{
					continue;
				}
				return process.Observed
					? WindowsCorrelationReasons.LaunchedProcess
					: WindowsCorrelationReasons.SameProcess;
			}
		}

		if (!string.IsNullOrEmpty(session.AppUserModelId) &&
			session.AppUserModelId.Equals(window.AppUserModelId, StringComparison.OrdinalIgnoreCase))
		{
			return WindowsCorrelationReasons.AppUserModelId;
		}

		if (!string.IsNullOrEmpty(session.PackageFamilyName) &&
			session.PackageFamilyName.Equals(
				window.PackageFamilyName,
				StringComparison.OrdinalIgnoreCase))
		{
			return WindowsCorrelationReasons.PackageFamily;
		}

		if (window.OwnerHandle != 0 &&
			window.ProcessStartFileTime != 0 &&
			authorizedByHandle.ContainsKey(window.OwnerHandle) &&
			liveByHandle.TryGetValue(window.OwnerHandle, out var owner) &&
			owner.ProcessId == window.ProcessId &&
			owner.ProcessStartFileTime == window.ProcessStartFileTime)
		{
			// Ownership alone proves nothing across processes: any program may make its window
			// owned by somebody else's. Requiring the owner to be authorized *and* to live in the
			// identical process makes this narrow enough to trust, and it is what attributes a
			// dialog inside a shared frame host that carries no app identity of its own.
			return WindowsCorrelationReasons.OwnedDialog;
		}

		return null;
	}
}

/// <summary>
/// One attached app inside one canvas panel. Held in memory only: an authorization that survived a
/// host restart would outlive the user's intent to grant it.
/// </summary>
internal sealed class WindowsSessionState
{
	public required string Id { get; init; }
	public required string Origin { get; init; }
	public required DateTimeOffset CreatedAt { get; init; }
	public string DisplayName { get; set; } = "";
	public string? CatalogEntryId { get; set; }
	public string? AppUserModelId { get; set; }
	public string? PackageFamilyName { get; set; }
	public string? ExecutablePath { get; set; }
	public List<WindowsProcessRecord> Processes { get; } = [];

	/// <summary>
	/// Authorized windows in the order they joined the session, which is the order the canvas
	/// draws its tabs in. A dictionary would reorder tabs whenever a window closed.
	/// </summary>
	public List<WindowsAuthorizedRecord> Windows { get; } = [];

	public string? SelectedWindowId { get; set; }
	public string? PendingCode { get; set; }
	public string? PendingDetail { get; set; }

	public void RememberProcess(WindowsProcessRecord process)
	{
		if (Processes.Exists(known =>
				known.ProcessId == process.ProcessId &&
				known.StartFileTime == process.StartFileTime))
		{
			return;
		}
		Processes.Add(process);
	}
}
