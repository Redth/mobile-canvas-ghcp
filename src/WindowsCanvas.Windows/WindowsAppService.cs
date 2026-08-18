using System.Collections.Concurrent;
using System.Security.Cryptography;
using MobileCanvas.Contracts;
using WindowsCanvas.Contracts;

namespace WindowsCanvas.Windows;

/// <summary>
/// The one guarded entry point to Windows desktop automation.
///
/// State is keyed by <see cref="CanvasContextKey"/>, so a panel sees its own app session, its own
/// window candidates, and nothing else. Callers never name a window: they hand back an opaque
/// identifier this service minted for their panel, and every resolution re-reads the live desktop
/// and re-proves the window's handle, process identity, Windows session, and integrity before the
/// identifier means anything. That is what keeps a grant from surviving into a reused handle or a
/// recycled process ID.
/// </summary>
public sealed class WindowsAppService(
	IWindowsNativeBridge bridge,
	IWindowsWindowController windowController,
	IWindowsProcessLauncher processLauncher,
	IWindowsWindowGeometry? windowGeometry = null,
	IWindowsInputController? inputController = null)
{
	/// <summary>
	/// How long an untouched panel keeps its session and candidate identifiers. A canvas that was
	/// closed without detaching must not leave an app authorized indefinitely.
	/// </summary>
	private static readonly TimeSpan PanelLifetime = TimeSpan.FromHours(4);
	private static readonly TimeSpan ThumbnailEnumerationLifetime = TimeSpan.FromMilliseconds(250);

	private static readonly TimeSpan CorrelationPollInterval = TimeSpan.FromMilliseconds(250);
	private const double MaximumCorrelationTimeoutSeconds = 60;

	private readonly IWindowsWindowGeometry _geometry = windowGeometry ?? new Win32WindowGeometry();
	private readonly IWindowsInputController _input = inputController ?? new Win32InputController();

	private readonly ConcurrentDictionary<CanvasContextKey, PanelState> _panels = new();

	/// <summary>
	/// What this machine can do, and what to do about it when it cannot. Never throws for a
	/// missing helper or a non-Windows host: those are the answers, not failures to produce one.
	/// </summary>
	public async Task<WindowsPreflight> GetPreflightAsync(CancellationToken cancellationToken = default)
	{
		var location = bridge.Locate();
		if (!location.PlatformSupported)
		{
			return new WindowsPreflight
			{
				Ready = false,
				PlatformSupported = false,
				Code = WindowsErrorCodes.PlatformUnsupported,
				Detail = location.Detail ?? "Windows App Canvas runs only on Windows.",
				HelperPath = location.Path,
			};
		}
		if (!location.Present)
		{
			return new WindowsPreflight
			{
				Ready = false,
				PlatformSupported = true,
				Code = WindowsErrorCodes.HelperMissing,
				Detail = location.Detail,
				HelperPath = location.Path,
			};
		}

		WindowsHelperCapabilities capabilities;
		try
		{
			capabilities = await bridge.GetCapabilitiesAsync(cancellationToken).ConfigureAwait(false);
		}
		catch (WindowsCanvasException exception)
		{
			return new WindowsPreflight
			{
				Ready = false,
				PlatformSupported = true,
				Code = exception.Code,
				Detail = exception.Message,
				HelperPath = location.Path,
				HelperPresent = true,
			};
		}

		var features = capabilities.Features;
		var signature = features?.AuthenticodeSignature;
		var session = capabilities.Session;
		var interactive = session?.Interactive ?? false;
		var stale = DescribeStaleHelper(capabilities);
		return new WindowsPreflight
		{
			Ready = interactive,
			PlatformSupported = true,
			Code = interactive ? null : WindowsErrorCodes.SessionNotInteractive,
			Detail = interactive
				? stale
				: "The host is not running in an interactive Windows session, so it can neither " +
					"see nor drive desktop windows.",
			HelperPath = location.Path,
			HelperPresent = true,
			HelperVersion = capabilities.HelperVersion,
			HelperArchitecture = capabilities.Architecture,
			HelperSchemaVersion = capabilities.SchemaVersion,
			SignatureStatus = signature?.Status,
			SignatureValid = signature?.Valid ?? false,
			Features =
			[
				Feature(WindowsFeatureNames.ShellAppCatalog, features?.ShellAppCatalog),
				Feature(WindowsFeatureNames.UiAutomation, features?.UiAutomation),
				new WindowsFeatureState
				{
					Name = WindowsFeatureNames.WindowsGraphicsCapture,
					Available = features?.WindowsGraphicsCapture?.Available ?? false,
					Detail = features?.WindowsGraphicsCapture is { Available: false } capture
						? $"Requires Windows build {capture.MinimumBuild}; this machine reports " +
							$"{capture.ReportedBuild} ({capture.Hresult})."
						: null,
				},
				Feature(WindowsFeatureNames.MediaFoundationH264, features?.MediaFoundationH264),
				Feature(WindowsFeatureNames.SendInput, features?.SendInput),
			],
			Environment = session is null
				? null
				: new WindowsSessionEnvironment
				{
					SessionId = session.Id,
					Interactive = session.Interactive,
					IntegrityLevel = session.IntegrityLevel,
					IntegrityValue = session.IntegrityValue,
					OperatingSystem = capabilities.Os is { } os
						? $"{os.Family} {os.Major}.{os.Minor} build {os.Build} ({os.NativeArchitecture})"
						: null,
				},
		};
	}

	public async Task<WindowsCatalogResult> ListCatalogAsync(
		WindowsCatalogQuery? query = null,
		CancellationToken cancellationToken = default)
	{
		var catalog = await bridge.GetCatalogAsync(cancellationToken).ConfigureAwait(false);
		return WindowsCatalogNormalizer.Normalize(catalog, query);
	}

	/// <summary>
	/// Every top-level window this panel could attach to, with a fresh identifier minted for this
	/// panel. Windows in another logon session, above the host's integrity, or whose owning
	/// process the helper could not identify are listed and explicitly refused rather than hidden.
	/// </summary>
	public async Task<WindowsWindowCandidateList> ListWindowCandidatesAsync(
		CanvasContextKey key,
		CancellationToken cancellationToken = default)
	{
		var panel = Panel(key);
		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			var live = await RefreshAsync(panel, cancellationToken).ConfigureAwait(false);
			return BuildCandidates(panel, live);
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	public async Task<WindowsAppSession> LaunchCatalogAppAsync(
		CanvasContextKey key,
		WindowsCatalogLaunchRequest request,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(request);
		var panel = Panel(key);

		var catalog = await bridge.GetCatalogAsync(cancellationToken).ConfigureAwait(false);
		var entry = WindowsCatalogNormalizer.Resolve(catalog, request.EntryId);
		var launch = await bridge.LaunchCatalogEntryAsync(entry.Id, cancellationToken)
			.ConfigureAwait(false);

		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			var session = new WindowsSessionState
			{
				Id = NewId("was"),
				Origin = WindowsSessionOrigins.Catalog,
				CreatedAt = DateTimeOffset.UtcNow,
				DisplayName = entry.DisplayName,
				CatalogEntryId = entry.Id,
				AppUserModelId = entry.AppUserModelId ?? launch.Entry?.AppUserModelId,
				PackageFamilyName = entry.PackageFamilyName ?? launch.Entry?.PackageFamilyName,
				ExecutablePath = entry.ExecutablePath ?? launch.Entry?.ExecutablePath,
			};
			if (launch.ProcessId > 0)
			{
				session.RememberProcess(new WindowsProcessRecord(
					launch.ProcessId,
					launch.ProcessStartFileTime,
					session.ExecutablePath,
					WindowsWindowCorrelator.IsSharedHostProcess(session.ExecutablePath),
					Observed: true));
			}

			panel.Session = session;
			return await CorrelateLaunchAsync(
				panel,
				session,
				request.CorrelationTimeout,
				cancellationToken).ConfigureAwait(false);
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	public async Task<WindowsAppSession> LaunchExecutableAsync(
		CanvasContextKey key,
		WindowsExecutableLaunchRequest request,
		CancellationToken cancellationToken = default)
	{
		var panel = Panel(key);
		var (executablePath, arguments, workingDirectory) =
			WindowsExecutableRequest.Validate(request);

		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			// Prove the helper works and the host has a desktop *before* starting anything. A
			// launch that succeeded and then failed to correlate because this is not Windows would
			// have left a real process running for nobody.
			await ListLiveAsync(cancellationToken).ConfigureAwait(false);

			var launched = processLauncher.Launch(executablePath, arguments, workingDirectory);
			var session = new WindowsSessionState
			{
				Id = NewId("was"),
				Origin = WindowsSessionOrigins.Executable,
				CreatedAt = DateTimeOffset.UtcNow,
				DisplayName = Path.GetFileNameWithoutExtension(executablePath),
				ExecutablePath = executablePath,
			};
			session.RememberProcess(new WindowsProcessRecord(
				launched.ProcessId,
				launched.StartedAt?.UtcDateTime.ToFileTimeUtc() ?? 0,
				executablePath,
				WindowsWindowCorrelator.IsSharedHostProcess(executablePath),
				Observed: true));

			panel.Session = session;
			return await CorrelateLaunchAsync(
				panel,
				session,
				request.CorrelationTimeout,
				cancellationToken).ConfigureAwait(false);
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	/// <summary>
	/// Attaches to a window the user picked. This is the escape hatch for every app whose launch
	/// cannot be correlated: the user proved which window they meant by choosing it.
	/// </summary>
	public async Task<WindowsAppSession> AttachAsync(
		CanvasContextKey key,
		WindowsAttachRequest request,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(request);
		var panel = Panel(key);

		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			if (!panel.Candidates.TryGetValue(request.CandidateId ?? "", out var candidate))
			{
				throw WindowsCanvasException.NotFound(
					WindowsErrorCodes.CandidateNotFound,
					"That window is not one this canvas was offered. List windows again and " +
					"attach one of the identifiers it returns.");
			}

			var live = await ListLiveAsync(cancellationToken).ConfigureAwait(false);
			var window = Resolve(live, candidate);
			var sharedHost = WindowsWindowCorrelator.IsSharedHostProcess(window.ProcessPath);
			var session = new WindowsSessionState
			{
				Id = NewId("was"),
				Origin = WindowsSessionOrigins.Attach,
				CreatedAt = DateTimeOffset.UtcNow,
				DisplayName = DescribeWindow(window),
				AppUserModelId = Normalize(window.AppUserModelId),
				PackageFamilyName = Normalize(window.PackageFamilyName),
				ExecutablePath = sharedHost ? null : Normalize(window.ProcessPath),
			};
			session.RememberProcess(new WindowsProcessRecord(
				window.ProcessId,
				window.ProcessStartFileTime,
				window.ProcessPath,
				sharedHost,
				Observed: false));
			session.Windows.Add(new WindowsAuthorizedRecord(
				NewId("win"),
				WindowsWindowKey.Of(window),
				WindowsCorrelationReasons.Attached));
			session.SelectedWindowId = session.Windows[0].Id;

			panel.Session = session;
			Reconcile(session, live);
			return Project(session, live);
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	public async Task<WindowsAppSelection> GetSelectionAsync(
		CanvasContextKey key,
		CancellationToken cancellationToken = default)
	{
		var panel = Panel(key);
		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			if (panel.Session is null)
				return new WindowsAppSelection { HasSelection = false };
			var live = await RefreshAsync(panel, cancellationToken).ConfigureAwait(false);
			return new WindowsAppSelection
			{
				HasSelection = true,
				Session = Project(panel.Session, live),
			};
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	public async Task<WindowsAuthorizedWindowList> ListSessionWindowsAsync(
		CanvasContextKey key,
		CancellationToken cancellationToken = default)
	{
		var panel = Panel(key);
		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			var session = RequireSession(panel);
			var live = await RefreshAsync(panel, cancellationToken).ConfigureAwait(false);
			var projected = Project(session, live);
			return new WindowsAuthorizedWindowList
			{
				SessionId = session.Id,
				Windows = projected.Windows,
				SelectedWindowId = projected.SelectedWindowId,
			};
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	public async Task<WindowsAppSession> SelectWindowAsync(
		CanvasContextKey key,
		WindowsSelectWindowRequest request,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(request);
		var panel = Panel(key);
		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			var session = RequireSession(panel);
			var live = await RefreshAsync(panel, cancellationToken).ConfigureAwait(false);
			var record = RequireWindow(session, request.WindowId);
			// Selection is an action on the window, so the identity is re-proved here too rather
			// than being trusted because the refresh above happened to keep the record.
			Resolve(live, record.Key);
			session.SelectedWindowId = record.Id;
			return Project(session, live);
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	public Task<WindowsOperationResult> RevealAsync(
		CanvasContextKey key,
		WindowsWindowActionRequest? request = null,
		CancellationToken cancellationToken = default) =>
		ActAsync(key, request, "reveal", windowController.Reveal, cancellationToken);

	public Task<WindowsOperationResult> RestoreAsync(
		CanvasContextKey key,
		WindowsWindowActionRequest? request = null,
		CancellationToken cancellationToken = default) =>
		ActAsync(key, request, "restore", windowController.Restore, cancellationToken);

	/// <summary>
	/// Reads a bounded semantic UI tree for one opaque, authorized window. The ID is resolved and
	/// revalidated under the panel gate immediately before the helper receives the live handle.
	/// </summary>
	public async Task<WindowsUiSnapshot> GetUiSnapshotAsync(
		CanvasContextKey key,
		string windowId,
		WindowsUiSnapshotRequest? request = null,
		CancellationToken cancellationToken = default)
	{
		var normalized = WindowsUiAutomationNormalizer.SnapshotRequest(request);
		var panel = Panel(key);
		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			var session = RequireSession(panel);
			var live = await RefreshAsync(panel, cancellationToken).ConfigureAwait(false);
			var target = Resolve(live, RequireWindow(session, windowId).Key);
			var result = await bridge.GetUiSnapshotAsync(
				new WindowsNativeWindowTarget(target),
				normalized,
				cancellationToken)
				.ConfigureAwait(false);
			return WindowsUiAutomationNormalizer.Snapshot(result, normalized);
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	/// <summary>
	/// Finds every current semantic match in one authorized window. Unlike an action, finding may
	/// return more than one match; callers must add selector qualification before they act.
	/// </summary>
	public async Task<WindowsUiFindResult> FindUiAsync(
		CanvasContextKey key,
		string windowId,
		WindowsUiQuery? query = null,
		CancellationToken cancellationToken = default)
	{
		var normalized = WindowsUiAutomationNormalizer.Query(query);
		var panel = Panel(key);
		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			var session = RequireSession(panel);
			var live = await RefreshAsync(panel, cancellationToken).ConfigureAwait(false);
			var target = Resolve(live, RequireWindow(session, windowId).Key);
			var result = await bridge.FindUiAsync(
				new WindowsNativeWindowTarget(target),
				normalized,
				cancellationToken).ConfigureAwait(false);
			return WindowsUiAutomationNormalizer.Find(result, normalized);
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	/// <summary>
	/// Re-enumerates and re-resolves a semantic selector before performing exactly one action. The
	/// helper reports no-match and multi-match as explicit errors and never chooses a first match.
	/// </summary>
	public async Task<WindowsUiActionResult> ActUiAsync(
		CanvasContextKey key,
		string windowId,
		WindowsUiActionRequest request,
		CancellationToken cancellationToken = default)
	{
		var normalized = WindowsUiAutomationNormalizer.Action(request);
		var panel = Panel(key);
		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			var session = RequireSession(panel);
			var live = await RefreshAsync(panel, cancellationToken).ConfigureAwait(false);
			var target = Resolve(live, RequireWindow(session, windowId).Key);
			var result = await bridge.ActUiAsync(
				new WindowsNativeWindowTarget(target),
				normalized,
				cancellationToken).ConfigureAwait(false);
			return WindowsUiAutomationNormalizer.ActionResult(result, normalized);
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	/// <summary>
	/// Waits using bounded helper polling against a freshly re-resolved selector. Exists and
	/// not-exists may observe zero or many elements; property and state waits require one match.
	/// </summary>
	public async Task<WindowsUiWaitResult> WaitUiAsync(
		CanvasContextKey key,
		string windowId,
		WindowsUiWaitRequest request,
		CancellationToken cancellationToken = default)
	{
		var normalized = WindowsUiAutomationNormalizer.Wait(request);
		var panel = Panel(key);
		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			var session = RequireSession(panel);
			var live = await RefreshAsync(panel, cancellationToken).ConfigureAwait(false);
			var target = Resolve(live, RequireWindow(session, windowId).Key);
			var result = await bridge.WaitUiAsync(
				new WindowsNativeWindowTarget(target),
				normalized,
				cancellationToken).ConfigureAwait(false);
			return WindowsUiAutomationNormalizer.WaitResult(result, normalized);
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	/// <summary>
	/// Captures one still PNG of an authorized window through the same visible crop, geometry, and
	/// coordinate space a live stream uses, so an agent can look at a screenshot and send
	/// coordinates without converting between two ideas of the window.
	/// </summary>
	public async Task<WindowsScreenshot> CaptureScreenshotAsync(
		CanvasContextKey key,
		WindowsScreenshotRequest? request = null,
		CancellationToken cancellationToken = default)
	{
		var normalized = WindowsCaptureNormalizer.Screenshot(request);
		var panel = Panel(key);
		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			var session = RequireSession(panel);
			var live = await RefreshAsync(panel, cancellationToken).ConfigureAwait(false);
			var record = RequireWindow(session, normalized.WindowId ?? session.SelectedWindowId);
			var window = Resolve(live, record.Key);
			RequireCapturable(window);

			var screenshot = await bridge.CaptureScreenshotAsync(
				new WindowsNativeWindowTarget(window),
				normalized,
				cancellationToken).ConfigureAwait(false);
			return screenshot with
			{
				Descriptor = screenshot.Descriptor with
				{
					WindowId = record.Id,
					Geometry = WindowsCaptureTransform.Stamp(
						screenshot.Descriptor.Geometry,
						record.Key),
				},
			};
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	/// <summary>
	/// Captures one bounded PNG preview of a window this panel was *offered* but has not attached,
	/// so a person can recognise a window before granting anything.
	///
	/// This is read-only in the strongest sense the product has: it authorizes nothing, selects
	/// nothing, gives no window the foreground, and leaves the panel's app session exactly as it
	/// found it. The only thing it accepts is a candidate identifier this panel was handed by
	/// <see cref="ListWindowCandidatesAsync"/>, and that identifier is re-proved against the live
	/// desktop — handle, process ID, process creation time, packaged identity, logon session, and
	/// integrity — immediately before a single pixel is read. A candidate whose window closed, was
	/// replaced through a reused handle, or now runs above this host is refused with the same codes
	/// every other window operation uses, so a picker can draw an honest placeholder instead of a
	/// stale picture.
	/// </summary>
	public async Task<WindowsScreenshot> CaptureCandidateThumbnailAsync(
		CanvasContextKey key,
		string candidateId,
		int maximumDimension = 0,
		CancellationToken cancellationToken = default)
	{
		// Refused before any window is enumerated on this caller's behalf: a nonsense request
		// should not cost a desktop walk to find out about.
		var bounded = WindowsCaptureNormalizer.ThumbnailDimension(maximumDimension);
		var panel = Panel(key);
		var id = candidateId?.Trim() ?? "";
		WindowsWindowKey identity;
		WindowsHelperWindow window;
		WindowsScreenshotRequest request;
		string? signature;

		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			identity = RequireCandidate(panel, id);

			// A picker asks for every card at once. Coalesce that burst to one short-lived desktop
			// snapshot instead of spawning one enumeration helper per card. This remains the plain,
			// non-reconciling path: previewing candidates must never adopt them into the session.
			if (!panel.TryReadThumbnailWindows(
					DateTimeOffset.UtcNow,
					ThumbnailEnumerationLifetime,
					out var live))
			{
				live = await ListLiveAsync(cancellationToken).ConfigureAwait(false);
				panel.StoreThumbnailWindows(live, DateTimeOffset.UtcNow);
			}
			window = Resolve(live, identity);
			if (!WindowsWindowCorrelator.IsCandidate(window))
			{
				throw WindowsCanvasException.NotFound(
					WindowsErrorCodes.CandidateNotFound,
					"That window is no longer one this canvas is being offered. List windows " +
					"again to see what is open now.");
			}
			RequireCapturable(window);

			var geometry = _geometry.Read(window.Handle);
			request = WindowsCaptureNormalizer.Thumbnail(
				bounded,
				geometry?.ContentWidth ?? window.Bounds?.Width ?? 0,
				geometry?.ContentHeight ?? window.Bounds?.Height ?? 0);

			// The transform token fingerprints identity *and* geometry, which is exactly what a
			// cached picture stops being true about. A window that moved, resized, changed DPI, or
			// had its handle recycled produces a different signature and is captured again.
			signature = geometry is null
				? null
				: WindowsCaptureTransform.Version(identity, geometry);
			if (panel.TryReadThumbnail(id, request.MaximumDimension, signature, out var cached))
				return cached;
		}
		finally
		{
			panel.Gate.Release();
		}

		// Captured outside the panel gate so a grid of picker cards does not serialize behind one
		// another's helper startup, but behind a small per-panel limit so it cannot become one
		// Direct3D capture process per open window either.
		await panel.ThumbnailGate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			using var attempt = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
			attempt.CancelAfter(WindowsThumbnailLimits.TimeoutMilliseconds);

			WindowsScreenshot captured;
			try
			{
				captured = await bridge.CaptureScreenshotAsync(
					new WindowsNativeWindowTarget(window),
					request,
					attempt.Token).ConfigureAwait(false);
			}
			catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
			{
				throw WindowsCanvasException.Gateway(
					WindowsErrorCodes.CaptureFailed,
					"That window did not produce a preview frame within " +
					$"{WindowsThumbnailLimits.TimeoutMilliseconds}ms, so the picker was given a " +
					"failure rather than a hang.");
			}

			WindowsCaptureNormalizer.RequireThumbnailSize(captured.Png.Length);
			var thumbnail = captured with
			{
				Descriptor = captured.Descriptor with
				{
					// The candidate ID takes the descriptor's identifier slot: this image is of a
					// window that was offered, not of one that was authorized, and saying so keeps
					// a caller from mistaking it for a window it may drive.
					WindowId = id,
					ByteCount = captured.Png.Length,
					Geometry = WindowsCaptureTransform.Stamp(
						captured.Descriptor.Geometry,
						identity),
				},
			};

			if (signature is not null)
				panel.StoreThumbnail(id, request.MaximumDimension, signature, thumbnail);
			return thumbnail;
		}
		finally
		{
			panel.ThumbnailGate.Release();
		}
	}

	/// <summary>
	/// Opens a live Annex-B H.264 stream of an authorized window.
	///
	/// The window is resolved and revalidated under the panel gate, but the helper is started
	/// outside it: a capture pipeline takes time to negotiate an adapter and an encoder, and a
	/// panel must stay answerable meanwhile. The helper echoes the window identity it captured, and
	/// the bridge refuses a stream of anything else, so releasing the gate cannot widen what the
	/// caller sees.
	/// </summary>
	public async Task<IWindowsVideoSession> OpenVideoStreamAsync(
		CanvasContextKey key,
		WindowsStreamRequest? request = null,
		CancellationToken cancellationToken = default)
	{
		var normalized = WindowsCaptureNormalizer.Stream(request);
		var panel = Panel(key);
		WindowsAuthorizedRecord record;
		WindowsHelperWindow window;

		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			var session = RequireSession(panel);
			var live = await RefreshAsync(panel, cancellationToken).ConfigureAwait(false);
			record = RequireWindow(session, normalized.WindowId ?? session.SelectedWindowId);
			window = Resolve(live, record.Key);
			RequireCapturable(window);
		}
		finally
		{
			panel.Gate.Release();
		}

		var inner = await bridge.OpenVideoAsync(
			new WindowsNativeWindowTarget(window),
			normalized,
			cancellationToken).ConfigureAwait(false);
		try
		{
			return new WindowsIdentifiedVideoSession(
				inner,
				inner.Descriptor with
				{
					WindowId = record.Id,
					Geometry = WindowsCaptureTransform.Stamp(inner.Descriptor.Geometry, record.Key),
				});
		}
		catch
		{
			await inner.DisposeAsync().ConfigureAwait(false);
			throw;
		}
	}

	/// <summary>
	/// The window's live geometry and current transform token, without capturing anything. This is
	/// what lets a caller that already has a screenshot check whether its coordinates are still
	/// valid before spending a frame to find out.
	/// </summary>
	public async Task<WindowsCaptureGeometry> GetGeometryAsync(
		CanvasContextKey key,
		string? windowId = null,
		CancellationToken cancellationToken = default)
	{
		var panel = Panel(key);
		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			var session = RequireSession(panel);
			var live = await RefreshAsync(panel, cancellationToken).ConfigureAwait(false);
			var record = RequireWindow(session, windowId ?? session.SelectedWindowId);
			var window = Resolve(live, record.Key);
			return RequireGeometry(record, window, allowMinimized: true);
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	/// <summary>
	/// Clicks once or twice with one button. Prefer the semantic UI Automation actions: this path
	/// exists for owner-drawn and inaccessible content that has no semantic tree to act on.
	/// </summary>
	public Task<WindowsInputResult> ClickAsync(
		CanvasContextKey key,
		WindowsClickRequest request,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(request);
		var button = WindowsPointerButtons.Normalize(request.Button);
		var count = WindowsInputLimits.ClickCount(request.Count);
		var modifiers = ResolveModifiers(request.Modifiers);
		var mode = WindowsInputModes.Normalize(request.Mode);
		if (mode == WindowsInputModes.Background)
		{
			return BackgroundClickAsync(
				key,
				request,
				button,
				count,
				modifiers,
				cancellationToken);
		}
		return RunInputAsync(
			key,
			request.WindowId,
			request.TransformVersion,
			(panel, target) =>
			{
				var point = RequirePoint(
					request.X,
					request.Y,
					request.CaptureWidth,
					request.CaptureHeight,
					target.Geometry);
				var (screenX, screenY) = WindowsInputMapper.ToScreen(point, target.Geometry);
				RequireUncovered(target, screenX, screenY);

				Require(_input.MovePointer(screenX, screenY));
				HoldModifiers(panel, modifiers);
				try
				{
					for (var index = 0; index < count; index++)
					{
						PressButton(panel, button, screenX, screenY);
						ReleaseButton(panel, button, screenX, screenY);
					}
				}
				finally
				{
					ReleaseModifiers(panel, modifiers);
				}

				return Task.FromResult(Describe(
					target,
					count == 2 ? $"doubleClick:{button}" : $"click:{button}",
					point,
					screenX,
					screenY));
			},
			cancellationToken);
	}

	/// <summary>
	/// One half of a gesture: press, move, or release. A button left down by a caller that stopped
	/// halfway is released when the panel errors, releases its session, or detaches.
	/// </summary>
	public Task<WindowsInputResult> PointerAsync(
		CanvasContextKey key,
		WindowsPointerRequest request,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(request);
		var action = WindowsPointerActions.Normalize(request.Action);
		var button = WindowsPointerButtons.Normalize(request.Button);
		var modifiers = ResolveModifiers(request.Modifiers);
		RequireForegroundMode(request.Mode, "Pointer gestures");
		return RunInputAsync(
			key,
			request.WindowId,
			request.TransformVersion,
			(panel, target) =>
			{
				var point = RequirePoint(
					request.X,
					request.Y,
					request.CaptureWidth,
					request.CaptureHeight,
					target.Geometry);
				var (screenX, screenY) = WindowsInputMapper.ToScreen(point, target.Geometry);
				if (action != WindowsPointerActions.Up)
					RequireUncovered(target, screenX, screenY);

				HoldModifiers(panel, modifiers);
				try
				{
					Require(_input.MovePointer(screenX, screenY));
					panel.LastPointer = (screenX, screenY);
					switch (action)
					{
						case WindowsPointerActions.Down:
							PressButton(panel, button, screenX, screenY);
							break;
						case WindowsPointerActions.Up:
							ReleaseButton(panel, button, screenX, screenY);
							break;
					}
				}
				finally
				{
					// A held button survives the request on purpose; a held modifier never does.
					ReleaseModifiers(panel, modifiers);
				}

				return Task.FromResult(Describe(
					target,
					$"pointer:{action}:{button}",
					point,
					screenX,
					screenY));
			},
			cancellationToken);
	}

	/// <summary>Presses, moves along an interpolated path, and releases, as one operation.</summary>
	public Task<WindowsInputResult> DragAsync(
		CanvasContextKey key,
		WindowsDragRequest request,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(request);
		var button = WindowsPointerButtons.Normalize(request.Button);
		var steps = WindowsInputLimits.DragSteps(request.Steps);
		var duration = WindowsInputLimits.Duration(
			request.DurationMilliseconds,
			WindowsInputLimits.DefaultDragDurationMilliseconds);
		var modifiers = ResolveModifiers(request.Modifiers);
		RequireForegroundMode(request.Mode, "Dragging");
		return RunInputAsync(
			key,
			request.WindowId,
			request.TransformVersion,
			async (panel, target) =>
			{
				var start = RequirePoint(
					request.StartX,
					request.StartY,
					request.CaptureWidth,
					request.CaptureHeight,
					target.Geometry);
				var end = RequirePoint(
					request.EndX,
					request.EndY,
					request.CaptureWidth,
					request.CaptureHeight,
					target.Geometry);
				var (startX, startY) = WindowsInputMapper.ToScreen(start, target.Geometry);
				var (endX, endY) = WindowsInputMapper.ToScreen(end, target.Geometry);
				RequireUncovered(target, startX, startY);

				var path = WindowsInputMapper.Path(start, end, steps);
				var interval = TimeSpan.FromMilliseconds((double)duration / path.Length);

				Require(_input.MovePointer(startX, startY));
				HoldModifiers(panel, modifiers);
				try
				{
					PressButton(panel, button, startX, startY);
					foreach (var step in path)
					{
						var (stepX, stepY) = WindowsInputMapper.ToScreen(step, target.Geometry);
						Require(_input.MovePointer(stepX, stepY));
						panel.LastPointer = (stepX, stepY);
						if (interval > TimeSpan.Zero)
							await Task.Delay(interval, cancellationToken).ConfigureAwait(false);
					}
					ReleaseButton(panel, button, endX, endY);
				}
				finally
				{
					ReleaseModifiers(panel, modifiers);
				}

				return Describe(target, $"drag:{button}", start, startX, startY) with
				{
					EndPoint = end,
				};
			},
			cancellationToken);
	}

	/// <summary>Scrolls with the wheel, vertically, horizontally, or both.</summary>
	public Task<WindowsInputResult> WheelAsync(
		CanvasContextKey key,
		WindowsWheelRequest request,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(request);
		var vertical = RequireNotches(request.DeltaY, "deltaY");
		var horizontal = RequireNotches(request.DeltaX, "deltaX");
		if (vertical == 0 && horizontal == 0)
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				"A wheel request needs a non-zero deltaX or deltaY, in wheel notches.");
		}
		var modifiers = ResolveModifiers(request.Modifiers);
		var mode = WindowsInputModes.Normalize(request.Mode);
		if (mode == WindowsInputModes.Background)
		{
			return BackgroundWheelAsync(
				key,
				request,
				vertical,
				horizontal,
				modifiers,
				cancellationToken);
		}
		return RunInputAsync(
			key,
			request.WindowId,
			request.TransformVersion,
			(panel, target) =>
			{
				var point = RequirePoint(
					request.X,
					request.Y,
					request.CaptureWidth,
					request.CaptureHeight,
					target.Geometry);
				var (screenX, screenY) = WindowsInputMapper.ToScreen(point, target.Geometry);
				RequireUncovered(target, screenX, screenY);

				Require(_input.MovePointer(screenX, screenY));
				HoldModifiers(panel, modifiers);
				try
				{
					Require(_input.Wheel(screenX, screenY, vertical, horizontal));
				}
				finally
				{
					ReleaseModifiers(panel, modifiers);
				}

				return Task.FromResult(Describe(target, "wheel", point, screenX, screenY));
			},
			cancellationToken);
	}

	/// <summary>
	/// Presses, releases, or taps one or more keys. A <c>press</c> holds the keys in the order they
	/// were given and releases them in reverse, which is what turns ctrl+shift+p into a chord
	/// rather than three separate taps.
	/// </summary>
	public Task<WindowsInputResult> KeyAsync(
		CanvasContextKey key,
		WindowsKeyRequest request,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(request);
		var action = WindowsKeyActions.Normalize(request.Action);
		var strokes = ResolveKeys(request.Keys);
		var modifiers = ResolveModifiers(request.Modifiers);
		RequireForegroundMode(request.Mode, "Keyboard input");
		return RunInputAsync(
			key,
			request.WindowId,
			request.TransformVersion,
			(panel, target) =>
			{
				HoldModifiers(panel, modifiers);
				try
				{
					switch (action)
					{
						case WindowsKeyActions.Down:
							foreach (var stroke in strokes)
							{
								Require(_input.Key(stroke, down: true));
								panel.HeldKeys.Add(stroke);
							}
							break;
						case WindowsKeyActions.Up:
							for (var index = strokes.Length - 1; index >= 0; index--)
							{
								Require(_input.Key(strokes[index], down: false));
								panel.HeldKeys.Remove(strokes[index]);
							}
							break;
						default:
							PressChord(panel, strokes);
							break;
					}
				}
				finally
				{
					ReleaseModifiers(panel, modifiers);
				}

				return Task.FromResult(Describe(target, $"key:{action}", point: null, 0, 0) with
				{
					KeyCount = strokes.Length,
					ScreenPoint = null,
				});
			},
			cancellationToken);
	}

	/// <summary>
	/// Types UTF-16 text as Unicode key events.
	///
	/// This is also how a paste-like string is delivered: nothing is ever put on the user's
	/// clipboard, because a canvas that silently replaced what somebody had copied would be a
	/// surprise they never asked for. Newlines become Return and tabs become Tab, since Windows
	/// does not deliver those reliably as Unicode key events. The text itself is never echoed into
	/// a result or a panel activity event; only its length is.
	/// </summary>
	public Task<WindowsInputResult> TypeTextAsync(
		CanvasContextKey key,
		WindowsTypeTextRequest request,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(request);
		var text = request.Text ?? "";
		if (text.Length == 0)
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				"Typing requires some text.");
		}
		if (text.Length > WindowsInputLimits.MaximumTextLength)
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				$"Text is limited to {WindowsInputLimits.MaximumTextLength} UTF-16 code units; " +
				$"this request carried {text.Length}.");
		}
		var delay = TimeSpan.FromMilliseconds(
			Math.Clamp(request.DelayMilliseconds, 0, WindowsInputLimits.MaximumTextDelayMilliseconds));
		RequireForegroundMode(request.Mode, "Typing");

		return RunInputAsync(
			key,
			request.WindowId,
			request.TransformVersion,
			async (panel, target) =>
			{
				foreach (var unit in text)
				{
					switch (unit)
					{
						case '\r':
							continue;
						case '\n':
							PressChord(panel, [WindowsVirtualKeys.Resolve("enter")]);
							break;
						case '\t':
							PressChord(panel, [WindowsVirtualKeys.Resolve("tab")]);
							break;
						default:
							Require(_input.Unicode(unit, down: true));
							Require(_input.Unicode(unit, down: false));
							break;
					}
					if (delay > TimeSpan.Zero)
						await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
				}

				return Describe(target, "text", point: null, 0, 0) with
				{
					CharacterCount = text.Length,
					ScreenPoint = null,
				};
			},
			cancellationToken);
	}

	private Task<WindowsInputResult> BackgroundClickAsync(
		CanvasContextKey key,
		WindowsClickRequest request,
		string button,
		int count,
		WindowsKeyStroke[] modifiers,
		CancellationToken cancellationToken)
	{
		if (button != WindowsPointerButtons.Left || count != 1 || modifiers.Length != 0)
		{
			throw BackgroundUnavailable(
				"Focus-free clicks support one unmodified left click on a semantic control.");
		}

		return RunBackgroundUiAsync(
			key,
			request.WindowId,
			request.TransformVersion,
			request.X,
			request.Y,
			request.CaptureWidth,
			request.CaptureHeight,
			BackgroundClickAction,
			"click",
			scroll: null,
			cancellationToken);
	}

	private Task<WindowsInputResult> BackgroundWheelAsync(
		CanvasContextKey key,
		WindowsWheelRequest request,
		int vertical,
		int horizontal,
		WindowsKeyStroke[] modifiers,
		CancellationToken cancellationToken)
	{
		if (modifiers.Length != 0)
			throw BackgroundUnavailable("Focus-free scrolling does not support modifier keys.");

		var horizontalWins = Math.Abs(horizontal) > Math.Abs(vertical);
		var delta = horizontalWins ? horizontal : vertical;
		var direction = horizontalWins
			? delta > 0 ? WindowsUiScrollDirections.Right : WindowsUiScrollDirections.Left
			: delta > 0 ? WindowsUiScrollDirections.Up : WindowsUiScrollDirections.Down;
		var amount = Math.Abs(delta) >= 3
			? WindowsUiScrollAmounts.Large
			: WindowsUiScrollAmounts.Small;

		return RunBackgroundUiAsync(
			key,
			request.WindowId,
			request.TransformVersion,
			request.X,
			request.Y,
			request.CaptureWidth,
			request.CaptureHeight,
			BackgroundScrollAction,
			"scroll",
			new WindowsUiScrollRequest { Direction = direction, Amount = amount },
			cancellationToken);
	}

	private async Task<WindowsInputResult> RunBackgroundUiAsync(
		CanvasContextKey key,
		string? windowId,
		string transformVersion,
		double x,
		double y,
		int captureWidth,
		int captureHeight,
		Func<WindowsUiElement, string?> actionFor,
		string operation,
		WindowsUiScrollRequest? scroll,
		CancellationToken cancellationToken)
	{
		var panel = Panel(key);
		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			var session = RequireSession(panel);
			var live = await RefreshAsync(panel, cancellationToken).ConfigureAwait(false);
			var record = RequireWindow(session, windowId ?? session.SelectedWindowId);
			var window = Resolve(live, record.Key);
			RequireInputRate(panel);

			var geometry = RequireGeometry(record, window);
			RequireTransform(transformVersion, geometry);
			var point = RequirePoint(x, y, captureWidth, captureHeight, geometry);
			var (screenX, screenY) = WindowsInputMapper.ToScreen(point, geometry);
			var target = new InputTarget(session.Id, record, window, geometry);
			var snapshotRequest = new WindowsUiSnapshotRequest { TimeoutMilliseconds = 2_000 };
			var snapshot = WindowsUiAutomationNormalizer.Snapshot(
				await bridge.GetUiSnapshotAsync(
					new WindowsNativeWindowTarget(window),
					snapshotRequest,
					cancellationToken).ConfigureAwait(false),
				snapshotRequest);
			var hit = FindBackgroundTarget(snapshot.Root, screenX, screenY, actionFor);
			if (hit is null)
			{
				throw BackgroundUnavailable(
					$"That point has no semantic {operation} action. Nothing was sent.");
			}

			var actionRequest = WindowsUiAutomationNormalizer.Action(
				new WindowsUiActionRequest
				{
					Action = hit.Action,
					Selector = SelectorFor(hit.Element, hit.Path),
					Scroll = scroll,
					TimeoutMilliseconds = 2_000,
				});
			var previousForeground = _input.ForegroundWindow;
			var result = WindowsUiAutomationNormalizer.ActionResult(
				await bridge.ActUiAsync(
					new WindowsNativeWindowTarget(window),
					actionRequest,
					cancellationToken).ConfigureAwait(false),
				actionRequest);
			if (!result.Success)
			{
				throw new WindowsCanvasException(
					result.Code ?? WindowsErrorCodes.UiActionFailed,
					result.Detail ?? "The semantic background action failed.");
			}

			var focusDetail = await RestorePreviousForegroundAsync(
				previousForeground,
				window.Handle,
				window.ProcessId,
				cancellationToken).ConfigureAwait(false);
			return Describe(
				target,
				$"{(operation == "scroll" ? "wheel" : "click")}:background:{hit.Action}",
				point,
				screenX,
				screenY,
				foreground: _input.IsForeground(window.Handle)) with
			{
				Detail = focusDetail,
			};
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	private static string? BackgroundClickAction(WindowsUiElement element)
	{
		if (element.Properties.Enabled == false || element.Properties.Offscreen == true)
			return null;
		if (element.SupportedActions.Invoke)
			return WindowsUiActionKinds.Invoke;
		if (element.SupportedActions.Toggle)
			return WindowsUiActionKinds.Toggle;
		if (element.SupportedActions.Select)
			return WindowsUiActionKinds.Select;
		if (element.SupportedActions.Collapse &&
			element.Properties.State == WindowsUiStates.Expanded)
		{
			return WindowsUiActionKinds.Collapse;
		}
		if (element.SupportedActions.Expand)
			return WindowsUiActionKinds.Expand;
		return element.SupportedActions.Collapse ? WindowsUiActionKinds.Collapse : null;
	}

	private static string? BackgroundScrollAction(WindowsUiElement element) =>
		element.Properties.Enabled != false &&
		element.Properties.Offscreen != true &&
		element.SupportedActions.Scroll
			? WindowsUiActionKinds.Scroll
			: null;

	private static BackgroundUiTarget? FindBackgroundTarget(
		WindowsUiElement? root,
		int screenX,
		int screenY,
		Func<WindowsUiElement, string?> actionFor)
	{
		BackgroundUiTarget? best = null;

		void Visit(WindowsUiElement element, int[] path, int depth)
		{
			var bounds = element.Bounds;
			var contains = bounds is not null &&
				bounds.Width > 0 &&
				bounds.Height > 0 &&
				screenX >= bounds.Left &&
				screenX < bounds.Left + bounds.Width &&
				screenY >= bounds.Top &&
				screenY < bounds.Top + bounds.Height;
			if (contains)
			{
				var action = actionFor(element);
				if (action is not null && (best is null || depth >= best.Depth))
					best = new BackgroundUiTarget(element, path, action, depth);
			}

			for (var index = 0; index < element.Children.Length; index++)
				Visit(element.Children[index], [.. path, index], depth + 1);
		}

		if (root is not null)
			Visit(root, [], 0);
		return best;
	}

	private static WindowsUiSelector SelectorFor(WindowsUiElement element, int[] path) =>
		new()
		{
			AutomationId = NullIfEmpty(element.Properties.AutomationId),
			ControlType = element.ControlType == WindowsUiControlTypes.Unknown
				? null
				: element.ControlType,
			Name = NullIfEmpty(element.Properties.Name),
			Exact = true,
			Path = path,
			Index = path.Length == 0 ? 0 : null,
		};

	private static string? NullIfEmpty(string? value) =>
		string.IsNullOrWhiteSpace(value) ? null : value;

	private static void RequireForegroundMode(string? mode, string operation)
	{
		if (WindowsInputModes.Normalize(mode) != WindowsInputModes.Foreground)
		{
			throw BackgroundUnavailable(
				$"{operation} has no universal focus-free Windows API. Nothing was sent.");
		}
	}

	private static WindowsCanvasException BackgroundUnavailable(string detail) =>
		WindowsCanvasException.Conflict(
			WindowsErrorCodes.InputBackgroundUnavailable,
			$"{detail} Use UI Automation, or explicitly switch to foreground control to use the " +
			"real keyboard and pointer.");

	private async Task<string?> RestorePreviousForegroundAsync(
		long previousForeground,
		long target,
		int targetProcessId,
		CancellationToken cancellationToken)
	{
		if (previousForeground == 0 || previousForeground == target)
			return null;

		for (var attempt = 0; attempt < 6; attempt++)
		{
			var foreground = _input.ForegroundWindow;
			if (foreground == target ||
				(targetProcessId != 0 &&
					_input.ProcessIdForWindow(foreground) == targetProcessId))
			{
				break;
			}
			if (foreground != previousForeground)
				return null;
			if (attempt == 5)
				return null;
			await Task.Delay(40, cancellationToken).ConfigureAwait(false);
		}

		WindowsWindowActionOutcome outcome = default;
		for (var attempt = 0; attempt < 5; attempt++)
		{
			await Task.Delay(attempt == 0 ? 80 : 60, cancellationToken).ConfigureAwait(false);
			var foreground = _input.ForegroundWindow;
			if (foreground == previousForeground)
				return null;
			if (foreground != target &&
				_input.ProcessIdForWindow(foreground) != targetProcessId)
			{
				return null;
			}

			outcome = windowController.Reveal(previousForeground);
			if (_input.ForegroundWindow == previousForeground)
				return null;
		}

		return outcome.Detail is null
			? "The semantic action completed, but the app took foreground and Windows would not " +
				"restore the previously active window."
			: $"The semantic action completed, but the app took foreground. {outcome.Detail}";
	}

	/// <summary>
	/// Drops the session and every identifier this panel holds. The app keeps running; what ends
	/// is the canvas's authority over it. Taken under the panel gate so a request that is already
	/// resolving a window cannot race the revocation.
	/// </summary>
	public async Task<WindowsOperationResult> ReleaseAsync(
		CanvasContextKey key,
		CancellationToken cancellationToken = default)
	{
		var panel = Panel(key);
		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			// A panel that walked away mid-drag must not leave a mouse button or a modifier held
			// down on the user's real desktop.
			ReleaseHeldInput(panel);
			var released = panel.Session?.Id;
			panel.Session = null;
			panel.Candidates.Clear();
			panel.CandidateIds.Clear();
			return new WindowsOperationResult
			{
				Operation = "release",
				SessionId = released,
				Detail = released is null ? "No Windows app session was attached." : null,
			};
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	/// <summary>
	/// Forgets a panel entirely. Called when a canvas detaches or closes, so an abandoned panel
	/// cannot leave an authorization behind for a later panel to inherit.
	/// </summary>
	public void Detach(CanvasContextKey key)
	{
		if (_panels.TryRemove(key, out var panel))
		{
			panel.Gate.Wait();
			try
			{
				ReleaseHeldInput(panel);
			}
			finally
			{
				panel.Gate.Release();
			}
		}
	}

	/// <summary>
	/// The one path every coordinate-driven operation takes.
	///
	/// It re-reads the live desktop, re-proves the window's identity, re-reads its geometry, and
	/// only then compares the caller's transform token. A stale token fails here rather than
	/// somewhere further down where the coordinates would already have been turned into a click.
	/// </summary>
	private async Task<WindowsInputResult> RunInputAsync(
		CanvasContextKey key,
		string? windowId,
		string transformVersion,
		Func<PanelState, InputTarget, Task<WindowsInputResult>> action,
		CancellationToken cancellationToken)
	{
		var panel = Panel(key);
		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			var session = RequireSession(panel);
			var live = await RefreshAsync(panel, cancellationToken).ConfigureAwait(false);
			var record = RequireWindow(session, windowId ?? session.SelectedWindowId);
			var window = Resolve(live, record.Key);
			RequireInputRate(panel);

			var geometry = RequireGeometry(record, window);
			RequireTransform(transformVersion, geometry);
			RequireForeground(window);

			var target = new InputTarget(session.Id, record, window, geometry);
			try
			{
				return await action(panel, target).ConfigureAwait(false);
			}
			catch
			{
				// Whatever went wrong, the user's desk must not be left with a button or a
				// modifier stuck down because an operation stopped halfway.
				ReleaseHeldInput(panel);
				throw;
			}
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	/// <summary>A minimized window has no visible content, so capture reports rather than guesses.</summary>
	private static void RequireCapturable(WindowsHelperWindow window)
	{
		if (window.Minimized)
		{
			throw WindowsCanvasException.Conflict(
				WindowsErrorCodes.WindowMinimized,
				"That window is minimized, so it has no visible content to capture. Restore it " +
				"first.");
		}
	}

	private WindowsCaptureGeometry RequireGeometry(
		WindowsAuthorizedRecord record,
		WindowsHelperWindow window,
		bool allowMinimized = false)
	{
		var geometry = _geometry.Read(window.Handle)
			?? throw WindowsCanvasException.NotFound(
				WindowsErrorCodes.WindowNotFound,
				"That window no longer exists.");
		if (!allowMinimized && (geometry.Minimized || window.Minimized))
		{
			throw WindowsCanvasException.Conflict(
				WindowsErrorCodes.WindowMinimized,
				"That window is minimized, so it has no coordinate space to act in. Restore it " +
				"first.");
		}
		if (!allowMinimized && (geometry.ContentWidth <= 0 || geometry.ContentHeight <= 0))
		{
			throw WindowsCanvasException.Conflict(
				WindowsErrorCodes.InputOutOfBounds,
				"That window currently has no visible content area.");
		}
		return WindowsCaptureTransform.Stamp(geometry, record.Key);
	}

	private static void RequireTransform(string presented, WindowsCaptureGeometry geometry)
	{
		if (string.IsNullOrWhiteSpace(presented))
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InputTransformStale,
				"Coordinate input requires the transformVersion from the screenshot or stream " +
				$"descriptor the coordinates were measured against. The current one is " +
				$"'{geometry.TransformVersion}'.");
		}
		if (!WindowsCaptureTransform.Matches(presented, geometry.TransformVersion))
		{
			throw WindowsCanvasException.Conflict(
				WindowsErrorCodes.InputTransformStale,
				"The window moved, resized, changed DPI, or was minimized since those coordinates " +
				$"were measured. Capture it again: the current transformVersion is " +
				$"'{geometry.TransformVersion}'.");
		}
	}

	/// <summary>
	/// Synthetic input goes to whatever owns the foreground, so the target has to own it. Windows
	/// deliberately refuses foreground changes from a process the user is not interacting with, and
	/// that refusal is reported rather than worked around.
	/// </summary>
	private void RequireForeground(WindowsHelperWindow window)
	{
		if (_input.IsForeground(window.Handle))
			return;

		var outcome = windowController.Reveal(window.Handle);
		if (_input.IsForeground(window.Handle))
			return;

		throw WindowsCanvasException.Conflict(
			WindowsErrorCodes.InputForegroundRefused,
			outcome.Detail is null
				? "That window is not in the foreground, so synthetic input would have gone to " +
					"another window. Nothing was sent."
				: $"{outcome.Detail} Input was not sent, because it would have gone to another " +
					"window.");
	}

	private static void RequireInputRate(PanelState panel)
	{
		var now = DateTimeOffset.UtcNow;
		if (now - panel.InputWindowStart >= TimeSpan.FromSeconds(1))
		{
			panel.InputWindowStart = now;
			panel.InputCount = 0;
		}
		if (++panel.InputCount > WindowsInputLimits.MaximumOperationsPerSecond)
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InputRateLimited,
				$"This canvas exceeded {WindowsInputLimits.MaximumOperationsPerSecond} input " +
				"operations per second. A loop that fast is driving the user's real keyboard and " +
				"mouse, so it is stopped rather than slowed.",
				429);
		}
	}

	private static WindowsInputPoint RequirePoint(
		double x,
		double y,
		int captureWidth,
		int captureHeight,
		WindowsCaptureGeometry geometry)
	{
		if (captureWidth < 0 || captureHeight < 0)
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				"captureWidth and captureHeight cannot be negative.");
		}

		var point = WindowsInputMapper.ToContent(x, y, captureWidth, captureHeight, geometry);
		if (!WindowsInputMapper.IsInsideContent(point, geometry))
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InputOutOfBounds,
				$"({x}, {y}) is outside the window's {geometry.ContentWidth} by " +
				$"{geometry.ContentHeight} pixel capture area. Coordinates are " +
				"window-relative physical capture pixels, not desktop coordinates.");
		}
		return point;
	}

	/// <summary>
	/// Refuses to click a point that another window is covering. The foreground check proves the
	/// target owns the keyboard; this proves the pixel under the pointer belongs to it too, so a
	/// dialog or a tooltip that appeared since the screenshot cannot silently take the click.
	/// </summary>
	private void RequireUncovered(InputTarget target, int screenX, int screenY)
	{
		var owner = _input.WindowAtPoint(screenX, screenY);
		if (owner == 0 || owner == target.Window.Handle)
			return;

		throw WindowsCanvasException.Conflict(
			WindowsErrorCodes.InputForegroundRefused,
			"Another window now covers that point, so the input would have gone to it. Capture " +
			"the window again and retry.");
	}

	private static int RequireNotches(double delta, string field)
	{
		if (!double.IsFinite(delta))
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				$"{field} must be a finite number of wheel notches.");
		}
		var notches = (int)Math.Round(delta, MidpointRounding.AwayFromZero);
		if (Math.Abs(notches) > WindowsInputLimits.MaximumWheelNotches)
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				$"{field} is limited to {WindowsInputLimits.MaximumWheelNotches} wheel notches per " +
				"request.");
		}
		return notches;
	}

	private static WindowsKeyStroke[] ResolveModifiers(string[]? modifiers)
	{
		if (modifiers is null || modifiers.Length == 0)
			return [];
		if (modifiers.Length > WindowsInputLimits.MaximumModifiers)
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				$"At most {WindowsInputLimits.MaximumModifiers} modifiers may be held at once.");
		}
		foreach (var modifier in modifiers)
		{
			if (!WindowsVirtualKeys.IsModifier(modifier))
			{
				throw new WindowsCanvasException(
					WindowsErrorCodes.InvalidRequest,
					$"'{modifier}' is not a modifier. Use ctrl, alt, shift, or win.");
			}
		}
		return [.. modifiers.Select(WindowsVirtualKeys.Resolve)];
	}

	private static WindowsKeyStroke[] ResolveKeys(string[]? keys)
	{
		if (keys is null || keys.Length == 0)
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				"A key request needs at least one key name.");
		}
		if (keys.Length > WindowsInputLimits.MaximumKeys)
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				$"At most {WindowsInputLimits.MaximumKeys} keys may be sent in one request.");
		}
		return [.. keys.Select(WindowsVirtualKeys.Resolve)];
	}

	private void PressButton(PanelState panel, string button, int screenX, int screenY)
	{
		Require(_input.PointerButton(button, down: true, screenX, screenY));
		panel.LastPointer = (screenX, screenY);
		panel.HeldButtons.Add(button);
	}

	private void ReleaseButton(PanelState panel, string button, int screenX, int screenY)
	{
		Require(_input.PointerButton(button, down: false, screenX, screenY));
		panel.LastPointer = (screenX, screenY);
		panel.HeldButtons.Remove(button);
	}

	private void HoldModifiers(PanelState panel, WindowsKeyStroke[] modifiers)
	{
		foreach (var modifier in modifiers)
		{
			Require(_input.Key(modifier, down: true));
			panel.HeldKeys.Add(modifier);
		}
	}

	private void ReleaseModifiers(PanelState panel, WindowsKeyStroke[] modifiers)
	{
		for (var index = modifiers.Length - 1; index >= 0; index--)
		{
			// Release is best effort by design: a failure here must not mask the failure that is
			// already unwinding, and the panel-wide cleanup will try again.
			_input.Key(modifiers[index], down: false);
			panel.HeldKeys.Remove(modifiers[index]);
		}
	}

	private void PressChord(PanelState panel, WindowsKeyStroke[] strokes)
	{
		var pressed = 0;
		try
		{
			foreach (var stroke in strokes)
			{
				Require(_input.Key(stroke, down: true));
				panel.HeldKeys.Add(stroke);
				pressed++;
			}
		}
		finally
		{
			for (var index = pressed - 1; index >= 0; index--)
			{
				_input.Key(strokes[index], down: false);
				panel.HeldKeys.Remove(strokes[index]);
			}
		}
	}

	/// <summary>
	/// Releases everything this panel is still holding. Called whenever an operation fails and
	/// whenever a panel gives up its session, because a stuck mouse button or a stuck Ctrl on the
	/// user's own desktop is the worst thing this feature could leave behind.
	/// </summary>
	private void ReleaseHeldInput(PanelState panel)
	{
		foreach (var stroke in panel.HeldKeys.ToArray())
			_input.Key(stroke, down: false);
		panel.HeldKeys.Clear();

		foreach (var button in panel.HeldButtons.ToArray())
		{
			var (x, y) = panel.LastPointer;
			_input.PointerButton(button, down: false, x, y);
		}
		panel.HeldButtons.Clear();
	}

	private static void Require(WindowsInputOutcome outcome)
	{
		if (!outcome.Success)
		{
			throw WindowsCanvasException.Conflict(
				WindowsErrorCodes.InputFailed,
				outcome.Detail ?? "Windows refused the synthetic input.");
		}
	}

	private static WindowsInputResult Describe(
		InputTarget target,
		string operation,
		WindowsInputPoint? point,
		int screenX,
		int screenY,
		bool foreground = true) =>
		new()
		{
			Success = true,
			Operation = operation,
			SessionId = target.SessionId,
			WindowId = target.Record.Id,
			TransformVersion = target.Geometry.TransformVersion,
			Point = point,
			ScreenPoint = point is null
				? null
				: new WindowsInputPoint { X = screenX, Y = screenY },
			Foreground = foreground,
			Geometry = target.Geometry,
		};

	/// <summary>One resolved, revalidated input target, valid only inside the panel gate.</summary>
	private readonly record struct InputTarget(
		string SessionId,
		WindowsAuthorizedRecord Record,
		WindowsHelperWindow Window,
		WindowsCaptureGeometry Geometry);

	private sealed record BackgroundUiTarget(
		WindowsUiElement Element,
		int[] Path,
		string Action,
		int Depth);

	private async Task<WindowsOperationResult> ActAsync(
		CanvasContextKey key,
		WindowsWindowActionRequest? request,
		string operation,
		Func<long, WindowsWindowActionOutcome> action,
		CancellationToken cancellationToken)
	{		var panel = Panel(key);
		await panel.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			var session = RequireSession(panel);
			var live = await RefreshAsync(panel, cancellationToken).ConfigureAwait(false);
			var record = RequireWindow(session, request?.WindowId ?? session.SelectedWindowId);
			Resolve(live, record.Key);
			var outcome = action(record.Key.Handle);
			return new WindowsOperationResult
			{
				Success = outcome.Success,
				Operation = operation,
				SessionId = session.Id,
				WindowId = record.Id,
				Detail = outcome.Detail,
			};
		}
		finally
		{
			panel.Gate.Release();
		}
	}

	private async Task<WindowsAppSession> CorrelateLaunchAsync(
		PanelState panel,
		WindowsSessionState session,
		double timeoutSeconds,
		CancellationToken cancellationToken)
	{
		var timeout = TimeSpan.FromSeconds(
			Math.Clamp(double.IsFinite(timeoutSeconds) ? timeoutSeconds : 0, 0, MaximumCorrelationTimeoutSeconds));
		var deadline = DateTimeOffset.UtcNow + timeout;
		WindowsHelperWindowList live;
		while (true)
		{
			live = await ListLiveAsync(cancellationToken).ConfigureAwait(false);
			Reconcile(session, live);
			if (session.Windows.Count > 0 || DateTimeOffset.UtcNow >= deadline)
				break;
			await Task.Delay(CorrelationPollInterval, cancellationToken).ConfigureAwait(false);
		}

		if (session.Windows.Count == 0)
		{
			session.PendingCode = WindowsErrorCodes.LaunchNotCorrelated;
			session.PendingDetail =
				"The app was launched, but no window could be positively attributed to it within " +
				$"{timeout.TotalSeconds:0} seconds. Attach the window explicitly once it appears; " +
				"nothing is controlled until then.";
		}
		else
		{
			session.PendingCode = null;
			session.PendingDetail = null;
		}

		panel.LastTouchedAt = DateTimeOffset.UtcNow;
		return Project(session, live);
	}

	private async Task<WindowsHelperWindowList> RefreshAsync(
		PanelState panel,
		CancellationToken cancellationToken)
	{
		var live = await ListLiveAsync(cancellationToken).ConfigureAwait(false);
		if (panel.Session is { } session)
			Reconcile(session, live);
		return live;
	}

	private async Task<WindowsHelperWindowList> ListLiveAsync(CancellationToken cancellationToken)
	{
		var live = await bridge.ListWindowsAsync(cancellationToken).ConfigureAwait(false);
		if (live.Session is null)
		{
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.HelperFailed,
				"windows-app-helper.exe did not report which Windows session it enumerated.");
		}
		if (!live.Session.Interactive)
		{
			throw WindowsCanvasException.Conflict(
				WindowsErrorCodes.SessionNotInteractive,
				"The host is not running in an interactive Windows session.");
		}
		return live;
	}

	/// <summary>
	/// Re-proves every authorized window and adopts any newly correlated one. Runs before every
	/// answer and before every action, because a window's identity is only ever true at the moment
	/// it is read.
	/// </summary>
	private static void Reconcile(WindowsSessionState session, WindowsHelperWindowList live)
	{
		var host = live.Session!;
		var liveByHandle = live.Windows.ToDictionary(window => window.Handle);

		session.Windows.RemoveAll(record =>
			!liveByHandle.TryGetValue(record.Key.Handle, out var window)
			|| !WindowsWindowKey.IsProvable(window)
			|| WindowsWindowKey.Of(window) != record.Key
			|| window.SessionId != host.Id
			|| ExceedsHostIntegrity(window, host));

		bool added;
		do
		{
			added = false;
			var authorized = session.Windows.ToDictionary(record => record.Key.Handle);
			foreach (var window in live.Windows)
			{
				if (authorized.ContainsKey(window.Handle) ||
					!WindowsWindowCorrelator.IsCandidate(window) ||
					window.SessionId != host.Id ||
					ExceedsHostIntegrity(window, host))
				{
					continue;
				}

				var reason = WindowsWindowCorrelator.Reason(session, window, liveByHandle, authorized);
				if (reason is null)
					continue;

				session.Windows.Add(new WindowsAuthorizedRecord(
					NewId("win"),
					WindowsWindowKey.Of(window),
					reason));
				session.RememberProcess(new WindowsProcessRecord(
					window.ProcessId,
					window.ProcessStartFileTime,
					window.ProcessPath,
					WindowsWindowCorrelator.IsSharedHostProcess(window.ProcessPath),
					Observed: false));
				added = true;
			}
		}
		while (added);

		if (session.Windows.Count == 0)
			session.SelectedWindowId = null;
		else if (!session.Windows.Exists(record => record.Id == session.SelectedWindowId))
			session.SelectedWindowId = session.Windows[0].Id;
	}

	/// <summary>
	/// Turns a recorded identity back into a live window, or refuses. This is the only place an
	/// identifier becomes an HWND, and it fails closed on a destroyed window, a reused handle, a
	/// recycled process ID, another logon session, and a target above the host's integrity.
	/// </summary>
	private static WindowsHelperWindow Resolve(WindowsHelperWindowList live, WindowsWindowKey key)
	{
		var window = Array.Find(live.Windows, candidate => candidate.Handle == key.Handle)
			?? throw WindowsCanvasException.NotFound(
				WindowsErrorCodes.WindowNotFound,
				"That window no longer exists.");

		if (!WindowsWindowKey.IsProvable(window))
		{
			throw WindowsCanvasException.Forbidden(
				WindowsErrorCodes.WindowNotAuthorized,
				"Windows would no longer tell this host which process owns that window or at what " +
				"integrity it runs, so the grant was dropped rather than assumed.");
		}
		if (window.ProcessId != key.ProcessId)
		{
			throw WindowsCanvasException.Conflict(
				WindowsErrorCodes.WindowIdentityChanged,
				"That window handle now belongs to a different process. Windows reuses handles, " +
				"so the grant was dropped rather than followed.");
		}
		if (window.ProcessStartFileTime != key.ProcessStartFileTime)
		{
			throw WindowsCanvasException.Conflict(
				WindowsErrorCodes.WindowIdentityChanged,
				"The process behind that window was replaced by a different process with the same " +
				"process ID. The grant was dropped rather than followed.");
		}
		if (WindowsWindowKey.Of(window) != key)
		{
			throw WindowsCanvasException.Conflict(
				WindowsErrorCodes.WindowIdentityChanged,
				"That window now declares a different packaged app identity, so it is no longer " +
				"the window this canvas was granted.");
		}
		if (window.SessionId != live.Session!.Id)
		{
			throw WindowsCanvasException.Forbidden(
				WindowsErrorCodes.TargetSessionMismatch,
				"That window belongs to a different Windows logon session.");
		}
		if (ExceedsHostIntegrity(window, live.Session))
		{
			throw WindowsCanvasException.Forbidden(
				WindowsErrorCodes.TargetElevated,
				"That window runs at a higher integrity level than this host, so Windows will not " +
				"let it be driven. Elevation is never requested.");
		}
		return window;
	}

	private WindowsWindowCandidateList BuildCandidates(PanelState panel, WindowsHelperWindowList live)
	{
		var host = live.Session!;
		var authorizedByHandle = panel.Session is null
			? new Dictionary<long, WindowsAuthorizedRecord>()
			: panel.Session.Windows.ToDictionary(record => record.Key.Handle);

		// Identifiers are re-derived from the live desktop on every listing, but a window that is
		// still there keeps the identifier this panel was already handed: a client that lists and
		// then attaches must not lose to its own refresh.
		var previous = new Dictionary<WindowsWindowKey, string>(panel.CandidateIds);
		panel.Candidates.Clear();
		panel.CandidateIds.Clear();

		var candidates = new List<WindowsWindowCandidate>();
		foreach (var window in live.Windows)
		{
			if (!WindowsWindowCorrelator.IsCandidate(window))
				continue;

			var key = WindowsWindowKey.Of(window);
			authorizedByHandle.TryGetValue(window.Handle, out var authorized);
			var attached = authorized is not null
				&& authorized.Key.ProcessId == window.ProcessId
				&& authorized.Key.ProcessStartFileTime == window.ProcessStartFileTime;

			var id = attached ? authorized!.Id : MintCandidateId(panel, previous, key);
			var (attachable, code, detail) = Attachability(window, host, attached);
			candidates.Add(new WindowsWindowCandidate
			{
				Id = id,
				Title = window.Title,
				ProcessName = window.ProcessPath is null ? null : Path.GetFileName(window.ProcessPath),
				ProcessPath = window.ProcessPath,
				AppUserModelId = window.AppUserModelId,
				PackageFamilyName = window.PackageFamilyName,
				Bounds = ToBounds(window.Bounds),
				Minimized = window.Minimized,
				Cloaked = window.Cloaked,
				Attached = attached,
				SessionId = attached ? panel.Session!.Id : null,
				Attachable = attachable,
				UnattachableCode = code,
				UnattachableDetail = detail,
				IntegrityLevel = window.IntegrityLevel,
				Elevated = ExceedsHostIntegrity(window, host),
				Diagnostics = Diagnose(window),
			});
		}

		panel.LastTouchedAt = DateTimeOffset.UtcNow;
		return new WindowsWindowCandidateList
		{
			Windows = [.. candidates],
			Truncated = live.Truncated,
		};
	}

	private static (bool Attachable, string? Code, string? Detail) Attachability(
		WindowsHelperWindow window,
		WindowsHelperSession host,
		bool attached)
	{
		if (attached)
			return (false, null, "This window is already part of the attached app session.");
		if (window.SessionId != host.Id)
		{
			return (false, WindowsErrorCodes.TargetSessionMismatch,
				"This window belongs to a different Windows logon session.");
		}
		if (ExceedsHostIntegrity(window, host))
		{
			return (false, WindowsErrorCodes.TargetElevated,
				"This window runs elevated. Automation would have to elevate too, which this " +
				"product never does.");
		}
		if (window.IdentityAccess.Equals(WindowsIdentityAccess.Denied, StringComparison.Ordinal))
		{
			return (false, WindowsErrorCodes.WindowNotAuthorized,
				"Windows would not let the helper identify the process behind this window, so it " +
				"cannot be attached safely.");
		}
		if (!WindowsWindowKey.IsProvable(window))
		{
			return (false, WindowsErrorCodes.WindowNotAuthorized,
				"Windows would not tell this host when the owning process started or at what " +
				"integrity it runs, so this window has no identity that could be re-proved later.");
		}
		return (true, null, null);
	}

	private static string MintCandidateId(
		PanelState panel,
		Dictionary<WindowsWindowKey, string> previous,
		WindowsWindowKey key)
	{
		if (panel.CandidateIds.TryGetValue(key, out var existing))
			return existing;
		var id = previous.TryGetValue(key, out var reused) ? reused : NewId("cand");
		panel.CandidateIds[key] = id;
		panel.Candidates[id] = key;
		return id;
	}

	private static WindowsAppSession Project(
		WindowsSessionState session,
		WindowsHelperWindowList live)
	{
		var liveByHandle = live.Windows.ToDictionary(window => window.Handle);
		return new WindowsAppSession
		{
			Id = session.Id,
			DisplayName = session.DisplayName,
			Origin = session.Origin,
			CatalogEntryId = session.CatalogEntryId,
			AppUserModelId = session.AppUserModelId,
			PackageFamilyName = session.PackageFamilyName,
			ExecutablePath = session.ExecutablePath,
			CreatedAt = session.CreatedAt,
			Processes =
			[
				.. session.Processes.Select(process => new WindowsProcessIdentity
				{
					ProcessId = process.ProcessId,
					StartedAt = process.StartFileTime == 0
						? null
						: DateTimeOffset.FromFileTime(process.StartFileTime),
					ProcessPath = process.ProcessPath,
					Observed = process.Observed,
				}),
			],
			Windows =
			[
				.. session.Windows
					.Where(record => liveByHandle.ContainsKey(record.Key.Handle))
					.Select(record => ToAuthorized(
						record,
						liveByHandle[record.Key.Handle],
						record.Id == session.SelectedWindowId,
						live.Session!)),
			],
			SelectedWindowId = session.SelectedWindowId,
			PendingCode = session.PendingCode,
			PendingDetail = session.PendingDetail,
		};
	}

	private static WindowsAuthorizedWindow ToAuthorized(
		WindowsAuthorizedRecord record,
		WindowsHelperWindow window,
		bool selected,
		WindowsHelperSession host) => new()
		{
			Id = record.Id,
			Title = window.Title,
			Bounds = ToBounds(window.Bounds),
			Minimized = window.Minimized,
			Cloaked = window.Cloaked,
			Selected = selected,
			Correlation = record.Correlation,
			IntegrityLevel = window.IntegrityLevel,
			Elevated = ExceedsHostIntegrity(window, host),
			Diagnostics = Diagnose(window),
		};

	private static WindowsWindowDiagnostics Diagnose(WindowsHelperWindow window) => new()
	{
		NativeHandle = window.Handle,
		ProcessId = window.ProcessId,
		ProcessStartedAt = window.ProcessStartFileTime == 0
			? null
			: DateTimeOffset.FromFileTime(window.ProcessStartFileTime),
		WindowsSessionId = window.SessionId,
		ClassName = window.ClassName,
		IdentityAccess = window.IdentityAccess,
	};

	private static WindowsWindowBounds? ToBounds(WindowsHelperBounds? bounds) =>
		bounds is null
			? null
			: new WindowsWindowBounds
			{
				Left = bounds.Left,
				Top = bounds.Top,
				Width = bounds.Width,
				Height = bounds.Height,
			};

	private static bool ExceedsHostIntegrity(WindowsHelperWindow window, WindowsHelperSession host) =>
		window.IntegrityValue != 0 && host.IntegrityValue != 0
			? window.IntegrityValue > host.IntegrityValue
			: window.Elevated;

	/// <summary>
	/// Says so when the helper beside the host is not the one this host shipped with. A packaging
	/// mistake that leaves an old helper in place would otherwise only show up as a feature that
	/// mysteriously does not work. Development builds report an unparseable version and are left
	/// alone, because they are expected to be out of step.
	/// </summary>
	private static string? DescribeStaleHelper(WindowsHelperCapabilities capabilities)
	{
		var host = typeof(WindowsAppService).Assembly.GetName().Version;
		if (host is null || !Version.TryParse(capabilities.HelperVersion, out var helper))
			return null;
		var hostVersion = new Version(host.Major, host.Minor, Math.Max(host.Build, 0));
		var helperVersion = new Version(helper.Major, helper.Minor, Math.Max(helper.Build, 0));
		return helperVersion == hostVersion
			? null
			: $"windows-app-helper.exe reports version {helperVersion} beside a {hostVersion} " +
				"host. Reinstall the Mobile Canvas runtime so both come from one release.";
	}

	private static WindowsFeatureState Feature(string name, WindowsHelperFeature? feature) => new()	{
		Name = name,
		Available = feature?.Available ?? false,
		Detail = feature is { Available: false }
			? $"Unavailable on this machine ({feature.Hresult})."
			: null,
	};

	private static WindowsSessionState RequireSession(PanelState panel) =>
		panel.Session
		?? throw WindowsCanvasException.NotFound(
			WindowsErrorCodes.SessionNotFound,
			"This canvas has no Windows app session. Launch or attach an app first.");

	/// <summary>
	/// Turns a candidate identifier back into the window identity this panel was offered.
	///
	/// Both dictionaries are panel-scoped, so an identifier minted for another canvas means nothing
	/// here. The session's authorized windows are accepted too because a window this panel already
	/// attached is still listed as a candidate under its authorized ID, and a picker that can draw
	/// every other card should not go blank on the one it is already driving.
	/// </summary>
	private static WindowsWindowKey RequireCandidate(PanelState panel, string candidateId)
	{
		if (!string.IsNullOrEmpty(candidateId))
		{
			if (panel.Candidates.TryGetValue(candidateId, out var offered))
				return offered;

			var authorized = panel.Session?.Windows.Find(
				record => record.Id.Equals(candidateId, StringComparison.Ordinal));
			if (authorized is not null)
				return authorized.Key;
		}

		throw WindowsCanvasException.NotFound(
			WindowsErrorCodes.CandidateNotFound,
			"That window is not one this canvas was offered. List windows again and use one of " +
			"the identifiers it returns.");
	}

	private static WindowsAuthorizedRecord RequireWindow(WindowsSessionState session, string? windowId)
	{
		if (string.IsNullOrWhiteSpace(windowId))
		{
			throw WindowsCanvasException.NotFound(
				WindowsErrorCodes.WindowNotFound,
				"This app session has no window selected.");
		}
		return session.Windows.Find(record => record.Id.Equals(windowId, StringComparison.Ordinal))
			?? throw WindowsCanvasException.Forbidden(
				WindowsErrorCodes.WindowNotAuthorized,
				"That window is not one this app session is authorized to drive.");
	}

	private PanelState Panel(CanvasContextKey key)
	{
		RequireWindowsSurface(key);
		PruneExpiredPanels(DateTimeOffset.UtcNow);
		var panel = _panels.GetOrAdd(key, _ => new PanelState());
		panel.LastTouchedAt = DateTimeOffset.UtcNow;
		return panel;
	}

	private static void RequireWindowsSurface(CanvasContextKey key)
	{
		ArgumentNullException.ThrowIfNull(key);
		if (!key.Surface.Equals(CanvasSurfaces.Windows, StringComparison.Ordinal))
		{
			throw WindowsCanvasException.Forbidden(
				WindowsErrorCodes.SurfaceRequired,
				$"Windows App Canvas endpoints require a '{CanvasSurfaces.Windows}' canvas " +
				$"session; this one is scoped to '{key.Surface}'.");
		}
	}

	internal void PruneExpiredPanels(DateTimeOffset now)
	{
		var cutoff = now - PanelLifetime;
		foreach (var (key, panel) in _panels)
		{
			if (panel.LastTouchedAt >= cutoff || !panel.Gate.Wait(0))
				continue;

			try
			{
				if (panel.LastTouchedAt >= cutoff)
					continue;

				// Conditional removal prevents an old panel from deleting a replacement that was
				// attached under the same canvas key while this pruning pass was running.
				var entry = new KeyValuePair<CanvasContextKey, PanelState>(key, panel);
				if (((ICollection<KeyValuePair<CanvasContextKey, PanelState>>)_panels).Remove(entry))
					ReleaseHeldInput(panel);
			}
			finally
			{
				panel.Gate.Release();
			}
		}
	}

	private static string DescribeWindow(WindowsHelperWindow window)
	{
		if (!string.IsNullOrWhiteSpace(window.Title))
			return window.Title.Trim();
		if (!string.IsNullOrWhiteSpace(window.ProcessPath))
			return Path.GetFileNameWithoutExtension(window.ProcessPath);
		return window.AppUserModelId ?? "Windows app";
	}

	private static string? Normalize(string? value) =>
		string.IsNullOrWhiteSpace(value) ? null : value.Trim();

	private static string NewId(string prefix) =>
		$"{prefix}_{Convert.ToHexString(RandomNumberGenerator.GetBytes(12)).ToLowerInvariant()}";

	private sealed class PanelState
	{
		public SemaphoreSlim Gate { get; } = new(1, 1);

		/// <summary>
		/// How many candidate thumbnails this panel may capture at once. A picker asks for every
		/// open window the moment it opens, and each capture is a helper process negotiating a
		/// Direct3D adapter, so the grid is bounded here rather than by whatever the browser
		/// happened to request in parallel.
		/// </summary>
		public SemaphoreSlim ThumbnailGate { get; } = new(
			WindowsThumbnailLimits.MaximumConcurrentCaptures,
			WindowsThumbnailLimits.MaximumConcurrentCaptures);

		public Dictionary<string, WindowsWindowKey> Candidates { get; } = new(StringComparer.Ordinal);
		public Dictionary<WindowsWindowKey, string> CandidateIds { get; } = new();
		public WindowsSessionState? Session { get; set; }
		public DateTimeOffset LastTouchedAt { get; set; } = DateTimeOffset.UtcNow;

		/// <summary>
		/// Recently captured candidate thumbnails, so re-rendering a picker grid does not
		/// re-capture every window on the desktop. Each entry carries the transform signature it
		/// was captured under, and a signature covers identity and geometry together: a window that
		/// moved, resized, changed DPI, closed, or had its handle recycled can never be answered
		/// from here.
		///
		/// Guarded by its own lock rather than by the panel gate, because thumbnails are captured
		/// with the gate released so a grid of cards does not serialize behind one another.
		/// </summary>
		private Dictionary<string, ThumbnailEntry> Thumbnails { get; } = new(StringComparer.Ordinal);

		private readonly Lock _thumbnails = new();
		private WindowsHelperWindowList? _thumbnailWindows;
		private DateTimeOffset _thumbnailWindowsAt;

		public bool TryReadThumbnail(
			string candidateId,
			int maximumDimension,
			string? signature,
			out WindowsScreenshot thumbnail)
		{
			thumbnail = null!;
			if (signature is null)
				return false;

			var now = DateTimeOffset.UtcNow;
			lock (_thumbnails)
			{
				if (!Thumbnails.TryGetValue(
						ThumbnailKey(candidateId, maximumDimension),
						out var entry) ||
					entry.ExpiresAt <= now ||
					!entry.Signature.Equals(signature, StringComparison.Ordinal))
				{
					return false;
				}

				thumbnail = entry.Thumbnail;
				return true;
			}
		}

		/// <summary>
		/// Reuses one desktop enumeration only across the tight burst produced by opening the picker.
		/// Capture still verifies the helper's echoed process identity, and a later refresh performs a
		/// new enumeration, so this cannot turn an old HWND into authority over a replacement.
		/// Called while the panel gate is held.
		/// </summary>
		public bool TryReadThumbnailWindows(
			DateTimeOffset now,
			TimeSpan lifetime,
			out WindowsHelperWindowList windows)
		{
			if (_thumbnailWindows is not null && now - _thumbnailWindowsAt <= lifetime)
			{
				windows = _thumbnailWindows;
				return true;
			}
			windows = null!;
			return false;
		}

		/// <summary>Called while the panel gate is held.</summary>
		public void StoreThumbnailWindows(WindowsHelperWindowList windows, DateTimeOffset capturedAt)
		{
			_thumbnailWindows = windows;
			_thumbnailWindowsAt = capturedAt;
		}

		public void StoreThumbnail(
			string candidateId,
			int maximumDimension,
			string signature,
			WindowsScreenshot thumbnail)
		{
			var now = DateTimeOffset.UtcNow;
			lock (_thumbnails)
			{
				foreach (var (key, entry) in Thumbnails.ToArray())
				{
					if (entry.ExpiresAt <= now)
						Thumbnails.Remove(key);
				}

				// A panel that walked a very long window list must not accumulate pictures forever.
				// Everything here is at most a few seconds old, so dropping the lot is honest: the
				// next request captures again rather than being served something stale.
				if (Thumbnails.Count >= WindowsThumbnailLimits.MaximumCacheEntries)
					Thumbnails.Clear();

				Thumbnails[ThumbnailKey(candidateId, maximumDimension)] = new ThumbnailEntry(
					signature,
					now.AddSeconds(WindowsThumbnailLimits.CacheSeconds),
					thumbnail);
			}
		}

		private static string ThumbnailKey(string candidateId, int maximumDimension) =>
			$"{candidateId}|{maximumDimension}";

		private sealed record ThumbnailEntry(
			string Signature,
			DateTimeOffset ExpiresAt,
			WindowsScreenshot Thumbnail);

		/// <summary>
		/// Pointer buttons and keys this panel currently holds down on the real desktop. They are
		/// tracked so a caller that pressed and never released — or that failed halfway through a
		/// drag — cannot leave the user's mouse or keyboard stuck.
		/// </summary>
		public HashSet<string> HeldButtons { get; } = new(StringComparer.Ordinal);
		public List<WindowsKeyStroke> HeldKeys { get; } = [];

		/// <summary>Where the pointer was last placed, so a stuck button is released in place.</summary>
		public (int X, int Y) LastPointer { get; set; }

		public DateTimeOffset InputWindowStart { get; set; } = DateTimeOffset.UtcNow;
		public int InputCount { get; set; }
	}
}

public static class WindowsSessionOrigins
{
	public const string Catalog = "catalog";
	public const string Executable = "executable";
	public const string Attach = "attach";
}
