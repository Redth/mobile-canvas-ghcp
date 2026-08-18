using WindowsCanvas.Contracts;
using WindowsCanvas.Windows;
using MobileCanvas.Contracts;

namespace WindowsCanvas.Tests;

/// <summary>
/// Screenshots and live video.
///
/// The rules being proved here are the ones that make a picture safe to act on: it is of the window
/// this panel was granted, its geometry carries a token bound to that window's identity, and a
/// window with nothing to show says so instead of producing a black frame nobody can interpret.
/// </summary>
public sealed class WindowsCaptureTests
{
	private static readonly CanvasContextKey Panel =
		new("session", "panel", CanvasSurfaces.Windows);

	[Fact]
	public async Task Screenshot_CarriesTheOpaqueWindowIdAndATokenBoundToThatWindow()
	{
		var harness = await Harness.AttachedAsync();

		var screenshot = await harness.Service.CaptureScreenshotAsync(Panel);

		Assert.Equal(harness.WindowId, screenshot.Descriptor.WindowId);
		Assert.Equal(Fixtures.PngBytes, screenshot.Png);
		Assert.StartsWith("wct1_", screenshot.Descriptor.Geometry.TransformVersion, StringComparison.Ordinal);
		// The same window, unchanged, produces the same token, so a caller can screenshot and then
		// act without a race it cannot see.
		var geometry = await harness.Service.GetGeometryAsync(Panel);
		Assert.Equal(geometry.TransformVersion, screenshot.Descriptor.Geometry.TransformVersion);
	}

	[Fact]
	public async Task Screenshot_RefusesAMinimizedWindow()
	{
		var harness = await Harness.AttachedAsync();
		harness.Bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 100, "Fixture window", minimized: true));

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureScreenshotAsync(Panel));

		Assert.Equal(WindowsErrorCodes.WindowMinimized, failure.Code);
		Assert.Empty(harness.Bridge.Screenshots);
	}

	[Fact]
	public async Task Screenshot_DropsTheGrantWhenTheWindowBecameElevated()
	{
		var harness = await Harness.AttachedAsync();
		harness.Bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(
				11,
				100,
				"Fixture window",
				integrityValue: 0x3000,
				integrityLevel: WindowsIntegrityLevels.High,
				elevated: true));

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureScreenshotAsync(
				Panel,
				new WindowsScreenshotRequest { WindowId = harness.WindowId }));

		// A target above this host's integrity is dropped from the session rather than captured;
		// the identifier stops meaning anything at the moment the window stopped qualifying.
		Assert.Equal(WindowsErrorCodes.WindowNotAuthorized, failure.Code);
		Assert.Empty(harness.Bridge.Screenshots);
	}

	[Fact]
	public async Task Screenshot_DropsTheGrantWhenTheHandleWasReusedByAnotherProcess()
	{
		var harness = await Harness.AttachedAsync();
		harness.Bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 777, "Someone else's window"));

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureScreenshotAsync(
				Panel,
				new WindowsScreenshotRequest { WindowId = harness.WindowId }));

		Assert.Equal(WindowsErrorCodes.WindowNotAuthorized, failure.Code);
		Assert.Empty(harness.Bridge.Screenshots);
	}

	[Fact]
	public async Task Screenshot_IsNotReachableFromAnotherPanel()
	{
		var harness = await Harness.AttachedAsync();
		var other = new CanvasContextKey("session", "other-panel", CanvasSurfaces.Windows);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureScreenshotAsync(
				other,
				new WindowsScreenshotRequest { WindowId = harness.WindowId }));

		Assert.Equal(WindowsErrorCodes.SessionNotFound, failure.Code);
	}

	[Fact]
	public async Task Screenshot_RefusesAMobileCanvasSession()
	{
		var harness = await Harness.AttachedAsync();
		var mobile = new CanvasContextKey("session", "panel", CanvasSurfaces.Mobile);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureScreenshotAsync(mobile));

		Assert.Equal(WindowsErrorCodes.SurfaceRequired, failure.Code);
	}

	[Fact]
	public async Task Screenshot_RefusesGeometryTheHelperCouldNotDescribe()
	{
		var harness = await Harness.AttachedAsync();
		harness.Bridge.OnScreenshot = (_, _) => new WindowsScreenshot
		{
			Png = Fixtures.PngBytes,
			Descriptor = new WindowsScreenshotDescriptor
			{
				Geometry = Fixtures.Geometry() with { ContentWidth = 0, CaptureWidth = 0 },
			},
		};

		// The bridge normalizes helper output, so the service is handed geometry only after it has
		// been proven to describe a real coordinate space. Reaching past the bridge proves the
		// check exists where the bytes enter the domain.
		var geometry = Fixtures.Geometry() with { ContentWidth = 0 };
		var failure = Assert.Throws<WindowsCanvasException>(
			() => WindowsCaptureNormalizer.Geometry(geometry, "screenshot"));
		Assert.Equal(WindowsErrorCodes.CaptureFailed, failure.Code);
	}

	[Fact]
	public void Bridge_RefusesACaptureOfADifferentWindowThanTheOneAuthorized()
	{
		var window = Fixtures.Window(11, 100, "Fixture window");
		var mismatch = new WindowsHelperCapture
		{
			SchemaVersion = 1,
			Ok = true,
			Handle = 12,
			ProcessId = 100,
			ProcessStartFileTime = window.ProcessStartFileTime,
		};

		var failure = Assert.Throws<WindowsCanvasException>(
			() => WindowsCaptureNormalizer.RequireIdentity(mismatch, window));

		Assert.Equal(WindowsErrorCodes.CaptureIdentityMismatch, failure.Code);
	}

	[Theory]
	[InlineData(WindowsCaptureStatuses.Minimized, WindowsErrorCodes.WindowMinimized)]
	[InlineData(WindowsCaptureStatuses.ProtectedContent, WindowsErrorCodes.CaptureProtected)]
	[InlineData(WindowsCaptureStatuses.Closed, WindowsErrorCodes.WindowNotFound)]
	[InlineData(WindowsCaptureStatuses.Unavailable, WindowsErrorCodes.CaptureUnavailable)]
	[InlineData(WindowsCaptureStatuses.Error, WindowsErrorCodes.CaptureFailed)]
	public void HelperStatus_MapsOntoTheCodeACallerBranchesOn(string status, string code)
	{
		var failure = Assert.Throws<WindowsCanvasException>(
			() => WindowsCaptureNormalizer.RequireOk(
				new WindowsHelperCapture
				{
					SchemaVersion = 1,
					Ok = false,
					Status = status,
					Error = new WindowsHelperErrorDetail { Code = "x", Message = "y" },
				},
				"screenshot"));

		Assert.Equal(code, failure.Code);
	}

	[Fact]
	public void HelperStatus_RefusesAMismatchedSchemaVersion()
	{
		var failure = Assert.Throws<WindowsCanvasException>(
			() => WindowsCaptureNormalizer.RequireOk(
				new WindowsHelperCapture { SchemaVersion = 99, Ok = true },
				"capture"));

		Assert.Equal(WindowsErrorCodes.HelperIncompatible, failure.Code);
	}

	[Fact]
	public async Task Stream_StampsTheDescriptorAndReportsWhyItEnded()
	{
		var harness = await Harness.AttachedAsync();

		await using var video = await harness.Service.OpenVideoStreamAsync(
			Panel,
			new WindowsStreamRequest { FramesPerSecond = 30, Scale = 0.5 });

		var chunks = new List<byte[]>();
		await foreach (var chunk in video.ReadAsync())
			chunks.Add(chunk.ToArray());

		Assert.Equal(harness.WindowId, video.Descriptor.WindowId);
		Assert.Equal("h264-annexb", video.Descriptor.Encoding);
		Assert.StartsWith("wct1_", video.Descriptor.Geometry.TransformVersion, StringComparison.Ordinal);
		Assert.Equal(2, chunks.Count);
		// A resize ends the stream on purpose: an H.264 decoder cannot be handed frames of a new
		// size, so the browser reconnects for a fresh descriptor and keyframe.
		Assert.Equal(WindowsStreamEndReasons.ContentSizeChanged, video.End.Reason);
		Assert.True(video.End.Reconnect);
		Assert.Equal(harness.WindowId, video.End.WindowId);
	}

	[Fact]
	public async Task Stream_BoundsTheRequestedRate()
	{
		var harness = await Harness.AttachedAsync();

		await using var video = await harness.Service.OpenVideoStreamAsync(
			Panel,
			new WindowsStreamRequest
			{
				FramesPerSecond = 9000,
				Scale = 12,
				AverageBitrate = long.MaxValue,
			});

		var requested = Assert.Single(harness.Bridge.Streams);
		Assert.Equal(WindowsCaptureLimits.MaximumFramesPerSecond, requested.FramesPerSecond);
		Assert.Equal(WindowsCaptureLimits.MaximumScale, requested.Scale);
		Assert.Equal(WindowsCaptureLimits.MaximumBitrate, requested.AverageBitrate);
	}

	[Fact]
	public async Task Stream_RefusesAMinimizedWindow()
	{
		var harness = await Harness.AttachedAsync();
		harness.Bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 100, "Fixture window", minimized: true));

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.OpenVideoStreamAsync(Panel));

		Assert.Equal(WindowsErrorCodes.WindowMinimized, failure.Code);
		Assert.Empty(harness.Bridge.Streams);
	}

	[Theory]
	[InlineData(WindowsStreamEndReasons.ContentSizeChanged, true)]
	[InlineData(WindowsStreamEndReasons.DpiChanged, true)]
	[InlineData(WindowsStreamEndReasons.Minimized, false)]
	[InlineData(WindowsStreamEndReasons.WindowClosed, false)]
	[InlineData(WindowsStreamEndReasons.ClientClosed, false)]
	public void EndReason_SaysWhetherReconnectingWouldHelp(string reason, bool reconnect) =>
		Assert.Equal(reconnect, WindowsStreamEndReasons.ShouldReconnect(reason));

	private sealed class Harness
	{
		public required WindowsAppService Service { get; init; }
		public required FakeWindowsNativeBridge Bridge { get; init; }
		public required FakeWindowGeometry Geometry { get; init; }
		public required string WindowId { get; init; }

		public static async Task<Harness> AttachedAsync()
		{
			var bridge = new FakeWindowsNativeBridge
			{
				Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Fixture window")),
			};
			var geometry = new FakeWindowGeometry();
			var service = new WindowsAppService(
				bridge,
				new FakeWindowController(),
				new FakeProcessLauncher(),
				geometry,
				new FakeInputController { Foreground = 11 });

			var candidates = await service.ListWindowCandidatesAsync(Panel);
			var session = await service.AttachAsync(
				Panel,
				new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });

			return new Harness
			{
				Service = service,
				Bridge = bridge,
				Geometry = geometry,
				WindowId = session.Windows[0].Id,
			};
		}
	}
}
