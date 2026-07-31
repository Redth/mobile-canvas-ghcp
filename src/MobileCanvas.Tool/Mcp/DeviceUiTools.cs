using System.ComponentModel;
using MobileCanvas.Contracts;
using ModelContextProtocol.Server;

namespace MobileCanvas.Tool;

/// <summary>
/// Reads the on-screen accessibility hierarchy so a caller can act on named elements instead of
/// pixel coordinates recovered from a screenshot.
/// </summary>
[McpServerToolType]
public sealed class DeviceUiTools(DeviceHostClient client)
{
	[McpServerTool(Name = "mobile_device_ui_dump", Title = "Read screen elements", Destructive = false, ReadOnly = true, OpenWorld = false)]
	[Description(
		"Read the accessibility hierarchy of whatever is on screen, as a tree of elements with labels, "
		+ "identifiers, roles and logical-point frames. Use this to understand a screen without a screenshot.")]
	public Task<UiSnapshot> Dump(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Also return the untouched platform payload; useful when the normalized tree omits something.")]
		bool includeRaw = false,
		CancellationToken cancellationToken = default) =>
		client.GetUiSnapshotAsync(deviceId, includeRaw, cancellationToken);

	[McpServerTool(Name = "mobile_device_ui_find", Title = "Find screen elements", Destructive = false, ReadOnly = true, OpenWorld = false)]
	[Description(
		"Find on-screen elements by visible text, accessibility identifier, or role. Returns each match "
		+ "with its center point, so the result can be fed straight to a tap.")]
	public Task<UiQueryResult> Find(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Visible text or accessibility label to match; substring and case-insensitive unless exact is set.")]
		string? text = null,
		[Description("Accessibility identifier to match.")] string? identifier = null,
		[Description("Element role: button, text, field, image, switch, slider, link, cell, list, tab, checkbox, container, other.")]
		string? role = null,
		[Description("Require the whole value to match rather than a substring.")] bool exact = false,
		[Description("Maximum number of matches to return.")] int limit = 20,
		CancellationToken cancellationToken = default) =>
		client.FindUiElementsAsync(
			deviceId,
			new UiQuery { Text = text, Identifier = identifier, Role = role, Exact = exact, Limit = limit },
			cancellationToken);

	[McpServerTool(Name = "mobile_device_ui_tap", Title = "Tap element", Destructive = false, OpenWorld = false)]
	[Description(
		"Tap the first element matching a query. Prefer this over coordinate taps: it reads the live "
		+ "hierarchy, so it stays correct when layout, scroll position, or device size changes.")]
	public Task<UiTapResult> Tap(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Visible text or accessibility label to match; substring and case-insensitive unless exact is set.")]
		string? text = null,
		[Description("Accessibility identifier to match.")] string? identifier = null,
		[Description("Element role, for example button, field, or switch.")] string? role = null,
		[Description("Require the whole value to match rather than a substring.")] bool exact = false,
		CancellationToken cancellationToken = default) =>
		client.TapUiElementAsync(
			deviceId,
			new UiQuery { Text = text, Identifier = identifier, Role = role, Exact = exact, Limit = 1 },
			cancellationToken: cancellationToken);
}
