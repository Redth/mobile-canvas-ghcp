namespace WindowsCanvas.Contracts;

/// <summary>
/// Hard limits shared by the public Windows UI Automation surface and its native helper. They keep
/// one inaccessible or unusually deep provider from turning a diagnostic request into an unbounded
/// cross-process traversal.
/// </summary>
public static class WindowsUiAutomationLimits
{
	public const int DefaultMaximumDepth = 12;
	public const int MaximumDepth = 32;
	public const int DefaultMaximumNodes = 500;
	public const int MaximumNodes = 5_000;
	public const int DefaultTimeoutMilliseconds = 5_000;
	public const int MaximumTimeoutMilliseconds = 30_000;
	public const int DefaultQueryLimit = 50;
	public const int MaximumQueryLimit = 500;
	public const int DefaultPollIntervalMilliseconds = 200;
	public const int MinimumPollIntervalMilliseconds = 50;
}

/// <summary>One physical-pixel rectangle in desktop screen coordinates.</summary>
public sealed record WindowsUiPhysicalPixelRect
{
	public int Left { get; init; }
	public int Top { get; init; }
	public int Width { get; init; }
	public int Height { get; init; }
}

/// <summary>
/// Normalized UI Automation control types. The native control type remains available in
/// <see cref="WindowsUiElement.ControlType"/>, while <see cref="WindowsUiElement.Role"/> gives
/// callers a compact cross-framework vocabulary.
/// </summary>
public static class WindowsUiControlTypes
{
	public const string Unknown = "unknown";
	public const string Button = "button";
	public const string Calendar = "calendar";
	public const string CheckBox = "checkBox";
	public const string ComboBox = "comboBox";
	public const string Custom = "custom";
	public const string DataGrid = "dataGrid";
	public const string DataItem = "dataItem";
	public const string Document = "document";
	public const string Edit = "edit";
	public const string Group = "group";
	public const string Header = "header";
	public const string HeaderItem = "headerItem";
	public const string Hyperlink = "hyperlink";
	public const string Image = "image";
	public const string List = "list";
	public const string ListItem = "listItem";
	public const string Menu = "menu";
	public const string MenuBar = "menuBar";
	public const string MenuItem = "menuItem";
	public const string Pane = "pane";
	public const string ProgressBar = "progressBar";
	public const string RadioButton = "radioButton";
	public const string ScrollBar = "scrollBar";
	public const string Separator = "separator";
	public const string Slider = "slider";
	public const string Spinner = "spinner";
	public const string SplitButton = "splitButton";
	public const string StatusBar = "statusBar";
	public const string Tab = "tab";
	public const string TabItem = "tabItem";
	public const string Table = "table";
	public const string Text = "text";
	public const string Thumb = "thumb";
	public const string TitleBar = "titleBar";
	public const string ToolBar = "toolBar";
	public const string ToolTip = "toolTip";
	public const string Tree = "tree";
	public const string TreeItem = "treeItem";
	public const string Window = "window";
}

/// <summary>Compact semantic roles mapped from native UI Automation control types.</summary>
public static class WindowsUiRoles
{
	public const string Unknown = "unknown";
	public const string Button = "button";
	public const string CheckBox = "checkbox";
	public const string ComboBox = "combobox";
	public const string Dialog = "dialog";
	public const string Field = "field";
	public const string Image = "image";
	public const string Link = "link";
	public const string List = "list";
	public const string ListItem = "listItem";
	public const string Menu = "menu";
	public const string MenuItem = "menuItem";
	public const string Progress = "progress";
	public const string RadioButton = "radio";
	public const string ScrollBar = "scrollbar";
	public const string Slider = "slider";
	public const string Tab = "tab";
	public const string TabItem = "tabItem";
	public const string Text = "text";
	public const string Tree = "tree";
	public const string TreeItem = "treeItem";
	public const string Window = "window";
	public const string Container = "container";
}

/// <summary>Cached, non-secret properties of one UI Automation element.</summary>
public sealed record WindowsUiProperties
{
	public string? Name { get; init; }
	public string? AutomationId { get; init; }
	public string? ClassName { get; init; }
	public string? FrameworkId { get; init; }
	public bool? Enabled { get; init; }
	public bool? Offscreen { get; init; }
	public bool? Focusable { get; init; }
	public bool? Focused { get; init; }
	public bool? Password { get; init; }

	/// <summary>
	/// The current Value pattern value only when the element is not a password field. Text pattern
	/// contents are never requested or exposed by this protocol.
	/// </summary>
	public string? Value { get; init; }

	/// <summary>
	/// A normalized state such as <c>on</c>, <c>off</c>, <c>expanded</c>, <c>collapsed</c>,
	/// <c>selected</c>, or <c>unselected</c>.
	/// </summary>
	public string? State { get; init; }
}

/// <summary>Whether an element currently supports a semantic UI Automation operation.</summary>
public sealed record WindowsUiSupportedActions
{
	public bool Invoke { get; init; }
	public bool SetValue { get; init; }
	public bool Select { get; init; }
	public bool Toggle { get; init; }
	public bool Expand { get; init; }
	public bool Collapse { get; init; }
	public bool Scroll { get; init; }
	public bool Focus { get; init; }
}

/// <summary>One bounded UI Automation node. Runtime IDs are diagnostics only and are never durable selectors.</summary>
public sealed record WindowsUiElement
{
	/// <summary>
	/// Reserved for an ephemeral UI Automation runtime identifier when a provider can safely expose
	/// one. It is diagnostic inside one snapshot only; callers must use
	/// <see cref="WindowsUiSelector"/> to resolve a fresh element before every operation.
	/// </summary>
	public string? RuntimeId { get; init; }

	public string ControlType { get; init; } = WindowsUiControlTypes.Unknown;
	public string Role { get; init; } = WindowsUiRoles.Unknown;
	public WindowsUiPhysicalPixelRect? Bounds { get; init; }
	public WindowsUiProperties Properties { get; init; } = new();
	public WindowsUiSupportedActions SupportedActions { get; init; } = new();
	public WindowsUiElement[] Children { get; init; } = [];
}

/// <summary>Common bounded traversal metadata returned by snapshot, query, action, and wait.</summary>
public sealed record WindowsUiOperationMetadata
{
	public bool Truncated { get; init; }
	public bool TimedOut { get; init; }
	public int NodeCount { get; init; }
	public int MaximumDepth { get; init; }
	public int MaximumNodes { get; init; }
	public int ElapsedMilliseconds { get; init; }
	public string? Detail { get; init; }
}

public sealed record WindowsUiSnapshotRequest
{
	public int MaximumDepth { get; init; } = WindowsUiAutomationLimits.DefaultMaximumDepth;
	public int MaximumNodes { get; init; } = WindowsUiAutomationLimits.DefaultMaximumNodes;
	public int TimeoutMilliseconds { get; init; } = WindowsUiAutomationLimits.DefaultTimeoutMilliseconds;
}

/// <summary>A capped tree rooted at one authorized top-level window.</summary>
public sealed record WindowsUiSnapshot
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;
	public WindowsUiElement? Root { get; init; }
	public WindowsUiOperationMetadata Metadata { get; init; } = new();
}

/// <summary>
/// Stable semantic selector fields. Resolution deliberately prefers AutomationId + ControlType,
/// then ControlType + Name/value, then explicitly-qualified ancestry, index, or path. Runtime IDs
/// and native handles are intentionally not selector fields.
/// </summary>
public sealed record WindowsUiSelector
{
	public string? AutomationId { get; init; }
	public string? ControlType { get; init; }
	public string? Role { get; init; }
	public string? Name { get; init; }
	public string? Value { get; init; }
	public bool Exact { get; init; } = true;

	/// <summary>
	/// Ancestors from the root toward the parent. This is only considered when neither preferred
	/// selector form is present.
	/// </summary>
	public WindowsUiSelector[] Ancestors { get; init; } = [];

	/// <summary>
	/// Explicit zero-based child indexes from the window root. Like <see cref="Index"/>, this is a
	/// last-resort qualified locator and never an implicit "first match" rule.
	/// </summary>
	public int[] Path { get; init; } = [];

	/// <summary>Explicit zero-based ordinal among otherwise matching elements.</summary>
	public int? Index { get; init; }
}

/// <summary>
/// Selector precedence shared by API documentation, client tooling, and tests. The native helper
/// still re-resolves against a live tree; this classification never turns an element into a durable
/// handle or chooses among multiple matches.
/// </summary>
public static class WindowsUiSelectorPrecedence
{
	public const string AutomationIdAndControlType = "automationIdAndControlType";
	public const string ControlTypeAndNameOrValue = "controlTypeAndNameOrValue";
	public const string SemanticConstraint = "semanticConstraint";
	public const string QualifiedFallback = "qualifiedFallback";

	public static string? Classify(WindowsUiSelector? selector)
	{
		if (selector is null)
			return null;
		var hasType = !string.IsNullOrWhiteSpace(selector.ControlType) ||
			!string.IsNullOrWhiteSpace(selector.Role);
		if (hasType && !string.IsNullOrWhiteSpace(selector.AutomationId))
			return AutomationIdAndControlType;
		if (hasType &&
			(!string.IsNullOrWhiteSpace(selector.Name) ||
				!string.IsNullOrWhiteSpace(selector.Value)))
		{
			return ControlTypeAndNameOrValue;
		}
		if (hasType ||
			!string.IsNullOrWhiteSpace(selector.AutomationId) ||
			!string.IsNullOrWhiteSpace(selector.Name) ||
			!string.IsNullOrWhiteSpace(selector.Value))
		{
			return SemanticConstraint;
		}
		return (selector.Ancestors?.Length ?? 0) > 0 ||
			(selector.Path?.Length ?? 0) > 0 ||
			selector.Index.HasValue
				? QualifiedFallback
				: null;
	}
}

public sealed record WindowsUiQuery
{
	public WindowsUiSelector Selector { get; init; } = new();
	public int Limit { get; init; } = WindowsUiAutomationLimits.DefaultQueryLimit;
	public int MaximumDepth { get; init; } = WindowsUiAutomationLimits.DefaultMaximumDepth;
	public int MaximumNodes { get; init; } = WindowsUiAutomationLimits.DefaultMaximumNodes;
	public int TimeoutMilliseconds { get; init; } = WindowsUiAutomationLimits.DefaultTimeoutMilliseconds;
}

public sealed record WindowsUiMatch
{
	public WindowsUiElement Element { get; init; } = new();

	/// <summary>The qualified selector the helper derived for this match, excluding runtime IDs.</summary>
	public WindowsUiSelector Selector { get; init; } = new();
}

public sealed record WindowsUiFindResult
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;
	public WindowsUiMatch[] Matches { get; init; } = [];
	public int TotalMatches { get; init; }
	public WindowsUiOperationMetadata Metadata { get; init; } = new();
}

public static class WindowsUiActionKinds
{
	public const string Invoke = "invoke";
	public const string SetValue = "setValue";
	public const string Select = "select";
	public const string Toggle = "toggle";
	public const string Expand = "expand";
	public const string Collapse = "collapse";
	public const string Scroll = "scroll";
	public const string Focus = "focus";
}

public static class WindowsUiScrollDirections
{
	public const string Up = "up";
	public const string Down = "down";
	public const string Left = "left";
	public const string Right = "right";
}

public static class WindowsUiScrollAmounts
{
	public const string Small = "small";
	public const string Large = "large";
}

public sealed record WindowsUiScrollRequest
{
	public string Direction { get; init; } = WindowsUiScrollDirections.Down;
	public string Amount { get; init; } = WindowsUiScrollAmounts.Small;
}

public sealed record WindowsUiActionRequest
{
	public string Action { get; init; } = "";
	public WindowsUiSelector Selector { get; init; } = new();

	/// <summary>
	/// Text supplied to a Value pattern. It is accepted only for non-password controls, never
	/// copied into a result or activity event, and is sent to the helper through stdin rather than a
	/// process command line.
	/// </summary>
	public string? Value { get; init; }
	public WindowsUiScrollRequest? Scroll { get; init; }
	public int MaximumDepth { get; init; } = WindowsUiAutomationLimits.DefaultMaximumDepth;
	public int MaximumNodes { get; init; } = WindowsUiAutomationLimits.DefaultMaximumNodes;
	public int TimeoutMilliseconds { get; init; } = WindowsUiAutomationLimits.DefaultTimeoutMilliseconds;
}

public sealed record WindowsUiActionResult
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;
	public bool Success { get; init; }
	public string Action { get; init; } = "";
	public string? Code { get; init; }
	public string? Detail { get; init; }
	public WindowsUiMatch? Match { get; init; }
	public int? ValueLength { get; init; }
	public WindowsUiOperationMetadata Metadata { get; init; } = new();
}

public static class WindowsUiWaitConditions
{
	public const string Exists = "exists";
	public const string NotExists = "notExists";
	public const string Property = "property";
	public const string State = "state";
}

public sealed record WindowsUiWaitRequest
{
	public WindowsUiSelector Selector { get; init; } = new();
	public string Condition { get; init; } = WindowsUiWaitConditions.Exists;

	/// <summary>
	/// For <c>property</c>, one of name, enabled, offscreen, focusable, focused, or value. Password
	/// values are never observable or waitable.
	/// </summary>
	public string? Property { get; init; }
	public string? ExpectedValue { get; init; }
	public int TimeoutMilliseconds { get; init; } = WindowsUiAutomationLimits.DefaultTimeoutMilliseconds;
	public int PollIntervalMilliseconds { get; init; } =
		WindowsUiAutomationLimits.DefaultPollIntervalMilliseconds;
	public int MaximumDepth { get; init; } = WindowsUiAutomationLimits.DefaultMaximumDepth;
	public int MaximumNodes { get; init; } = WindowsUiAutomationLimits.DefaultMaximumNodes;
}

public sealed record WindowsUiWaitResult
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;
	public bool Satisfied { get; init; }
	public string Condition { get; init; } = "";
	public string? Code { get; init; }
	public string? Detail { get; init; }
	public WindowsUiMatch? Match { get; init; }
	public WindowsUiOperationMetadata Metadata { get; init; } = new();
}

public sealed record WindowsHelperUiSnapshot
{
	public int SchemaVersion { get; init; }
	public bool Ok { get; init; }
	public string HelperVersion { get; init; } = "";
	public WindowsUiSnapshot? Result { get; init; }
}

public sealed record WindowsHelperUiFind
{
	public int SchemaVersion { get; init; }
	public bool Ok { get; init; }
	public string HelperVersion { get; init; } = "";
	public WindowsUiFindResult? Result { get; init; }
}

public sealed record WindowsHelperUiAction
{
	public int SchemaVersion { get; init; }
	public bool Ok { get; init; }
	public string HelperVersion { get; init; } = "";
	public WindowsUiActionResult? Result { get; init; }
}

public sealed record WindowsHelperUiWait
{
	public int SchemaVersion { get; init; }
	public bool Ok { get; init; }
	public string HelperVersion { get; init; } = "";
	public WindowsUiWaitResult? Result { get; init; }
}
