using MobileCanvas.Contracts;

namespace MobileCanvas.Android;

/// <summary>
/// Reads the package inventory that <c>pm list packages</c> reports.
/// </summary>
public static class PackageListParser
{
	/// <summary>
	/// Parses bare <c>package:&lt;name&gt;</c> lines, as printed by <c>pm list packages</c> without
	/// <c>-f</c>.
	/// </summary>
	/// <remarks>
	/// The separator has to be the <em>last</em> <c>=</c>, not the first: modern APK paths embed a
	/// base64 directory name that routinely ends in <c>==</c>, so splitting from the left cuts the path
	/// in half. Package names cannot contain <c>=</c>, which is what makes splitting from the right safe.
	/// That applies here too, because callers sometimes pass <c>-f</c> output through.
	/// </remarks>
	public static string[] ParseNames(string? output)
	{
		if (string.IsNullOrWhiteSpace(output))
			return [];

		var names = new List<string>();
		foreach (var rawLine in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
		{
			var line = rawLine.Trim();
			if (!line.StartsWith("package:", StringComparison.Ordinal))
				continue;

			var body = line["package:".Length..];

			// Drop any trailing "versionCode:n" and then the apk path, if this was -f output.
			var space = body.IndexOf(' ');
			if (space >= 0)
				body = body[..space];

			var separator = body.LastIndexOf('=');
			if (separator >= 0)
				body = body[(separator + 1)..];

			if (body.Length > 0)
				names.Add(body);
		}

		return [.. names];
	}
	/// <summary>
	/// Parses lines of the form <c>package:&lt;apk path&gt;=&lt;package name&gt; versionCode:&lt;n&gt;</c>.
	/// </summary>
	public static InstalledApp[] Parse(
		string? output,
		string kind,
		IReadOnlyDictionary<string, int>? running = null)
	{
		if (string.IsNullOrWhiteSpace(output))
			return [];

		var apps = new List<InstalledApp>();
		foreach (var rawLine in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
		{
			var line = rawLine.Trim();
			if (!line.StartsWith("package:", StringComparison.Ordinal))
				continue;

			line = line["package:".Length..];

			string? build = null;
			var versionMarker = line.LastIndexOf(" versionCode:", StringComparison.Ordinal);
			if (versionMarker >= 0)
			{
				build = line[(versionMarker + " versionCode:".Length)..].Trim();
				line = line[..versionMarker];
			}

			var separator = line.LastIndexOf('=');
			var path = separator > 0 ? line[..separator] : null;
			var packageName = (separator > 0 ? line[(separator + 1)..] : line).Trim();
			if (packageName.Length == 0)
				continue;

			var pid = ResolvePid(running, packageName);
			apps.Add(new InstalledApp
			{
				BundleId = packageName,
				// Android keeps an app's display label in its compiled resources, which cannot be read
				// without pulling and unpacking the APK. Left null rather than filled with the package
				// name, so a caller can tell "no label available" from "the label is the package name".
				Name = null,
				Version = null,
				Build = string.IsNullOrWhiteSpace(build) ? null : build,
				Kind = kind,
				Running = pid is not null,
				ProcessId = pid,
				Path = path,
			});
		}

		return [.. apps];
	}

	/// <summary>
	/// Maps package names to process IDs from <c>ps -A -o PID,NAME</c>.
	/// </summary>
	public static Dictionary<string, int> ParseRunning(string? output)
	{
		var running = new Dictionary<string, int>(StringComparer.Ordinal);
		if (string.IsNullOrWhiteSpace(output))
			return running;

		foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
		{
			var columns = line.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
			if (columns.Length < 2 || !int.TryParse(columns[0], out var pid))
				continue;

			var name = columns[1];
			// Kernel threads are bracketed and every app process is named for its package, so anything
			// without a dot is not an app.
			if (name.StartsWith('[') || !name.Contains('.'))
				continue;

			// A package's extra processes are named "<package>:<suffix>"; the main process wins, so a
			// reported PID is the one a caller would attach a debugger to.
			var colon = name.IndexOf(':');
			if (colon > 0)
			{
				var owner = name[..colon];
				running.TryAdd(owner, pid);
				continue;
			}

			running[name] = pid;
		}

		return running;
	}

	/// <summary>
	/// Reads the launchable component out of <c>cmd package resolve-activity --brief</c>, whose useful
	/// answer is the last line of a block of resolution detail.
	/// </summary>
	public static string? ParseResolvedActivity(string? output)
	{
		if (string.IsNullOrWhiteSpace(output))
			return null;

		var lines = output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
		for (var index = lines.Length - 1; index >= 0; index--)
		{
			var line = lines[index];
			if (line.Contains('/') && !line.Contains(' ') && !line.StartsWith("No ", StringComparison.Ordinal))
				return line;
		}

		return null;
	}

	private static int? ResolvePid(IReadOnlyDictionary<string, int>? running, string packageName) =>
		running is not null && running.TryGetValue(packageName, out var pid) ? pid : null;

	/// <summary>
	/// Returns the line explaining why <c>am start -W</c> did not launch an app, or null when it did.
	/// </summary>
	/// <remarks>
	/// am writes its failures to stdout and still exits zero, so its output is the only reliable
	/// signal. A missing <c>Status:</c> line counts as success rather than failure: older platform
	/// versions do not print one, and the launch still happened.
	/// </remarks>
	public static string? FindLaunchFailure(string? output)
	{
		if (string.IsNullOrWhiteSpace(output))
			return "am produced no output.";

		var lines = output.Split('\n').Select(line => line.Trim()).ToArray();

		// am prints a bare "Error type 3" before the line that says what actually went wrong, so the
		// first Error line is the least useful one. Prefer the one carrying a message.
		var error = lines.FirstOrDefault(line => line.StartsWith("Error:", StringComparison.OrdinalIgnoreCase))
			?? lines.FirstOrDefault(line => line.StartsWith("Error", StringComparison.OrdinalIgnoreCase));
		if (error is not null)
			return error;

		var status = lines.FirstOrDefault(line => line.StartsWith("Status:", StringComparison.OrdinalIgnoreCase));
		if (status is null)
			return null;

		return status["Status:".Length..].Trim().Equals("ok", StringComparison.OrdinalIgnoreCase) ? null : status;
	}
}
