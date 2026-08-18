using WindowsCanvas.Contracts;
using WindowsCanvas.Windows;

namespace WindowsCanvas.Tests;

/// <summary>
/// The arithmetic that decides where a click lands.
///
/// None of it needs a desktop, and all of it needs to be right on desks that are not the one this
/// was written on: two monitors with different scaling, a primary display that is not the leftmost,
/// and a browser that scaled the picture to whatever fit.
/// </summary>
public sealed class WindowsCaptureGeometryTests
{
	private static readonly WindowsWindowKey Identity = new(0x1234, 4242, 130000000000000000, null);

	[Fact]
	public void Build_SeparatesFrameContentAndClientOrigins()
	{
		var geometry = Win32WindowGeometry.Build(
			frame: new WindowsWindowBounds { Left = 92, Top = 100, Width = 816, Height = 608 },
			content: new WindowsWindowBounds { Left = 100, Top = 100, Width = 800, Height = 600 },
			client: new WindowsWindowBounds { Left = 101, Top = 132, Width = 798, Height = 567 },
			dpi: 144,
			minimized: false);

		// The window rectangle starts eight pixels left of what a person sees, because Windows
		// keeps an invisible resize border there.
		Assert.Equal(8, geometry.VisibleOffset.X);
		Assert.Equal(0, geometry.VisibleOffset.Y);
		Assert.Equal(-8, geometry.FrameOffset.X);
		Assert.Equal(1, geometry.ClientOffset.X);
		Assert.Equal(32, geometry.ClientOffset.Y);
		Assert.Equal(800, geometry.ContentWidth);
		Assert.Equal(800, geometry.CaptureWidth);
		Assert.Equal(1, geometry.Scale);
		Assert.Equal(144u, geometry.Dpi);
		Assert.Equal(1.5, geometry.DpiScale);
	}

	[Fact]
	public void ToContent_IsIndependentOfHowTheImageWasScaled()
	{
		var geometry = Fixtures.Geometry(contentWidth: 800, contentHeight: 600);

		var full = WindowsInputMapper.ToContent(400, 300, 800, 600, geometry);
		var half = WindowsInputMapper.ToContent(200, 150, 400, 300, geometry);
		var implicitContent = WindowsInputMapper.ToContent(400, 300, 0, 0, geometry);

		// The same place in the window, whichever size the caller measured it in. Nothing about a
		// panel's rendered size or its letterboxing takes part.
		Assert.Equal(400, full.X);
		Assert.Equal(400, half.X);
		Assert.Equal(300, half.Y);
		Assert.Equal(400, implicitContent.X);
	}

	[Fact]
	public void ToScreen_HandlesNegativeVirtualDesktopCoordinates()
	{
		var geometry = Fixtures.Geometry(left: -1920, top: -200);

		var (x, y) = WindowsInputMapper.ToScreen(
			new WindowsInputPoint { X = 10, Y = 20 },
			geometry);

		Assert.Equal(-1910, x);
		Assert.Equal(-180, y);
	}

	[Fact]
	public void ToAbsolute_NormalizesAcrossAVirtualDesktopWithANegativeOrigin()
	{
		var desktop = new WindowsWindowBounds
		{
			Left = -1920,
			Top = -200,
			Width = 3840,
			Height = 1280,
		};

		var origin = WindowsInputMapper.ToAbsolute(-1920, -200, desktop);
		var far = WindowsInputMapper.ToAbsolute(1919, 1079, desktop);
		var outside = WindowsInputMapper.ToAbsolute(9999, 9999, desktop);

		Assert.Equal((0, 0), origin);
		Assert.Equal((65535, 65535), far);
		// A point off the desktop is clamped rather than wrapped: a wrapped coordinate would click
		// somewhere real and arbitrary.
		Assert.Equal((65535, 65535), outside);
	}

	[Theory]
	[InlineData(0, 0, true)]
	[InlineData(799, 599, true)]
	[InlineData(800, 300, false)]
	[InlineData(-1, 10, false)]
	public void IsInsideContent_RefusesPointsPastTheWindowEdge(double x, double y, bool inside)
	{
		var geometry = Fixtures.Geometry(contentWidth: 800, contentHeight: 600);

		Assert.Equal(
			inside,
			WindowsInputMapper.IsInsideContent(new WindowsInputPoint { X = x, Y = y }, geometry));
	}

	[Fact]
	public void Path_IncludesBothEndpoints()
	{
		var path = WindowsInputMapper.Path(
			new WindowsInputPoint { X = 0, Y = 0 },
			new WindowsInputPoint { X = 100, Y = 50 },
			steps: 4);

		Assert.Equal(5, path.Length);
		Assert.Equal(0, path[0].X);
		Assert.Equal(100, path[^1].X);
		Assert.Equal(50, path[^1].Y);
	}

	[Fact]
	public void TransformVersion_ChangesWithEveryGeometryFactThatCouldMoveAPixel()
	{
		var geometry = Fixtures.Geometry();
		var stable = WindowsCaptureTransform.Version(Identity, geometry);

		Assert.Equal(stable, WindowsCaptureTransform.Version(Identity, geometry));
		Assert.NotEqual(
			stable,
			WindowsCaptureTransform.Version(Identity, Fixtures.Geometry(contentWidth: 801)));
		Assert.NotEqual(
			stable,
			WindowsCaptureTransform.Version(Identity, Fixtures.Geometry(left: -1919)));
		Assert.NotEqual(
			stable,
			WindowsCaptureTransform.Version(Identity, Fixtures.Geometry(dpi: 96)));
		Assert.NotEqual(
			stable,
			WindowsCaptureTransform.Version(Identity, Fixtures.Geometry(minimized: true)));
	}

	[Fact]
	public void TransformVersion_IgnoresCaptureScale()
	{
		// A half-scale stream and a full-scale screenshot describe the same window state. A caller
		// says which image size its coordinates are in through the request, not by holding two
		// different tokens for one window.
		Assert.Equal(
			WindowsCaptureTransform.Version(Identity, Fixtures.Geometry(scale: 1)),
			WindowsCaptureTransform.Version(Identity, Fixtures.Geometry(scale: 0.5)));
	}

	[Fact]
	public void TransformVersion_IsBoundToTheWindowIdentity()
	{
		var geometry = Fixtures.Geometry();
		var reused = new WindowsWindowKey(
			Identity.Handle,
			Identity.ProcessId + 1,
			Identity.ProcessStartFileTime,
			null);

		// A recycled handle in a different process is a different window, even at the same place.
		Assert.NotEqual(
			WindowsCaptureTransform.Version(Identity, geometry),
			WindowsCaptureTransform.Version(reused, geometry));
	}

	[Fact]
	public void Matches_RequiresAnExactToken()
	{
		var geometry = WindowsCaptureTransform.Stamp(Fixtures.Geometry(), Identity);

		Assert.True(WindowsCaptureTransform.Matches(geometry.TransformVersion, geometry.TransformVersion));
		Assert.True(WindowsCaptureTransform.Matches(
			$"  {geometry.TransformVersion} ",
			geometry.TransformVersion));
		Assert.False(WindowsCaptureTransform.Matches("", geometry.TransformVersion));
		Assert.False(WindowsCaptureTransform.Matches("wct1_deadbeef", geometry.TransformVersion));
	}

	[Fact]
	public void VirtualKeys_ResolveDocumentedNamesAndExplicitCodes()
	{
		Assert.Equal(0x41, WindowsVirtualKeys.Resolve("a").VirtualKey);
		Assert.Equal(0x0D, WindowsVirtualKeys.Resolve("enter").VirtualKey);
		Assert.Equal(0x74, WindowsVirtualKeys.Resolve("f5").VirtualKey);
		Assert.Equal(0x2F, WindowsVirtualKeys.Resolve("vk:0x2F").VirtualKey);
		Assert.Equal(0x2F, WindowsVirtualKeys.Resolve("vk:47").VirtualKey);

		// Navigation keys live on the extended part of the keyboard, and applications that read
		// scancodes tell them apart from the numeric keypad only by that flag.
		Assert.True(WindowsVirtualKeys.Resolve("left").Extended);
		Assert.False(WindowsVirtualKeys.Resolve("numpad4").Extended);

		var unknown = Assert.Throws<WindowsCanvasException>(
			() => WindowsVirtualKeys.Resolve("hyper"));
		Assert.Equal(WindowsErrorCodes.InvalidRequest, unknown.Code);
	}
}
