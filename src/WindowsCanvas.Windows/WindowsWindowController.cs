using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace WindowsCanvas.Windows;

/// <summary>The outcome of a window action Windows is allowed to refuse.</summary>
public readonly record struct WindowsWindowActionOutcome(bool Success, string? Detail)
{
	public static readonly WindowsWindowActionOutcome Ok = new(true, null);

	public static WindowsWindowActionOutcome Refused(string detail) => new(false, detail);
}

/// <summary>
/// Foreground and restore, the two window operations this stage needs. They are behind an
/// interface because they are the only part of the Windows domain that has to touch user32
/// directly, and because a test suite must be able to exercise reveal and restore without a
/// desktop.
/// </summary>
public interface IWindowsWindowController
{
	WindowsWindowActionOutcome Reveal(long handle);

	WindowsWindowActionOutcome Restore(long handle);
}

/// <summary>
/// The real implementation. Source-generated P/Invoke keeps it Native AOT friendly, and every
/// entry point is guarded by <see cref="OperatingSystem.IsWindows"/> so this type can be compiled
/// and published into a macOS or Linux host without ever being called there.
/// </summary>
public sealed partial class Win32WindowController : IWindowsWindowController
{
	private const int SwRestore = 9;
	private const int SwShow = 5;

	public WindowsWindowActionOutcome Reveal(long handle)
	{
		if (!OperatingSystem.IsWindows())
			return WindowsWindowActionOutcome.Refused("Window actions require Windows.");

		var window = (nint)handle;
		if (!IsWindow(window))
			return WindowsWindowActionOutcome.Refused("The window no longer exists.");

		if (IsIconic(window))
			ShowWindow(window, SwRestore);
		else
			ShowWindow(window, SwShow);

		// Windows deliberately refuses foreground changes from a process the user is not
		// interacting with. First ask normally, then temporarily join the foreground and target
		// input queues. The latter is the documented way for an explicit user/agent reveal request
		// to transfer focus without posting private input messages to the target.
		return TrySetForeground(window)
			? WindowsWindowActionOutcome.Ok
			: WindowsWindowActionOutcome.Refused(
				"Windows declined to bring the window to the foreground. It was shown and " +
				"flashed in the taskbar instead.");
	}

	public WindowsWindowActionOutcome Restore(long handle)
	{
		if (!OperatingSystem.IsWindows())
			return WindowsWindowActionOutcome.Refused("Window actions require Windows.");

		var window = (nint)handle;
		if (!IsWindow(window))
			return WindowsWindowActionOutcome.Refused("The window no longer exists.");
		if (!IsIconic(window))
			return new WindowsWindowActionOutcome(true, "The window was not minimized.");

		return ShowWindow(window, SwRestore) || !IsIconic(window)
			? WindowsWindowActionOutcome.Ok
			: WindowsWindowActionOutcome.Refused("Windows declined to restore the window.");
	}

	private static bool TrySetForeground(nint window)
	{
		if (SetForegroundWindow(window) || GetForegroundWindow() == window)
			return true;

		var currentThread = GetCurrentThreadId();
		var foreground = GetForegroundWindow();
		var foregroundThread = foreground == 0
			? 0
			: GetWindowThreadProcessId(foreground, out _);
		var targetThread = GetWindowThreadProcessId(window, out _);
		var attachedForeground = false;
		var attachedTarget = false;
		try
		{
			if (foregroundThread != 0 && foregroundThread != currentThread)
				attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
			if (targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread)
				attachedTarget = AttachThreadInput(currentThread, targetThread, true);

			BringWindowToTop(window);
			SetForegroundWindow(window);
			SetFocus(window);
			return GetForegroundWindow() == window;
		}
		finally
		{
			if (attachedTarget)
				AttachThreadInput(currentThread, targetThread, false);
			if (attachedForeground)
				AttachThreadInput(currentThread, foregroundThread, false);
		}
	}

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static partial bool IsWindow(nint handle);

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static partial bool IsIconic(nint handle);

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static partial bool ShowWindow(nint handle, int command);

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static partial bool SetForegroundWindow(nint handle);

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	private static partial nint GetForegroundWindow();

	[SupportedOSPlatform("windows")]
	[LibraryImport("kernel32.dll")]
	private static partial uint GetCurrentThreadId();

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	private static partial uint GetWindowThreadProcessId(nint handle, out uint processId);

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static partial bool AttachThreadInput(uint attachThreadId, uint attachToThreadId, [MarshalAs(UnmanagedType.Bool)] bool attach);

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static partial bool BringWindowToTop(nint handle);

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	private static partial nint SetFocus(nint handle);
}
