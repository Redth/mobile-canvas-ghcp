using System.Text.RegularExpressions;
using MobileCanvas.Contracts;

namespace MobileCanvas.Android;

/// <summary>
/// Reads <c>ls -lAL</c> output from the device shell.
/// </summary>
public static partial class LsParser
{
	/// <summary>
	/// Parses a long listing, whose lines read
	/// <c>drwxrwx--x 5 u0_a227 u0_a227 4096 2026-07-31 14:21 files</c>.
	/// </summary>
	/// <remarks>
	/// Split on whitespace only as far as the date, because a file name can contain spaces and the
	/// owner and group columns are not fixed width. Anything that does not look like an entry -- the
	/// "total" header, a warning -- is skipped rather than turned into a file that does not exist.
	/// </remarks>
	public static DeviceFile[] Parse(string? output, string directory)
	{
		if (string.IsNullOrWhiteSpace(output))
			return [];

		var files = new List<DeviceFile>();
		foreach (var rawLine in output.Split('\n'))
		{
			var match = Entry().Match(rawLine.TrimEnd('\r'));
			if (!match.Success)
				continue;

			var name = match.Groups[5].Value;

			// A symlink -L could not follow is still listed, as "name -> target".
			var arrow = name.IndexOf(" -> ", StringComparison.Ordinal);
			if (match.Groups[1].Value[0] == 'l' && arrow > 0)
				name = name[..arrow];

			var isDirectory = match.Groups[1].Value[0] == 'd';

			files.Add(new DeviceFile
			{
				Name = name,
				Path = Join(directory, name),
				IsDirectory = isDirectory,
				Size = isDirectory ? 0 : long.Parse(match.Groups[2].Value),
				Modified = $"{match.Groups[3].Value} {match.Groups[4].Value}",
			});
		}

		return [.. files];
	}

	/// <summary>Joins a directory and a name the way the device addresses them.</summary>
	private static string Join(string directory, string name)
	{
		// The device root is the one directory whose trailing slash is the whole path.
		if (directory == "/")
			return $"/{name}";

		var trimmed = directory.TrimEnd('/');

		// run-as starts in the app's data directory, where "" or "." is how a caller names the root.
		if (trimmed is "" or ".")
			return name;

		return $"{trimmed}/{name}";
	}

	[GeneratedRegex(
		@"^([dlbcps-][rwxsStT-]{9}[.+]?)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s+(.+)$",
		RegexOptions.CultureInvariant)]
	private static partial Regex Entry();
}
