using MobileCanvas.Contracts;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

public class NativeCaptureTests
{
	[Theory]
	[InlineData(1206, 2622)]
	[InlineData(2622, 1206)]
	public void FramebufferArguments_TargetTheUdidAndNativePanelScale(int pixelWidth, int pixelHeight)
	{
		var startInfo = IosScreenCaptureVideoSession.CreateFramebufferStartInfo(
			"/tmp/mobile-screencap",
			"SIMULATOR-UDID",
			new StreamOptions
			{
				FramesPerSecond = 42,
				AverageBitrate = 5_000_000,
				Scale = 0.5,
			},
			new DisplayGeometry { PixelWidth = pixelWidth, PixelHeight = pixelHeight });

		Assert.Equal(
			[
				"framebuffer",
				"--udid",
				"SIMULATOR-UDID",
				"--fps",
				"42",
				"--bitrate",
				"5000000",
				"--max-height",
				"1311",
			],
			startInfo.ArgumentList);
	}

	[Fact]
	public void ScreenCaptureArguments_KeepTheExistingWindowCaptureContract()
	{
		var startInfo = IosScreenCaptureVideoSession.CreateScreenCaptureStartInfo(
			"/tmp/mobile-screencap",
			new ScreencapWindow
			{
				WindowId = 123,
				ScreenHeight = 800,
				BackingScale = 2,
			},
			new StreamOptions
			{
				FramesPerSecond = 30,
				AverageBitrate = 12_000_000,
				Scale = 0.75,
			});

		Assert.Equal(
			[
				"capture",
				"--window-id",
				"123",
				"--fps",
				"30",
				"--bitrate",
				"12000000",
				"--max-height",
				"1200",
			],
			startInfo.ArgumentList);
	}

	[Fact]
	public void Diagnostics_ParsesFramebufferAndFallbackAvailability()
	{
		var diagnostics = ScreenCaptureHelper.ParseDiagnostics("""
			{
			  "framebufferAvailable": true,
			  "framebufferDetail": "CoreSimulator IOSurface capture is available.",
			  "screenRecordingGranted": false,
			  "screenRecordingDetail": "Permission preflight only.",
			  "accessibilityGranted": true
			}
			""");

		Assert.True(diagnostics.FramebufferAvailable);
		Assert.Equal("CoreSimulator IOSurface capture is available.", diagnostics.FramebufferDetail);
		Assert.False(diagnostics.ScreenRecordingGranted);
		Assert.True(diagnostics.AccessibilityGranted);
	}

	[Fact]
	public void FallbackDetail_PreservesBothFailedNativeSources()
	{
		var detail = IosSimulatorBackend.BuildCaptureFallbackDetail(
			"private API changed",
			"Screen Recording denied");

		Assert.Equal(
			"Direct framebuffer capture unavailable: private API changed "
			+ "ScreenCaptureKit fallback unavailable: Screen Recording denied",
			detail);
	}
}
