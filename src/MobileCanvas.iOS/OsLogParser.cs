using System.Text.Json;
using MobileCanvas.Contracts;

namespace MobileCanvas.iOS;

/// <summary>
/// Reads <c>log show --style ndjson</c> output and the JSON header of an <c>.ips</c> crash report.
/// </summary>
public static class OsLogParser
{
	/// <summary>
	/// Parses one JSON object per line, as <c>log show --style ndjson</c> writes them.
	/// </summary>
	/// <remarks>
	/// ndjson is used over the compact style because the compact style is a formatted table that has to
	/// be unpicked by column, and loses the subsystem and category -- which on Apple platforms say more
	/// about where a line came from than the process name does. The trade is verbosity, and it is paid
	/// once here rather than by every caller.
	///
	/// The stream also carries activity and state events that are not log lines at all; those have no
	/// <c>eventMessage</c> and are skipped.
	/// </remarks>
	public static LogEntry[] Parse(string? output)
	{
		if (string.IsNullOrWhiteSpace(output))
			return [];

		var entries = new List<LogEntry>();
		foreach (var rawLine in output.Split('\n'))
		{
			var line = rawLine.Trim();
			if (line.Length == 0 || line[0] != '{')
				continue;

			LogEntry? entry;
			try
			{
				entry = ParseLine(line);
			}
			catch (JsonException)
			{
				// log show prefixes its output with a header line and can interleave notices. A line it
				// will not stand behind as JSON is not worth failing the whole read for.
				continue;
			}

			if (entry is not null)
				entries.Add(entry);
		}

		return [.. entries];
	}

	private static LogEntry? ParseLine(string line)
	{
		using var document = JsonDocument.Parse(line);
		var root = document.RootElement;

		var message = Text(root, "eventMessage");
		if (message is null)
			return null;

		return new LogEntry
		{
			Timestamp = Text(root, "timestamp") ?? "",
			Level = MapLevel(Text(root, "messageType")),
			Source = ProcessName(Text(root, "processImagePath")) ?? "",
			Message = message,
			ProcessId = root.TryGetProperty("processID", out var pid) && pid.ValueKind == JsonValueKind.Number
				? pid.GetInt32()
				: null,
			Subsystem = Qualify(Text(root, "subsystem"), Text(root, "category")),
		};
	}

	/// <summary>
	/// Maps Apple's message types onto the shared ladder.
	/// </summary>
	/// <remarks>
	/// Apple's ladder has no warning rung, and its "Default" is the ordinary level an app logs at, so it
	/// maps to info rather than inventing a severity the system never assigned.
	/// </remarks>
	private static string MapLevel(string? messageType) => messageType switch
	{
		"Debug" => LogLevels.Debug,
		"Info" => LogLevels.Info,
		"Default" => LogLevels.Info,
		"Error" => LogLevels.Error,
		"Fault" => LogLevels.Fatal,
		_ => LogLevels.Info,
	};

	/// <summary>
	/// The predicate fragment <c>log show</c> wants for a minimum level.
	/// </summary>
	/// <remarks>
	/// messageType is numeric in predicates even though it is a string in the output: 0 Default, 1 Info,
	/// 2 Debug, 16 Error, 17 Fault. Anything at or below Default is left unfiltered, because excluding
	/// debug and info from the log's own query drops lines the caller may have written on purpose.
	/// </remarks>
	public static string? ToPredicate(string? level) => level?.ToLowerInvariant() switch
	{
		LogLevels.Warning or LogLevels.Error => "messageType == 16 OR messageType == 17",
		LogLevels.Fatal => "messageType == 17",
		_ => null,
	};

	/// <summary>
	/// Reads the JSON header of an <c>.ips</c> crash report.
	/// </summary>
	/// <remarks>
	/// An .ips file is a JSON header line followed by a second, much larger JSON body. Only the header
	/// is read to summarize a report, which keeps listing a directory of them cheap.
	///
	/// <c>is_simulated</c> is the field that matters most: the same directory holds crashes from the
	/// host Mac, and returning a developer's unrelated desktop crashes as "device crashes" would be both
	/// wrong and a leak of things they did not ask about.
	/// </remarks>
	public static CrashReport? ParseReportHeader(string? headerLine, string id)
	{
		if (string.IsNullOrWhiteSpace(headerLine))
			return null;

		try
		{
			using var document = JsonDocument.Parse(headerLine);
			var root = document.RootElement;

			if (!root.TryGetProperty("is_simulated", out var simulated) || simulated.GetInt32() != 1)
				return null;

			return new CrashReport
			{
				Id = id,
				Name = Text(root, "app_name") ?? Text(root, "name") ?? id,
				BundleId = Text(root, "bundleID"),
				Timestamp = Text(root, "timestamp") ?? "",
				Kind = DescribeBugType(Text(root, "bug_type")),
			};
		}
		catch (JsonException)
		{
			return null;
		}
	}

	/// <summary>Names the bug types a simulator actually produces; passes anything else through.</summary>
	private static string DescribeBugType(string? bugType) => bugType switch
	{
		"109" => "crash",
		"309" => "user fault",
		"288" => "hang",
		"144" => "memory",
		null => "crash",
		_ => $"type {bugType}",
	};

	/// <summary>Trims an executable path down to the process name that <c>log show</c> matches on.</summary>
	private static string? ProcessName(string? path)
	{
		if (string.IsNullOrWhiteSpace(path))
			return null;

		var slash = path.LastIndexOf('/');
		return slash < 0 ? path : path[(slash + 1)..];
	}

	/// <summary>Joins subsystem and category the way Apple's own tools print them.</summary>
	private static string? Qualify(string? subsystem, string? category)
	{
		if (string.IsNullOrWhiteSpace(subsystem))
			return null;

		return string.IsNullOrWhiteSpace(category) ? subsystem : $"{subsystem}:{category}";
	}

	private static string? Text(JsonElement element, string name) =>
		element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
			? value.GetString()
			: null;
}
