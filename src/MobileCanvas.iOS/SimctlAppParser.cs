using System.Text.Json;
using MobileCanvas.Contracts;

namespace MobileCanvas.iOS;

/// <summary>
/// Reads the app inventory that <c>simctl listapps</c> reports.
/// </summary>
/// <remarks>
/// simctl answers in an OpenStep property list, not JSON, and ignores every flag that asks it to do
/// otherwise. Rather than hand-write a parser for a format Apple has not documented in decades, the
/// backend pipes the output through <c>plutil</c> -- which ships with macOS, so it costs a process
/// rather than a dependency -- and this parses the JSON that comes back.
/// </remarks>
public static class SimctlAppParser
{
	public static InstalledApp[] Parse(string json, IReadOnlyDictionary<string, int>? running = null)
	{
		if (string.IsNullOrWhiteSpace(json))
			return [];

		using var document = JsonDocument.Parse(json);
		if (document.RootElement.ValueKind != JsonValueKind.Object)
			return [];

		var apps = new List<InstalledApp>();
		foreach (var entry in document.RootElement.EnumerateObject())
		{
			if (entry.Value.ValueKind != JsonValueKind.Object)
				continue;

			var bundleId = Text(entry.Value, "CFBundleIdentifier") ?? entry.Name;
			var hasProcess = running is not null && running.TryGetValue(bundleId, out var pid);

			apps.Add(new InstalledApp
			{
				BundleId = bundleId,
				// The display name is what springboard shows; CFBundleName is the shorter internal
				// name and is the better fallback than showing the identifier twice.
				Name = Text(entry.Value, "CFBundleDisplayName") ?? Text(entry.Value, "CFBundleName"),
				Version = Text(entry.Value, "CFBundleShortVersionString"),
				Build = Text(entry.Value, "CFBundleVersion"),
				Kind = string.Equals(Text(entry.Value, "ApplicationType"), "User", StringComparison.OrdinalIgnoreCase)
					? AppKinds.User
					: AppKinds.System,
				Running = hasProcess,
				ProcessId = hasProcess ? running![bundleId] : null,
				Path = Text(entry.Value, "Path"),
				DataContainer = ToPath(Text(entry.Value, "DataContainer")),
			});
		}

		return [.. apps];
	}

	/// <summary>
	/// Maps bundle IDs to process IDs from <c>launchctl list</c>.
	/// </summary>
	/// <remarks>
	/// A running app appears as a job labelled <c>UIKitApplication:&lt;bundle id&gt;[hash][hash]</c>.
	/// That label is the only place the simulator exposes which apps are alive, and reading it is one
	/// call for every app rather than one call each.
	/// </remarks>
	public static Dictionary<string, int> ParseRunning(string? launchctlOutput)
	{
		var running = new Dictionary<string, int>(StringComparer.Ordinal);
		if (string.IsNullOrWhiteSpace(launchctlOutput))
			return running;

		foreach (var line in launchctlOutput.Split('\n', StringSplitOptions.RemoveEmptyEntries))
		{
			var columns = line.Split('\t');
			if (columns.Length < 3)
				continue;

			const string prefix = "UIKitApplication:";
			var label = columns[2].Trim();
			if (!label.StartsWith(prefix, StringComparison.Ordinal))
				continue;

			var bundleId = label[prefix.Length..];
			var bracket = bundleId.IndexOf('[');
			if (bracket > 0)
				bundleId = bundleId[..bracket];

			// A job that has never run reports "-" instead of a PID; it is installed, not running.
			if (bundleId.Length > 0 && int.TryParse(columns[0].Trim(), out var pid))
				running[bundleId] = pid;
		}

		return running;
	}

	/// <summary>
	/// Reads the process ID out of <c>simctl launch</c>, which answers <c>&lt;bundle id&gt;: &lt;pid&gt;</c>.
	/// </summary>
	public static int? ParseLaunchedPid(string? output)
	{
		if (string.IsNullOrWhiteSpace(output))
			return null;

		var separator = output.LastIndexOf(':');
		return separator >= 0 && int.TryParse(output[(separator + 1)..].Trim(), out var pid) ? pid : null;
	}

	private static string? Text(JsonElement element, string name) =>
		element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
			? value.GetString()
			: null;

	/// <summary>
	/// Turns a container <c>file://</c> URL into a plain path, since every filesystem call a caller
	/// would make next takes a path.
	/// </summary>
	private static string? ToPath(string? fileUrl)
	{
		if (string.IsNullOrWhiteSpace(fileUrl))
			return null;

		if (!Uri.TryCreate(fileUrl, UriKind.Absolute, out var uri) || !uri.IsFile)
			return fileUrl;

		return uri.LocalPath.TrimEnd('/');
	}
}
