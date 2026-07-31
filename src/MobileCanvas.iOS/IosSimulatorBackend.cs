using MobileCanvas.Contracts;
using MobileCanvas.Core;
using Idb;
using System.Collections.Concurrent;
using System.Diagnostics;

namespace MobileCanvas.iOS;

public sealed class IosSimulatorBackend : IDeviceBackend, IAsyncDisposable
{
	private readonly IProcessRunner _processRunner;
	private readonly IdbCompanionManager _companions;
	private readonly IosRecordingManager _recordings;
	private readonly SimulatorDisplayProfiles _profiles;

	// Input events resolve the target device before every send. Doing that through `simctl list`
	// costs a 350-600ms subprocess, which dominated input latency and made drags feel detached.
	// Booted state only changes through lifecycle calls (which invalidate this) or an external
	// shutdown, and the latter surfaces as a companion failure anyway.
	private readonly ConcurrentDictionary<string, (DeviceTarget Device, long Stamp)> _bootedCache = new();
	private readonly ConcurrentDictionary<string, bool> _revalidating = new();
	private static readonly TimeSpan BootedCacheLifetime = TimeSpan.FromSeconds(15);

	public IosSimulatorBackend(IProcessRunner processRunner)
	{
		_processRunner = processRunner;
		_companions = new IdbCompanionManager(processRunner);
		_recordings = new IosRecordingManager(processRunner);
		_profiles = new SimulatorDisplayProfiles(processRunner);
	}

	public string Platform => DevicePlatforms.Ios;

	public async Task<DeviceCatalog> GetCatalogAsync(CancellationToken cancellationToken = default)
	{
		if (!OperatingSystem.IsMacOS())
		{
			return new DeviceCatalog
			{
				Diagnostics =
				[
					new HostDiagnostics
					{
						Platform = DevicePlatforms.Ios,
						Ready = false,
						Checks =
						[
							new DependencyCheck
							{
								Name = "macOS",
								Status = "error",
								Message = "iOS Simulator is only available on macOS.",
							},
						],
					},
				],
			};
		}

		var result = await RunAsync(["list", "--json"], cancellationToken).ConfigureAwait(false);
		EnsureSuccess("xcrun", ["simctl", "list", "--json"], result);
		var catalog = SimctlCatalogParser.Parse(result.StandardOutput);
		RefreshBootedCache(catalog.Devices);
		return catalog with
		{
			Diagnostics = [await GetDiagnosticsAsync(cancellationToken).ConfigureAwait(false)],
		};
	}

	public async Task<DeviceTarget[]> ListDevicesAsync(CancellationToken cancellationToken = default) =>
		(await GetCatalogAsync(cancellationToken).ConfigureAwait(false)).Devices;

	public async Task<DeviceTarget> GetDeviceAsync(
		string deviceId,
		CancellationToken cancellationToken = default)
	{
		var device = (await ListDevicesAsync(cancellationToken).ConfigureAwait(false))
			.FirstOrDefault(candidate => candidate.Id.Equals(deviceId, StringComparison.OrdinalIgnoreCase));
		return device ?? throw new DeviceNotFoundException(deviceId);
	}

	public async Task<DisplayGeometry> GetDisplayAsync(
		string deviceId,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var arguments = new[] { "io", device.NativeId, "enumerate" };
		var result = await RunAsync(arguments, cancellationToken).ConfigureAwait(false);
		EnsureSuccess("xcrun", ["simctl", .. arguments], result);
		var display = SimctlDisplayParser.Parse(result.StandardOutput);

		var cornerRadius = await _profiles.TryGetCornerRadiusAsync(
			device.DeviceTypeId,
			display.PixelWidth,
			display.PixelHeight,
			cancellationToken).ConfigureAwait(false);

		return display with
		{
			CornerRadius = cornerRadius,
			CornerCurve = DisplayCornerCurves.Continuous,
		};
	}

	public async Task<DeviceTarget> CreateAsync(
		CreateDeviceRequest request,
		CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrWhiteSpace(request.Name))
			throw new ArgumentException("Device name is required.", nameof(request));
		var catalog = await GetCatalogAsync(cancellationToken).ConfigureAwait(false);
		if (!catalog.Runtimes.Any(runtime =>
			runtime.Id == request.RuntimeId && runtime.IsAvailable))
		{
			throw new ArgumentException(
				$"Runtime '{request.RuntimeId}' is not installed or available.",
				nameof(request));
		}
		if (!catalog.DeviceTypes.Any(type => type.Id == request.DeviceTypeId))
			throw new ArgumentException($"Device type '{request.DeviceTypeId}' was not found.", nameof(request));

		var arguments = new[] { "create", request.Name, request.DeviceTypeId, request.RuntimeId };
		var result = await RunAsync(arguments, cancellationToken).ConfigureAwait(false);
		EnsureSuccess("xcrun", ["simctl", .. arguments], result);
		var udid = result.StandardOutput.Trim();
		return await GetDeviceAsync(
			DeviceIdentity.Create(DevicePlatforms.Ios, "core-simulator", udid),
			cancellationToken).ConfigureAwait(false);
	}

	public async Task<DeviceTarget> BootAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		InvalidateBootedCache(deviceId);
		var device = await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
		if (device.State != DeviceStates.Booted)
		{
			var bootArguments = new[] { "boot", device.NativeId };
			var boot = await RunAsync(bootArguments, cancellationToken).ConfigureAwait(false);
			EnsureSuccess("xcrun", ["simctl", .. bootArguments], boot);
			var waitArguments = new[] { "bootstatus", device.NativeId, "-b" };
			var wait = await RunAsync(waitArguments, cancellationToken).ConfigureAwait(false);
			EnsureSuccess("xcrun", ["simctl", .. waitArguments], wait);
		}
		return await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
	}

	public async Task<DeviceTarget> ShutdownAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		InvalidateBootedCache(deviceId);
		var device = await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
		if (device.State != DeviceStates.Shutdown)
		{
			var arguments = new[] { "shutdown", device.NativeId };
			var result = await RunAsync(arguments, cancellationToken).ConfigureAwait(false);
			EnsureSuccess("xcrun", ["simctl", .. arguments], result);
		}
		return await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
	}

	public async Task<DeviceTarget> RestartAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		await ShutdownAsync(deviceId, cancellationToken).ConfigureAwait(false);
		return await BootAsync(deviceId, cancellationToken).ConfigureAwait(false);
	}

	public async Task<DeviceTarget> EraseAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		InvalidateBootedCache(deviceId);
		var device = await ShutdownAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var arguments = new[] { "erase", device.NativeId };
		var result = await RunAsync(arguments, cancellationToken).ConfigureAwait(false);
		EnsureSuccess("xcrun", ["simctl", .. arguments], result);
		return await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
	}

	public async Task DeleteAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		InvalidateBootedCache(deviceId);
		var device = await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
		if (device.State != DeviceStates.Shutdown)
			await ShutdownAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var arguments = new[] { "delete", device.NativeId };
		var result = await RunAsync(arguments, cancellationToken).ConfigureAwait(false);
		EnsureSuccess("xcrun", ["simctl", .. arguments], result);
	}

	public async Task<DeviceTarget> RevealAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		var device = await BootAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var arguments = new[] { "-a", "Simulator", "--args", "-CurrentDeviceUDID", device.NativeId };
		var result = await _processRunner.RunAsync(
			new ProcessRequest("open", arguments),
			cancellationToken).ConfigureAwait(false);
		EnsureSuccess("open", arguments, result);
		return device;
	}

	public async Task TapAsync(
		string deviceId,
		TapRequest request,
		CancellationToken cancellationToken = default)
	{
		var companion = await GetCompanionAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var point = new Point { X = request.X, Y = request.Y };
		var events = new List<HIDEvent>
		{
			Touch(point, HIDEvent.Types.HIDDirection.Down),
		};
		if (request.Duration > 0)
			events.Add(new HIDEvent { Delay = new HIDEvent.Types.HIDDelay { Duration = request.Duration } });
		events.Add(Touch(point, HIDEvent.Types.HIDDirection.Up));
		await companion.SendHidAsync(events, cancellationToken).ConfigureAwait(false);
	}

	public async Task TouchAsync(
		string deviceId,
		TouchRequest request,
		CancellationToken cancellationToken = default)
	{
		var companion = await GetCompanionAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var point = new Point { X = request.X, Y = request.Y };
		// Indigo has no distinct move phase: a touch that is already down is moved by pressing
		// again at the new point, so down and move share the same direction.
		var direction = string.Equals(request.Phase, TouchPhases.Up, StringComparison.OrdinalIgnoreCase)
			? HIDEvent.Types.HIDDirection.Up
			: HIDEvent.Types.HIDDirection.Down;
		await companion.SendHidAsync([Touch(point, direction)], cancellationToken).ConfigureAwait(false);
	}

	public async Task SwipeAsync(
		string deviceId,
		SwipeRequest request,
		CancellationToken cancellationToken = default)
	{
		var companion = await GetCompanionAsync(deviceId, cancellationToken).ConfigureAwait(false);
		await companion.SendHidAsync(
			[
				new HIDEvent
				{
					Swipe = new HIDEvent.Types.HIDSwipe
					{
						Start = new Point { X = request.StartX, Y = request.StartY },
						End = new Point { X = request.EndX, Y = request.EndY },
						Duration = request.Duration,
					},
				},
			],
			cancellationToken).ConfigureAwait(false);
	}

	public async Task TypeTextAsync(
		string deviceId,
		string text,
		CancellationToken cancellationToken = default)
	{
		var companion = await GetCompanionAsync(deviceId, cancellationToken).ConfigureAwait(false);
		if (IdbKeyboard.TryCreateTextEvents(text, out var events))
		{
			await companion.SendHidAsync(events, cancellationToken).ConfigureAwait(false);
			return;
		}

		var arguments = new[] { "simctl", "pbcopy", companion.Udid };
		var clipboard = await _processRunner.RunAsync(
			new ProcessRequest("xcrun", arguments, StandardInput: text),
			cancellationToken).ConfigureAwait(false);
		EnsureSuccess("xcrun", arguments, clipboard);
		await companion.SendHidAsync(IdbKeyboard.CreatePasteEvents(), cancellationToken).ConfigureAwait(false);
	}

	public async Task PressKeyAsync(
		string deviceId,
		ulong keyCode,
		CancellationToken cancellationToken = default)
	{
		var companion = await GetCompanionAsync(deviceId, cancellationToken).ConfigureAwait(false);
		await companion.SendHidAsync(IdbKeyboard.CreateKeyPress(keyCode), cancellationToken)
			.ConfigureAwait(false);
	}

	public async Task PressButtonAsync(
		string deviceId,
		string button,
		CancellationToken cancellationToken = default)
	{
		var companion = await GetCompanionAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var buttonType = button.ToLowerInvariant() switch
		{
			"home" => HIDEvent.Types.HIDButtonType.Home,
			"lock" => HIDEvent.Types.HIDButtonType.Lock,
			"side" or "side-button" => HIDEvent.Types.HIDButtonType.SideButton,
			"siri" => HIDEvent.Types.HIDButtonType.Siri,
			"apple-pay" => HIDEvent.Types.HIDButtonType.ApplePay,
			_ => throw new ArgumentException(
				"Button must be home, lock, side-button, siri, or apple-pay.",
				nameof(button)),
		};
		var grpcButton = new HIDEvent.Types.HIDButton { Button = buttonType };
		await companion.SendHidAsync(
			[
				Button(grpcButton, HIDEvent.Types.HIDDirection.Down),
				Button(grpcButton, HIDEvent.Types.HIDDirection.Up),
			],
			cancellationToken).ConfigureAwait(false);
	}

	public Task RotateAsync(
		string deviceId,
		string orientation,
		CancellationToken cancellationToken = default) =>
		throw new NotSupportedException(
			"Rotation is not exposed by the installed idb companion protocol.");

	public async Task<byte[]> ScreenshotAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var path = Path.Combine(Path.GetTempPath(), $"mobile-canvas-{Guid.NewGuid():N}.png");
		try
		{
			var arguments = new[] { "io", device.NativeId, "screenshot", "--type=png", path };
			var result = await RunAsync(arguments, cancellationToken).ConfigureAwait(false);
			EnsureSuccess("xcrun", ["simctl", .. arguments], result);
			return await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false);
		}
		finally
		{
			if (File.Exists(path))
				File.Delete(path);
		}
	}

	/// <summary>
	/// Opens a live video stream, preferring ScreenCaptureKit and falling back to idb.
	/// </summary>
	/// <remarks>
	/// idb's encoder emits a single IDR per session with frame reordering on, so a corrupt picture
	/// never recovers, and it never exceeded ~28 FPS. ScreenCaptureKit is the primary path; idb is
	/// kept as a fallback for hosts without the native helper or without Screen Recording and
	/// Accessibility permission, so video degrades instead of disappearing.
	/// </remarks>
	public async Task<ILiveVideoSession> OpenVideoStreamAsync(
		string deviceId,
		StreamOptions options,
		CancellationToken cancellationToken = default)
	{
		var display = await GetDisplayAsync(deviceId, cancellationToken).ConfigureAwait(false);

		if (ScreenCaptureHelper.Path is { } helperPath)
		{
			var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
			var window = await FindCaptureWindowAsync(deviceId, device.NativeId, cancellationToken)
				.ConfigureAwait(false);
			if (window is not null)
			{
				try
				{
					return await IosScreenCaptureVideoSession.StartAsync(
						helperPath,
						window,
						options,
						display,
						static () => { },
						cancellationToken).ConfigureAwait(false);
				}
				catch (Exception exception) when (exception is not OperationCanceledException)
				{
					ScreenCaptureUnavailableReason = exception.Message;
				}
			}
		}

		var companion = await GetCompanionAsync(deviceId, cancellationToken).ConfigureAwait(false);
		return await companion.OpenVideoAsync(
				options,
				display,
				ScreenCaptureUnavailableReason,
				cancellationToken)
			.ConfigureAwait(false);
	}

	/// <summary>
	/// The most recent reason ScreenCaptureKit capture could not be used, surfaced through
	/// diagnostics so the canvas can explain a degraded stream instead of silently looking worse.
	/// </summary>
	internal string? ScreenCaptureUnavailableReason { get; private set; }

	private async Task<ScreencapWindow?> FindCaptureWindowAsync(
		string deviceId,
		string nativeId,
		CancellationToken cancellationToken)
	{
		// Without Accessibility the helper cannot read window UDIDs, so no window can ever match.
		// Checking first avoids a pointless reveal (which activates Simulator.app and retargets its
		// displayed device) followed by ten failed retries, and reports the real cause.
		var permissions = await ScreenCaptureHelper.GetDiagnosticsAsync(cancellationToken).ConfigureAwait(false);
		if (!permissions.AccessibilityGranted)
		{
			ScreenCaptureUnavailableReason =
				"Grant Accessibility permission so the device screen can be located precisely.";
			return null;
		}

		var window = await MatchWindowAsync(nativeId, cancellationToken).ConfigureAwait(false);
		if (window is not null)
			return window;

		// ScreenCaptureKit can only capture a window that exists, so a booted device whose window
		// was closed or is showing another simulator needs Simulator.app brought forward first.
		try
		{
			await RevealAsync(deviceId, cancellationToken).ConfigureAwait(false);
		}
		catch (Exception exception) when (exception is not OperationCanceledException)
		{
			ScreenCaptureUnavailableReason = exception.Message;
			return null;
		}

		for (var attempt = 0; attempt < 10; attempt++)
		{
			await Task.Delay(300, cancellationToken).ConfigureAwait(false);
			window = await MatchWindowAsync(nativeId, cancellationToken).ConfigureAwait(false);
			if (window is not null)
				return window;
		}

		ScreenCaptureUnavailableReason =
			"Simulator.app is not showing a window for this device, so ScreenCaptureKit cannot capture it.";
		return null;
	}

	private async Task<ScreencapWindow?> MatchWindowAsync(string nativeId, CancellationToken cancellationToken)
	{
		var windows = await ScreenCaptureHelper.ListAsync(cancellationToken).ConfigureAwait(false);
		if (windows.Count == 0)
		{
			ScreenCaptureUnavailableReason =
				"No simulator windows are visible to ScreenCaptureKit. Grant Screen Recording permission.";
			return null;
		}

		var match = windows.FirstOrDefault(window =>
			string.Equals(window.Udid, nativeId, StringComparison.OrdinalIgnoreCase));
		if (match is null)
			return null;

		if (!match.HasExactGeometry)
		{
			// Without Accessibility we would capture Simulator chrome and the bezel, which breaks
			// input coordinate mapping. Degrading to idb is better than a misaligned picture.
			ScreenCaptureUnavailableReason =
				"Grant Accessibility permission so the device screen can be cropped exactly.";
			return null;
		}

		return match;
	}

	public async Task<RecordingStatus> StartRecordingAsync(
		string deviceId,
		RecordingStartRequest request,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		return await _recordings.StartAsync(
			deviceId,
			device.NativeId,
			request,
			cancellationToken).ConfigureAwait(false);
	}

	public Task<RecordingStatus> StopRecordingAsync(
		string deviceId,
		CancellationToken cancellationToken = default) =>
		_recordings.StopAsync(deviceId, cancellationToken);

	public Task<RecordingStatus> GetRecordingStatusAsync(
		string deviceId,
		CancellationToken cancellationToken = default) =>
		Task.FromResult(_recordings.GetStatus(deviceId));

	public async Task<UiSnapshot> GetUiSnapshotAsync(
		string deviceId,
		bool includeRaw,
		CancellationToken cancellationToken = default)
	{
		var companion = await GetCompanionAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var json = await companion.GetAccessibilityJsonAsync(cancellationToken).ConfigureAwait(false);
		var root = AccessibilityParser.Parse(json);

		return new UiSnapshot
		{
			DeviceId = deviceId,
			Platform = DevicePlatforms.Ios,
			Root = root,
			ElementCount = UiTree.Count(root),
			Raw = includeRaw ? json : null,
		};
	}

	#region Apps

	public async Task<InstalledApp[]> ListAppsAsync(
		string deviceId,
		bool includeSystem,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var json = await ListAppsJsonAsync(device.NativeId, cancellationToken).ConfigureAwait(false);

		// Running state is one extra call for the whole list, so it is always included: knowing an app
		// is already up is what tells a caller whether to launch it or just bring it forward.
		var running = SimctlAppParser.ParseRunning(
			await TryListRunningAsync(device.NativeId, cancellationToken).ConfigureAwait(false));

		var apps = SimctlAppParser.Parse(json, running);
		return includeSystem ? apps : [.. apps.Where(app => app.Kind == AppKinds.User)];
	}

	public async Task<AppOperationResult> LaunchAppAsync(
		string deviceId,
		AppLaunchRequest request,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);

		if (request.Relaunch)
		{
			// A terminate for an app that is not running exits non-zero, which is not a failure of the
			// relaunch the caller asked for, so its result is deliberately ignored.
			await RunAsync(["terminate", device.NativeId, request.BundleId], cancellationToken)
				.ConfigureAwait(false);
		}

		var arguments = new List<string> { "launch", device.NativeId, request.BundleId };
		arguments.AddRange(request.Arguments);

		var result = await RunAsync(arguments, cancellationToken).ConfigureAwait(false);
		if (result.ExitCode != 0)
			throw new DeviceCapabilityException(DescribeAppFailure("launch", request.BundleId, result));

		return new AppOperationResult
		{
			DeviceId = deviceId,
			BundleId = request.BundleId,
			Operation = AppOperations.Launch,
			ProcessId = SimctlAppParser.ParseLaunchedPid(result.StandardOutput),
		};
	}

	public async Task<AppOperationResult> TerminateAppAsync(
		string deviceId,
		string bundleId,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var result = await RunAsync(["terminate", device.NativeId, bundleId], cancellationToken)
			.ConfigureAwait(false);

		if (result.ExitCode != 0)
			throw new DeviceCapabilityException(DescribeAppFailure("terminate", bundleId, result));

		return new AppOperationResult
		{
			DeviceId = deviceId,
			BundleId = bundleId,
			Operation = AppOperations.Terminate,
		};
	}

	public async Task<AppOperationResult> InstallAppAsync(
		string deviceId,
		AppInstallRequest request,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var result = await RunAsync(["install", device.NativeId, request.Path], cancellationToken)
			.ConfigureAwait(false);

		if (result.ExitCode != 0)
			throw new DeviceCapabilityException(DescribeAppFailure("install", request.Path, result));

		// simctl says nothing about what it installed, so the bundle ID is read back from the app's own
		// Info.plist. A caller that just installed something needs its identifier to launch it.
		var bundleId = await TryReadBundleIdAsync(request.Path, cancellationToken).ConfigureAwait(false);

		return new AppOperationResult
		{
			DeviceId = deviceId,
			BundleId = bundleId ?? "",
			Operation = AppOperations.Install,
			Detail = request.Path,
		};
	}

	public async Task<AppOperationResult> UninstallAppAsync(
		string deviceId,
		string bundleId,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);

		// simctl uninstall succeeds silently for an app that was never installed, so a mistyped bundle
		// ID would read as a completed uninstall. Android reports that case, and a caller should not
		// have to know which platform it is talking to, so the app is confirmed present first.
		var container = await RunAsync(["get_app_container", device.NativeId, bundleId], cancellationToken)
			.ConfigureAwait(false);

		if (container.ExitCode != 0)
			throw new DeviceCapabilityException(
				$"'{bundleId}' is not installed on '{device.NativeId}', so there is nothing to uninstall.");

		var result = await RunAsync(["uninstall", device.NativeId, bundleId], cancellationToken)
			.ConfigureAwait(false);

		if (result.ExitCode != 0)
			throw new DeviceCapabilityException(DescribeAppFailure("uninstall", bundleId, result));

		return new AppOperationResult
		{
			DeviceId = deviceId,
			BundleId = bundleId,
			Operation = AppOperations.Uninstall,
		};
	}

	/// <summary>
	/// Runs <c>simctl listapps</c> and converts its property list to JSON with <c>plutil</c>.
	/// </summary>
	private async Task<string> ListAppsJsonAsync(string udid, CancellationToken cancellationToken)
	{
		var listed = await RunAsync(["listapps", udid], cancellationToken).ConfigureAwait(false);
		EnsureSuccess("xcrun", ["simctl", "listapps", udid], listed);

		var converted = await _processRunner.RunAsync(
			new ProcessRequest("plutil", ["-convert", "json", "-o", "-", "-"], StandardInput: listed.StandardOutput),
			cancellationToken).ConfigureAwait(false);

		if (converted.ExitCode != 0)
			throw new DeviceCapabilityException(
				$"Could not read the app list from simulator '{udid}': plutil rejected simctl's output "
				+ $"({converted.StandardError.Trim()}).");

		return converted.StandardOutput;
	}

	/// <summary>
	/// Lists running jobs, tolerating failure: an app list is still useful without running state, so a
	/// simulator that will not answer should degrade rather than fail the whole call.
	/// </summary>
	private async Task<string?> TryListRunningAsync(string udid, CancellationToken cancellationToken)
	{
		try
		{
			var result = await _processRunner.RunAsync(
				new ProcessRequest("xcrun", ["simctl", "spawn", udid, "launchctl", "list"]),
				cancellationToken).ConfigureAwait(false);
			return result.ExitCode == 0 ? result.StandardOutput : null;
		}
		catch (Exception exception) when (exception is not OperationCanceledException)
		{
			return null;
		}
	}

	private async Task<string?> TryReadBundleIdAsync(string appPath, CancellationToken cancellationToken)
	{
		var plist = Path.Combine(appPath, "Info.plist");
		if (!File.Exists(plist))
			return null;

		var result = await _processRunner.RunAsync(
			new ProcessRequest("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist]),
			cancellationToken).ConfigureAwait(false);

		return result.ExitCode == 0 ? result.StandardOutput.Trim() : null;
	}

	private static string DescribeAppFailure(string operation, string subject, ProcessResult result)
	{
		var detail = string.IsNullOrWhiteSpace(result.StandardError)
			? result.StandardOutput.Trim()
			: result.StandardError.Trim();

		return $"Could not {operation} '{subject}': "
			+ (detail.Length == 0 ? $"simctl exited with code {result.ExitCode}." : detail);
	}

	#endregion

	public async ValueTask DisposeAsync()
	{
		await _recordings.DisposeAsync().ConfigureAwait(false);
		await _companions.DisposeAsync().ConfigureAwait(false);
	}

	private async Task<IdbCompanionSession> GetCompanionAsync(
		string deviceId,
		CancellationToken cancellationToken)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		return await _companions.GetAsync(device.NativeId, cancellationToken).ConfigureAwait(false);
	}

	private async Task<DeviceTarget> RequireBootedAsync(
		string deviceId,
		CancellationToken cancellationToken)
	{
		// Re-verifying "is it booted" costs a `simctl list` subprocess (340-620ms), which is far
		// more than the input itself and would land in the middle of a drag. A known device is
		// therefore served immediately and revalidated in the background, so only the very first
		// input for a device ever blocks. Our own lifecycle operations invalidate explicitly, so
		// a stale entry only survives an out-of-band shutdown, where the send fails visibly anyway.
		if (_bootedCache.TryGetValue(deviceId, out var cached))
		{
			if (Stopwatch.GetElapsedTime(cached.Stamp) >= BootedCacheLifetime)
				RevalidateBootedInBackground(deviceId);
			return cached.Device;
		}

		var device = await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
		if (device.State != DeviceStates.Booted)
		{
			_bootedCache.TryRemove(deviceId, out _);
			throw new InvalidOperationException($"Simulator '{device.Name}' is not booted.");
		}
		_bootedCache[deviceId] = (device, Stopwatch.GetTimestamp());
		return device;
	}

	/// <summary>
	/// Refreshes one cached device off the input path, at most once at a time per device.
	/// </summary>
	private void RevalidateBootedInBackground(string deviceId)
	{
		if (!_revalidating.TryAdd(deviceId, true))
			return;

		_ = Task.Run(async () =>
		{
			try
			{
				var device = await GetDeviceAsync(deviceId, CancellationToken.None).ConfigureAwait(false);
				if (device.State == DeviceStates.Booted)
					_bootedCache[deviceId] = (device, Stopwatch.GetTimestamp());
				else
					_bootedCache.TryRemove(deviceId, out _);
			}
			catch
			{
				// A failed probe must not disturb input; the next attempt will retry.
			}
			finally
			{
				_revalidating.TryRemove(deviceId, out _);
			}
		});
	}

	private void InvalidateBootedCache(string deviceId) => _bootedCache.TryRemove(deviceId, out _);

	// Every catalog read is an authoritative snapshot, so it is reused to keep the cache warm.
	private void RefreshBootedCache(IEnumerable<DeviceTarget> devices)
	{
		var stamp = Stopwatch.GetTimestamp();
		foreach (var device in devices)
		{
			if (device.State == DeviceStates.Booted)
				_bootedCache[device.Id] = (device, stamp);
			else
				_bootedCache.TryRemove(device.Id, out _);
		}
	}

	private Task<ProcessResult> RunAsync(
		IReadOnlyList<string> arguments,
		CancellationToken cancellationToken) =>
		_processRunner.RunAsync(
			new ProcessRequest("xcrun", ["simctl", .. arguments]),
			cancellationToken);

	private async Task<HostDiagnostics> GetDiagnosticsAsync(CancellationToken cancellationToken)
	{
		var checks = new List<DependencyCheck>();
		var xcode = await _processRunner.RunAsync(
			new ProcessRequest("xcode-select", ["-p"]),
			cancellationToken).ConfigureAwait(false);
		checks.Add(new DependencyCheck
		{
			Name = "Xcode",
			Status = xcode.ExitCode == 0 ? "ok" : "error",
			Message = xcode.ExitCode == 0
				? "Full Xcode developer directory is selected."
				: xcode.StandardError.Trim(),
			Path = xcode.ExitCode == 0 ? xcode.StandardOutput.Trim() : null,
		});

		var companion = IdbCompanionLocator.Find();
		checks.Add(new DependencyCheck
		{
			Name = "idb_companion",
			Status = companion is null ? "error" : "ok",
			Message = companion is null
				? "Install idb_companion or set MOBILE_CANVAS_IDB_COMPANION."
				: "idb_companion is available for touch, keyboard, and fallback video.",
			Path = companion,
		});

		// Capture is the one dependency that degrades silently: without it the stream still works,
		// just through idb's corrupt encoder. Report the helper and both TCC grants separately so a
		// user knows which prompt to accept rather than only seeing a worse picture.
		var screencap = await ScreenCaptureHelper.GetDiagnosticsAsync(cancellationToken)
			.ConfigureAwait(false);
		var screencapPath = ScreenCaptureHelper.Path;
		var screencapReady = screencapPath is not null
			&& screencap.ScreenRecordingGranted
			&& screencap.AccessibilityGranted;
		checks.Add(new DependencyCheck
		{
			Name = "mobile-screencap",
			// A missing permission is a warning rather than an error: the idb fallback still
			// streams, so the host is degraded but not broken.
			Status = screencapReady ? "ok" : screencapPath is null ? "error" : "warning",
			Message = screencapPath is null
				? "mobile-screencap was not found next to mobile-canvas; video falls back to idb."
				: screencapReady
					? "ScreenCaptureKit capture is available."
					: BuildScreencapMessage(screencap),
			Path = screencapPath,
		});

		return new HostDiagnostics
		{
			Platform = DevicePlatforms.Ios,
			Ready = checks.All(check => check.Status != "error"),
			Checks = checks.ToArray(),
		};
	}

	private static string BuildScreencapMessage(ScreencapDiagnostics diagnostics)
	{
		var missing = new List<string>();
		if (!diagnostics.ScreenRecordingGranted)
			missing.Add("Screen Recording");
		if (!diagnostics.AccessibilityGranted)
			missing.Add("Accessibility");
		var permissions = missing.Count == 0
			? "permission"
			: string.Join(" and ", missing);
		return $"Grant {permissions} in System Settings > Privacy & Security to enable "
			+ "ScreenCaptureKit video; until then video falls back to idb.";
	}

	private static void EnsureSuccess(
		string fileName,
		IReadOnlyList<string> arguments,
		ProcessResult result)
	{
		if (result.ExitCode != 0)
			throw new ProcessExecutionException(fileName, arguments, result);
	}

	private static HIDEvent Touch(Point point, HIDEvent.Types.HIDDirection direction) => new()
	{
		Press = new HIDEvent.Types.HIDPress
		{
			Action = new HIDEvent.Types.HIDPressAction
			{
				Touch = new HIDEvent.Types.HIDTouch { Point = point },
			},
			Direction = direction,
		},
	};

	private static HIDEvent Button(
		HIDEvent.Types.HIDButton button,
		HIDEvent.Types.HIDDirection direction) => new()
	{
		Press = new HIDEvent.Types.HIDPress
		{
			Action = new HIDEvent.Types.HIDPressAction { Button = button },
			Direction = direction,
		},
	};
}
