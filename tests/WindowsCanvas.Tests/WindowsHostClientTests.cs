using MobileCanvas.Contracts;
using MobileCanvas.Tool;
using WindowsCanvas.Contracts;

namespace WindowsCanvas.Tests;

/// <summary>
/// The Windows client reuses the Mobile client's host discovery, control token, and query shape,
/// so what has to be pinned is the part that is Windows-specific: a control-token caller must name
/// the Windows surface, or the host's scope guard would treat it as a Mobile caller.
/// </summary>
public sealed class WindowsHostClientTests
{
	[Fact]
	public void ControlTokenRequests_NameTheWindowsSurface()
	{
		var query = DeviceHostClient.WithContextQuery(
			"/api/v1/windows/session",
			new CanvasContextKey("session id", "panel/1", CanvasSurfaces.Windows));

		Assert.Equal(
			"/api/v1/windows/session?sessionId=session%20id&instanceId=panel%2F1&surface=windows",
			query);
	}

	[Fact]
	public void MobileRequests_StayByteIdenticalToClientsThatPredateSurfaces()
	{
		var query = DeviceHostClient.WithContextQuery(
			"/api/v1/selection",
			new CanvasContextKey("session", "panel"));

		Assert.Equal("/api/v1/selection?sessionId=session&instanceId=panel", query);
	}

	[Fact]
	public void ExistingQueryStrings_AreExtendedRatherThanReplaced()
	{
		var query = DeviceHostClient.WithContextQuery(
			"/api/v1/windows/apps?text=fixture",
			new CanvasContextKey("session", "panel", CanvasSurfaces.Windows));

		Assert.Equal(
			"/api/v1/windows/apps?text=fixture&sessionId=session&instanceId=panel&surface=windows",
			query);
	}

	[Fact]
	public void ScreenshotWithoutADescriptor_IsRefusedRatherThanReturnedWithEmptyGeometry()
	{
		using var bare = new HttpResponseMessage();
		using var garbled = new HttpResponseMessage();
		garbled.Headers.Add(WindowsCaptureHeaders.Descriptor, "not-base64!!");

		// Coordinates against unknown geometry would be a guess, and this path never guesses.
		Assert.Equal(
			WindowsErrorCodes.CaptureFailed,
			Assert.Throws<WindowsCanvasException>(
				() => WindowsHostClient.DecodeDescriptor(bare, 0)).Code);
		Assert.Equal(
			WindowsErrorCodes.CaptureFailed,
			Assert.Throws<WindowsCanvasException>(
				() => WindowsHostClient.DecodeDescriptor(garbled, 0)).Code);
	}

	[Fact]
	public void ScreenshotDescriptor_RoundTripsThroughItsResponseHeader()
	{
		var descriptor = new WindowsScreenshotDescriptor
		{
			WindowId = "win_1",
			Geometry = new WindowsCaptureGeometry
			{
				ContentWidth = 800,
				ContentHeight = 600,
				TransformVersion = "wct1_abcdef",
			},
		};
		using var response = new HttpResponseMessage();
		response.Headers.Add(
			WindowsCaptureHeaders.Descriptor,
			WindowsApi.EncodeDescriptor(descriptor));

		var decoded = WindowsHostClient.DecodeDescriptor(response, byteCount: 4096);

		Assert.Equal("win_1", decoded.WindowId);
		Assert.Equal("wct1_abcdef", decoded.Geometry.TransformVersion);
		Assert.Equal(4096, decoded.ByteCount);
	}
}
