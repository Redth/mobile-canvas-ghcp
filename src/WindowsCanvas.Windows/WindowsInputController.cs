using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using WindowsCanvas.Contracts;

namespace WindowsCanvas.Windows;

/// <summary>The outcome of one synthetic input primitive Windows is allowed to refuse.</summary>
public readonly record struct WindowsInputOutcome(bool Success, string? Detail)
{
	public static readonly WindowsInputOutcome Ok = new(true, null);

	public static WindowsInputOutcome Refused(string detail) => new(false, detail);
}

/// <summary>
/// The synthetic input primitives screenshot-guided control is built from.
///
/// It is deliberately primitive. All of the policy — revalidating the window, checking the
/// transform token, mapping coordinates, holding and releasing modifiers, cleaning up a stuck
/// button — lives in the service, so it can be tested without a desktop, and this interface only
/// has to be right about how <c>SendInput</c> is called.
/// </summary>
public interface IWindowsInputController
{
	/// <summary>The virtual desktop rectangle in physical pixels; the origin may be negative.</summary>
	WindowsWindowBounds VirtualDesktop { get; }

	/// <summary>Whether the given window currently owns the foreground.</summary>
	bool IsForeground(long handle);

	/// <summary>
	/// The top-level window whose pixel is at a physical desktop point, or 0 when Windows would not
	/// say. It is what proves the pixel a click is aimed at still belongs to the target window
	/// rather than to a dialog that opened after the screenshot.
	/// </summary>
	long WindowAtPoint(int screenX, int screenY);

	WindowsInputOutcome MovePointer(int screenX, int screenY);

	WindowsInputOutcome PointerButton(string button, bool down, int screenX, int screenY);

	/// <summary>Wheel movement in notches; positive is up and right, as on a physical wheel.</summary>
	WindowsInputOutcome Wheel(int screenX, int screenY, int verticalNotches, int horizontalNotches);

	WindowsInputOutcome Key(WindowsKeyStroke stroke, bool down);

	/// <summary>
	/// One UTF-16 code unit as a Unicode key event. This is how text is typed: no clipboard is
	/// touched, no window message is posted, and surrogate pairs are sent as two units.
	/// </summary>
	WindowsInputOutcome Unicode(char unit, bool down);
}

/// <summary>
/// The real implementation, over <c>SendInput</c>.
///
/// Pointer events are absolute and virtual-desktop relative, which is the only form that is correct
/// on a multi-monitor desktop with mixed DPI or a negative origin. Nothing here posts a private
/// window message: synthetic input goes through the same queue a real keyboard and mouse use, so an
/// application cannot be driven into a state it would never reach from the desk.
/// </summary>
public sealed partial class Win32InputController : IWindowsInputController
{
	private const uint InputMouse = 0;
	private const uint InputKeyboard = 1;

	private const uint MouseMove = 0x0001;
	private const uint MouseLeftDown = 0x0002;
	private const uint MouseLeftUp = 0x0004;
	private const uint MouseRightDown = 0x0008;
	private const uint MouseRightUp = 0x0010;
	private const uint MouseMiddleDown = 0x0020;
	private const uint MouseMiddleUp = 0x0040;
	private const uint MouseWheel = 0x0800;
	private const uint MouseHorizontalWheel = 0x1000;
	private const uint MouseVirtualDesk = 0x4000;
	private const uint MouseAbsolute = 0x8000;

	private const uint KeyExtended = 0x0001;
	private const uint KeyUp = 0x0002;
	private const uint KeyUnicode = 0x0004;

	private const int WheelDelta = 120;

	private const int VirtualScreenX = 76;
	private const int VirtualScreenY = 77;
	private const int VirtualScreenWidth = 78;
	private const int VirtualScreenHeight = 79;

	private const uint GaRoot = 2;

	public WindowsWindowBounds VirtualDesktop
	{
		get
		{
			if (!OperatingSystem.IsWindows())
				return new WindowsWindowBounds();
			WindowsDpiAwareness.Ensure();
			return new WindowsWindowBounds
			{
				Left = GetSystemMetrics(VirtualScreenX),
				Top = GetSystemMetrics(VirtualScreenY),
				Width = Math.Max(GetSystemMetrics(VirtualScreenWidth), 1),
				Height = Math.Max(GetSystemMetrics(VirtualScreenHeight), 1),
			};
		}
	}

	public bool IsForeground(long handle) =>
		OperatingSystem.IsWindows() && GetForegroundWindow() == (nint)handle;

	public long WindowAtPoint(int screenX, int screenY)
	{
		if (!OperatingSystem.IsWindows())
			return 0;
		WindowsDpiAwareness.Ensure();
		var window = WindowFromPoint(new PointValue { X = screenX, Y = screenY });
		if (window == 0)
			return 0;
		// WindowFromPoint answers with the deepest child; the grant is keyed on the top-level
		// window, so walk up to its root before comparing.
		var root = GetAncestor(window, GaRoot);
		return root == 0 ? window : root;
	}

	public WindowsInputOutcome MovePointer(int screenX, int screenY) =>
		SendMouse(MouseMove, mouseData: 0, screenX, screenY);

	public WindowsInputOutcome PointerButton(string button, bool down, int screenX, int screenY)
	{
		var flag = (button, down) switch
		{
			(WindowsPointerButtons.Left, true) => MouseLeftDown,
			(WindowsPointerButtons.Left, false) => MouseLeftUp,
			(WindowsPointerButtons.Right, true) => MouseRightDown,
			(WindowsPointerButtons.Right, false) => MouseRightUp,
			(WindowsPointerButtons.Middle, true) => MouseMiddleDown,
			(WindowsPointerButtons.Middle, false) => MouseMiddleUp,
			_ => 0u,
		};
		return flag == 0
			? WindowsInputOutcome.Refused($"'{button}' is not a supported pointer button.")
			// The button event carries the position too, so a click cannot be separated from its
			// move by another program's input arriving between the two.
			: SendMouse(flag | MouseMove, mouseData: 0, screenX, screenY);
	}

	public WindowsInputOutcome Wheel(
		int screenX,
		int screenY,
		int verticalNotches,
		int horizontalNotches)
	{
		if (verticalNotches != 0)
		{
			var vertical = SendMouse(
				MouseWheel | MouseMove,
				unchecked((uint)(verticalNotches * WheelDelta)),
				screenX,
				screenY);
			if (!vertical.Success)
				return vertical;
		}
		if (horizontalNotches != 0)
		{
			return SendMouse(
				MouseHorizontalWheel | MouseMove,
				unchecked((uint)(horizontalNotches * WheelDelta)),
				screenX,
				screenY);
		}
		return WindowsInputOutcome.Ok;
	}

	public WindowsInputOutcome Key(WindowsKeyStroke stroke, bool down)
	{
		if (!OperatingSystem.IsWindows())
			return WindowsInputOutcome.Refused("Windows input requires Windows.");

		var input = new Input
		{
			Type = InputKeyboard,
			Data = new InputUnion
			{
				Keyboard = new KeyboardInput
				{
					VirtualKey = stroke.VirtualKey,
					// Applications that read scancodes rather than virtual keys — games and some
					// terminals — see nothing at all without this.
					Scan = (ushort)MapVirtualKeyW(stroke.VirtualKey, 0),
					Flags = (stroke.Extended ? KeyExtended : 0) | (down ? 0 : KeyUp),
				},
			},
		};
		return Send(ref input, "key");
	}

	public WindowsInputOutcome Unicode(char unit, bool down)
	{
		if (!OperatingSystem.IsWindows())
			return WindowsInputOutcome.Refused("Windows input requires Windows.");

		var input = new Input
		{
			Type = InputKeyboard,
			Data = new InputUnion
			{
				Keyboard = new KeyboardInput
				{
					VirtualKey = 0,
					Scan = unit,
					Flags = KeyUnicode | (down ? 0 : KeyUp),
				},
			},
		};
		return Send(ref input, "text");
	}

	private WindowsInputOutcome SendMouse(uint flags, uint mouseData, int screenX, int screenY)
	{
		if (!OperatingSystem.IsWindows())
			return WindowsInputOutcome.Refused("Windows input requires Windows.");

		var (absoluteX, absoluteY) = WindowsInputMapper.ToAbsolute(screenX, screenY, VirtualDesktop);
		var input = new Input
		{
			Type = InputMouse,
			Data = new InputUnion
			{
				Mouse = new MouseInput
				{
					Dx = absoluteX,
					Dy = absoluteY,
					MouseData = mouseData,
					Flags = flags | MouseAbsolute | MouseVirtualDesk,
				},
			},
		};
		return Send(ref input, "pointer");
	}

	private static WindowsInputOutcome Send(ref Input input, string what)
	{
		var sent = SendInput(1, ref input, Marshal.SizeOf<Input>());
		if (sent == 1)
			return WindowsInputOutcome.Ok;

		// A blocked SendInput is normally UIPI: the target runs at a higher integrity level, or
		// something above this host owns the foreground. Saying which call failed and why beats a
		// silent no-op that reads as a broken application.
		var error = Marshal.GetLastPInvokeError();
		return WindowsInputOutcome.Refused(
			$"Windows rejected the synthetic {what} input (error {error}). This usually means the " +
			"target window is at a higher integrity level than this host, or a system UI owns the " +
			"foreground.");
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct Input
	{
		public uint Type;
		public InputUnion Data;
	}

	[StructLayout(LayoutKind.Explicit)]
	private struct InputUnion
	{
		[FieldOffset(0)]
		public MouseInput Mouse;

		[FieldOffset(0)]
		public KeyboardInput Keyboard;
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct MouseInput
	{
		public int Dx;
		public int Dy;
		public uint MouseData;
		public uint Flags;
		public uint Time;
		public nuint ExtraInfo;
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct KeyboardInput
	{
		public ushort VirtualKey;
		public ushort Scan;
		public uint Flags;
		public uint Time;
		public nuint ExtraInfo;
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct PointValue
	{
		public int X;
		public int Y;
	}

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	private static partial nint WindowFromPoint(PointValue point);

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	private static partial nint GetAncestor(nint handle, uint flags);

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll", SetLastError = true)]
	private static partial uint SendInput(uint count, ref Input inputs, int size);

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	private static partial nint GetForegroundWindow();

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	private static partial int GetSystemMetrics(int index);

	[SupportedOSPlatform("windows")]
	[LibraryImport("user32.dll")]
	private static partial uint MapVirtualKeyW(uint code, uint mapType);
}
