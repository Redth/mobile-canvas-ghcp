using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using MobileCanvas.Contracts;

namespace MobileCanvas.iOS;

/// <summary>
/// Turns idb's nested accessibility payload into the normalized element tree.
/// </summary>
/// <remarks>
/// The payload is read defensively. idb has carried several spellings of the same idea over its
/// releases -- <c>AXLabel</c> beside <c>label</c>, a structured <c>frame</c> beside the older
/// <c>AXFrame</c> string -- and a companion is installed independently of this tool, so accepting
/// every spelling costs a few lines and avoids an empty tree against an unexpected version.
/// </remarks>
internal static partial class AccessibilityParser
{
	public static UiElement? Parse(string json)
	{
		if (string.IsNullOrWhiteSpace(json))
			return null;

		JsonDocument document;
		try
		{
			document = JsonDocument.Parse(json);
		}
		catch (JsonException)
		{
			return null;
		}

		using (document)
		{
			var root = document.RootElement;

			// A point query returns the single element under the point; a whole-screen query returns the
			// application. Both are handled so callers can share one parser.
			if (root.ValueKind == JsonValueKind.Array)
			{
				var elements = root.EnumerateArray().Select(Convert).ToArray();
				return elements.Length == 1
					? elements[0]
					: new UiElement { Role = UiRoles.Container, RawRole = "screen", Children = elements };
			}

			return root.ValueKind == JsonValueKind.Object ? Convert(root) : null;
		}
	}

	private static UiElement Convert(JsonElement node)
	{
		var role = String(node, "role") ?? String(node, "type") ?? String(node, "AXRole");
		var label = String(node, "AXLabel") ?? String(node, "label") ?? String(node, "title");
		var value = ScalarString(node, "AXValue") ?? ScalarString(node, "value");
		var identifier = String(node, "AXUniqueId") ?? String(node, "identifier") ?? String(node, "AXIdentifier");
		var mapped = MapRole(role, String(node, "subrole"));

		return new UiElement
		{
			Role = mapped,
			RawRole = role,
			Label = Clean(label),
			Value = Clean(value),
			Identifier = Clean(identifier),
			Hint = Clean(String(node, "help") ?? String(node, "AXHelp")),
			Frame = ParseFrame(node),
			Enabled = Bool(node, "enabled") ?? true,
			Focused = Bool(node, "focused") ?? Bool(node, "AXFocused") ?? false,
			Interactable = IsInteractable(mapped) && (Bool(node, "enabled") ?? true),
			Children = ParseChildren(node),
		};
	}

	private static UiElement[] ParseChildren(JsonElement node)
	{
		if (!node.TryGetProperty("children", out var children) || children.ValueKind != JsonValueKind.Array)
		{
			if (!node.TryGetProperty("AXChildren", out children) || children.ValueKind != JsonValueKind.Array)
				return [];
		}

		return [.. children.EnumerateArray()
			.Where(child => child.ValueKind == JsonValueKind.Object)
			.Select(Convert)];
	}

	/// <summary>
	/// iOS reports accessibility frames in points already, so no density conversion is needed here --
	/// unlike Android, whose hierarchy is in pixels.
	/// </summary>
	private static UiRect? ParseFrame(JsonElement node)
	{
		if (node.TryGetProperty("frame", out var frame) && frame.ValueKind == JsonValueKind.Object)
		{
			return new UiRect
			{
				X = Double(frame, "x") ?? 0,
				Y = Double(frame, "y") ?? 0,
				Width = Double(frame, "width") ?? 0,
				Height = Double(frame, "height") ?? 0,
			};
		}

		// Older payloads carry the frame as the CoreGraphics description "{{x, y}, {w, h}}".
		if (String(node, "AXFrame") is { Length: > 0 } text)
		{
			var match = FramePattern().Match(text);
			if (match.Success)
			{
				return new UiRect
				{
					X = ParseDouble(match.Groups[1].Value),
					Y = ParseDouble(match.Groups[2].Value),
					Width = ParseDouble(match.Groups[3].Value),
					Height = ParseDouble(match.Groups[4].Value),
				};
			}
		}

		return null;
	}

	private static string MapRole(string? role, string? subrole)
	{
		if (string.Equals(subrole, "AXSecureTextField", StringComparison.OrdinalIgnoreCase))
			return UiRoles.Field;

		return role switch
		{
			null or "" => UiRoles.Other,
			"AXButton" or "Button" => UiRoles.Button,
			"AXStaticText" or "StaticText" or "Text" => UiRoles.Text,
			"AXTextField" or "TextField" or "AXTextArea" or "TextView" or "SearchField" => UiRoles.Field,
			"AXImage" or "Image" or "Icon" => UiRoles.Image,
			"AXSwitch" or "Switch" or "Toggle" => UiRoles.Switch,
			"AXSlider" or "Slider" => UiRoles.Slider,
			"AXLink" or "Link" => UiRoles.Link,
			"AXCell" or "Cell" or "CollectionCell" => UiRoles.Cell,
			"AXTable" or "Table" or "AXScrollArea" or "ScrollView" or "CollectionView" => UiRoles.List,
			"AXTabBar" or "TabBar" or "AXTab" or "Tab" => UiRoles.Tab,
			"AXCheckBox" or "CheckBox" => UiRoles.Checkbox,
			"AXApplication" or "Application" or "AXWindow" or "Window" or "AXGroup" or "Group" =>
				UiRoles.Container,
			_ => UiRoles.Other,
		};
	}

	/// <summary>
	/// iOS does not publish a "clickable" flag the way Android does, so the role stands in for it.
	/// </summary>
	private static bool IsInteractable(string role) => role is UiRoles.Button or UiRoles.Link
		or UiRoles.Cell or UiRoles.Switch or UiRoles.Tab or UiRoles.Checkbox or UiRoles.Field
		or UiRoles.Slider;

	private static string? Clean(string? value) =>
		string.IsNullOrWhiteSpace(value) || value == "null" ? null : value;

	private static string? String(JsonElement node, string name) =>
		node.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String
			? property.GetString()
			: null;

	private static string? ScalarString(JsonElement node, string name)
	{
		if (!node.TryGetProperty(name, out var property))
			return null;

		return property.ValueKind switch
		{
			JsonValueKind.String => property.GetString(),
			JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False => property.GetRawText(),
			_ => null,
		};
	}

	private static bool? Bool(JsonElement node, string name) =>
		node.TryGetProperty(name, out var property) && property.ValueKind is JsonValueKind.True or JsonValueKind.False
			? property.GetBoolean()
			: null;

	private static double? Double(JsonElement node, string name) =>
		node.TryGetProperty(name, out var property) &&
		property.ValueKind == JsonValueKind.Number &&
		property.TryGetDouble(out var value)
			? value
			: null;

	private static double ParseDouble(string value) =>
		double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;

	[GeneratedRegex(@"\{\{\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\},\s*\{\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\}\}")]
	private static partial Regex FramePattern();
}
