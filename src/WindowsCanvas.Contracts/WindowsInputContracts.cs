using System.Globalization;

namespace WindowsCanvas.Contracts;

/// <summary>
/// Bounds on screenshot-guided input. They exist because this path drives the user's real desktop:
/// a request that is too long, too fast, or too big is refused rather than trusted.
/// </summary>
public static class WindowsInputLimits
{
	public const int MinimumClickCount = 1;
	public const int MaximumClickCount = 2;

	/// <summary>Longest string one type request may send, in UTF-16 code units.</summary>
	public const int MaximumTextLength = 4096;

	/// <summary>Longest chord a key request may hold at once, such as ctrl+shift+alt+p.</summary>
	public const int MaximumKeys = 8;
	public const int MaximumModifiers = 4;

	public const int MinimumDragSteps = 2;
	public const int DefaultDragSteps = 24;
	public const int MaximumDragSteps = 256;

	public const int DefaultDragDurationMilliseconds = 250;
	public const int MaximumDurationMilliseconds = 10_000;

	/// <summary>Largest wheel movement in notches per axis, in either direction.</summary>
	public const int MaximumWheelNotches = 30;

	public const int MaximumTextDelayMilliseconds = 100;

	/// <summary>
	/// Ceiling on input requests per canvas panel per second. Real agent loops are far below this;
	/// anything above it is a runaway, and a runaway that is driving a real keyboard is worth
	/// stopping.
	/// </summary>
	public const int MaximumOperationsPerSecond = 40;

	public static int ClickCount(int value) =>
		value <= 0 ? MinimumClickCount : Math.Clamp(value, MinimumClickCount, MaximumClickCount);

	public static int DragSteps(int value) =>
		value <= 0 ? DefaultDragSteps : Math.Clamp(value, MinimumDragSteps, MaximumDragSteps);

	public static int Duration(int value, int fallback) =>
		value < 0 ? fallback : Math.Min(value, MaximumDurationMilliseconds);
}

public static class WindowsPointerButtons
{
	public const string Left = "left";
	public const string Right = "right";
	public const string Middle = "middle";

	public static readonly string[] All = [Left, Right, Middle];

	public static bool IsSupported(string? button) =>
		button is not null && Array.Exists(All, known => known.Equals(button, StringComparison.Ordinal));

	public static string Normalize(string? button)
	{
		if (string.IsNullOrWhiteSpace(button))
			return Left;
		var trimmed = button.Trim().ToLowerInvariant();
		return IsSupported(trimmed)
			? trimmed
			: throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				$"'{button}' is not a supported pointer button. Use left, right, or middle.");
	}
}

public static class WindowsPointerActions
{
	public const string Down = "down";
	public const string Move = "move";
	public const string Up = "up";

	public static readonly string[] All = [Down, Move, Up];

	public static string Normalize(string? action)
	{
		var trimmed = action?.Trim().ToLowerInvariant();
		return Array.Exists(All, known => known.Equals(trimmed, StringComparison.Ordinal))
			? trimmed!
			: throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				$"'{action}' is not a supported pointer action. Use down, move, or up.");
	}
}

public static class WindowsKeyActions
{
	public const string Down = "down";
	public const string Up = "up";
	public const string Press = "press";

	public static readonly string[] All = [Down, Up, Press];

	public static string Normalize(string? action)
	{
		if (string.IsNullOrWhiteSpace(action))
			return Press;
		var trimmed = action.Trim().ToLowerInvariant();
		return Array.Exists(All, known => known.Equals(trimmed, StringComparison.Ordinal))
			? trimmed
			: throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				$"'{action}' is not a supported key action. Use down, up, or press.");
	}
}

/// <summary>One resolved key: a Windows virtual-key code and whether it needs the extended flag.</summary>
public readonly record struct WindowsKeyStroke(ushort VirtualKey, bool Extended);

/// <summary>
/// The documented key vocabulary for screenshot-guided input.
///
/// Names are stable, lowercase, and camel-cased for multi-word keys; they map onto documented
/// Windows virtual-key codes. Keys that live on the extended part of the keyboard are flagged, so
/// <c>SendInput</c> sends the scancode form applications expect for arrows, navigation, and the
/// right-hand modifiers rather than their numeric-keypad twins.
///
/// A caller that needs something outside this list may pass <c>vk:0x2F</c> or <c>vk:47</c>, which
/// is an explicit request for one virtual-key code rather than a guess at a name.
/// </summary>
public static class WindowsVirtualKeys
{
	private const string ExplicitPrefix = "vk:";

	private static readonly Dictionary<string, WindowsKeyStroke> Named = Build();

	/// <summary>Every documented name, sorted, for tool descriptions and diagnostics.</summary>
	public static IReadOnlyList<string> Names { get; } =
		[.. Named.Keys.OrderBy(name => name, StringComparer.Ordinal)];

	public static bool TryResolve(string? key, out WindowsKeyStroke stroke)
	{
		stroke = default;
		if (string.IsNullOrWhiteSpace(key))
			return false;

		var trimmed = key.Trim();
		if (trimmed.StartsWith(ExplicitPrefix, StringComparison.OrdinalIgnoreCase))
		{
			var literal = trimmed[ExplicitPrefix.Length..];
			var hex = literal.StartsWith("0x", StringComparison.OrdinalIgnoreCase);
			var parsed = hex
				? ushort.TryParse(
					literal[2..],
					NumberStyles.HexNumber,
					CultureInfo.InvariantCulture,
					out var code)
				: ushort.TryParse(literal, NumberStyles.Integer, CultureInfo.InvariantCulture, out code);
			if (!parsed || code == 0 || code > 0xFE)
				return false;
			stroke = new WindowsKeyStroke(code, Extended: false);
			return true;
		}

		return Named.TryGetValue(trimmed.ToLowerInvariant(), out stroke);
	}

	public static WindowsKeyStroke Resolve(string? key) =>
		TryResolve(key, out var stroke)
			? stroke
			: throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				$"'{key}' is not a known key name. Use a documented name such as enter, tab, f5, " +
				"ctrl, or a, or an explicit virtual-key code such as vk:0x2F.");

	/// <summary>Whether a name is one of the four modifiers a chord may hold.</summary>
	public static bool IsModifier(string? key)
	{
		var trimmed = key?.Trim().ToLowerInvariant();
		return trimmed is "ctrl" or "control" or "alt" or "shift" or "win"
			or "leftctrl" or "rightctrl" or "leftalt" or "rightalt"
			or "leftshift" or "rightshift" or "leftwin" or "rightwin";
	}

	private static Dictionary<string, WindowsKeyStroke> Build()
	{
		var map = new Dictionary<string, WindowsKeyStroke>(StringComparer.Ordinal);

		void Add(string name, int code, bool extended = false) =>
			map[name] = new WindowsKeyStroke((ushort)code, extended);

		for (var letter = 'a'; letter <= 'z'; letter++)
			Add(letter.ToString(), char.ToUpperInvariant(letter));
		for (var digit = 0; digit <= 9; digit++)
			Add(digit.ToString(CultureInfo.InvariantCulture), 0x30 + digit);
		for (var function = 1; function <= 24; function++)
			Add($"f{function}", 0x6F + function);

		Add("backspace", 0x08);
		Add("tab", 0x09);
		Add("clear", 0x0C);
		Add("enter", 0x0D);
		Add("return", 0x0D);
		Add("shift", 0x10);
		Add("ctrl", 0x11);
		Add("control", 0x11);
		Add("alt", 0x12);
		Add("pause", 0x13);
		Add("capslock", 0x14);
		Add("escape", 0x1B);
		Add("esc", 0x1B);
		Add("space", 0x20);
		Add("pageup", 0x21, extended: true);
		Add("pagedown", 0x22, extended: true);
		Add("end", 0x23, extended: true);
		Add("home", 0x24, extended: true);
		Add("left", 0x25, extended: true);
		Add("up", 0x26, extended: true);
		Add("right", 0x27, extended: true);
		Add("down", 0x28, extended: true);
		Add("printscreen", 0x2C, extended: true);
		Add("insert", 0x2D, extended: true);
		Add("delete", 0x2E, extended: true);
		Add("win", 0x5B, extended: true);
		Add("leftwin", 0x5B, extended: true);
		Add("rightwin", 0x5C, extended: true);
		Add("apps", 0x5D, extended: true);
		Add("menu", 0x5D, extended: true);

		Add("numpad0", 0x60);
		Add("numpad1", 0x61);
		Add("numpad2", 0x62);
		Add("numpad3", 0x63);
		Add("numpad4", 0x64);
		Add("numpad5", 0x65);
		Add("numpad6", 0x66);
		Add("numpad7", 0x67);
		Add("numpad8", 0x68);
		Add("numpad9", 0x69);
		Add("multiply", 0x6A);
		Add("add", 0x6B);
		Add("subtract", 0x6D);
		Add("decimal", 0x6E);
		Add("divide", 0x6F, extended: true);

		Add("numlock", 0x90, extended: true);
		Add("scrolllock", 0x91);

		Add("leftshift", 0xA0);
		Add("rightshift", 0xA1, extended: true);
		Add("leftctrl", 0xA2);
		Add("rightctrl", 0xA3, extended: true);
		Add("leftalt", 0xA4);
		Add("rightalt", 0xA5, extended: true);

		Add("semicolon", 0xBA);
		Add("plus", 0xBB);
		Add("comma", 0xBC);
		Add("minus", 0xBD);
		Add("period", 0xBE);
		Add("slash", 0xBF);
		Add("backtick", 0xC0);
		Add("leftbracket", 0xDB);
		Add("backslash", 0xDC);
		Add("rightbracket", 0xDD);
		Add("quote", 0xDE);

		return map;
	}
}

/// <summary>
/// A point in the canonical capture space: selected-window-relative physical capture pixels, with
/// the origin at the top-left of the window's visible content.
/// </summary>
public sealed record WindowsInputPoint
{
	public double X { get; init; }
	public double Y { get; init; }
}

/// <summary>
/// Fields every coordinate-driven request carries.
///
/// <see cref="TransformVersion"/> is the token from the screenshot or stream descriptor the caller
/// measured against; the host re-reads the window's live geometry and refuses a request whose token
/// no longer matches. <see cref="CaptureWidth"/> and <see cref="CaptureHeight"/> say which image
/// size the coordinates are expressed in, so a caller reading a half-scale stream does not have to
/// convert, and so nothing about the browser's rendered size or letterboxing ever takes part in the
/// mapping. Leaving them at zero means the coordinates are already content pixels.
/// </summary>
public sealed record WindowsInputFrame
{
	public string? WindowId { get; init; }
	public string TransformVersion { get; init; } = "";
	public int CaptureWidth { get; init; }
	public int CaptureHeight { get; init; }
}

public sealed record WindowsClickRequest
{
	public string? WindowId { get; init; }
	public string TransformVersion { get; init; } = "";
	public int CaptureWidth { get; init; }
	public int CaptureHeight { get; init; }
	public double X { get; init; }
	public double Y { get; init; }
	public string Button { get; init; } = WindowsPointerButtons.Left;

	/// <summary>1 for a single click, 2 for a double click. Nothing higher is accepted.</summary>
	public int Count { get; init; } = 1;

	/// <summary>Modifier key names held for the duration of the click, then released.</summary>
	public string[] Modifiers { get; init; } = [];
}

public sealed record WindowsPointerRequest
{
	public string? WindowId { get; init; }
	public string TransformVersion { get; init; } = "";
	public int CaptureWidth { get; init; }
	public int CaptureHeight { get; init; }
	public double X { get; init; }
	public double Y { get; init; }

	/// <summary>down, move, or up.</summary>
	public string Action { get; init; } = WindowsPointerActions.Move;
	public string Button { get; init; } = WindowsPointerButtons.Left;
	public string[] Modifiers { get; init; } = [];
}

public sealed record WindowsDragRequest
{
	public string? WindowId { get; init; }
	public string TransformVersion { get; init; } = "";
	public int CaptureWidth { get; init; }
	public int CaptureHeight { get; init; }
	public double StartX { get; init; }
	public double StartY { get; init; }
	public double EndX { get; init; }
	public double EndY { get; init; }
	public string Button { get; init; } = WindowsPointerButtons.Left;
	public int DurationMilliseconds { get; init; } =
		WindowsInputLimits.DefaultDragDurationMilliseconds;
	public int Steps { get; init; } = WindowsInputLimits.DefaultDragSteps;
	public string[] Modifiers { get; init; } = [];
}

public sealed record WindowsWheelRequest
{
	public string? WindowId { get; init; }
	public string TransformVersion { get; init; } = "";
	public int CaptureWidth { get; init; }
	public int CaptureHeight { get; init; }
	public double X { get; init; }
	public double Y { get; init; }

	/// <summary>Vertical notches; positive scrolls up, matching a physical wheel.</summary>
	public double DeltaY { get; init; }

	/// <summary>Horizontal notches; positive scrolls right.</summary>
	public double DeltaX { get; init; }
	public string[] Modifiers { get; init; } = [];
}

public sealed record WindowsKeyRequest
{
	public string? WindowId { get; init; }
	public string TransformVersion { get; init; } = "";

	/// <summary>
	/// Keys to act on, in order. For <c>press</c> they are held in order and released in reverse,
	/// which is what makes ctrl+shift+p a chord rather than three separate taps.
	/// </summary>
	public string[] Keys { get; init; } = [];

	/// <summary>down, up, or press.</summary>
	public string Action { get; init; } = WindowsKeyActions.Press;

	/// <summary>Modifiers held around the whole request.</summary>
	public string[] Modifiers { get; init; } = [];
}

public sealed record WindowsTypeTextRequest
{
	public string? WindowId { get; init; }
	public string TransformVersion { get; init; } = "";

	/// <summary>
	/// UTF-16 text to type as Unicode key events. Sending a long string this way is the supported
	/// alternative to pasting: nothing is ever placed on the user's clipboard, and the text is
	/// never echoed into results or panel activity.
	/// </summary>
	public string Text { get; init; } = "";

	/// <summary>Optional per-character delay for applications that drop fast synthetic input.</summary>
	public int DelayMilliseconds { get; init; }
}

/// <summary>
/// What one input operation did. It reports the geometry and transform token that were current at
/// the moment it ran, so a caller that is looping can carry the fresh token forward instead of
/// taking another screenshot to discover the window moved.
/// </summary>
public sealed record WindowsInputResult
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;
	public bool Success { get; init; } = true;

	/// <summary>Safe operation label, such as <c>click</c>, <c>drag</c>, or <c>key:press</c>.</summary>
	public string Operation { get; init; } = "";
	public string SessionId { get; init; } = "";
	public string WindowId { get; init; } = "";

	/// <summary>The transform token that was current when the operation ran.</summary>
	public string TransformVersion { get; init; } = "";

	/// <summary>Machine-readable reason when Windows refused something the caller may retry.</summary>
	public string? Code { get; init; }
	public string? Detail { get; init; }

	/// <summary>Where the operation acted, in content pixels.</summary>
	public WindowsInputPoint? Point { get; init; }

	/// <summary>Where a drag ended, in content pixels.</summary>
	public WindowsInputPoint? EndPoint { get; init; }

	/// <summary>The same place in physical virtual-desktop pixels, for diagnostics.</summary>
	public WindowsInputPoint? ScreenPoint { get; init; }

	/// <summary>How much text was typed. The text itself is never reported anywhere.</summary>
	public int? CharacterCount { get; init; }

	/// <summary>How many keys a key request acted on.</summary>
	public int? KeyCount { get; init; }

	/// <summary>Whether the target window was actually in the foreground when input was sent.</summary>
	public bool Foreground { get; init; }

	public WindowsCaptureGeometry Geometry { get; init; } = new();
}
