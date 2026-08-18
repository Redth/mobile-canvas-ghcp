namespace WindowsCanvas.Contracts;

/// <summary>
/// Version of the Windows App Canvas JSON surface. It is independent of the Mobile Canvas host
/// protocol: the two products ship in one bundle but evolve their own payloads.
/// </summary>
public static class WindowsCanvasProtocol
{
	public const string Version = "1.0";

	/// <summary>
	/// Schema version the native helper must stamp on every payload. The bridge refuses anything
	/// else rather than guessing which fields a differently versioned helper meant.
	/// </summary>
	public const int HelperSchemaVersion = 1;
}

/// <summary>
/// Machine-readable reasons a Windows request failed. Callers branch on these rather than on
/// message text, and each maps to one HTTP status in the API layer.
/// </summary>
public static class WindowsErrorCodes
{
	public const string PlatformUnsupported = "windows_platform_unsupported";
	public const string HelperMissing = "windows_helper_missing";
	public const string HelperIncompatible = "windows_helper_incompatible";
	public const string HelperFailed = "windows_helper_failed";
	public const string HelperTimeout = "windows_helper_timeout";
	public const string HelperOutputTooLarge = "windows_helper_output_too_large";
	public const string InvalidRequest = "windows_invalid_request";
	public const string SurfaceRequired = "windows_surface_required";
	public const string CatalogEntryNotFound = "windows_catalog_entry_not_found";
	public const string CatalogEntryAmbiguous = "windows_catalog_entry_ambiguous";
	public const string CandidateNotFound = "windows_candidate_not_found";
	public const string SessionNotFound = "windows_session_not_found";
	public const string SessionNotInteractive = "windows_session_not_interactive";
	public const string WindowNotFound = "windows_window_not_found";
	public const string WindowIdentityChanged = "windows_window_identity_changed";
	public const string WindowNotAuthorized = "windows_window_not_authorized";
	public const string TargetElevated = "windows_target_elevated";
	public const string TargetSessionMismatch = "windows_target_session_mismatch";
	public const string LaunchFailed = "windows_launch_failed";
	public const string LaunchNotCorrelated = "windows_launch_not_correlated";
	public const string ExecutableNotFound = "windows_executable_not_found";
	public const string WorkingDirectoryNotFound = "windows_working_directory_not_found";
	public const string OperationUnsupported = "windows_operation_unsupported";
	public const string UiInvalidSelector = "windows_uia_invalid_selector";
	public const string UiElementNotFound = "windows_uia_element_not_found";
	public const string UiElementAmbiguous = "windows_uia_element_ambiguous";
	public const string UiCapabilityUnavailable = "windows_uia_capability_unavailable";
	public const string UiPasswordValueForbidden = "windows_uia_password_value_forbidden";
	public const string UiTimeout = "windows_uia_timeout";
	public const string UiActionFailed = "windows_uia_action_failed";

	/// <summary>The window is minimized, so it has neither visible content nor a coordinate space.</summary>
	public const string WindowMinimized = "windows_window_minimized";

	public const string CaptureUnavailable = "windows_capture_unavailable";
	public const string CaptureFailed = "windows_capture_failed";

	/// <summary>The window excludes itself from capture through display affinity.</summary>
	public const string CaptureProtected = "windows_capture_protected";

	/// <summary>The helper returned a capture of a window other than the authorized one.</summary>
	public const string CaptureIdentityMismatch = "windows_capture_identity_mismatch";

	/// <summary>
	/// The caller's transform token no longer describes the window. Coordinates measured against a
	/// window that has since moved, resized, changed DPI, or minimized are refused rather than
	/// applied to wherever that place is now.
	/// </summary>
	public const string InputTransformStale = "windows_input_transform_stale";

	public const string InputOutOfBounds = "windows_input_out_of_bounds";

	/// <summary>Windows declined to give the target window the foreground, so input was not sent.</summary>
	public const string InputForegroundRefused = "windows_input_foreground_refused";

	/// <summary>
	/// Focus-free input could not represent this operation through UI Automation. The caller may
	/// explicitly opt into foreground control, but the host never does that implicitly.
	/// </summary>
	public const string InputBackgroundUnavailable = "windows_input_background_unavailable";

	public const string InputFailed = "windows_input_failed";
	public const string InputRateLimited = "windows_input_rate_limited";
}

/// <summary>
/// A Windows App Canvas failure that already knows its own machine-readable code and the HTTP
/// status it deserves. Throwing this from the service keeps the API layer from re-deriving intent
/// from exception types that mean different things on the Mobile surface.
/// </summary>
public sealed class WindowsCanvasException(string code, string message, int status = 400)
	: Exception(message)
{
	public string Code { get; } = code;

	/// <summary>HTTP status this failure maps to. 400 unless the code says otherwise.</summary>
	public int Status { get; } = status;

	public static WindowsCanvasException NotFound(string code, string message) =>
		new(code, message, 404);

	public static WindowsCanvasException Conflict(string code, string message) =>
		new(code, message, 409);

	public static WindowsCanvasException Forbidden(string code, string message) =>
		new(code, message, 403);

	public static WindowsCanvasException Gateway(string code, string message) =>
		new(code, message, 502);
}

public sealed record WindowsApiError
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;
	public string Code { get; init; } = "";
	public string Message { get; init; } = "";
}

/// <summary>
/// The result of an operation that changes state without returning a new view of it, such as
/// revealing or restoring a window.
/// </summary>
public sealed record WindowsOperationResult
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;
	public bool Success { get; init; } = true;
	public string Operation { get; init; } = "";
	public string? SessionId { get; init; }
	public string? WindowId { get; init; }

	/// <summary>
	/// Why an operation that the caller is allowed to make did not take effect, such as Windows
	/// refusing a foreground change. Absent when the operation did what it said.
	/// </summary>
	public string? Detail { get; init; }
}
