using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using WindowsCanvas.Contracts;

namespace WindowsCanvas.Windows;

/// <summary>
/// Reads one window's live geometry. It is an interface because geometry is the input to every
/// coordinate decision this product makes, and those decisions have to be testable on a machine
/// with no desktop at all.
/// </summary>
public interface IWindowsWindowGeometry
{
	/// <summary>
	/// The window's current geometry, or <c>null</c> when the window no longer exists. The token is
	/// not filled in here: only the service knows the window identity it must be bound to.
	/// </summary>
	WindowsCaptureGeometry? Read(long handle);
}

/// <summary>
/// Raises this process to Per-Monitor-V2 DPI awareness the first time Windows geometry matters.
///
/// Without it every coordinate this host reads or sends would be silently virtualized on a
/// high-DPI monitor: <c>GetWindowRect</c> would answer in scaled pixels while the capture helper —
/// which is Per-Monitor-V2 through its manifest — answered in physical ones, and clicks would land
/// somewhere near the target rather than on it. It is set lazily rather than at startup because it
/// is a Windows-only concern that must not change how the Mobile host starts anywhere else.
/// </summary>
internal static partial class WindowsDpiAwareness
{
	private static readonly nint PerMonitorV2 = -4;
	private static readonly nint PerMonitor = -3;

	private static readonly Lazy<string> State = new(Apply, isThreadSafe: true);

	/// <summary><c>perMonitorV2</c>, <c>perMonitor</c>, <c>system</c>, <c>unaware</c>, or <c>unknown</c>.</summary>
	public static string Ensure() => State.Value;

	/// <summary>
	/// Whether coordinates read from this process are physical pixels. A host that could not reach
	/// per-monitor awareness still works on a 100% display, and says so rather than pretending.
	/// </summary>
	public static bool IsPhysical() =>
		Ensure() is "perMonitorV2" or "perMonitor";

	private static string Apply()
	{
		if (!OperatingSystem.IsWindows())
			return "unknown";

		try
		{
			if (SetProcessDpiAwarenessContext(PerMonitorV2))
				return "perMonitorV2";
			if (SetProcessDpiAwarenessContext(PerMonitor))
				return "perMonitor";
			// Both calls fail with ERROR_ACCESS_DENIED once awareness is already set, including
			// when a host manifest already set it, so the current value decides the answer.
			return Describe();
		}
		catch (EntryPointNotFoundException)
		{
			return Legacy();
		}
		catch (DllNotFoundException)
		{
			return "unknown";
		}
	}

	private static string Legacy()
	{
		try
		{
			return SetProcessDPIAware() ? "system" : "unaware";
		}
		catch (EntryPointNotFoundException)
		{
			return "unknown";
		}
		catch (DllNotFoundException)
		{
			return "unknown";
		}
	}

	private static string Describe()
	{
		try
		{
			return GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) switch
			{
				0 => "unaware",
				1 => "system",
				2 => "perMonitor",
				3 => "perMonitorV2",
				_ => "unknown",
			};
		}
		catch (EntryPointNotFoundException)
		{
			return "unknown";
		}
	}

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll", SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static partial bool SetProcessDpiAwarenessContext(nint context);

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static partial bool SetProcessDPIAware();

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	private static partial nint GetThreadDpiAwarenessContext();

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	private static partial int GetAwarenessFromDpiAwarenessContext(nint context);
}

/// <summary>
/// The real geometry reader.
///
/// The visible content rectangle comes from the Desktop Window Manager's extended frame bounds
/// rather than from <c>GetWindowRect</c>. Since Windows 10 a top-level window's rectangle extends
/// past its visible edge by an invisible resize border, and Windows.Graphics.Capture produces a
/// surface of that full size. Cropping to the extended frame bounds is what makes a screenshot show
/// the window a person sees, and it is what makes the coordinate origin agree between the managed
/// host and the native helper.
/// </summary>
public sealed partial class Win32WindowGeometry : IWindowsWindowGeometry
{
	private const int ExtendedFrameBounds = 9;

	public WindowsCaptureGeometry? Read(long handle)
	{
		if (!OperatingSystem.IsWindows())
			return null;

		WindowsDpiAwareness.Ensure();
		var window = (nint)handle;
		if (window == 0 || !IsWindow(window) || !TryGetWindowBounds(window, out var frame))
			return null;

		var content = TryExtendedFrameBounds(window) ?? frame;
		var minimized = IsIconic(window);
		var client = ClientBounds(window, frame);
		var dpi = DpiFor(window);
		return Build(frame, content, client, dpi, minimized);
	}

	/// <summary>
	/// Composes geometry from already-measured rectangles. Kept separate from the P/Invoke calls so
	/// the arithmetic that decides where a click lands can be tested directly.
	/// </summary>
	internal static WindowsCaptureGeometry Build(
		WindowsWindowBounds frame,
		WindowsWindowBounds content,
		WindowsWindowBounds client,
		uint dpi,
		bool minimized)
	{
		var contentWidth = Math.Max(content.Width, 0);
		var contentHeight = Math.Max(content.Height, 0);
		return new WindowsCaptureGeometry
		{
			ContentWidth = contentWidth,
			ContentHeight = contentHeight,
			CaptureWidth = contentWidth,
			CaptureHeight = contentHeight,
			Scale = 1,
			SurfaceWidth = Math.Max(frame.Width, 0),
			SurfaceHeight = Math.Max(frame.Height, 0),
			VisibleOffset = new WindowsCapturePoint
			{
				X = content.Left - frame.Left,
				Y = content.Top - frame.Top,
			},
			FrameOffset = new WindowsCapturePoint
			{
				X = frame.Left - content.Left,
				Y = frame.Top - content.Top,
			},
			ClientOffset = new WindowsCapturePoint
			{
				X = client.Left - content.Left,
				Y = client.Top - content.Top,
			},
			ClientWidth = Math.Max(client.Width, 0),
			ClientHeight = Math.Max(client.Height, 0),
			ContentScreenBounds = content,
			WindowScreenBounds = frame,
			ClientScreenBounds = client,
			Dpi = dpi == 0 ? 96 : dpi,
			DpiScale = (dpi == 0 ? 96 : dpi) / 96.0,
			Minimized = minimized,
		};
	}

	private static WindowsWindowBounds? TryExtendedFrameBounds(nint window)
	{
		try
		{
			return DwmGetWindowAttribute(
				window,
				ExtendedFrameBounds,
				out var bounds,
				Marshal.SizeOf<Rect>()) == 0
				? bounds.ToBounds()
				: null;
		}
		catch (DllNotFoundException)
		{
			// Desktop Window Manager composition is always on since Windows 8, but a stripped
			// image without dwmapi.dll must degrade to the window rectangle rather than fail.
			return null;
		}
		catch (EntryPointNotFoundException)
		{
			return null;
		}
	}

	private static WindowsWindowBounds ClientBounds(nint window, WindowsWindowBounds frame)
	{
		if (!GetClientRect(window, out var local))
			return frame;
		var origin = new Point { X = 0, Y = 0 };
		if (!ClientToScreen(window, ref origin))
			return frame;
		return new WindowsWindowBounds
		{
			Left = origin.X,
			Top = origin.Y,
			Width = Math.Max(local.Right - local.Left, 0),
			Height = Math.Max(local.Bottom - local.Top, 0),
		};
	}

	private static uint DpiFor(nint window)
	{
		try
		{
			var dpi = GetDpiForWindow(window);
			return dpi == 0 ? 96 : dpi;
		}
		catch (EntryPointNotFoundException)
		{
			// Windows 10 1607 introduced GetDpiForWindow. Below the capture floor this host
			// supports anyway, so 100% is the honest answer rather than a failure.
			return 96;
		}
	}

	private static bool TryGetWindowBounds(nint window, out WindowsWindowBounds bounds)
	{
		if (GetWindowRect(window, out Rect rect))
		{
			bounds = rect.ToBounds();
			return true;
		}
		bounds = new WindowsWindowBounds();
		return false;
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct Rect
	{
		public int Left;
		public int Top;
		public int Right;
		public int Bottom;

		public readonly WindowsWindowBounds ToBounds() => new()
		{
			Left = Left,
			Top = Top,
			Width = Math.Max(Right - Left, 0),
			Height = Math.Max(Bottom - Top, 0),
		};
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct Point
	{
		public int X;
		public int Y;
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
	private static partial bool GetWindowRect(nint handle, out Rect bounds);

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static partial bool GetClientRect(nint handle, out Rect bounds);

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static partial bool ClientToScreen(nint handle, ref Point point);

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	private static partial uint GetDpiForWindow(nint handle);

	[SupportedOSPlatform("windows")]
	[LibraryImport("dwmapi.dll")]
	private static partial int DwmGetWindowAttribute(
		nint handle,
		int attribute,
		out Rect value,
		int size);
}
