using System.Text.RegularExpressions;
using MobileCanvas.Contracts;

namespace MobileCanvas.iOS;

internal static partial class SimctlDisplayParser
{
	public static DisplayGeometry Parse(string output)
	{
		var screenStart = output.IndexOf("Connected Screens:", StringComparison.Ordinal);
		var displays = screenStart >= 0 ? output[screenStart..] : output;
		var display = SelectPrimaryDisplay(displays);
		var pixelMatch = PixelSizeRegex().Match(display);
		var scaleMatch = ScaleRegex().Match(display);
		var orientationMatch = OrientationRegex().Match(display);

		if (!pixelMatch.Success ||
			!int.TryParse(pixelMatch.Groups[1].Value, out var width) ||
			!int.TryParse(pixelMatch.Groups[2].Value, out var height))
		{
			throw new InvalidOperationException("simctl did not report the simulator display pixel size.");
		}

		var scale = scaleMatch.Success && double.TryParse(
			scaleMatch.Groups[1].Value,
			System.Globalization.CultureInfo.InvariantCulture,
			out var parsedScale)
				? parsedScale
				: InferScale(width);

		return new DisplayGeometry
		{
			PixelWidth = width,
			PixelHeight = height,
			PointWidth = width / scale,
			PointHeight = height / scale,
			Scale = scale,
			Orientation = NormalizeOrientation(orientationMatch.Success ? orientationMatch.Groups[1].Value : null),
		};
	}

	private static string SelectPrimaryDisplay(string output)
	{
		var screens = ScreenRegex().Matches(output)
			.Select(match => new
			{
				Name = match.Groups["name"].Value.Trim(),
				Body = match.Groups["body"].Value,
			})
			.ToArray();

		if (screens.Length == 0)
			return output;

		return screens.FirstOrDefault(screen =>
				ScreenTypeRegex().IsMatch(screen.Body))?.Body
			?? screens.FirstOrDefault(screen =>
				screen.Name.Equals("LCD", StringComparison.OrdinalIgnoreCase))?.Body
			?? screens[0].Body;
	}

	private static double InferScale(int width) => width >= 1000 ? 3 : 2;

	private static string NormalizeOrientation(string? value) =>
		value?.Trim().ToLowerInvariant() switch
		{
			"landscape left" => "landscape-left",
			"landscape right" => "landscape-right",
			"portrait upside down" => "portrait-upside-down",
			_ => "portrait",
		};

	[GeneratedRegex(@"Pixel Size:\s*\{(\d+),\s*(\d+)\}", RegexOptions.CultureInvariant)]
	private static partial Regex PixelSizeRegex();

	[GeneratedRegex(@"Preferred UI Scale:\s*([0-9.]+)", RegexOptions.CultureInvariant)]
	private static partial Regex ScaleRegex();

	[GeneratedRegex(@"UI Orientation:\s*([^\r\n]+)", RegexOptions.CultureInvariant)]
	private static partial Regex OrientationRegex();

	[GeneratedRegex(
		@"^\s*\(\d+\)\s+(?<name>[^:\r\n]+):\s*\r?\n(?<body>.*?)(?=^\s*\(\d+\)\s+[^:\r\n]+:\s*$|\z)",
		RegexOptions.CultureInvariant | RegexOptions.Multiline | RegexOptions.Singleline)]
	private static partial Regex ScreenRegex();

	[GeneratedRegex(@"^\s*Screen Type:\s*Integrated\s*$", RegexOptions.CultureInvariant | RegexOptions.Multiline | RegexOptions.IgnoreCase)]
	private static partial Regex ScreenTypeRegex();
}
