using System.Text.Json;

namespace MobileCanvas.iOS;

/// <summary>
/// Pure parsing for the two Xcode payloads that describe a simulated device's physical display.
/// </summary>
internal static class SimulatorCapabilitiesParser
{
	/// <summary>
	/// Maps device type identifiers to their <c>.simdevicetype</c> bundle paths, from the output of
	/// <c>xcrun simctl list devicetypes --json</c>.
	/// </summary>
	public static IReadOnlyDictionary<string, string> ParseBundlePaths(string json)
	{
		var paths = new Dictionary<string, string>(StringComparer.Ordinal);
		using var document = JsonDocument.Parse(json);
		if (!document.RootElement.TryGetProperty("devicetypes", out var deviceTypes) ||
			deviceTypes.ValueKind != JsonValueKind.Array)
		{
			return paths;
		}

		foreach (var deviceType in deviceTypes.EnumerateArray())
		{
			if (GetString(deviceType, "identifier") is not { Length: > 0 } identifier)
				continue;
			if (GetString(deviceType, "bundlePath") is not { Length: > 0 } bundlePath)
				continue;
			paths[identifier] = bundlePath;
		}

		return paths;
	}

	/// <summary>
	/// Corner radius in points for the built-in display, from a <c>capabilities.plist</c> converted
	/// to JSON.
	/// </summary>
	/// <remarks>
	/// Profiles list several displays -- the panel plus TV-out, CarPlay and the resizable scene --
	/// and only the integrated one describes the device in hand. The framebuffer size disambiguates
	/// when a profile declares more than one, and the top-level <c>DeviceCornerRadius</c> is the
	/// fallback for older profiles that predate per-display radii.
	/// </remarks>
	public static double? ParseCornerRadius(string json, int pixelWidth, int pixelHeight)
	{
		using var document = JsonDocument.Parse(json);
		if (!document.RootElement.TryGetProperty("capabilities", out var capabilities) ||
			capabilities.ValueKind != JsonValueKind.Object)
		{
			return null;
		}

		if (capabilities.TryGetProperty("displays", out var displays) &&
			displays.ValueKind == JsonValueKind.Array)
		{
			JsonElement? integrated = null;
			foreach (var display in displays.EnumerateArray())
			{
				if (GetString(display, "displayType") != "integrated")
					continue;

				integrated ??= display;
				if (GetInt32(display, "width") == pixelWidth && GetInt32(display, "height") == pixelHeight)
				{
					integrated = display;
					break;
				}
			}

			if (integrated is { } panel && GetCornerRadius(panel) is { } perDisplay)
				return perDisplay;
		}

		return GetDouble(capabilities, "DeviceCornerRadius");
	}

	/// <summary>
	/// Largest of the four corner radii. They are equal on every shipping profile; taking the
	/// largest keeps a hypothetical asymmetric panel from being cropped too tightly at one corner.
	/// </summary>
	private static double? GetCornerRadius(JsonElement display)
	{
		double? largest = null;
		foreach (var key in (ReadOnlySpan<string>)["cornerRadiusUL", "cornerRadiusUR", "cornerRadiusLL", "cornerRadiusLR"])
		{
			if (GetDouble(display, key) is { } value)
				largest = largest is { } current ? Math.Max(current, value) : value;
		}

		return largest;
	}

	private static string? GetString(JsonElement element, string propertyName) =>
		element.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.String
			? property.GetString()
			: null;

	private static double? GetDouble(JsonElement element, string propertyName) =>
		element.TryGetProperty(propertyName, out var property) &&
		property.ValueKind == JsonValueKind.Number &&
		property.TryGetDouble(out var value)
			? value
			: null;

	private static int GetInt32(JsonElement element, string propertyName) =>
		element.TryGetProperty(propertyName, out var property) &&
		property.ValueKind == JsonValueKind.Number &&
		property.TryGetInt32(out var value)
			? value
			: 0;
}
