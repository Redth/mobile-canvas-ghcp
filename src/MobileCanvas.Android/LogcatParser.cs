using System.Text.RegularExpressions;
using MobileCanvas.Contracts;

namespace MobileCanvas.Android;

/// <summary>
/// Reads <c>logcat -v threadtime</c> output and <c>dumpsys dropbox</c> listings.
/// </summary>
public static partial class LogcatParser
{
	/// <summary>
	/// Parses <c>logcat -v threadtime</c> lines, which read
	/// <c>MM-DD HH:MM:SS.mmm  PID  TID L TAG: message</c>.
	/// </summary>
	/// <remarks>
	/// Continuation lines -- the frames under a stack trace, say -- carry no header of their own, so
	/// they are appended to the entry above rather than dropped. A stack trace parted from its
	/// exception is the half a caller does not need.
	/// </remarks>
	public static LogEntry[] Parse(string? output)
	{
		if (string.IsNullOrWhiteSpace(output))
			return [];

		var entries = new List<LogEntry>();
		foreach (var rawLine in output.Split('\n'))
		{
			var line = rawLine.TrimEnd('\r');
			if (line.Length == 0)
				continue;

			// logcat announces each buffer it starts reading. That is about logcat, not the device.
			if (line.StartsWith("--------- beginning of", StringComparison.Ordinal))
				continue;

			var match = ThreadTimeLine().Match(line);
			if (match.Success)
			{
				entries.Add(new LogEntry
				{
					Timestamp = match.Groups[1].Value,
					ProcessId = int.Parse(match.Groups[2].Value),
					Level = MapLevel(match.Groups[4].Value[0]),
					Source = match.Groups[5].Value.Trim(),
					Message = match.Groups[6].Value.Trim(),
				});
				continue;
			}

			if (entries.Count > 0)
			{
				var previous = entries[^1];
				entries[^1] = previous with { Message = previous.Message + "\n" + line.Trim() };
			}
		}

		return [.. entries];
	}

	/// <summary>Maps logcat's single-letter priorities onto the shared ladder.</summary>
	private static string MapLevel(char priority) => priority switch
	{
		'V' => LogLevels.Verbose,
		'D' => LogLevels.Debug,
		'I' => LogLevels.Info,
		'W' => LogLevels.Warning,
		'E' => LogLevels.Error,
		'F' or 'A' => LogLevels.Fatal,
		_ => LogLevels.Info,
	};

	/// <summary>
	/// The single-letter priority logcat wants in a filter spec such as <c>*:E</c>.
	/// </summary>
	public static char ToPriority(string? level) => level?.ToLowerInvariant() switch
	{
		LogLevels.Debug => 'D',
		LogLevels.Info => 'I',
		LogLevels.Warning => 'W',
		LogLevels.Error => 'E',
		LogLevels.Fatal => 'F',
		_ => 'V',
	};

	/// <summary>
	/// Parses the entry list <c>dumpsys dropbox</c> prints, whose lines read
	/// <c>2026-07-29 13:57:02 data_app_anr (compressed text, 7111 bytes)</c>.
	/// </summary>
	/// <remarks>
	/// The tag names the failure -- <c>data_app_crash</c>, <c>data_app_anr</c>,
	/// <c>data_app_strictmode</c> -- and its prefix says whether an app or the system was at fault. The
	/// timestamp doubles as the identifier, because that is what dropbox itself takes back.
	/// </remarks>
	public static CrashReport[] ParseDropbox(string? output)
	{
		if (string.IsNullOrWhiteSpace(output))
			return [];

		var reports = new List<CrashReport>();
		foreach (var rawLine in output.Split('\n'))
		{
			var match = DropboxEntry().Match(rawLine.Trim());
			if (!match.Success)
				continue;

			var tag = match.Groups[2].Value;
			reports.Add(new CrashReport
			{
				Id = $"{match.Groups[1].Value}|{tag}",
				Name = tag,
				Timestamp = match.Groups[1].Value,
				Kind = DescribeTag(tag),
			});
		}

		// dropbox prints oldest first; a caller chasing a crash wants the one that just happened.
		reports.Reverse();
		return [.. reports];
	}

	/// <summary>Turns a dropbox tag into something a reader does not have to decode.</summary>
	public static string DescribeTag(string tag)
	{
		if (tag.EndsWith("_native_crash", StringComparison.Ordinal))
			return "native crash";
		if (tag.EndsWith("_anr", StringComparison.Ordinal))
			return "anr";
		if (tag.EndsWith("_crash", StringComparison.Ordinal))
			return "crash";
		if (tag.EndsWith("_strictmode", StringComparison.Ordinal))
			return "strict mode violation";
		if (tag.EndsWith("_wtf", StringComparison.Ordinal))
			return "wtf";
		if (tag.EndsWith("_watchdog", StringComparison.Ordinal))
			return "watchdog";

		return tag;
	}

	/// <summary>
	/// Finds the package a dropbox report blames, which it writes as a "Process:" header.
	/// </summary>
	public static string? FindDropboxPackage(string? content)
	{
		if (string.IsNullOrWhiteSpace(content))
			return null;

		var match = DropboxProcess().Match(content);
		return match.Success ? match.Groups[1].Value.Trim() : null;
	}

	/// <summary>
	/// Pulls the report itself out of <c>dumpsys dropbox --print</c>, which prefixes it with a summary
	/// of the whole drop box and a rule of equals signs.
	/// </summary>
	/// <remarks>
	/// Returns null when no entry followed the preamble. dumpsys says "(No entries found.)" and still
	/// exits zero, so its output length cannot be used to tell a hit from a miss.
	/// </remarks>
	public static string? ExtractDropboxEntry(string? output)
	{
		if (string.IsNullOrWhiteSpace(output))
			return null;

		var lines = output.Split('\n');
		var start = Array.FindIndex(lines, line => line.TrimEnd('\r').StartsWith("====", StringComparison.Ordinal));

		if (start < 0 || start + 1 >= lines.Length)
			return null;

		var body = string.Join('\n', lines.Skip(start + 1)).Trim();
		return body.Length == 0 ? null : body;
	}

	[GeneratedRegex(
		@"^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?):\s?(.*)$",
		RegexOptions.CultureInvariant)]
	private static partial Regex ThreadTimeLine();

	[GeneratedRegex(
		@"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\S+) \(",
		RegexOptions.CultureInvariant)]
	private static partial Regex DropboxEntry();

	[GeneratedRegex(@"^Process:\s*(.+)$", RegexOptions.CultureInvariant | RegexOptions.Multiline)]
	private static partial Regex DropboxProcess();
}
