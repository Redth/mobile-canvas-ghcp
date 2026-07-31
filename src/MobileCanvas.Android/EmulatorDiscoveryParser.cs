using System.Globalization;

namespace MobileCanvas.Android;

/// <summary>
/// A running emulator as advertised by its discovery file. The emulator writes one of these per
/// process into the per-user "running" directory, and it is the only place that joins an AVD name,
/// an adb serial, and a gRPC endpoint together.
/// </summary>
internal sealed record EmulatorInstance
{
	public int ProcessId { get; init; }
	public string AvdId { get; init; } = "";
	public string AvdName { get; init; } = "";
	public string? AvdDirectory { get; init; }
	public int SerialPort { get; init; }
	public int AdbPort { get; init; }
	public int GrpcPort { get; init; }
	public string? GrpcToken { get; init; }
	public string? EmulatorVersion { get; init; }
	public string? CommandLine { get; init; }

	public string Serial => SerialPort > 0 ? $"emulator-{SerialPort}" : "";

	public bool HasGrpc => GrpcPort > 0;

	/// <summary>
	/// Whether the emulator was launched with host GPU acceleration. Software rendering drops
	/// <c>streamScreenshot</c> from ~50 FPS to ~3 FPS, so this is surfaced as a diagnostic rather
	/// than left to look like a bug in the stream.
	/// </summary>
	public bool LikelySoftwareRendered =>
		CommandLine is { Length: > 0 } cmd &&
		(cmd.Contains("swiftshader", StringComparison.OrdinalIgnoreCase) ||
			cmd.Contains("\"-gpu\" \"guest\"", StringComparison.OrdinalIgnoreCase) ||
			cmd.Contains("\"-gpu\" \"off\"", StringComparison.OrdinalIgnoreCase));
}

internal static class EmulatorDiscoveryParser
{
	/// <summary>
	/// Parses a <c>pid_&lt;pid&gt;.ini</c> discovery file. The format is flat <c>key=value</c> lines;
	/// values are not quoted except for <c>cmdline</c>, which keeps its per-argument quoting.
	/// </summary>
	public static EmulatorInstance? Parse(string contents)
	{
		var values = new Dictionary<string, string>(StringComparer.Ordinal);
		foreach (var rawLine in contents.Split('\n'))
		{
			var line = rawLine.Trim('\r', ' ', '\t');
			if (line.Length == 0 || line[0] == '#')
				continue;

			var separator = line.IndexOf('=');
			if (separator <= 0)
				continue;

			values[line[..separator]] = line[(separator + 1)..];
		}

		if (values.Count == 0)
			return null;

		var avdId = Get("avd.id") ?? Get("avd.name");
		if (string.IsNullOrWhiteSpace(avdId))
			return null;

		return new EmulatorInstance
		{
			ProcessId = GetInt("pid"),
			AvdId = avdId,
			AvdName = Get("avd.name") ?? avdId,
			AvdDirectory = Get("avd.dir"),
			SerialPort = GetInt("port.serial"),
			AdbPort = GetInt("port.adb"),
			GrpcPort = GetInt("grpc.port"),
			GrpcToken = Get("grpc.token"),
			EmulatorVersion = Get("emulator.version"),
			CommandLine = Get("cmdline"),
		};

		string? Get(string key) => values.TryGetValue(key, out var value) && value.Length > 0 ? value : null;

		int GetInt(string key) =>
			Get(key) is { } raw && int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
				? parsed
				: 0;
	}

	/// <summary>
	/// Parses the output of <c>adb devices -l</c> into serial/state pairs. The first line is a
	/// header and offline/unauthorized devices keep their reported state rather than being dropped,
	/// so a stuck emulator stays visible in the catalog.
	/// </summary>
	public static IReadOnlyList<(string Serial, string State)> ParseAdbDevices(string output)
	{
		var results = new List<(string, string)>();
		foreach (var rawLine in output.Split('\n'))
		{
			var line = rawLine.Trim();
			if (line.Length == 0 || line.StartsWith("List of devices", StringComparison.Ordinal))
				continue;

			var parts = line.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries);
			if (parts.Length < 2)
				continue;

			results.Add((parts[0], parts[1]));
		}

		return results;
	}

	/// <summary>
	/// Parses <c>emulator -list-avds</c>. The command prints one AVD id per line but can also emit
	/// unrelated warnings, so anything containing whitespace is ignored.
	/// </summary>
	public static IReadOnlyList<string> ParseAvdList(string output)
	{
		var results = new List<string>();
		foreach (var rawLine in output.Split('\n'))
		{
			var line = rawLine.Trim();
			if (line.Length == 0 || line.Contains(' ') || line.Contains('\t'))
				continue;

			results.Add(line);
		}

		return results;
	}

	/// <summary>
	/// Parses <c>adb shell wm size</c>, which reports "Physical size: WxH" and optionally an
	/// "Override size" that wins when a resolution override is active.
	/// </summary>
	public static (int Width, int Height)? ParseWmSize(string output)
	{
		(int, int)? physical = null;
		(int, int)? over = null;

		foreach (var rawLine in output.Split('\n'))
		{
			var line = rawLine.Trim();
			var separator = line.IndexOf(':');
			if (separator < 0)
				continue;

			var label = line[..separator].Trim();
			var value = line[(separator + 1)..].Trim();
			var cross = value.IndexOf('x');
			if (cross <= 0)
				continue;

			if (!int.TryParse(value[..cross], out var width) ||
				!int.TryParse(value[(cross + 1)..], out var height))
				continue;

			if (label.Equals("Override size", StringComparison.OrdinalIgnoreCase))
				over = (width, height);
			else if (label.Equals("Physical size", StringComparison.OrdinalIgnoreCase))
				physical = (width, height);
		}

		return over ?? physical;
	}

	/// <summary>
	/// Parses <c>adb shell wm density</c>, shaped like <c>wm size</c>. Density is needed to convert
	/// physical pixels into density-independent points for the canvas coordinate transform.
	/// </summary>
	public static int? ParseWmDensity(string output)
	{
		int? physical = null;
		int? over = null;

		foreach (var rawLine in output.Split('\n'))
		{
			var line = rawLine.Trim();
			var separator = line.IndexOf(':');
			if (separator < 0)
				continue;

			var label = line[..separator].Trim();
			if (!int.TryParse(line[(separator + 1)..].Trim(), out var density))
				continue;

			if (label.Equals("Override density", StringComparison.OrdinalIgnoreCase))
				over = density;
			else if (label.Equals("Physical density", StringComparison.OrdinalIgnoreCase))
				physical = density;
		}

		return over ?? physical;
	}

	/// <summary>
	/// Parses the rounded-corner radius, in physical pixels, out of <c>adb shell dumpsys display</c>.
	/// </summary>
	/// <remarks>
	/// The section reads
	/// <c>roundedCorners RoundedCorners{[RoundedCorner{position=TopLeft, radius=28, center=Point(28, 28)}, ...]}</c>
	/// and is the only place the platform states what the panel actually looks like -- the emulator's
	/// framebuffer is a plain rectangle, and the hardware config carries no corner geometry. The
	/// built-in display is dumped first, so the first block is the one that describes the screen the
	/// canvas is showing. Radii are equal on every device seen so far; the largest is taken so an
	/// asymmetric panel is never cropped too tightly.
	/// </remarks>
	public static int? ParseRoundedCornerRadius(string output)
	{
		var start = output.IndexOf("RoundedCorners{", StringComparison.Ordinal);
		if (start < 0)
			return null;

		var end = output.IndexOf("}]}", start, StringComparison.Ordinal);
		// A truncated dump would otherwise let the scan run on into unrelated `radius=` values.
		var block = end >= 0
			? output[start..(end + 3)]
			: output[start..Math.Min(output.Length, start + 512)];

		int? largest = null;
		var cursor = 0;
		while (true)
		{
			var marker = block.IndexOf("radius=", cursor, StringComparison.Ordinal);
			if (marker < 0)
				break;

			cursor = marker + "radius=".Length;
			var digits = cursor;
			while (digits < block.Length && char.IsAsciiDigit(block[digits]))
				digits++;

			if (digits > cursor && int.TryParse(
					block.AsSpan(cursor, digits - cursor),
					NumberStyles.Integer,
					CultureInfo.InvariantCulture,
					out var radius))
			{
				largest = largest is { } current ? Math.Max(current, radius) : radius;
			}

			cursor = digits;
		}

		return largest;
	}
}
