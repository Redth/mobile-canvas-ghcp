using System.ComponentModel;
using MobileCanvas.Contracts;
using ModelContextProtocol.Server;

namespace MobileCanvas.Tool;

[McpServerToolType]
public sealed class DeviceInteractionTools(DeviceHostClient client)
{
	[McpServerTool(Name = "mobile_device_tap", Title = "Tap device", Destructive = false, OpenWorld = false)]
	[Description("Tap or long-press a booted device at logical point coordinates.")]
	public async Task<OperationResult> Tap(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Horizontal logical point coordinate.")] double x,
		[Description("Vertical logical point coordinate.")] double y,
		[Description("Press duration in seconds; zero performs a tap.")] double duration = 0,
		CancellationToken cancellationToken = default)
	{
		await client.TapAsync(
			deviceId,
			new TapRequest { X = x, Y = y, Duration = duration },
			cancellationToken: cancellationToken).ConfigureAwait(false);
		return Result("tap", deviceId);
	}

	[McpServerTool(Name = "mobile_device_swipe", Title = "Swipe device", Destructive = false, OpenWorld = false)]
	[Description("Swipe or drag across a booted device using logical point coordinates and a duration.")]
	public async Task<OperationResult> Swipe(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Starting horizontal logical point coordinate.")] double startX,
		[Description("Starting vertical logical point coordinate.")] double startY,
		[Description("Ending horizontal logical point coordinate.")] double endX,
		[Description("Ending vertical logical point coordinate.")] double endY,
		[Description("Gesture duration in seconds.")] double duration = 0.35,
		CancellationToken cancellationToken = default)
	{
		await client.SwipeAsync(
			deviceId,
			new SwipeRequest
			{
				StartX = startX,
				StartY = startY,
				EndX = endX,
				EndY = endY,
				Duration = duration,
			},
			cancellationToken: cancellationToken).ConfigureAwait(false);
		return Result("swipe", deviceId);
	}

	[McpServerTool(Name = "mobile_device_type_text", Title = "Type text", Destructive = false, OpenWorld = false)]
	[Description("Type text into the focused control on a booted device, using clipboard paste for unsupported Unicode.")]
	public async Task<OperationResult> TypeText(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Text to enter into the focused control on the device.")] string text,
		CancellationToken cancellationToken = default)
	{
		await client.TypeTextAsync(deviceId, text, cancellationToken: cancellationToken).ConfigureAwait(false);
		return Result("type-text", deviceId);
	}

	[McpServerTool(Name = "mobile_device_press_key", Title = "Press key", Destructive = false, OpenWorld = false)]
	[Description("Press one USB HID keyboard key on a booted device.")]
	public async Task<OperationResult> PressKey(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("USB HID keyboard usage code, such as 40 for Return or 42 for Backspace.")] ulong keyCode,
		CancellationToken cancellationToken = default)
	{
		await client.PressKeyAsync(deviceId, keyCode, cancellationToken: cancellationToken).ConfigureAwait(false);
		return Result("press-key", deviceId);
	}

	[McpServerTool(Name = "mobile_device_press_button", Title = "Press device button", Destructive = false, OpenWorld = false)]
	[Description("Press a hardware button on a booted device. iOS accepts home, lock, side-button, siri, and apple-pay; Android accepts home, back, apps, power, volume-up, volume-down, and menu.")]
	public async Task<OperationResult> PressButton(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Button name. iOS: home, lock, side-button, siri, apple-pay. Android: home, back, apps, lock/power, volume-up, volume-down, menu.")] string button,
		CancellationToken cancellationToken = default)
	{
		await client.PressButtonAsync(deviceId, button, cancellationToken: cancellationToken).ConfigureAwait(false);
		return Result("press-button", deviceId);
	}

	[McpServerTool(Name = "mobile_device_long_press", Title = "Long press device", Destructive = false, OpenWorld = false)]
	[Description("Press and hold a booted device at logical point coordinates, for context menus, drag handles, and icon rearrangement.")]
	public async Task<OperationResult> LongPress(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Horizontal logical point coordinate.")] double x,
		[Description("Vertical logical point coordinate.")] double y,
		[Description("Hold duration in seconds.")] double duration = 1,
		CancellationToken cancellationToken = default)
	{
		await client.TapAsync(
			deviceId,
			new TapRequest { X = x, Y = y, Duration = duration },
			cancellationToken: cancellationToken).ConfigureAwait(false);
		return Result("long-press", deviceId);
	}

	[McpServerTool(Name = "mobile_device_rotate", Title = "Rotate device", Destructive = false, OpenWorld = false)]
	[Description("Rotate a booted device to a new orientation.")]
	public async Task<OperationResult> Rotate(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Target orientation: portrait, portrait-upside-down, landscape-left, or landscape-right.")] string orientation,
		CancellationToken cancellationToken = default)
	{
		await client.RotateAsync(deviceId, orientation, cancellationToken: cancellationToken).ConfigureAwait(false);
		return Result("rotate", deviceId);
	}

	[McpServerTool(Name = "mobile_device_display", Title = "Get device display geometry", ReadOnly = true, Destructive = false, OpenWorld = false)]
	[Description("Get the display geometry of a booted device: logical point size, pixel size, scale, and orientation. Call this before tapping or swiping so coordinates land where intended; all input takes logical points, not pixels.")]
	public Task<DisplayGeometry> Display(
		[Description("Provider-qualified device ID.")] string deviceId,
		CancellationToken cancellationToken = default) =>
		client.GetDisplayAsync(deviceId, cancellationToken);

	private static OperationResult Result(string operation, string deviceId) =>
		new() { Operation = operation, DeviceId = deviceId };
}
