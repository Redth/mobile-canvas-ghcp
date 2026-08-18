using System.Runtime.InteropServices;
using WindowsCanvas.Contracts;

namespace WindowsCanvas.Windows;

/// <summary>
/// The bridge used when the host is not running on Windows. Registering it keeps startup and
/// routing identical on every platform: the Windows endpoints exist, answer, and explain that the
/// product needs Windows, instead of the host failing to build its service graph on macOS.
/// </summary>
public sealed class UnsupportedWindowsNativeBridge : IWindowsNativeBridge
{
	private static readonly string Reason =
		"Windows App Canvas requires Windows. This host is running on " +
		$"{RuntimeInformation.RuntimeIdentifier}.";

	public WindowsHelperLocation Locate() => new()
	{
		PlatformSupported = false,
		Present = false,
		Detail = Reason,
	};

	public Task<WindowsHelperCapabilities> GetCapabilitiesAsync(
		CancellationToken cancellationToken = default) => Refuse<WindowsHelperCapabilities>();

	public Task<WindowsHelperCatalog> GetCatalogAsync(CancellationToken cancellationToken = default) =>
		Refuse<WindowsHelperCatalog>();

	public Task<WindowsHelperWindowList> ListWindowsAsync(
		CancellationToken cancellationToken = default) => Refuse<WindowsHelperWindowList>();

	public Task<WindowsHelperLaunch> LaunchCatalogEntryAsync(
		string entryId,
		CancellationToken cancellationToken = default) => Refuse<WindowsHelperLaunch>();

	public Task<WindowsUiSnapshot> GetUiSnapshotAsync(
		WindowsNativeWindowTarget target,
		WindowsUiSnapshotRequest request,
		CancellationToken cancellationToken = default) => Refuse<WindowsUiSnapshot>();

	public Task<WindowsUiFindResult> FindUiAsync(
		WindowsNativeWindowTarget target,
		WindowsUiQuery query,
		CancellationToken cancellationToken = default) => Refuse<WindowsUiFindResult>();

	public Task<WindowsUiActionResult> ActUiAsync(
		WindowsNativeWindowTarget target,
		WindowsUiActionRequest request,
		CancellationToken cancellationToken = default) => Refuse<WindowsUiActionResult>();

	public Task<WindowsUiWaitResult> WaitUiAsync(
		WindowsNativeWindowTarget target,
		WindowsUiWaitRequest request,
		CancellationToken cancellationToken = default) => Refuse<WindowsUiWaitResult>();

	public Task<WindowsScreenshot> CaptureScreenshotAsync(
		WindowsNativeWindowTarget target,
		WindowsScreenshotRequest request,
		CancellationToken cancellationToken = default) => Refuse<WindowsScreenshot>();

	public Task<IWindowsVideoSession> OpenVideoAsync(
		WindowsNativeWindowTarget target,
		WindowsStreamRequest request,
		CancellationToken cancellationToken = default) => Refuse<IWindowsVideoSession>();

	private static Task<T> Refuse<T>() =>
		Task.FromException<T>(
			WindowsCanvasException.Conflict(WindowsErrorCodes.PlatformUnsupported, Reason));
}
