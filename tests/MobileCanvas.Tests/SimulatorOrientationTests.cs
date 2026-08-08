using MobileCanvas.iOS;
using MobileCanvas.Contracts;

namespace MobileCanvas.Tests;

public sealed class SimulatorOrientationTests
{
	[Theory]
	[InlineData("portrait", "portrait")]
	[InlineData("portraitupsidedown", "portrait-upside-down")]
	[InlineData("landscape", "landscape-left")]
	[InlineData("landscaperight", "landscape-right")]
	public void Normalize_ReturnsTheCanonicalValue(string orientation, string expected)
	{
		Assert.Equal(expected, SimulatorOrientation.Normalize(orientation));
	}

	[Fact]
	public void Normalize_RejectsAnUnknownOrientation()
	{
		var exception = Assert.Throws<ArgumentException>(() => SimulatorOrientation.Normalize("face-up"));

		Assert.Contains("landscape-right", exception.Message);
	}

	[Theory]
	[InlineData("landscape-left")]
	[InlineData("landscape-right")]
	public void Apply_SwapsPortraitDimensionsForLandscape(string orientation)
	{
		var display = new DisplayGeometry
		{
			PixelWidth = 1179,
			PixelHeight = 2556,
			PointWidth = 393,
			PointHeight = 852,
			Scale = 3,
		};

		var rotated = SimulatorOrientation.Apply(display, orientation);

		Assert.Equal(2556, rotated.PixelWidth);
		Assert.Equal(1179, rotated.PixelHeight);
		Assert.Equal(852, rotated.PointWidth);
		Assert.Equal(393, rotated.PointHeight);
		Assert.Equal(orientation, rotated.Orientation);
	}

	[Fact]
	public void Apply_PreservesDimensionsWhenOrientationIsUnavailable()
	{
		var display = new DisplayGeometry
		{
			PixelWidth = 1179,
			PixelHeight = 2556,
			PointWidth = 393,
			PointHeight = 852,
			Scale = 3,
		};

		Assert.Same(display, SimulatorOrientation.Apply(display, null));
	}
}
