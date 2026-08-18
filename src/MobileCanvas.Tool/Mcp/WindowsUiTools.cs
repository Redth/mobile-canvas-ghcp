using System.ComponentModel;
using MobileCanvas.Contracts;
using ModelContextProtocol.Server;
using WindowsCanvas.Contracts;

namespace MobileCanvas.Tool;

/// <summary>
/// Semantic automation for one already-authorized Windows App canvas window. These tools never
/// accept a native HWND; the host turns the opaque window ID back into a live handle only after it
/// has revalidated the panel grant, process identity, logon session, and integrity.
/// </summary>
[McpServerToolType]
public sealed class WindowsUiTools(WindowsHostClient client)
{
	[McpServerTool(
		Name = "windows_app_ui_dump",
		Title = "Read Windows app UI tree",
		ReadOnly = true,
		Destructive = false,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description(
		"Read a bounded, current UI Automation tree for an authorized Windows app window. Prefer this " +
		"and the semantic find/act tools before any future coordinate fallback. Password values and " +
		"text-pattern content are never returned; inaccessible owner-drawn controls may be sparse.")]
	public Task<WindowsUiSnapshot> Dump(
		[Description("Copilot session ID that owns the Windows App canvas.")] string sessionId,
		[Description("Stable Windows App canvas instance ID.")] string instanceId,
		[Description("Opaque authorized window ID from the Windows app session. Never a raw HWND.")] string windowId,
		[Description("Maximum tree depth, from 1 through 32.")] int maximumDepth =
			WindowsUiAutomationLimits.DefaultMaximumDepth,
		[Description("Maximum nodes, from 1 through 5000.")] int maximumNodes =
			WindowsUiAutomationLimits.DefaultMaximumNodes,
		[Description("Bounded helper timeout in milliseconds, up to 30000.")] int timeoutMilliseconds =
			WindowsUiAutomationLimits.DefaultTimeoutMilliseconds,
		CancellationToken cancellationToken = default) =>
		client.GetUiSnapshotAsync(
			Context(sessionId, instanceId),
			windowId,
			new WindowsUiSnapshotRequest
			{
				MaximumDepth = maximumDepth,
				MaximumNodes = maximumNodes,
				TimeoutMilliseconds = timeoutMilliseconds,
			},
			cancellationToken);

	[McpServerTool(
		Name = "windows_app_ui_find",
		Title = "Find Windows app elements",
		ReadOnly = true,
		Destructive = false,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description(
		"Find current semantic UI Automation matches in an authorized Windows app window. Use " +
		"automationId plus controlType first, then controlType plus name/value; use an explicit path " +
		"or index only as a last resort. Multiple matches are reported, never silently narrowed.")]
	public Task<WindowsUiFindResult> Find(
		[Description("Copilot session ID that owns the Windows App canvas.")] string sessionId,
		[Description("Stable Windows App canvas instance ID.")] string instanceId,
		[Description("Opaque authorized window ID from the Windows app session.")] string windowId,
		[Description("Automation ID, used with controlType as the preferred selector.")] string? automationId = null,
		[Description("Normalized control type, for example button, edit, checkbox, or listItem.")] string? controlType = null,
		[Description("Normalized semantic role, for example button, field, checkbox, or dialog.")] string? role = null,
		[Description("Accessible name constraint.")] string? name = null,
		[Description("Non-secret current value constraint. Password values are never observable.")] string? value = null,
		[Description("Require exact name/value matching.")] bool exact = true,
		[Description("Explicit zero-based match ordinal; use only to disambiguate a known stable structure.")] int? index = null,
		[Description("Maximum matches to return.")] int limit = WindowsUiAutomationLimits.DefaultQueryLimit,
		CancellationToken cancellationToken = default) =>
		client.FindUiAsync(
			Context(sessionId, instanceId),
			windowId,
			new WindowsUiQuery
			{
				Selector = Selector(automationId, controlType, role, name, value, exact, index),
				Limit = limit,
			},
			cancellationToken);

	[McpServerTool(
		Name = "windows_app_ui_act",
		Title = "Act on Windows app element",
		Destructive = false,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description(
		"Re-resolve exactly one semantic Windows UI Automation element and invoke, setValue, select, " +
		"toggle, expand, collapse, scroll, or focus it. Prefer this over coordinate control. Zero " +
		"matches and multiple matches are explicit errors; unavailable patterns return a capability " +
		"error; setValue refuses password controls.")]
	public Task<WindowsUiActionResult> Act(
		[Description("Copilot session ID that owns the Windows App canvas.")] string sessionId,
		[Description("Stable Windows App canvas instance ID.")] string instanceId,
		[Description("Opaque authorized window ID from the Windows app session.")] string windowId,
		[Description("Action: invoke, setValue, select, toggle, expand, collapse, scroll, or focus.")] string action,
		[Description("Automation ID, used with controlType as the preferred selector.")] string? automationId = null,
		[Description("Normalized control type.")] string? controlType = null,
		[Description("Normalized semantic role.")] string? role = null,
		[Description("Accessible name constraint.")] string? name = null,
		[Description("Non-secret current value constraint.")] string? matchValue = null,
		[Description("Require exact name/value matching.")] bool exact = true,
		[Description("Explicit zero-based match ordinal; never omitted to mean first.")] int? index = null,
		[Description("Text for setValue only. It is not reflected into results or panel activity.")] string? value = null,
		[Description("Scroll direction for scroll only: up, down, left, or right.")] string? direction = null,
		[Description("Scroll amount for scroll only: small or large.")] string? amount = null,
		CancellationToken cancellationToken = default) =>
		client.ActUiAsync(
			Context(sessionId, instanceId),
			windowId,
			new WindowsUiActionRequest
			{
				Action = action,
				Selector = Selector(automationId, controlType, role, name, matchValue, exact, index),
				Value = value,
				Scroll = direction is null && amount is null
					? null
					: new WindowsUiScrollRequest
					{
						Direction = direction ?? WindowsUiScrollDirections.Down,
						Amount = amount ?? WindowsUiScrollAmounts.Small,
					},
			},
			cancellationToken);

	[McpServerTool(
		Name = "windows_app_ui_wait",
		Title = "Wait for Windows app UI",
		ReadOnly = true,
		Destructive = false,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description(
		"Wait with bounded polling for a semantic UI Automation element to exist or not exist, or for one current element's " +
		"non-secret property/state to equal an expected value. The selector is re-enumerated each poll; " +
		"property/state waits report ambiguity rather than choosing an arbitrary match.")]
	public Task<WindowsUiWaitResult> Wait(
		[Description("Copilot session ID that owns the Windows App canvas.")] string sessionId,
		[Description("Stable Windows App canvas instance ID.")] string instanceId,
		[Description("Opaque authorized window ID from the Windows app session.")] string windowId,
		[Description("Wait condition: exists, notExists, property, or state.")] string condition,
		[Description("Automation ID, used with controlType as the preferred selector.")] string? automationId = null,
		[Description("Normalized control type.")] string? controlType = null,
		[Description("Normalized semantic role.")] string? role = null,
		[Description("Accessible name constraint.")] string? name = null,
		[Description("Non-secret current value constraint.")] string? value = null,
		[Description("Require exact name/value matching.")] bool exact = true,
		[Description("Explicit zero-based match ordinal.")] int? index = null,
		[Description("For property waits: name, enabled, offscreen, focusable, focused, or value.")] string? property = null,
		[Description("Expected non-secret property or state value.")] string? expectedValue = null,
		[Description("Maximum wait duration in milliseconds.")] int timeoutMilliseconds =
			WindowsUiAutomationLimits.DefaultTimeoutMilliseconds,
		[Description("Polling interval in milliseconds, at least 50.")] int pollIntervalMilliseconds =
			WindowsUiAutomationLimits.DefaultPollIntervalMilliseconds,
		CancellationToken cancellationToken = default) =>
		client.WaitUiAsync(
			Context(sessionId, instanceId),
			windowId,
			new WindowsUiWaitRequest
			{
				Selector = Selector(automationId, controlType, role, name, value, exact, index),
				Condition = condition,
				Property = property,
				ExpectedValue = expectedValue,
				TimeoutMilliseconds = timeoutMilliseconds,
				PollIntervalMilliseconds = pollIntervalMilliseconds,
			},
			cancellationToken);

	private static CanvasContextKey Context(string sessionId, string instanceId) =>
		new(sessionId, instanceId, CanvasSurfaces.Windows);

	private static WindowsUiSelector Selector(
		string? automationId,
		string? controlType,
		string? role,
		string? name,
		string? value,
		bool exact,
		int? index) =>
		new()
		{
			AutomationId = automationId,
			ControlType = controlType,
			Role = role,
			Name = name,
			Value = value,
			Exact = exact,
			Index = index,
		};
}
