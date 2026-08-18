using WindowsCanvas.Windows;
using Microsoft.Extensions.DependencyInjection;

namespace MobileCanvas.Tool;

/// <summary>
/// Registers the Windows App Canvas service graph.
///
/// It registers on every platform, and that is deliberate. Mobile Canvas has to start on macOS and
/// Linux exactly as it does today, and a Windows machine without the native helper has to start
/// too — a missing helper is a diagnostic the Windows endpoints report, not a reason for the host
/// to refuse to run. What changes per platform is only which bridge is behind the service: the
/// real one that runs <c>windows-app-helper.exe</c>, or one that explains why this is not Windows.
/// </summary>
internal static class WindowsCanvasRegistration
{
	public static void Add(IServiceCollection services)
	{
		if (OperatingSystem.IsWindows())
			services.AddSingleton<IWindowsNativeBridge>(_ => new ProcessWindowsNativeBridge());
		else
			services.AddSingleton<IWindowsNativeBridge, UnsupportedWindowsNativeBridge>();

		services.AddSingleton<IWindowsWindowController, Win32WindowController>();
		services.AddSingleton<IWindowsWindowGeometry, Win32WindowGeometry>();
		services.AddSingleton<IWindowsInputController, Win32InputController>();
		services.AddSingleton<IWindowsProcessLauncher, SystemWindowsProcessLauncher>();
		services.AddSingleton<WindowsAppService>();
	}
}
