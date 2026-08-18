using System.ComponentModel;
using MobileCanvas.Contracts;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using WindowsCanvas.Contracts;

namespace MobileCanvas.Tool;

/// <summary>
/// Screenshot-guided pointer and keyboard control of one already-authorized Windows App canvas
/// window.
///
/// This is the fallback path. The semantic UI Automation tools resolve a real control and act on
/// it; these tools act on a place, which only stays correct while the window has not moved. That is
/// why every one of them requires the transform token from the screenshot the coordinates were read
/// off, and why a stale token is refused instead of clicked. No tool here accepts a native window
/// handle: the host turns an opaque window ID back into one only after revalidating the panel
/// grant, process identity, logon session, and integrity level.
/// </summary>
[McpServerToolType]
public sealed class WindowsVisualTools(WindowsHostClient client)
{
	[McpServerTool(
		Name = "windows_app_screenshot",
		Title = "Capture Windows app screenshot",
		ReadOnly = true,
		Destructive = false,
		OpenWorld = false)]
	[Description(
		"Capture a PNG of an authorized Windows app window and save it to the Mobile Canvas " +
		"artifacts directory. Prefer the semantic windows_app_ui_* tools for finding and acting on " +
		"controls; use this when a window has no useful UI Automation tree. Coordinates read off " +
		"this image are window-relative physical capture pixels, and every later click, drag, " +
		"wheel, key, or type call must pass back the transformVersion this returns, because a " +
		"window that has since moved, resized, or changed DPI invalidates them.")]
	public async Task<ContentBlock[]> Screenshot(
		[Description("Copilot session ID that owns the Windows App canvas.")] string sessionId,
		[Description("Stable Windows App canvas instance ID.")] string instanceId,
		[Description("Opaque authorized window ID from the Windows app session. Never a raw window handle.")] string windowId,
		[Description("Delivered pixels per content pixel, from 0.1 through 1. Leave at 1 so image coordinates are already the canonical space.")] double scale = 1,
		[Description("Optional clamp on the longest delivered edge, in pixels. 0 applies no extra clamp.")] int maximumDimension = 0,
		[Description("Draw the mouse cursor into the image when this machine allows the choice.")] bool includeCursor = false,
		[Description("Optional absolute output path; omit to use the Mobile Canvas artifacts directory.")] string? outputPath = null,
		CancellationToken cancellationToken = default)
	{
		var screenshot = await client.ScreenshotAsync(
			Context(sessionId, instanceId),
			windowId,
			new WindowsScreenshotRequest
			{
				Scale = scale,
				MaximumDimension = maximumDimension,
				IncludeCursor = includeCursor,
			},
			cancellationToken).ConfigureAwait(false);

		var path = Path.GetFullPath(
			outputPath ?? WindowsCli.CreateScreenshotPath(screenshot.Descriptor.WindowId));
		Directory.CreateDirectory(Path.GetDirectoryName(path)!);
		await File.WriteAllBytesAsync(path, screenshot.Png, cancellationToken).ConfigureAwait(false);

		var geometry = screenshot.Descriptor.Geometry;
		return
		[
			new TextContentBlock
			{
				Text =
					$"Saved {screenshot.Png.Length} byte PNG to {path}. " +
					$"Content {geometry.ContentWidth}x{geometry.ContentHeight} physical pixels, " +
					$"delivered {geometry.CaptureWidth}x{geometry.CaptureHeight} at scale " +
					$"{geometry.Scale:0.###}, DPI {geometry.Dpi}. " +
					$"transformVersion={geometry.TransformVersion}. Pass that token, and the " +
					$"captureWidth/captureHeight above, with any coordinate input. " +
					$"Source {screenshot.Descriptor.Source}" +
					(screenshot.Descriptor.SourceDetail is null
						? "."
						: $" ({screenshot.Descriptor.SourceDetail})."),
			},
			ImageContentBlock.FromBytes(screenshot.Png, "image/png"),
		];
	}

	[McpServerTool(
		Name = "windows_app_click",
		Title = "Click in Windows app window",
		Destructive = false,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description(
		"Click at a window-relative physical capture pixel in an authorized Windows app window. " +
		"Prefer the semantic windows_app_ui_act tool: it re-resolves a real control, while this " +
		"acts on a place. Requires the transformVersion from the screenshot the coordinates were " +
		"measured against; a window that moved, resized, changed DPI, or was minimized is refused " +
		"rather than clicked. Use count 2 for a double click and button right for a context click.")]
	public Task<WindowsInputResult> Click(
		[Description("Copilot session ID that owns the Windows App canvas.")] string sessionId,
		[Description("Stable Windows App canvas instance ID.")] string instanceId,
		[Description("Opaque authorized window ID.")] string windowId,
		[Description("transformVersion from the screenshot or stream descriptor these coordinates came from.")] string transformVersion,
		[Description("X in capture pixels, measured from the left edge of the window's visible content.")] double x,
		[Description("Y in capture pixels, measured from the top edge of the window's visible content.")] double y,
		[Description("Pointer button: left, right, or middle.")] string button = WindowsPointerButtons.Left,
		[Description("1 for a single click, 2 for a double click.")] int count = 1,
		[Description("Width of the image the coordinates were read from; 0 means they are content pixels.")] int captureWidth = 0,
		[Description("Height of the image the coordinates were read from; 0 means they are content pixels.")] int captureHeight = 0,
		[Description("Modifier keys held for the click: ctrl, alt, shift, or win.")] string[]? modifiers = null,
		CancellationToken cancellationToken = default) =>
		client.ClickAsync(
			Context(sessionId, instanceId),
			windowId,
			new WindowsClickRequest
			{
				TransformVersion = transformVersion,
				CaptureWidth = captureWidth,
				CaptureHeight = captureHeight,
				X = x,
				Y = y,
				Button = button,
				Count = count,
				Modifiers = modifiers ?? [],
			},
			cancellationToken);

	[McpServerTool(
		Name = "windows_app_drag",
		Title = "Drag in Windows app window",
		Destructive = false,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description(
		"Press, move along an interpolated path, and release in an authorized Windows app window. " +
		"Prefer semantic windows_app_ui_act operations where the target exposes one. Coordinates " +
		"are window-relative physical capture pixels and require the transformVersion from the " +
		"screenshot they were measured against. The button is always released, including when the " +
		"drag fails partway.")]
	public Task<WindowsInputResult> Drag(
		[Description("Copilot session ID that owns the Windows App canvas.")] string sessionId,
		[Description("Stable Windows App canvas instance ID.")] string instanceId,
		[Description("Opaque authorized window ID.")] string windowId,
		[Description("transformVersion from the screenshot or stream descriptor these coordinates came from.")] string transformVersion,
		[Description("Starting X in capture pixels.")] double startX,
		[Description("Starting Y in capture pixels.")] double startY,
		[Description("Ending X in capture pixels.")] double endX,
		[Description("Ending Y in capture pixels.")] double endY,
		[Description("Pointer button: left, right, or middle.")] string button = WindowsPointerButtons.Left,
		[Description("How long the drag takes, in milliseconds.")] int durationMilliseconds =
			WindowsInputLimits.DefaultDragDurationMilliseconds,
		[Description("How many intermediate moves to send.")] int steps = WindowsInputLimits.DefaultDragSteps,
		[Description("Width of the image the coordinates were read from; 0 means content pixels.")] int captureWidth = 0,
		[Description("Height of the image the coordinates were read from; 0 means content pixels.")] int captureHeight = 0,
		[Description("Modifier keys held for the drag.")] string[]? modifiers = null,
		CancellationToken cancellationToken = default) =>
		client.DragAsync(
			Context(sessionId, instanceId),
			windowId,
			new WindowsDragRequest
			{
				TransformVersion = transformVersion,
				CaptureWidth = captureWidth,
				CaptureHeight = captureHeight,
				StartX = startX,
				StartY = startY,
				EndX = endX,
				EndY = endY,
				Button = button,
				DurationMilliseconds = durationMilliseconds,
				Steps = steps,
				Modifiers = modifiers ?? [],
			},
			cancellationToken);

	[McpServerTool(
		Name = "windows_app_wheel",
		Title = "Scroll in Windows app window",
		Destructive = false,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description(
		"Scroll with the mouse wheel over a point in an authorized Windows app window. Prefer the " +
		"semantic windows_app_ui_act scroll action when the control exposes a scroll pattern. " +
		"Deltas are wheel notches: positive deltaY scrolls up and positive deltaX scrolls right. " +
		"Requires the transformVersion from the screenshot the coordinates were measured against.")]
	public Task<WindowsInputResult> Wheel(
		[Description("Copilot session ID that owns the Windows App canvas.")] string sessionId,
		[Description("Stable Windows App canvas instance ID.")] string instanceId,
		[Description("Opaque authorized window ID.")] string windowId,
		[Description("transformVersion from the screenshot or stream descriptor these coordinates came from.")] string transformVersion,
		[Description("X in capture pixels.")] double x,
		[Description("Y in capture pixels.")] double y,
		[Description("Vertical wheel notches; positive scrolls up.")] double deltaY = 0,
		[Description("Horizontal wheel notches; positive scrolls right.")] double deltaX = 0,
		[Description("Width of the image the coordinates were read from; 0 means content pixels.")] int captureWidth = 0,
		[Description("Height of the image the coordinates were read from; 0 means content pixels.")] int captureHeight = 0,
		[Description("Modifier keys held for the scroll.")] string[]? modifiers = null,
		CancellationToken cancellationToken = default) =>
		client.WheelAsync(
			Context(sessionId, instanceId),
			windowId,
			new WindowsWheelRequest
			{
				TransformVersion = transformVersion,
				CaptureWidth = captureWidth,
				CaptureHeight = captureHeight,
				X = x,
				Y = y,
				DeltaY = deltaY,
				DeltaX = deltaX,
				Modifiers = modifiers ?? [],
			},
			cancellationToken);

	[McpServerTool(
		Name = "windows_app_key",
		Title = "Send keys to Windows app window",
		Destructive = false,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description(
		"Press, hold, or release keys in an authorized Windows app window. Prefer semantic " +
		"windows_app_ui_act operations for buttons and fields; use this for shortcuts and for " +
		"content with no UI Automation tree. Key names are documented lowercase names such as " +
		"enter, tab, escape, f5, home, delete, a, or 1, or an explicit virtual-key code such as " +
		"vk:0x2F. A press holds the keys in order and releases them in reverse, which is what makes " +
		"a chord. Requires the current transformVersion so input cannot reach a window that changed.")]
	public Task<WindowsInputResult> Key(
		[Description("Copilot session ID that owns the Windows App canvas.")] string sessionId,
		[Description("Stable Windows App canvas instance ID.")] string instanceId,
		[Description("Opaque authorized window ID.")] string windowId,
		[Description("transformVersion from the most recent screenshot, stream descriptor, or geometry read.")] string transformVersion,
		[Description("Key names to act on, in order.")] string[] keys,
		[Description("down, up, or press.")] string action = WindowsKeyActions.Press,
		[Description("Modifier keys held around the request: ctrl, alt, shift, or win.")] string[]? modifiers = null,
		CancellationToken cancellationToken = default) =>
		client.KeyAsync(
			Context(sessionId, instanceId),
			windowId,
			new WindowsKeyRequest
			{
				TransformVersion = transformVersion,
				Keys = keys,
				Action = action,
				Modifiers = modifiers ?? [],
			},
			cancellationToken);

	[McpServerTool(
		Name = "windows_app_type_text",
		Title = "Type text into Windows app window",
		Destructive = false,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description(
		"Type UTF-16 text into an authorized Windows app window as Unicode key events. Prefer the " +
		"semantic windows_app_ui_act setValue action when the field exposes a value pattern. This " +
		"is also how a paste-like string is delivered: nothing is ever placed on the user's " +
		"clipboard. Newlines become Return and tabs become Tab. The text is never echoed back into " +
		"results or panel activity; only its length is. Requires the current transformVersion.")]
	public Task<WindowsInputResult> TypeText(
		[Description("Copilot session ID that owns the Windows App canvas.")] string sessionId,
		[Description("Stable Windows App canvas instance ID.")] string instanceId,
		[Description("Opaque authorized window ID.")] string windowId,
		[Description("transformVersion from the most recent screenshot, stream descriptor, or geometry read.")] string transformVersion,
		[Description("Text to type into whichever control currently has focus in that window.")] string text,
		[Description("Optional per-character delay in milliseconds, up to 100, for apps that drop fast synthetic input.")] int delayMilliseconds = 0,
		CancellationToken cancellationToken = default) =>
		client.TypeTextAsync(
			Context(sessionId, instanceId),
			windowId,
			new WindowsTypeTextRequest
			{
				TransformVersion = transformVersion,
				Text = text,
				DelayMilliseconds = delayMilliseconds,
			},
			cancellationToken);

	[McpServerTool(
		Name = "windows_app_geometry",
		Title = "Read Windows app window geometry",
		ReadOnly = true,
		Destructive = false,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description(
		"Read an authorized Windows app window's current geometry and transformVersion without " +
		"capturing an image. Use it to check whether coordinates from an earlier screenshot are " +
		"still valid before spending a capture to find out. Prefer the semantic windows_app_ui_* " +
		"tools over coordinates whenever the window exposes a UI Automation tree.")]
	public Task<WindowsCaptureGeometry> Geometry(
		[Description("Copilot session ID that owns the Windows App canvas.")] string sessionId,
		[Description("Stable Windows App canvas instance ID.")] string instanceId,
		[Description("Opaque authorized window ID.")] string windowId,
		CancellationToken cancellationToken = default) =>
		client.GetGeometryAsync(Context(sessionId, instanceId), windowId, cancellationToken);

	private static CanvasContextKey Context(string sessionId, string instanceId) =>
		new(sessionId, instanceId, CanvasSurfaces.Windows);
}
