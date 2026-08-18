using WindowsCanvas.Contracts;
using WindowsCanvas.Windows;

namespace WindowsCanvas.Tests;

/// <summary>
/// A native bridge that answers from fixtures. Everything the Windows domain decides — which
/// windows belong to a session, whether a grant survived, whether a target is reachable — is
/// decided from what the helper reported, so replacing the helper with fixtures exercises the
/// real rules on any operating system.
/// </summary>
internal sealed class FakeWindowsNativeBridge : IWindowsNativeBridge
{
	public WindowsHelperLocation Location { get; set; } = new()
	{
		PlatformSupported = true,
		Present = true,
		Path = "/mobile-canvas/windows-app-helper.exe",
	};

	public WindowsHelperCapabilities Capabilities { get; set; } = Fixtures.Capabilities();

	public WindowsHelperCatalog Catalog { get; set; } = new()
	{
		SchemaVersion = 1,
		Ok = true,
		HelperVersion = "1.2.3",
	};

	public WindowsHelperWindowList Windows { get; set; } = Fixtures.WindowList();

	public Func<string, WindowsHelperLaunch>? OnLaunch { get; set; }
	public Func<WindowsNativeWindowTarget, WindowsUiSnapshotRequest, WindowsUiSnapshot>? OnSnapshot { get; set; }
	public Func<WindowsNativeWindowTarget, WindowsUiQuery, WindowsUiFindResult>? OnFind { get; set; }
	public Func<WindowsNativeWindowTarget, WindowsUiActionRequest, WindowsUiActionResult>? OnAction { get; set; }
	public Func<WindowsNativeWindowTarget, WindowsUiWaitRequest, WindowsUiWaitResult>? OnWait { get; set; }

	public Exception? CapabilitiesFailure { get; set; }

	public List<string> Launched { get; } = [];
	public List<long> UiTargets { get; } = [];
	public List<WindowsUiActionRequest> UiActions { get; } = [];

	public int WindowListCalls { get; private set; }

	public WindowsHelperLocation Locate() => Location;

	public Task<WindowsHelperCapabilities> GetCapabilitiesAsync(
		CancellationToken cancellationToken = default) =>
		CapabilitiesFailure is null
			? Task.FromResult(Capabilities)
			: Task.FromException<WindowsHelperCapabilities>(CapabilitiesFailure);

	public Task<WindowsHelperCatalog> GetCatalogAsync(CancellationToken cancellationToken = default) =>
		Task.FromResult(Catalog);

	public Task<WindowsHelperWindowList> ListWindowsAsync(
		CancellationToken cancellationToken = default)
	{
		WindowListCalls++;
		return Task.FromResult(Windows);
	}

	public Task<WindowsHelperLaunch> LaunchCatalogEntryAsync(
		string entryId,
		CancellationToken cancellationToken = default)
	{
		Launched.Add(entryId);
		return Task.FromResult(
			OnLaunch?.Invoke(entryId)
			?? new WindowsHelperLaunch { SchemaVersion = 1, Ok = true, HelperVersion = "1.2.3" });
	}

	public Task<WindowsUiSnapshot> GetUiSnapshotAsync(
		WindowsNativeWindowTarget target,
		WindowsUiSnapshotRequest request,
		CancellationToken cancellationToken = default)
	{
		UiTargets.Add(target.Handle);
		return Task.FromResult(
			OnSnapshot?.Invoke(target, request)
			?? new WindowsUiSnapshot
			{
				Root = new WindowsUiElement
				{
					ControlType = WindowsUiControlTypes.Window,
					Role = WindowsUiRoles.Window,
					Properties = new WindowsUiProperties { Name = target.Window.Title },
				},
				Metadata = new WindowsUiOperationMetadata
				{
					NodeCount = 1,
					MaximumDepth = request.MaximumDepth,
					MaximumNodes = request.MaximumNodes,
				},
			});
	}

	public Task<WindowsUiFindResult> FindUiAsync(
		WindowsNativeWindowTarget target,
		WindowsUiQuery query,
		CancellationToken cancellationToken = default)
	{
		UiTargets.Add(target.Handle);
		return Task.FromResult(OnFind?.Invoke(target, query) ?? new WindowsUiFindResult());
	}

	public Task<WindowsUiActionResult> ActUiAsync(
		WindowsNativeWindowTarget target,
		WindowsUiActionRequest request,
		CancellationToken cancellationToken = default)
	{
		UiTargets.Add(target.Handle);
		UiActions.Add(request);
		return Task.FromResult(
			OnAction?.Invoke(target, request)
			?? new WindowsUiActionResult
			{
				Success = true,
				Action = request.Action,
				Metadata = new WindowsUiOperationMetadata
				{
					MaximumDepth = request.MaximumDepth,
					MaximumNodes = request.MaximumNodes,
				},
			});
	}

	public Task<WindowsUiWaitResult> WaitUiAsync(
		WindowsNativeWindowTarget target,
		WindowsUiWaitRequest request,
		CancellationToken cancellationToken = default)
	{
		UiTargets.Add(target.Handle);
		return Task.FromResult(
			OnWait?.Invoke(target, request)
			?? new WindowsUiWaitResult
			{
				Satisfied = true,
				Condition = request.Condition,
				Metadata = new WindowsUiOperationMetadata
				{
					MaximumDepth = request.MaximumDepth,
					MaximumNodes = request.MaximumNodes,
				},
			});
	}

	public Func<WindowsNativeWindowTarget, WindowsScreenshotRequest, WindowsScreenshot>? OnScreenshot
	{
		get;
		set;
	}

	public Func<WindowsNativeWindowTarget, WindowsStreamRequest, IWindowsVideoSession>? OnVideo
	{
		get;
		set;
	}

	public List<WindowsScreenshotRequest> Screenshots { get; } = [];
	public List<WindowsStreamRequest> Streams { get; } = [];

	private readonly Lock _captureLock = new();

	public Task<WindowsScreenshot> CaptureScreenshotAsync(
		WindowsNativeWindowTarget target,
		WindowsScreenshotRequest request,
		CancellationToken cancellationToken = default)
	{
		// Thumbnail capture is deliberately concurrent, so the fixture's own bookkeeping has to
		// survive being called from several threads at once.
		lock (_captureLock)
		{
			Screenshots.Add(request);
			UiTargets.Add(target.Handle);
		}
		return Task.FromResult(
			OnScreenshot?.Invoke(target, request)
			?? new WindowsScreenshot
			{
				Png = Fixtures.PngBytes,
				Descriptor = new WindowsScreenshotDescriptor
				{
					Geometry = Fixtures.Geometry(),
					ByteCount = Fixtures.PngBytes.Length,
					CapturedAt = DateTimeOffset.UtcNow,
				},
			});
	}

	public Task<IWindowsVideoSession> OpenVideoAsync(
		WindowsNativeWindowTarget target,
		WindowsStreamRequest request,
		CancellationToken cancellationToken = default)
	{
		Streams.Add(request);
		UiTargets.Add(target.Handle);
		return Task.FromResult(
			OnVideo?.Invoke(target, request)
			?? (IWindowsVideoSession)new FakeWindowsVideoSession(
				new WindowsStreamDescriptor
				{
					FramesPerSecond = request.FramesPerSecond,
					Scale = request.Scale,
					AverageBitrate = request.AverageBitrate,
					Geometry = Fixtures.Geometry(),
				}));
	}
}

/// <summary>
/// A video session that yields fixed Annex-B-shaped bytes and then ends for a stated reason. The
/// reason is the part worth testing: a browser decides whether to reconnect from it.
/// </summary>
internal sealed class FakeWindowsVideoSession(
	WindowsStreamDescriptor descriptor,
	byte[][]? chunks = null,
	WindowsStreamEnd? end = null) : IWindowsVideoSession
{
	public WindowsStreamDescriptor Descriptor { get; } = descriptor;

	public WindowsStreamEnd End { get; } = end ?? new WindowsStreamEnd
	{
		Reason = WindowsStreamEndReasons.ContentSizeChanged,
		Reconnect = true,
	};

	public bool Disposed { get; private set; }

	public async IAsyncEnumerable<ReadOnlyMemory<byte>> ReadAsync(
		[System.Runtime.CompilerServices.EnumeratorCancellation]
		CancellationToken cancellationToken = default)
	{
		foreach (var chunk in chunks ?? [[0, 0, 0, 1, 0x67], [0, 0, 0, 1, 0x65]])
		{
			cancellationToken.ThrowIfCancellationRequested();
			yield return chunk;
			await Task.Yield();
		}
	}

	public ValueTask DisposeAsync()
	{
		Disposed = true;
		return ValueTask.CompletedTask;
	}
}

/// <summary>
/// Live geometry from a fixture rather than from a desktop. Everything the coordinate path decides
/// is a function of these numbers, so a mixed-DPI, negative-origin, multi-monitor desktop is a
/// value here rather than a machine somebody has to own.
/// </summary>
internal sealed class FakeWindowGeometry : IWindowsWindowGeometry
{
	public Dictionary<long, WindowsCaptureGeometry?> Geometries { get; } = [];

	public WindowsCaptureGeometry? Default { get; set; } = Fixtures.Geometry();

	public int Reads { get; private set; }

	public WindowsCaptureGeometry? Read(long handle)
	{
		Reads++;
		return Geometries.TryGetValue(handle, out var geometry) ? geometry : Default;
	}
}

/// <summary>
/// Records the exact sequence of synthetic input primitives. Order is the point: a modifier that
/// is pressed and never released, or a button left down after a failure, is a real bug on somebody's
/// real keyboard, and the only way to catch it without a desktop is to watch the sequence.
/// </summary>
internal sealed class FakeInputController : IWindowsInputController
{
	public List<string> Operations { get; } = [];

	public WindowsWindowBounds Desktop { get; set; } = new()
	{
		Left = 0,
		Top = 0,
		Width = 1920,
		Height = 1080,
	};

	public WindowsWindowBounds VirtualDesktop => Desktop;

	public long Foreground { get; set; }

	/// <summary>Which window Windows reports at a point. Zero means "would not say".</summary>
	public long? Covering { get; set; }

	/// <summary>Returns a refusal for the first operation whose label it matches.</summary>
	public Func<string, WindowsInputOutcome?>? Refuse { get; set; }

	public bool IsForeground(long handle) => Foreground == handle;

	public long WindowAtPoint(int screenX, int screenY) => Covering ?? Foreground;

	public WindowsInputOutcome MovePointer(int screenX, int screenY) =>
		Record($"move:{screenX},{screenY}");

	public WindowsInputOutcome PointerButton(string button, bool down, int screenX, int screenY) =>
		Record($"{(down ? "down" : "up")}:{button}@{screenX},{screenY}");

	public WindowsInputOutcome Wheel(
		int screenX,
		int screenY,
		int verticalNotches,
		int horizontalNotches) =>
		Record($"wheel:{verticalNotches},{horizontalNotches}@{screenX},{screenY}");

	public WindowsInputOutcome Key(WindowsKeyStroke stroke, bool down) =>
		Record($"key:{stroke.VirtualKey}:{(down ? "down" : "up")}");

	public WindowsInputOutcome Unicode(char unit, bool down) =>
		Record($"unicode:{(int)unit}:{(down ? "down" : "up")}");

	private WindowsInputOutcome Record(string operation)
	{
		Operations.Add(operation);
		return Refuse?.Invoke(operation) ?? WindowsInputOutcome.Ok;
	}
}

internal sealed class FakeWindowController : IWindowsWindowController
{
	public List<(string Action, long Handle)> Calls { get; } = [];

	public WindowsWindowActionOutcome RevealOutcome { get; set; } = WindowsWindowActionOutcome.Ok;

	public WindowsWindowActionOutcome RestoreOutcome { get; set; } = WindowsWindowActionOutcome.Ok;

	public WindowsWindowActionOutcome Reveal(long handle)
	{
		Calls.Add(("reveal", handle));
		return RevealOutcome;
	}

	public WindowsWindowActionOutcome Restore(long handle)
	{
		Calls.Add(("restore", handle));
		return RestoreOutcome;
	}
}

internal sealed class FakeProcessLauncher : IWindowsProcessLauncher
{
	public List<(string Path, string[] Arguments, string? WorkingDirectory)> Calls { get; } = [];

	public int ProcessId { get; set; } = 4242;

	public DateTimeOffset? StartedAt { get; set; } = new DateTimeOffset(
		2026, 8, 17, 12, 0, 0, TimeSpan.Zero);

	public WindowsLaunchedProcess Launch(
		string executablePath,
		string[] arguments,
		string? workingDirectory)
	{
		Calls.Add((executablePath, arguments, workingDirectory));
		return new WindowsLaunchedProcess(ProcessId, StartedAt, executablePath);
	}
}

internal static class Fixtures
{
	public const uint InteractiveSession = 1;

	/// <summary>A one-pixel PNG. The bytes only have to be recognizably an image, not a picture.</summary>
	public static readonly byte[] PngBytes =
	[
		0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
		0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
	];

	/// <summary>
	/// A window on a second monitor to the left of the primary one, at 150% scaling. Negative
	/// desktop coordinates and a non-96 DPI are the normal case on a real desk, so they are the
	/// default here rather than a special case somebody has to remember to test.
	/// </summary>
	public static WindowsCaptureGeometry Geometry(
		int contentWidth = 800,
		int contentHeight = 600,
		int left = -1920,
		int top = -200,
		uint dpi = 144,
		bool minimized = false,
		double scale = 1) =>
		Win32WindowGeometry.Build(
			frame: new WindowsWindowBounds
			{
				Left = left - 8,
				Top = top,
				Width = contentWidth + 16,
				Height = contentHeight + 8,
			},
			content: new WindowsWindowBounds
			{
				Left = left,
				Top = top,
				Width = contentWidth,
				Height = contentHeight,
			},
			client: new WindowsWindowBounds
			{
				Left = left + 1,
				Top = top + 32,
				Width = contentWidth - 2,
				Height = contentHeight - 33,
			},
			dpi,
			minimized) with
		{
			CaptureWidth = (int)Math.Round(contentWidth * scale),
			CaptureHeight = (int)Math.Round(contentHeight * scale),
			Scale = scale,
		};

	public static readonly long MediumStart =
		new DateTime(2026, 8, 17, 12, 0, 0, DateTimeKind.Utc).ToFileTimeUtc();

	public static WindowsHelperCapabilities Capabilities(
		bool interactive = true,
		string signature = "unsigned") => new()
		{
			SchemaVersion = 1,
			Ok = true,
			HelperVersion = "1.2.3",
			Architecture = "x64",
			Os = new WindowsHelperOperatingSystem
			{
				Family = "Windows",
				Major = 10,
				Minor = 0,
				Build = 26100,
				NativeArchitecture = "x64",
			},
			Session = Session(interactive),
			Features = new WindowsHelperFeatures
			{
				ShellAppCatalog = new WindowsHelperFeature { Available = true, Hresult = "0x00000000" },
				UiAutomation = new WindowsHelperFeature { Available = true, Hresult = "0x00000000" },
				WindowsGraphicsCapture = new WindowsHelperCaptureFeature
				{
					Available = true,
					MinimumBuild = 18362,
					ReportedBuild = 26100,
					Hresult = "0x00000000",
				},
				MediaFoundationH264 = new WindowsHelperFeature { Available = true },
				SendInput = new WindowsHelperFeature { Available = true },
				AuthenticodeSignature = new WindowsHelperSignature
				{
					Valid = signature == "valid",
					Status = signature,
					Hresult = "0x800B0100",
				},
			},
		};

	public static WindowsHelperSession Session(bool interactive = true) => new()
	{
		Id = interactive ? InteractiveSession : 0,
		Interactive = interactive,
		IntegrityLevel = WindowsIntegrityLevels.Medium,
		IntegrityValue = 0x2000,
	};

	public static WindowsHelperWindowList WindowList(params WindowsHelperWindow[] windows) => new()
	{
		SchemaVersion = 1,
		Ok = true,
		HelperVersion = "1.2.3",
		Session = Session(),
		Windows = windows,
	};

	public static WindowsHelperWindow Window(
		long handle,
		int processId,
		string title,
		string? processPath = "C:\\apps\\fixture.exe",
		long? startFileTime = null,
		string? aumid = null,
		string? packageFamily = null,
		long ownerHandle = 0,
		uint sessionId = InteractiveSession,
		uint integrityValue = 0x2000,
		string integrityLevel = WindowsIntegrityLevels.Medium,
		bool elevated = false,
		bool visible = true,
		bool minimized = false,
		bool cloaked = false,
		bool toolWindow = false,
		string identityAccess = WindowsIdentityAccess.Full) => new()
		{
			Handle = handle,
			ProcessId = processId,
			ProcessStartFileTime = startFileTime ?? MediumStart,
			SessionId = sessionId,
			Title = title,
			ClassName = "FixtureWindow",
			Bounds = new WindowsHelperBounds { Left = 0, Top = 0, Width = 800, Height = 600 },
			Visible = visible,
			Minimized = minimized,
			Cloaked = cloaked,
			ToolWindow = toolWindow,
			OwnerHandle = ownerHandle,
			ProcessPath = processPath,
			AppUserModelId = aumid,
			PackageFamilyName = packageFamily,
			IntegrityLevel = integrityLevel,
			IntegrityValue = integrityValue,
			Elevated = elevated,
			IdentityAccess = identityAccess,
		};

	public static WindowsHelperCatalogEntry Entry(
		string id,
		string displayName,
		string source = WindowsCatalogSources.AppsFolder,
		string kind = WindowsCatalogKinds.Desktop,
		string launchMethod = WindowsLaunchMethods.ShellItem,
		string? aumid = null,
		string? packageFamily = null,
		string? executablePath = null,
		string? arguments = null,
		string? shortcutPath = null,
		string? registryKey = null,
		string? parsingName = null) => new()
		{
			Id = id,
			DisplayName = displayName,
			Source = source,
			Kind = kind,
			LaunchMethod = launchMethod,
			AppUserModelId = aumid,
			PackageFamilyName = packageFamily,
			ExecutablePath = executablePath,
			Arguments = arguments,
			ShortcutPath = shortcutPath,
			RegistryKey = registryKey,
			ParsingName = parsingName,
		};
}
