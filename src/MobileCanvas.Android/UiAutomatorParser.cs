using System.Globalization;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using MobileCanvas.Contracts;

namespace MobileCanvas.Android;

/// <summary>
/// Turns a <c>uiautomator dump</c> hierarchy into the normalized element tree.
/// </summary>
internal static partial class UiAutomatorParser
{
	/// <param name="scale">
	/// Display density. uiautomator reports bounds in physical pixels while every other coordinate in
	/// this API is a logical point, so bounds are divided through to match tap and swipe input.
	/// </param>
	public static UiElement? Parse(string dump, double scale)
	{
		var xml = Extract(dump);
		if (xml is null)
			return null;

		XDocument document;
		try
		{
			document = XDocument.Parse(xml);
		}
		catch (XmlException)
		{
			return null;
		}

		if (document.Root is not { } root)
			return null;

		var divisor = scale > 0 ? scale : 1;

		// The <hierarchy> root is a wrapper rather than a view. A single child is the window itself and
		// makes a better root; several children mean multiple windows, which need something to hang off.
		var windows = root.Elements("node").ToArray();
		if (windows.Length == 1)
			return Convert(windows[0], divisor);

		return new UiElement
		{
			Role = UiRoles.Container,
			RawRole = "hierarchy",
			Children = [.. windows.Select(window => Convert(window, divisor))],
		};
	}

	/// <summary>
	/// Isolates the XML document from the surrounding output. Dumping to <c>/dev/tty</c> is the only
	/// way to avoid a second pull off the device, but it also prints a completion notice afterwards.
	/// </summary>
	private static string? Extract(string dump)
	{
		var start = dump.IndexOf("<?xml", StringComparison.Ordinal);
		if (start < 0)
			start = dump.IndexOf("<hierarchy", StringComparison.Ordinal);
		if (start < 0)
			return null;

		const string closing = "</hierarchy>";
		var end = dump.LastIndexOf(closing, StringComparison.Ordinal);
		return end < 0 ? null : dump[start..(end + closing.Length)];
	}

	private static UiElement Convert(XElement node, double scale)
	{
		var className = Attribute(node, "class");
		var text = Attribute(node, "text");
		var description = Attribute(node, "content-desc");
		var clickable = Flag(node, "clickable");

		return new UiElement
		{
			Role = MapRole(className, Flag(node, "checkable")),
			RawRole = className,
			// A view with no text of its own is identified by its content description, which is what a
			// screen reader would announce and therefore what a caller is most likely to search for.
			Label = Coalesce(text, description),
			Value = Flag(node, "checkable") ? (Flag(node, "checked") ? "checked" : "unchecked") : null,
			Identifier = Coalesce(Attribute(node, "resource-id")),
			Hint = string.IsNullOrEmpty(text) ? null : Coalesce(description),
			Frame = ParseBounds(Attribute(node, "bounds"), scale),
			Enabled = Flag(node, "enabled"),
			Focused = Flag(node, "focused"),
			Interactable = clickable || Flag(node, "long-clickable") || Flag(node, "checkable"),
			Children = [.. node.Elements("node").Select(child => Convert(child, scale))],
		};
	}

	private static string MapRole(string? className, bool checkable) => className switch
	{
		null or "" => UiRoles.Other,
		_ when className.EndsWith("Button", StringComparison.Ordinal) =>
			checkable ? UiRoles.Checkbox : UiRoles.Button,
		_ when className.EndsWith("EditText", StringComparison.Ordinal) => UiRoles.Field,
		_ when className.EndsWith("Switch", StringComparison.Ordinal) => UiRoles.Switch,
		_ when className.EndsWith("CheckBox", StringComparison.Ordinal) => UiRoles.Checkbox,
		_ when className.EndsWith("SeekBar", StringComparison.Ordinal) => UiRoles.Slider,
		_ when className.EndsWith("TextView", StringComparison.Ordinal) => UiRoles.Text,
		_ when className.EndsWith("ImageView", StringComparison.Ordinal) => UiRoles.Image,
		_ when className.EndsWith("ImageButton", StringComparison.Ordinal) => UiRoles.Button,
		_ when className.EndsWith("RecyclerView", StringComparison.Ordinal) => UiRoles.List,
		_ when className.EndsWith("ListView", StringComparison.Ordinal) => UiRoles.List,
		_ when className.EndsWith("ScrollView", StringComparison.Ordinal) => UiRoles.List,
		_ when className.EndsWith("TabWidget", StringComparison.Ordinal) => UiRoles.Tab,
		_ when className.EndsWith("Layout", StringComparison.Ordinal) => UiRoles.Container,
		_ when className.EndsWith("ViewGroup", StringComparison.Ordinal) => UiRoles.Container,
		_ => UiRoles.Other,
	};

	private static UiRect? ParseBounds(string? bounds, double scale)
	{
		if (string.IsNullOrEmpty(bounds))
			return null;

		var match = BoundsPattern().Match(bounds);
		if (!match.Success)
			return null;

		var left = ParseDouble(match.Groups[1].Value);
		var top = ParseDouble(match.Groups[2].Value);
		var right = ParseDouble(match.Groups[3].Value);
		var bottom = ParseDouble(match.Groups[4].Value);

		return new UiRect
		{
			X = left / scale,
			Y = top / scale,
			Width = (right - left) / scale,
			Height = (bottom - top) / scale,
		};
	}

	private static double ParseDouble(string value) =>
		double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)
			? parsed
			: 0;

	private static string? Attribute(XElement node, string name) => node.Attribute(name)?.Value;

	private static bool Flag(XElement node, string name) =>
		string.Equals(Attribute(node, name), "true", StringComparison.OrdinalIgnoreCase);

	private static string? Coalesce(params string?[] candidates) =>
		candidates.FirstOrDefault(candidate => !string.IsNullOrWhiteSpace(candidate));

	[GeneratedRegex(@"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]")]
	private static partial Regex BoundsPattern();
}
