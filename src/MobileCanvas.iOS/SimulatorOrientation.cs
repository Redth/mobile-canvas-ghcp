namespace MobileCanvas.iOS;

internal static class SimulatorOrientation
{
	public static string Normalize(string orientation)
	{
		return orientation.ToLowerInvariant() switch
		{
			"portrait" => "portrait",
			"portrait-upside-down" or "portraitupsidedown" => "portrait-upside-down",
			"landscape" or "landscape-left" or "landscapeleft" => "landscape-left",
			"landscape-right" or "landscaperight" => "landscape-right",
			_ => throw new ArgumentException(
				"Orientation must be portrait, portrait-upside-down, landscape-left, or landscape-right.",
				nameof(orientation)),
		};
	}

	public static MobileCanvas.Contracts.DisplayGeometry Apply(
		MobileCanvas.Contracts.DisplayGeometry display,
		string? orientation)
	{
		if (orientation is not (
			"portrait" or "portrait-upside-down" or "landscape-left" or "landscape-right"))
			return display;

		var landscape = orientation.StartsWith("landscape", StringComparison.Ordinal);
		var dimensionsAreLandscape = display.PointWidth > display.PointHeight;
		if (landscape == dimensionsAreLandscape)
			return display with { Orientation = orientation };

		return display with
		{
			PixelWidth = display.PixelHeight,
			PixelHeight = display.PixelWidth,
			PointWidth = display.PointHeight,
			PointHeight = display.PointWidth,
			Orientation = orientation,
		};
	}
}
