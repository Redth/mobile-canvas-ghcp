using MobileCanvas.Contracts;
using WindowsCanvas.Contracts;
using WindowsCanvas.Windows;

namespace WindowsCanvas.Tests;

/// <summary>
/// Previews of windows a panel was offered but has not attached.
///
/// A thumbnail is the one picture this product takes of a window nobody granted, which makes its
/// rules the interesting part: the only thing it accepts is an identifier this exact panel was
/// handed, that identifier is re-proved against the live desktop before a pixel is read, the image
/// is bounded on purpose, and looking at it must leave the panel authorized to do exactly nothing
/// it was not already allowed to do.
/// </summary>
public sealed class WindowsThumbnailTests
{
	private static readonly CanvasContextKey Panel =
		new("session", "panel", CanvasSurfaces.Windows);

	private static readonly CanvasContextKey OtherPanel =
		new("session", "other-panel", CanvasSurfaces.Windows);

	[Fact]
	public async Task Thumbnail_NamesTheCandidateAndCarriesATokenBoundToThatWindow()
	{
		var harness = await Harness.ListedAsync();

		var thumbnail = await harness.Service.CaptureCandidateThumbnailAsync(
			Panel,
			harness.CandidateId);

		Assert.Equal(Fixtures.PngBytes, thumbnail.Png);
		// The descriptor names the candidate, not an authorized window: this is a picture of
		// something offered, and calling it a window ID would invite a caller to try to drive it.
		Assert.Equal(harness.CandidateId, thumbnail.Descriptor.WindowId);
		Assert.Equal("png", thumbnail.Descriptor.Format);
		Assert.Equal(Fixtures.PngBytes.Length, thumbnail.Descriptor.ByteCount);
		Assert.StartsWith(
			"wct1_",
			thumbnail.Descriptor.Geometry.TransformVersion,
			StringComparison.Ordinal);
	}

	[Fact]
	public async Task Thumbnail_IsNeverACaptureRequestedWithTheCursorOrAtFullSize()
	{
		var harness = await Harness.ListedAsync();

		await harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId);

		var requested = Assert.Single(harness.Bridge.Screenshots);
		Assert.False(requested.IncludeCursor);
		Assert.Equal(WindowsThumbnailLimits.DefaultDimension, requested.MaximumDimension);
		// 320 across an 800-pixel window is 0.4 of it. The scale is derived rather than asked for,
		// so a caller cannot request a desktop-sized picker card.
		Assert.Equal(0.4, requested.Scale, 6);
	}

	[Theory]
	[InlineData(0, WindowsThumbnailLimits.DefaultDimension, 0.4)]
	[InlineData(320, WindowsThumbnailLimits.DefaultDimension, 0.4)]
	[InlineData(10, WindowsThumbnailLimits.MinimumDimension, 0.12)]
	[InlineData(5000, WindowsThumbnailLimits.MaximumDimension, 0.8)]
	public async Task Thumbnail_BoundsTheRequestedSizeAndDerivesTheScaleFromIt(
		int requestedDimension,
		int expectedDimension,
		double expectedScale)
	{
		var harness = await Harness.ListedAsync();

		await harness.Service.CaptureCandidateThumbnailAsync(
			Panel,
			harness.CandidateId,
			requestedDimension);

		var requested = Assert.Single(harness.Bridge.Screenshots);
		Assert.Equal(expectedDimension, requested.MaximumDimension);
		Assert.Equal(expectedScale, requested.Scale, 6);
	}

	[Fact]
	public async Task Thumbnail_RefusesANegativeSize()
	{
		var harness = await Harness.ListedAsync();
		var enumerations = harness.Bridge.WindowListCalls;

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId, -1));

		Assert.Equal(WindowsErrorCodes.InvalidRequest, failure.Code);
		Assert.Empty(harness.Bridge.Screenshots);
		// A nonsense request does not cost a walk of the desktop to find out about.
		Assert.Equal(enumerations, harness.Bridge.WindowListCalls);
	}

	/// <summary>
	/// A window far larger than any card would still be scaled below the hard floor on capture
	/// scale, so the requested dimension travels to the helper as a clamp of its own rather than
	/// being trusted to fall out of the arithmetic.
	/// </summary>
	[Fact]
	public async Task Thumbnail_ClampsTheScaleAndStillBoundsTheLongestEdge()
	{
		var harness = await Harness.ListedAsync();
		harness.Geometry.Default = Fixtures.Geometry(contentWidth: 8000, contentHeight: 4000);

		await harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId);

		var requested = Assert.Single(harness.Bridge.Screenshots);
		Assert.Equal(WindowsCaptureLimits.MinimumScale, requested.Scale, 6);
		Assert.Equal(WindowsThumbnailLimits.DefaultDimension, requested.MaximumDimension);
	}

	[Fact]
	public async Task Thumbnail_RefusesAnIdentifierThisPanelWasNeverOffered()
	{
		var harness = await Harness.ListedAsync();

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureCandidateThumbnailAsync(Panel, "cand_invented"));

		Assert.Equal(WindowsErrorCodes.CandidateNotFound, failure.Code);
		Assert.Empty(harness.Bridge.Screenshots);
	}

	/// <summary>
	/// Candidate identifiers are capabilities handed to one panel. Another canvas holding the same
	/// string must get nothing from it, or the identifier would be a name for a window rather than
	/// a grant to look at one.
	/// </summary>
	[Fact]
	public async Task Thumbnail_IsNotReachableWithAnotherPanelsCandidate()
	{
		var harness = await Harness.ListedAsync();
		await harness.Service.ListWindowCandidatesAsync(OtherPanel);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureCandidateThumbnailAsync(
				OtherPanel,
				harness.CandidateId));

		Assert.Equal(WindowsErrorCodes.CandidateNotFound, failure.Code);
		Assert.Empty(harness.Bridge.Screenshots);
	}

	[Fact]
	public async Task Thumbnail_RefusesAMobileCanvasSession()
	{
		var harness = await Harness.ListedAsync();
		var mobile = new CanvasContextKey("session", "panel", CanvasSurfaces.Mobile);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureCandidateThumbnailAsync(mobile, harness.CandidateId));

		Assert.Equal(WindowsErrorCodes.SurfaceRequired, failure.Code);
	}

	[Fact]
	public async Task Thumbnail_RefusesAHandleThatNowBelongsToAnotherProcess()
	{
		var harness = await Harness.ListedAsync();
		harness.Bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 777, "Someone else's window"));

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId));

		Assert.Equal(WindowsErrorCodes.WindowIdentityChanged, failure.Code);
		Assert.Empty(harness.Bridge.Screenshots);
	}

	[Fact]
	public async Task Thumbnail_RefusesAProcessIdThatWasRecycled()
	{
		var harness = await Harness.ListedAsync();
		harness.Bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(
				11,
				100,
				"A different program with the same process ID",
				startFileTime: Fixtures.MediumStart + 1_000_000));

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId));

		Assert.Equal(WindowsErrorCodes.WindowIdentityChanged, failure.Code);
		Assert.Empty(harness.Bridge.Screenshots);
	}

	[Fact]
	public async Task Thumbnail_ReportsAWindowThatClosed()
	{
		var harness = await Harness.ListedAsync();
		harness.Bridge.Windows = Fixtures.WindowList();

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId));

		Assert.Equal(WindowsErrorCodes.WindowNotFound, failure.Code);
		Assert.Equal(404, failure.Status);
	}

	[Fact]
	public async Task Thumbnail_ReportsAMinimizedWindowInsteadOfCapturingNothing()
	{
		var harness = await Harness.ListedAsync(
			Fixtures.Window(11, 100, "Fixture window", minimized: true));

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId));

		Assert.Equal(WindowsErrorCodes.WindowMinimized, failure.Code);
		Assert.Equal(409, failure.Status);
		Assert.Empty(harness.Bridge.Screenshots);
	}

	[Fact]
	public async Task Thumbnail_ReportsAnElevatedWindowRatherThanReadingIt()
	{
		var harness = await Harness.ListedAsync(
			Fixtures.Window(
				11,
				100,
				"Elevated window",
				integrityValue: 0x3000,
				integrityLevel: WindowsIntegrityLevels.High,
				elevated: true));

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId));

		Assert.Equal(WindowsErrorCodes.TargetElevated, failure.Code);
		Assert.Equal(403, failure.Status);
		Assert.Empty(harness.Bridge.Screenshots);
	}

	[Fact]
	public async Task Thumbnail_ReportsAWindowThatExcludesItselfFromCapture()
	{
		var harness = await Harness.ListedAsync();
		harness.Bridge.OnScreenshot = (_, _) => throw WindowsCanvasException.Conflict(
			WindowsErrorCodes.CaptureProtected,
			"That window excludes itself from screen capture.");

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId));

		// The picker draws a placeholder from this code rather than an empty card nobody can
		// explain.
		Assert.Equal(WindowsErrorCodes.CaptureProtected, failure.Code);
	}

	[Fact]
	public async Task Thumbnail_RefusesAnImageTooLargeToBeAPickerCard()
	{
		var harness = await Harness.ListedAsync();
		harness.Bridge.OnScreenshot = (_, _) => new WindowsScreenshot
		{
			Png = new byte[WindowsThumbnailLimits.MaximumBytes + 1],
			Descriptor = new WindowsScreenshotDescriptor { Geometry = Fixtures.Geometry() },
		};

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId));

		Assert.Equal(WindowsErrorCodes.CaptureFailed, failure.Code);
	}

	[Fact]
	public async Task Thumbnail_ReportsACaptureThatRanPastItsDeadline()
	{
		var harness = await Harness.ListedAsync();
		harness.Bridge.OnScreenshot = (_, _) => throw new OperationCanceledException();

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId));

		// A picker showing a placeholder is a better answer than a card that never resolves.
		Assert.Equal(WindowsErrorCodes.CaptureFailed, failure.Code);
		Assert.Equal(502, failure.Status);
	}

	[Fact]
	public async Task Thumbnail_StillReportsACallerWhoGaveUpAsCancellation()
	{
		var harness = await Harness.ListedAsync();
		using var abandoned = new CancellationTokenSource();
		harness.Bridge.OnScreenshot = (_, _) =>
		{
			abandoned.Cancel();
			throw new OperationCanceledException(abandoned.Token);
		};

		// A panel that closed its picker is not a capture failure, and dressing it up as one would
		// put an error on a card nobody is looking at.
		await Assert.ThrowsAnyAsync<OperationCanceledException>(
			() => harness.Service.CaptureCandidateThumbnailAsync(
				Panel,
				harness.CandidateId,
				0,
				abandoned.Token));
	}

	/// <summary>
	/// The whole point of the endpoint is that it precedes a grant. If looking at a card authorized
	/// anything, a picker would be attaching every window it drew.
	/// </summary>
	[Fact]
	public async Task Thumbnail_LeavesThePanelWithNoSessionAndNoInput()
	{
		var harness = await Harness.ListedAsync();

		await harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId);

		var selection = await harness.Service.GetSelectionAsync(Panel);
		Assert.False(selection.HasSelection);
		Assert.Null(selection.Session);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.ListSessionWindowsAsync(Panel));
		Assert.Equal(WindowsErrorCodes.SessionNotFound, failure.Code);

		// Nothing was revealed, restored, focused, or clicked to take the picture.
		Assert.Empty(harness.WindowController.Calls);
		Assert.Empty(harness.Input.Operations);
	}

	/// <summary>
	/// A window that was already attached is still listed as a candidate, under its authorized ID.
	/// The picker should not go blank on the one card it is actually driving.
	/// </summary>
	[Fact]
	public async Task Thumbnail_AlsoAnswersForAWindowThisPanelAlreadyAttached()
	{
		var harness = await Harness.ListedAsync();
		var session = await harness.Service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = harness.CandidateId });
		var candidates = await harness.Service.ListWindowCandidatesAsync(Panel);
		var attached = Assert.Single(candidates.Windows);

		var thumbnail = await harness.Service.CaptureCandidateThumbnailAsync(Panel, attached.Id);

		Assert.True(attached.Attached);
		Assert.Equal(session.Windows[0].Id, attached.Id);
		Assert.Equal(attached.Id, thumbnail.Descriptor.WindowId);
	}

	[Fact]
	public async Task Thumbnail_ServesARecentImageAgainWithoutRecapturing()
	{
		var harness = await Harness.ListedAsync();

		var first = await harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId);
		var second = await harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId);

		Assert.Single(harness.Bridge.Screenshots);
		Assert.Equal(first.Descriptor.Geometry.TransformVersion, second.Descriptor.Geometry.TransformVersion);
	}

	[Fact]
	public async Task Thumbnail_NeverServesAPictureOfWhereTheWindowUsedToBe()
	{
		var harness = await Harness.ListedAsync();
		await harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId);

		// The window moved and resized. The cached image is now a picture of a window state that no
		// longer exists, so the signature stops matching and it is captured again.
		harness.Geometry.Default = Fixtures.Geometry(contentWidth: 1024, contentHeight: 768, left: 40);
		await harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId);

		Assert.Equal(2, harness.Bridge.Screenshots.Count);
	}

	[Fact]
	public async Task Thumbnail_CachesPerRequestedSize()
	{
		var harness = await Harness.ListedAsync();

		await harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId, 320);
		await harness.Service.CaptureCandidateThumbnailAsync(Panel, harness.CandidateId, 128);

		Assert.Equal(2, harness.Bridge.Screenshots.Count);
	}

	[Fact]
	public async Task Thumbnail_BurstReusesOneDesktopEnumeration()
	{
		var harness = await Harness.ListedAsync(
			Fixtures.Window(11, 100, "One"),
			Fixtures.Window(12, 101, "Two"));
		var candidates = await harness.Service.ListWindowCandidatesAsync(Panel);
		var before = harness.Bridge.WindowListCalls;

		await harness.Service.CaptureCandidateThumbnailAsync(Panel, candidates.Windows[0].Id);
		await harness.Service.CaptureCandidateThumbnailAsync(Panel, candidates.Windows[1].Id);

		Assert.Equal(before + 1, harness.Bridge.WindowListCalls);
		Assert.Equal(2, harness.Bridge.Screenshots.Count);
	}

	/// <summary>
	/// A picker asks for every open window at once. Each capture is a helper process negotiating a
	/// Direct3D adapter, so a twenty-window desktop must never become twenty of them.
	/// </summary>
	[Fact]
	public async Task Thumbnail_BoundsHowManyCapturesOnePanelRunsAtOnce()
	{
		var harness = await Harness.ListedAsync(
			Fixtures.Window(11, 100, "One"),
			Fixtures.Window(12, 101, "Two"),
			Fixtures.Window(13, 102, "Three"),
			Fixtures.Window(14, 103, "Four"));
		var candidates = await harness.Service.ListWindowCandidatesAsync(Panel);

		var inFlight = 0;
		var peak = 0;
		using var release = new ManualResetEventSlim(false);
		harness.Bridge.OnScreenshot = (_, _) =>
		{
			var current = Interlocked.Increment(ref inFlight);
			InterlockedRaise(ref peak, current);
			release.Wait(TimeSpan.FromSeconds(10));
			Interlocked.Decrement(ref inFlight);
			return new WindowsScreenshot
			{
				Png = Fixtures.PngBytes,
				Descriptor = new WindowsScreenshotDescriptor { Geometry = Fixtures.Geometry() },
			};
		};

		// The fixture holds its capture threads still so the peak can be observed, which needs the
		// pool to be willing to hand out threads immediately rather than injecting them a second at
		// a time while the rest of the suite runs beside this test.
		ThreadPool.GetMinThreads(out var workers, out var completionPorts);
		ThreadPool.SetMinThreads(Math.Max(workers, 16), completionPorts);
		try
		{
			var captures = candidates.Windows
				.Select(candidate => Task.Run(() =>
					harness.Service.CaptureCandidateThumbnailAsync(Panel, candidate.Id)))
				.ToArray();
			Assert.True(
				SpinWait.SpinUntil(
					() => Volatile.Read(ref peak) >= WindowsThumbnailLimits.MaximumConcurrentCaptures,
					TimeSpan.FromSeconds(10)),
				"Thumbnails never ran in parallel at all.");
			release.Set();
			await Task.WhenAll(captures);
		}
		finally
		{
			release.Set();
			ThreadPool.SetMinThreads(workers, completionPorts);
		}

		Assert.Equal(4, candidates.Windows.Length);
		Assert.Equal(WindowsThumbnailLimits.MaximumConcurrentCaptures, Volatile.Read(ref peak));
	}

	private static void InterlockedRaise(ref int target, int candidate)
	{
		var observed = Volatile.Read(ref target);
		while (candidate > observed)
		{
			var exchanged = Interlocked.CompareExchange(ref target, candidate, observed);
			if (exchanged == observed)
				return;
			observed = exchanged;
		}
	}

	private sealed class Harness
	{
		public required WindowsAppService Service { get; init; }
		public required FakeWindowsNativeBridge Bridge { get; init; }
		public required FakeWindowGeometry Geometry { get; init; }
		public required FakeWindowController WindowController { get; init; }
		public required FakeInputController Input { get; init; }
		public required string CandidateId { get; init; }

		public static async Task<Harness> ListedAsync(params WindowsHelperWindow[] windows)
		{
			var bridge = new FakeWindowsNativeBridge
			{
				Windows = Fixtures.WindowList(
					windows.Length == 0
						? [Fixtures.Window(11, 100, "Fixture window")]
						: windows),
			};
			var geometry = new FakeWindowGeometry();
			var windowController = new FakeWindowController();
			var input = new FakeInputController { Foreground = 11 };
			var service = new WindowsAppService(
				bridge,
				windowController,
				new FakeProcessLauncher(),
				geometry,
				input);

			var candidates = await service.ListWindowCandidatesAsync(Panel);
			return new Harness
			{
				Service = service,
				Bridge = bridge,
				Geometry = geometry,
				WindowController = windowController,
				Input = input,
				CandidateId = candidates.Windows[0].Id,
			};
		}
	}
}
