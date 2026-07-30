namespace MobileCanvas.Android;

/// <summary>
/// Translates the shared contract's USB HID usage codes into Android key event names.
/// </summary>
/// <remarks>
/// This only exists for the adb fallback. The emulator's gRPC keyboard path accepts USB HID usage
/// codes natively (<c>KeyCodeType.Usb</c>), so no translation happens on the fast path.
/// </remarks>
internal static class AndroidKeyMap
{
	public static string? UsbToAndroidKeyEvent(ulong usage) => usage switch
	{
		0x28 => "KEYCODE_ENTER",
		0x29 => "KEYCODE_ESCAPE",
		0x2A => "KEYCODE_DEL",
		0x2B => "KEYCODE_TAB",
		0x2C => "KEYCODE_SPACE",
		0x4A => "KEYCODE_MOVE_HOME",
		0x4B => "KEYCODE_PAGE_UP",
		0x4C => "KEYCODE_FORWARD_DEL",
		0x4D => "KEYCODE_MOVE_END",
		0x4E => "KEYCODE_PAGE_DOWN",
		0x4F => "KEYCODE_DPAD_RIGHT",
		0x50 => "KEYCODE_DPAD_LEFT",
		0x51 => "KEYCODE_DPAD_DOWN",
		0x52 => "KEYCODE_DPAD_UP",
		_ => null,
	};
}
