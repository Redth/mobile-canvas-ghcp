namespace MobileCanvas.Contracts;

/// <summary>
/// A rectangle in logical points, matching the coordinate space every input request already uses so
/// a caller can feed a match straight back into a tap without converting anything.
/// </summary>
public sealed record UiRect
{
	public double X { get; init; }
	public double Y { get; init; }
	public double Width { get; init; }
	public double Height { get; init; }

	public double CenterX => X + (Width / 2);
	public double CenterY => Y + (Height / 2);
}

/// <summary>
/// One node of the on-screen element tree, normalized across platforms.
/// </summary>
/// <remarks>
/// iOS and Android describe the screen very differently -- an accessibility tree of AX roles versus a
/// view hierarchy of Java class names -- so each field here holds whichever of the two is the closest
/// equivalent, and <see cref="RawRole"/> keeps the untranslated original for callers that need to be
/// precise about one platform.
/// </remarks>
public sealed record UiElement
{
	/// <summary>Cross-platform role such as <c>button</c>, <c>text</c> or <c>field</c>.</summary>
	public string Role { get; init; } = UiRoles.Other;

	/// <summary>The platform's own type: an AX role on iOS, a view class name on Android.</summary>
	public string? RawRole { get; init; }

	/// <summary>Visible text, or the accessibility label when the element draws no text.</summary>
	public string? Label { get; init; }

	/// <summary>Current value of a control: field contents, switch state, slider position.</summary>
	public string? Value { get; init; }

	/// <summary>Stable test identifier: an accessibility identifier on iOS, a resource ID on Android.</summary>
	public string? Identifier { get; init; }

	/// <summary>Supplementary description, from AX hints or Android's content description.</summary>
	public string? Hint { get; init; }

	public UiRect? Frame { get; init; }
	public bool Enabled { get; init; } = true;
	public bool Focused { get; init; }

	/// <summary>Whether the element responds to a tap, so a search can skip decorative nodes.</summary>
	public bool Interactable { get; init; }

	public UiElement[] Children { get; init; } = [];
}

public static class UiRoles
{
	public const string Button = "button";
	public const string Text = "text";
	public const string Field = "field";
	public const string Image = "image";
	public const string Switch = "switch";
	public const string Slider = "slider";
	public const string Link = "link";
	public const string Cell = "cell";
	public const string List = "list";
	public const string Tab = "tab";
	public const string Checkbox = "checkbox";
	public const string Container = "container";
	public const string Other = "other";
}

public sealed record UiSnapshot
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public string DeviceId { get; init; } = "";
	public string Platform { get; init; } = "";
	public UiElement? Root { get; init; }
	public int ElementCount { get; init; }

	/// <summary>
	/// The untouched platform payload -- idb's accessibility JSON or uiautomator's XML -- returned
	/// only when asked for, since it is large and duplicates <see cref="Root"/>.
	/// </summary>
	public string? Raw { get; init; }
}

/// <summary>
/// Search terms for locating elements. Every supplied term must match; omitted terms are ignored.
/// </summary>
public sealed record UiQuery
{
	/// <summary>Matched against label, value and hint.</summary>
	public string? Text { get; init; }

	/// <summary>Matched against the accessibility identifier or resource ID.</summary>
	public string? Identifier { get; init; }

	/// <summary>Restricts results to one normalized <see cref="UiRoles"/> value.</summary>
	public string? Role { get; init; }

	/// <summary>Requires the whole field to equal the term rather than contain it.</summary>
	public bool Exact { get; init; }

	/// <summary>Skips elements that do not respond to a tap.</summary>
	public bool InteractableOnly { get; init; }

	public int Limit { get; init; } = 20;
}

public sealed record UiMatch
{
	public UiElement Element { get; init; } = new();

	/// <summary>Centre of the element in logical points, ready to pass to a tap.</summary>
	public double CenterX { get; init; }
	public double CenterY { get; init; }

	/// <summary>Child indexes from the root, so an ambiguous match can still be identified exactly.</summary>
	public string Path { get; init; } = "";
}

public sealed record UiQueryResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public string DeviceId { get; init; } = "";
	public UiMatch[] Matches { get; init; } = [];

	/// <summary>Total matches found, which can exceed <see cref="UiQuery.Limit"/>.</summary>
	public int Total { get; init; }
}

/// <summary>
/// Result of tapping whatever a query matched, reporting the element that was hit so a caller can
/// tell an ambiguous query from a precise one without a second round trip.
/// </summary>
public sealed record UiTapResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public bool Success { get; init; } = true;
	public string DeviceId { get; init; } = "";
	public UiMatch? Match { get; init; }
	public int Total { get; init; }
}
