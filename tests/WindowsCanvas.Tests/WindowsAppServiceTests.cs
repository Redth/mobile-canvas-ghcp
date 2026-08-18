using MobileCanvas.Contracts;
using WindowsCanvas.Contracts;
using WindowsCanvas.Windows;

namespace WindowsCanvas.Tests;

public sealed class WindowsAppServiceTests
{
	private static readonly CanvasContextKey Panel =
		new("session", "panel-a", CanvasSurfaces.Windows);

	private static readonly CanvasContextKey OtherPanel =
		new("session", "panel-b", CanvasSurfaces.Windows);

	[Fact]
	public async Task Candidates_AreScopedToOnePanelAndCarryNoUsableHandle()
	{
		var service = Service(out var bridge, out _, out _);
		bridge.Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Fixture"));

		var listed = await service.ListWindowCandidatesAsync(Panel);
		var candidate = Assert.Single(listed.Windows);

		Assert.True(candidate.Attachable);
		Assert.StartsWith("cand_", candidate.Id, StringComparison.Ordinal);
		Assert.Equal(11, candidate.Diagnostics!.NativeHandle);

		// The identifier is a capability handed to one panel. Another panel that somehow learned it
		// still cannot use it.
		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.AttachAsync(OtherPanel, new WindowsAttachRequest { CandidateId = candidate.Id }));
		Assert.Equal(WindowsErrorCodes.CandidateNotFound, failure.Code);
	}

	[Fact]
	public async Task Candidates_KeepTheSameIdentifierAcrossListings()
	{
		var service = Service(out var bridge, out _, out _);
		bridge.Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Fixture"));

		var first = await service.ListWindowCandidatesAsync(Panel);
		var second = await service.ListWindowCandidatesAsync(Panel);

		Assert.Equal(first.Windows[0].Id, second.Windows[0].Id);
	}

	[Fact]
	public async Task Candidates_RefuseWindowsInAnotherLogonSessionOrAboveTheHost()
	{
		var service = Service(out var bridge, out _, out _);
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 100, "Other session", sessionId: 7),
			Fixtures.Window(12, 101, "Elevated", integrityValue: 0x3000, integrityLevel: WindowsIntegrityLevels.High),
			Fixtures.Window(13, 102, "Unknowable", identityAccess: WindowsIdentityAccess.Denied));

		var listed = await service.ListWindowCandidatesAsync(Panel);

		Assert.All(listed.Windows, window => Assert.False(window.Attachable));
		Assert.Equal(WindowsErrorCodes.TargetSessionMismatch, listed.Windows[0].UnattachableCode);
		Assert.Equal(WindowsErrorCodes.TargetElevated, listed.Windows[1].UnattachableCode);
		Assert.Equal(WindowsErrorCodes.WindowNotAuthorized, listed.Windows[2].UnattachableCode);
	}

	[Fact]
	public async Task Attach_AuthorizesTheWindowAndItsSiblingsInTheSameProcess()
	{
		var service = Service(out var bridge, out _, out _);
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 100, "Main"),
			Fixtures.Window(12, 100, "Second window"),
			Fixtures.Window(21, 200, "Someone else", processPath: "C:\\apps\\other.exe"));

		var candidates = await service.ListWindowCandidatesAsync(Panel);
		var session = await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });

		Assert.Equal(2, session.Windows.Length);
		Assert.Equal(WindowsCorrelationReasons.Attached, session.Windows[0].Correlation);
		Assert.Equal(WindowsCorrelationReasons.SameProcess, session.Windows[1].Correlation);
		Assert.DoesNotContain(session.Windows, window => window.Title == "Someone else");
		Assert.Equal(session.Windows[0].Id, session.SelectedWindowId);
	}

	[Fact]
	public async Task Attach_AdoptsADialogRaisedByTheSameProcess()
	{
		var service = Service(out var bridge, out _, out _);
		bridge.Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Main"));
		var candidates = await service.ListWindowCandidatesAsync(Panel);
		await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });

		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 100, "Main"),
			Fixtures.Window(31, 100, "Save as", ownerHandle: 11));
		var windows = await service.ListSessionWindowsAsync(Panel);

		Assert.Equal(2, windows.Windows.Length);
		Assert.Contains(
			windows.Windows,
			window => window.Correlation == WindowsCorrelationReasons.SameProcess
				&& window.Title == "Save as");
	}

	[Fact]
	public async Task Attach_AdoptsAnOwnedDialogInsideASharedFrameHost()
	{
		var service = Service(out var bridge, out _, out _);
		const string frameHost = "C:\\Windows\\System32\\ApplicationFrameHost.exe";
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(
				11,
				900,
				"Fixture packaged app",
				processPath: frameHost,
				aumid: "Fixture.App_8wekyb3d8bbwe!App",
				packageFamily: "Fixture.App_8wekyb3d8bbwe"));
		var candidates = await service.ListWindowCandidatesAsync(Panel);
		await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });

		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(
				11,
				900,
				"Fixture packaged app",
				processPath: frameHost,
				aumid: "Fixture.App_8wekyb3d8bbwe!App",
				packageFamily: "Fixture.App_8wekyb3d8bbwe"),
			// The dialog carries no identity of its own, so ownership plus the identical process
			// is the only thing that attributes it.
			Fixtures.Window(41, 900, "Confirm", processPath: frameHost, ownerHandle: 11),
			Fixtures.Window(42, 900, "Somebody else's dialog", processPath: frameHost));

		var windows = await service.ListSessionWindowsAsync(Panel);

		Assert.Equal(2, windows.Windows.Length);
		Assert.Equal(WindowsCorrelationReasons.OwnedDialog, windows.Windows[1].Correlation);
		Assert.Equal("Confirm", windows.Windows[1].Title);
	}

	[Fact]
	public async Task Attach_ToAPackagedWindowNeverAuthorizesEveryFrameHostWindow()
	{
		var service = Service(out var bridge, out _, out _);
		const string frameHost = "C:\\Windows\\System32\\ApplicationFrameHost.exe";
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(
				11,
				900,
				"Fixture packaged app",
				processPath: frameHost,
				aumid: "Fixture.App_8wekyb3d8bbwe!App",
				packageFamily: "Fixture.App_8wekyb3d8bbwe"),
			Fixtures.Window(
				12,
				900,
				"A different packaged app",
				processPath: frameHost,
				aumid: "Contoso.Other_8wekyb3d8bbwe!App",
				packageFamily: "Contoso.Other_8wekyb3d8bbwe"));

		var candidates = await service.ListWindowCandidatesAsync(Panel);
		var session = await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });

		var window = Assert.Single(session.Windows);
		Assert.Equal("Fixture packaged app", window.Title);
		Assert.Equal("Fixture.App_8wekyb3d8bbwe!App", session.AppUserModelId);
		// The frame host's process identity is shared, so it is never used to correlate.
		Assert.Null(session.ExecutablePath);
	}

	[Fact]
	public async Task Session_AdoptsANewWindowOfTheSamePackagedApp()
	{
		var service = Service(out var bridge, out _, out _);
		const string frameHost = "C:\\Windows\\System32\\ApplicationFrameHost.exe";
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(
				11,
				900,
				"Fixture packaged app",
				processPath: frameHost,
				aumid: "Fixture.App_8wekyb3d8bbwe!App",
				packageFamily: "Fixture.App_8wekyb3d8bbwe"));
		var candidates = await service.ListWindowCandidatesAsync(Panel);
		await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });

		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(
				11,
				900,
				"Fixture packaged app",
				processPath: frameHost,
				aumid: "Fixture.App_8wekyb3d8bbwe!App",
				packageFamily: "Fixture.App_8wekyb3d8bbwe"),
			Fixtures.Window(
				12,
				900,
				"Fixture second window",
				processPath: frameHost,
				aumid: "Fixture.App_8wekyb3d8bbwe!App",
				packageFamily: "Fixture.App_8wekyb3d8bbwe"));

		var windows = await service.ListSessionWindowsAsync(Panel);

		Assert.Equal(2, windows.Windows.Length);
		Assert.Equal(WindowsCorrelationReasons.AppUserModelId, windows.Windows[1].Correlation);
	}

	[Fact]
	public async Task Session_DropsAWindowWhoseHandleWasReusedByAnotherProcess()
	{
		var service = Service(out var bridge, out var controller, out _);
		bridge.Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Main"));
		var candidates = await service.ListWindowCandidatesAsync(Panel);
		var session = await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });
		var windowId = session.Windows[0].Id;

		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 555, "Something else entirely", processPath: "C:\\apps\\other.exe"));

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.RevealAsync(Panel, new WindowsWindowActionRequest { WindowId = windowId }));

		Assert.Equal(WindowsErrorCodes.WindowNotAuthorized, failure.Code);
		Assert.Empty(controller.Calls);
	}

	[Fact]
	public async Task Session_DropsAWindowWhoseProcessIdWasRecycled()
	{
		var service = Service(out var bridge, out var controller, out _);
		bridge.Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Main"));
		var candidates = await service.ListWindowCandidatesAsync(Panel);
		var session = await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });
		var windowId = session.Windows[0].Id;

		// Same handle, same PID, different process: Windows reused the identifier.
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 100, "Main", startFileTime: Fixtures.MediumStart + 5_000_000));

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.RestoreAsync(Panel, new WindowsWindowActionRequest { WindowId = windowId }));

		Assert.Equal(WindowsErrorCodes.WindowNotAuthorized, failure.Code);
		Assert.Empty(controller.Calls);
	}

	[Fact]
	public async Task Session_DropsAWindowThatBecameElevated()
	{
		var service = Service(out var bridge, out _, out _);
		bridge.Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Main"));
		var candidates = await service.ListWindowCandidatesAsync(Panel);
		await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });

		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(
				11,
				100,
				"Main",
				integrityValue: 0x3000,
				integrityLevel: WindowsIntegrityLevels.High));

		var windows = await service.ListSessionWindowsAsync(Panel);

		Assert.Empty(windows.Windows);
		Assert.Null(windows.SelectedWindowId);
	}

	[Fact]
	public async Task Tabs_SelectOneAuthorizedWindowAndRefuseAnyOther()
	{
		var service = Service(out var bridge, out var controller, out _);
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 100, "First"),
			Fixtures.Window(12, 100, "Second"),
			Fixtures.Window(21, 200, "Unrelated", processPath: "C:\\apps\\other.exe"));
		var candidates = await service.ListWindowCandidatesAsync(Panel);
		var session = await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });

		var selected = await service.SelectWindowAsync(
			Panel,
			new WindowsSelectWindowRequest { WindowId = session.Windows[1].Id });
		await service.RevealAsync(Panel);

		Assert.Equal(session.Windows[1].Id, selected.SelectedWindowId);
		Assert.Equal(("reveal", 12L), Assert.Single(controller.Calls));

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.SelectWindowAsync(
				Panel,
				new WindowsSelectWindowRequest { WindowId = "win_not_mine" }));
		Assert.Equal(WindowsErrorCodes.WindowNotAuthorized, failure.Code);
		Assert.Equal(403, failure.Status);
	}

	[Fact]
	public async Task Release_EndsTheGrantWithoutTouchingTheApp()
	{
		var service = Service(out var bridge, out var controller, out _);
		bridge.Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Main"));
		var candidates = await service.ListWindowCandidatesAsync(Panel);
		var session = await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });

		var released = await service.ReleaseAsync(Panel);
		var selection = await service.GetSelectionAsync(Panel);

		Assert.Equal(session.Id, released.SessionId);
		Assert.False(selection.HasSelection);
		Assert.Empty(controller.Calls);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.ListSessionWindowsAsync(Panel));
		Assert.Equal(WindowsErrorCodes.SessionNotFound, failure.Code);
	}

	[Fact]
	public async Task Detach_ForgetsThePanelEntirelySoIdentifiersCannotBeInherited()
	{
		var service = Service(out var bridge, out _, out _);
		bridge.Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Main"));
		var candidates = await service.ListWindowCandidatesAsync(Panel);

		service.Detach(Panel);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.AttachAsync(
				Panel,
				new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id }));
		Assert.Equal(WindowsErrorCodes.CandidateNotFound, failure.Code);
	}

	[Fact]
	public async Task Panels_KeepSeparateSessions()
	{
		var service = Service(out var bridge, out _, out _);
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 100, "First app"),
			Fixtures.Window(21, 200, "Second app", processPath: "C:\\apps\\other.exe"));

		var first = await service.ListWindowCandidatesAsync(Panel);
		var second = await service.ListWindowCandidatesAsync(OtherPanel);
		var one = await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = first.Windows[0].Id });
		var two = await service.AttachAsync(
			OtherPanel,
			new WindowsAttachRequest { CandidateId = second.Windows[1].Id });

		Assert.NotEqual(one.Id, two.Id);
		Assert.Equal("First app", one.DisplayName);
		Assert.Equal("Second app", two.DisplayName);
		Assert.Equal(
			"First app",
			(await service.GetSelectionAsync(Panel)).Session!.DisplayName);
	}

	[Fact]
	public async Task MobileContext_IsRefusedByEveryWindowsOperation()
	{
		var service = Service(out _, out _, out _);
		var mobile = new CanvasContextKey("session", "panel-a");

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.ListWindowCandidatesAsync(mobile));

		Assert.Equal(WindowsErrorCodes.SurfaceRequired, failure.Code);
		Assert.Equal(403, failure.Status);
		await Assert.ThrowsAsync<WindowsCanvasException>(() => service.ReleaseAsync(mobile));
	}

	[Fact]
	public async Task Reveal_ReportsAWindowsRefusalRatherThanClaimingSuccess()
	{
		var service = Service(out var bridge, out var controller, out _);
		controller.RevealOutcome = WindowsWindowActionOutcome.Refused("Windows declined.");
		bridge.Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Main"));
		var candidates = await service.ListWindowCandidatesAsync(Panel);
		await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });

		var result = await service.RevealAsync(Panel);

		Assert.False(result.Success);
		Assert.Equal("Windows declined.", result.Detail);
	}

	[Fact]
	public async Task LaunchByCatalog_AuthorizesOnlyTheProcessTheShellReported()
	{
		var service = Service(out var bridge, out _, out _);
		bridge.Catalog = new WindowsHelperCatalog
		{
			SchemaVersion = 1,
			Ok = true,
			Entries = [Fixtures.Entry("a1", "Fixture", executablePath: "C:\\apps\\fixture.exe")],
		};
		bridge.OnLaunch = _ => new WindowsHelperLaunch
		{
			SchemaVersion = 1,
			Ok = true,
			ProcessId = 100,
			ProcessStartFileTime = Fixtures.MediumStart,
			LaunchMethod = WindowsLaunchMethods.Executable,
		};
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 100, "Fixture window"),
			Fixtures.Window(21, 200, "Same executable, other process"));

		var session = await service.LaunchCatalogAppAsync(
			Panel,
			new WindowsCatalogLaunchRequest { EntryId = "a1", CorrelationTimeout = 0 });

		var window = Assert.Single(session.Windows);
		Assert.Equal("Fixture window", window.Title);
		Assert.Equal(WindowsCorrelationReasons.LaunchedProcess, window.Correlation);
	}

	[Fact]
	public async Task LaunchThatCannotBeCorrelated_LeavesTheSessionControllingNothing()
	{
		var service = Service(out var bridge, out _, out _);
		bridge.Catalog = new WindowsHelperCatalog
		{
			SchemaVersion = 1,
			Ok = true,
			Entries = [Fixtures.Entry("a1", "Fixture", executablePath: "C:\\apps\\fixture.exe")],
		};
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 100, "Something that merely runs the same exe"));

		var session = await service.LaunchCatalogAppAsync(
			Panel,
			new WindowsCatalogLaunchRequest { EntryId = "a1", CorrelationTimeout = 0 });

		Assert.Empty(session.Windows);
		Assert.Equal(WindowsErrorCodes.LaunchNotCorrelated, session.PendingCode);
		Assert.NotNull(session.PendingDetail);

		// The window is still offered for an explicit attach; it was simply never assumed.
		var candidates = await service.ListWindowCandidatesAsync(Panel);
		Assert.True(Assert.Single(candidates.Windows).Attachable);
	}

	[Fact]
	public async Task LaunchByCatalog_CorrelatesAPackagedAppByItsIdentity()
	{
		var service = Service(out var bridge, out _, out _);
		bridge.Catalog = new WindowsHelperCatalog
		{
			SchemaVersion = 1,
			Ok = true,
			Entries =
			[
				Fixtures.Entry(
					"a1",
					"Fixture packaged",
					kind: WindowsCatalogKinds.Packaged,
					aumid: "Fixture.App_8wekyb3d8bbwe!App",
					packageFamily: "Fixture.App_8wekyb3d8bbwe"),
			],
		};
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(
				11,
				900,
				"Fixture packaged",
				processPath: "C:\\Windows\\System32\\ApplicationFrameHost.exe",
				aumid: "Fixture.App_8wekyb3d8bbwe!App",
				packageFamily: "Fixture.App_8wekyb3d8bbwe"),
			Fixtures.Window(
				12,
				900,
				"Unrelated packaged app",
				processPath: "C:\\Windows\\System32\\ApplicationFrameHost.exe",
				aumid: "Contoso.Other_8wekyb3d8bbwe!App",
				packageFamily: "Contoso.Other_8wekyb3d8bbwe"));

		var session = await service.LaunchCatalogAppAsync(
			Panel,
			new WindowsCatalogLaunchRequest { EntryId = "a1", CorrelationTimeout = 0 });

		var window = Assert.Single(session.Windows);
		Assert.Equal("Fixture packaged", window.Title);
		Assert.Equal(WindowsCorrelationReasons.AppUserModelId, window.Correlation);
	}

	[Fact]
	public async Task Candidates_IgnoreToolAndCloakedAndUntitledWindows()
	{
		var service = Service(out var bridge, out _, out _);
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 100, "Real"),
			Fixtures.Window(12, 100, "Tool", toolWindow: true),
			Fixtures.Window(13, 100, "Cloaked", cloaked: true),
			Fixtures.Window(14, 100, "", processPath: "C:\\apps\\fixture.exe"),
			Fixtures.Window(15, 100, "Hidden", visible: false));

		var listed = await service.ListWindowCandidatesAsync(Panel);

		Assert.Equal("Real", Assert.Single(listed.Windows).Title);
	}

	[Fact]
	public async Task AttachedWindow_IsListedWithItsSessionIdentifier()
	{
		var service = Service(out var bridge, out _, out _);
		bridge.Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Main"));
		var candidates = await service.ListWindowCandidatesAsync(Panel);
		var session = await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });

		var listed = await service.ListWindowCandidatesAsync(Panel);
		var candidate = Assert.Single(listed.Windows);

		Assert.True(candidate.Attached);
		Assert.False(candidate.Attachable);
		Assert.Equal(session.Id, candidate.SessionId);
		Assert.Equal(session.Windows[0].Id, candidate.Id);
	}

	[Fact]
	public async Task RawOperatingSystemIdentifiers_AreNeverAcceptedAsInput()
	{
		var service = Service(out var bridge, out var controller, out _);
		bridge.Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Main"));
		var candidates = await service.ListWindowCandidatesAsync(Panel);
		await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });

		// The candidate reported its handle for diagnostics. Handing that handle, or the PID, back
		// as an identifier must not resolve to anything.
		foreach (var forged in new[] { "11", "0x0000000B", "100", "hwnd:11" })
		{
			var attach = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
				service.AttachAsync(Panel, new WindowsAttachRequest { CandidateId = forged }));
			Assert.Equal(WindowsErrorCodes.CandidateNotFound, attach.Code);

			var act = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
				service.RevealAsync(Panel, new WindowsWindowActionRequest { WindowId = forged }));
			Assert.Equal(WindowsErrorCodes.WindowNotAuthorized, act.Code);
		}

		Assert.Empty(controller.Calls);
	}

	[Fact]
	public async Task Candidates_RefuseAWindowWhoseProcessIdentityCannotBeProved()
	{
		var service = Service(out var bridge, out _, out _);
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 100, "No creation time", startFileTime: 0),
			Fixtures.Window(12, 101, "No integrity", integrityValue: 0,
				integrityLevel: WindowsIntegrityLevels.Unknown),
			Fixtures.Window(13, 102, "Partly readable", identityAccess: WindowsIdentityAccess.Limited));

		var listed = await service.ListWindowCandidatesAsync(Panel);

		Assert.Equal(WindowsErrorCodes.WindowNotAuthorized, listed.Windows[0].UnattachableCode);
		Assert.Equal(WindowsErrorCodes.WindowNotAuthorized, listed.Windows[1].UnattachableCode);
		// "Limited" is fine as long as the identity that matters was still readable.
		Assert.True(listed.Windows[2].Attachable);
	}

	[Fact]
	public async Task Session_NeverAdoptsWindowsWhoseIdentityIsMerelyUnknown()
	{
		var service = Service(out var bridge, out _, out _);
		bridge.Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Main"));
		var candidates = await service.ListWindowCandidatesAsync(Panel);
		await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });

		// A second window whose creation time is unreadable reports 0, exactly as the session's
		// own record would if it had been unreadable. Zero must never match zero.
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 100, "Main"),
			Fixtures.Window(12, 100, "Unreadable", startFileTime: 0));

		var windows = await service.ListSessionWindowsAsync(Panel);

		Assert.Equal("Main", Assert.Single(windows.Windows).Title);
	}

	[Fact]
	public async Task Session_DropsAFrameHostWindowThatNowHostsADifferentApp()
	{
		var service = Service(out var bridge, out var controller, out _);
		const string frameHost = "C:\\Windows\\System32\\ApplicationFrameHost.exe";
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(
				11,
				900,
				"Fixture packaged app",
				processPath: frameHost,
				aumid: "Fixture.App_8wekyb3d8bbwe!App",
				packageFamily: "Fixture.App_8wekyb3d8bbwe"));
		var candidates = await service.ListWindowCandidatesAsync(Panel);
		var session = await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });
		var windowId = session.Windows[0].Id;

		// Same handle, same frame-host process, different packaged app inside it.
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(
				11,
				900,
				"Someone else's app",
				processPath: frameHost,
				aumid: "Contoso.Other_8wekyb3d8bbwe!App",
				packageFamily: "Contoso.Other_8wekyb3d8bbwe"));

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.RevealAsync(Panel, new WindowsWindowActionRequest { WindowId = windowId }));

		Assert.Equal(WindowsErrorCodes.WindowNotAuthorized, failure.Code);
		Assert.Empty(controller.Calls);
	}

	private static WindowsAppService Service(
		out FakeWindowsNativeBridge bridge,
		out FakeWindowController controller,
		out FakeProcessLauncher launcher)
	{
		bridge = new FakeWindowsNativeBridge();
		controller = new FakeWindowController();
		launcher = new FakeProcessLauncher();
		return new WindowsAppService(bridge, controller, launcher);
	}
}
