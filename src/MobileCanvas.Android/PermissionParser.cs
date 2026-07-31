using System.Text.RegularExpressions;
using MobileCanvas.Contracts;

namespace MobileCanvas.Android;

/// <summary>
/// Reads the runtime permission state out of <c>dumpsys package</c>.
/// </summary>
public static partial class PermissionParser
{
	/// <summary>
	/// Pulls the <c>runtime permissions:</c> block, whose lines read
	/// <c>android.permission.CAMERA: granted=true, flags=[ USER_SENSITIVE_WHEN_GRANTED ]</c>.
	/// </summary>
	/// <remarks>
	/// Only that block is read. The neighbouring <c>requested permissions:</c> block lists names with
	/// no grant state at all, and <c>install permissions:</c> lists ones the user never gets a say
	/// over, so folding either in would report a permission as denied when it was simply not a runtime
	/// permission in the first place.
	/// </remarks>
	public static Dictionary<string, bool> ParseRuntimePermissions(string? output)
	{
		var permissions = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
		if (string.IsNullOrWhiteSpace(output))
			return permissions;

		var inBlock = false;
		foreach (var rawLine in output.Split('\n'))
		{
			var line = rawLine.TrimEnd('\r');
			var trimmed = line.Trim();

			if (trimmed.Equals("runtime permissions:", StringComparison.OrdinalIgnoreCase))
			{
				inBlock = true;
				continue;
			}

			if (!inBlock)
				continue;

			var match = Entry().Match(trimmed);
			if (match.Success)
			{
				permissions[match.Groups[1].Value] = match.Groups[2].Value
					.Equals("true", StringComparison.OrdinalIgnoreCase);
				continue;
			}

			// dumpsys indents entries under their heading, so the next unindented line ends the block.
			// A wrapped flags list stays indented and is simply skipped by the match above.
			if (trimmed.Length > 0 && trimmed.EndsWith(':') && !trimmed.StartsWith("android.", StringComparison.Ordinal))
				break;
		}

		return permissions;
	}

	[GeneratedRegex(
		@"^([A-Za-z0-9_.]+\.[A-Za-z0-9_]+):\s*granted=(true|false)",
		RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
	private static partial Regex Entry();
}
