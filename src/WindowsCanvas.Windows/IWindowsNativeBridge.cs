using WindowsCanvas.Contracts;

namespace WindowsCanvas.Windows;

/// <summary>
/// Where the native helper is expected to live and whether it is actually there. Reported rather
/// than thrown so a packaging mistake produces one readable diagnostic instead of a stack trace
/// from whichever Windows endpoint happened to be called first.
/// </summary>
public sealed record WindowsHelperLocation
{
	public bool PlatformSupported { get; init; }
	public string? Path { get; init; }
	public bool Present { get; init; }
	public string? Detail { get; init; }
}

/// <summary>
/// A one-call native target minted only inside <see cref="WindowsAppService"/> after an opaque
/// window ID was resolved against the live desktop. Its constructor and raw helper record are
/// internal so bridge consumers cannot turn this API into a public HWND input path.
/// </summary>
public sealed class WindowsNativeWindowTarget
{
	internal WindowsNativeWindowTarget(WindowsHelperWindow window) => Window = window;

	internal WindowsHelperWindow Window { get; }

	internal long Handle => Window.Handle;
}

/// <summary>
/// The only way managed code talks to <c>windows-app-helper.exe</c>. Everything that needs Shell
/// COM, package identity, or process introspection goes through here, which is also what lets the
/// whole Windows domain be tested without a desktop: tests inject a bridge that returns fixtures.
/// </summary>
public interface IWindowsNativeBridge
{
	WindowsHelperLocation Locate();

	Task<WindowsHelperCapabilities> GetCapabilitiesAsync(CancellationToken cancellationToken = default);

	Task<WindowsHelperCatalog> GetCatalogAsync(CancellationToken cancellationToken = default);

	Task<WindowsHelperWindowList> ListWindowsAsync(CancellationToken cancellationToken = default);

	/// <summary>
	/// Launches one catalog entry by its deterministic identity. The helper re-resolves the entry
	/// from the live catalog, so a caller can never hand it a path, a command line, or a verb.
	/// </summary>
	Task<WindowsHelperLaunch> LaunchCatalogEntryAsync(
		string entryId,
		CancellationToken cancellationToken = default);

	/// <summary>
	/// Captures one window's current UI Automation tree. The helper target is an internal one-call
	/// token, not a public HWND input: <see cref="WindowsAppService"/> obtains it only after
	/// resolving an opaque, panel-scoped window capability.
	/// </summary>
	Task<WindowsUiSnapshot> GetUiSnapshotAsync(
		WindowsNativeWindowTarget target,
		WindowsUiSnapshotRequest request,
		CancellationToken cancellationToken = default);

	Task<WindowsUiFindResult> FindUiAsync(
		WindowsNativeWindowTarget target,
		WindowsUiQuery query,
		CancellationToken cancellationToken = default);

	Task<WindowsUiActionResult> ActUiAsync(
		WindowsNativeWindowTarget target,
		WindowsUiActionRequest request,
		CancellationToken cancellationToken = default);

	Task<WindowsUiWaitResult> WaitUiAsync(
		WindowsNativeWindowTarget target,
		WindowsUiWaitRequest request,
		CancellationToken cancellationToken = default);

	/// <summary>
	/// Captures one still frame of a window as PNG, with the same visible crop and geometry a live
	/// stream uses. The descriptor echoes the window identity the helper actually captured, which
	/// is what lets the service prove the bytes belong to the window it authorized.
	/// </summary>
	Task<WindowsScreenshot> CaptureScreenshotAsync(
		WindowsNativeWindowTarget target,
		WindowsScreenshotRequest request,
		CancellationToken cancellationToken = default);

	/// <summary>
	/// Opens a long-lived Annex-B H.264 stream of a window. The session ends on its own, with a
	/// reason, whenever the window's size or DPI changes: an encoder is never fed frames of a size
	/// it was not configured for.
	/// </summary>
	Task<IWindowsVideoSession> OpenVideoAsync(
		WindowsNativeWindowTarget target,
		WindowsStreamRequest request,
		CancellationToken cancellationToken = default);
}
