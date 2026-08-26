using MobileCanvas.Contracts;
using MobileCanvas.Core;
using Idb;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;

namespace MobileCanvas.iOS;

public sealed class IosSimulatorBackend : IDeviceBackend, IAsyncDisposable
{
	private readonly IProcessRunner _processRunner;
	private readonly CoreSimulatorHidManager _hid;
	private readonly IdbCompanionManager _companions;
	private readonly NativeAccessibilityReader _accessibility;
	private readonly IosRecordingManager _recordings;
	private readonly SimulatorDisplayProfiles _profiles;

	// Input events resolve the target device before every send. Doing that through `simctl list`
	// costs a 350-600ms subprocess, which dominated input latency and made drags feel detached.
	// Booted state only changes through lifecycle calls (which invalidate this) or an external
	// shutdown, and the latter surfaces as a companion failure anyway.
	private readonly ConcurrentDictionary<string, (DeviceTarget Device, long Stamp)> _bootedCache = new();
	private readonly ConcurrentDictionary<string, bool> _revalidating = new();
	private readonly ConcurrentDictionary<string, string> _orientations = new(StringComparer.OrdinalIgnoreCase);
	private readonly ConcurrentDictionary<string, ActiveHidRoute> _activeTouches =
		new(StringComparer.OrdinalIgnoreCase);
	private readonly ConcurrentDictionary<string, SemaphoreSlim> _inputGates =
		new(StringComparer.OrdinalIgnoreCase);
	private readonly ConcurrentDictionary<string, bool> _removingInputSessions =
		new(StringComparer.OrdinalIgnoreCase);
	private readonly SemaphoreSlim _inputRemovalGate = new(1, 1);
	private static readonly TimeSpan BootedCacheLifetime = TimeSpan.FromSeconds(15);

	public IosSimulatorBackend(IProcessRunner processRunner)
	{
		_processRunner = processRunner;
		_hid = new CoreSimulatorHidManager();
		_companions = new IdbCompanionManager(processRunner);
		_accessibility = new NativeAccessibilityReader(processRunner);
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
		display = SimulatorOrientation.Apply(
			display,
			_orientations.GetValueOrDefault(device.NativeId, "portrait"));

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
		var nativeId = DeviceIdentity.GetNativeId(deviceId);
		try
		{
			var device = await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
			if (device.State != DeviceStates.Shutdown)
			{
				var arguments = new[] { "shutdown", device.NativeId };
				var result = await RunAsync(arguments, cancellationToken).ConfigureAwait(false);
				EnsureSuccess("xcrun", ["simctl", .. arguments], result);
			}
			return await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
		}
		finally
		{
			await RemoveInputSessionsAsync(nativeId).ConfigureAwait(false);
		}
	}

	public async Task<DeviceTarget> RestartAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		await ShutdownAsync(deviceId, cancellationToken).ConfigureAwait(false);
		return await BootAsync(deviceId, cancellationToken).ConfigureAwait(false);
	}

	public async Task<DeviceTarget> EraseAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		InvalidateBootedCache(deviceId);
		var nativeId = DeviceIdentity.GetNativeId(deviceId);
		try
		{
			var device = await ShutdownAsync(deviceId, cancellationToken).ConfigureAwait(false);
			var arguments = new[] { "erase", device.NativeId };
			var result = await RunAsync(arguments, cancellationToken).ConfigureAwait(false);
			EnsureSuccess("xcrun", ["simctl", .. arguments], result);
			return await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
		}
		finally
		{
			await RemoveInputSessionsAsync(nativeId).ConfigureAwait(false);
		}
	}

	public async Task DeleteAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		InvalidateBootedCache(deviceId);
		var nativeId = DeviceIdentity.GetNativeId(deviceId);
		try
		{
			var device = await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
			if (device.State != DeviceStates.Shutdown)
				await ShutdownAsync(deviceId, cancellationToken).ConfigureAwait(false);
			var arguments = new[] { "delete", device.NativeId };
			var result = await RunAsync(arguments, cancellationToken).ConfigureAwait(false);
			EnsureSuccess("xcrun", ["simctl", .. arguments], result);
		}
		finally
		{
			await RemoveInputSessionsAsync(nativeId).ConfigureAwait(false);
		}
	}

	public async Task<DeviceTarget> RevealAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		var device = await BootAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var host = await SimulatorHostLocator.ResolveSelectedAsync(
			_processRunner,
			cancellationToken).ConfigureAwait(false);
		var arguments = host.BuildOpenArguments(device.NativeId);
		var result = await _processRunner.RunAsync(
			new ProcessRequest("open", arguments),
			cancellationToken).ConfigureAwait(false);
		EnsureSuccess("open", arguments, result);
		await FocusSimulatorWindowAsync(host, device, cancellationToken).ConfigureAwait(false);
		return device;
	}

	/// <summary>
	/// Best-effort focus of the selected simulator host, which needs Accessibility. Reveal has already
	/// activated the app, so a denied permission leaves it frontmost rather than failing the call.
	/// </summary>
	private async Task FocusSimulatorWindowAsync(
		SimulatorHostInstallation host,
		DeviceTarget device,
		CancellationToken cancellationToken)
	{
		if (string.IsNullOrWhiteSpace(device.Name) || string.IsNullOrWhiteSpace(device.RuntimeName))
			return;
		var script = SimulatorWindowFocus.BuildScript(host, device.Name, device.RuntimeName);
		try
		{
			await _processRunner.RunAsync(
				new ProcessRequest("osascript", ["-e", script]),
				cancellationToken).ConfigureAwait(false);
		}
		catch (Exception exception) when (exception is not OperationCanceledException)
		{
			// Ignored: the window simply stays where it was.
		}
	}

	public async Task TapAsync(
		string deviceId,
		TapRequest request,
		CancellationToken cancellationToken = default)
	{
		await SendInputAsync(
			deviceId,
			IosHidEvents.CreateTap(request.X, request.Y, request.Duration),
			cancellationToken).ConfigureAwait(false);
	}

	public async Task TouchAsync(
		string deviceId,
		TouchRequest request,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var touch = IosHidEvents.CreateTouch(request.X, request.Y, request.Phase);
		var gate = _inputGates.GetOrAdd(device.NativeId, static _ => new SemaphoreSlim(1, 1));
		var enteredTouchGate = false;
		try
		{
			var acquired = false;
			try
			{
				await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
				acquired = true;
				enteredTouchGate = true;
				ThrowIfInputSessionsAreBeingRemoved(device.NativeId);
				if (touch.Phase == IosHidTouchPhase.Down)
				{
					if (_activeTouches.ContainsKey(device.NativeId))
						throw new DeviceCapabilityException("A continuous touch is already active on this simulator.");

					var route = await SendInputCoreAsync(device, [touch], cancellationToken).ConfigureAwait(false);
					_activeTouches[device.NativeId] = route;
					return;
				}

				if (!_activeTouches.TryGetValue(device.NativeId, out var active))
				{
					throw new DeviceCapabilityException(
						$"No continuous touch is active on simulator '{device.NativeId}'. "
						+ "Start the gesture with phase 'down'.");
				}

				try
				{
					await active.SendAsync([touch], cancellationToken).ConfigureAwait(false);
				}
				catch (CoreSimulatorHidException exception)
				{
					_activeTouches.TryRemove(device.NativeId, out _);
					throw new CoreSimulatorHidException(
						$"The continuous touch lost its bundled CoreSimulator HID session: {exception.Message}",
						beforeDelivery: false,
						exception);
				}
				catch (IdbHidException exception)
				{
					_activeTouches.TryRemove(device.NativeId, out _);
					throw new DeviceCapabilityException(
						$"The continuous touch lost its optional idb session: {exception.Message}");
				}
				finally
				{
					if (touch.Phase == IosHidTouchPhase.Up)
						_activeTouches.TryRemove(device.NativeId, out _);
				}
			}
			finally
			{
				if (acquired)
					gate.Release();
			}
		}
		catch (OperationCanceledException) when (enteredTouchGate)
		{
			// Cancellation can race a delivered down or move with its acknowledgement. Tear down
			// the captured transport so the helper's EOF cleanup lifts any possibly active contact,
			// and so the next gesture starts from a known state.
			await RemoveInputSessionsAsync(device.NativeId).ConfigureAwait(false);
			throw;
		}
	}

	public async Task SwipeAsync(
		string deviceId,
		SwipeRequest request,
		CancellationToken cancellationToken = default)
	{
		await SendInputAsync(
			deviceId,
			[
				IosHidEvents.CreateSwipe(
					request.StartX,
					request.StartY,
					request.EndX,
					request.EndY,
					request.Duration),
			],
			cancellationToken).ConfigureAwait(false);
	}

	public async Task TypeTextAsync(
		string deviceId,
		string text,
		CancellationToken cancellationToken = default)
	{
		if (text.Length == 0)
			return;

		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		if (IosHidEvents.TryCreateTextEvents(text, out var events))
		{
			await SendInputAsync(device, events, cancellationToken).ConfigureAwait(false);
			return;
		}

		var arguments = new[] { "simctl", "pbcopy", device.NativeId };
		var clipboard = await _processRunner.RunAsync(
			new ProcessRequest("xcrun", arguments, StandardInput: text),
			cancellationToken).ConfigureAwait(false);
		EnsureSuccess("xcrun", arguments, clipboard);
		await SendInputAsync(device, IosHidEvents.CreatePasteEvents(), cancellationToken)
			.ConfigureAwait(false);
	}

	public async Task PressKeyAsync(
		string deviceId,
		ulong keyCode,
		CancellationToken cancellationToken = default)
	{
		await SendInputAsync(
			deviceId,
			IosHidEvents.CreateKeyPress(keyCode),
			cancellationToken).ConfigureAwait(false);
	}

	public async Task PressButtonAsync(
		string deviceId,
		string button,
		CancellationToken cancellationToken = default)
	{
		await SendInputAsync(
			deviceId,
			[IosHidEvents.CreateButtonPress(button)],
			cancellationToken).ConfigureAwait(false);
	}

	public async Task RotateAsync(
		string deviceId,
		string orientation,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var normalizedOrientation = SimulatorOrientation.Normalize(orientation);
		var helperPath = ScreenCaptureHelper.Path
			?? throw new InvalidOperationException(
				"mobile-screencap is required to rotate an iOS Simulator.");
		var arguments = new[]
		{
			"rotate",
			"--udid",
			device.NativeId,
			"--orientation",
			normalizedOrientation,
		};
		var result = await _processRunner.RunAsync(
			new ProcessRequest(helperPath, arguments),
			cancellationToken).ConfigureAwait(false);
		EnsureSuccess(helperPath, arguments, result);
		_orientations[device.NativeId] = normalizedOrientation;
	}

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
	/// Opens a live video stream, preferring the direct simulator framebuffer.
	/// </summary>
	/// <remarks>
	/// idb's encoder emits a single IDR per session with frame reordering on, so a corrupt picture
	/// never recovers, and it never exceeded ~28 FPS. The native helper reads CoreSimulator's
	/// IOSurface without TCC permissions; ScreenCaptureKit and then idb remain fallbacks so private
	/// framework changes degrade instead of removing video.
	/// </remarks>
	public async Task<ILiveVideoSession> OpenVideoStreamAsync(
		string deviceId,
		StreamOptions options,
		CancellationToken cancellationToken = default)
	{
		string? framebufferUnavailableReason = null;
		string? screenCaptureUnavailableReason = null;
		var display = await GetDisplayAsync(deviceId, cancellationToken).ConfigureAwait(false);

		if (ScreenCaptureHelper.Path is { } helperPath)
		{
			var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
			try
			{
				return await IosScreenCaptureVideoSession.StartFramebufferAsync(
					helperPath,
					device.NativeId,
					options,
					display,
					static () => { },
					cancellationToken).ConfigureAwait(false);
			}
			catch (Exception exception) when (exception is not OperationCanceledException)
			{
				framebufferUnavailableReason = exception.Message;
			}

			var windowResult = await FindCaptureWindowAsync(device.NativeId, cancellationToken)
				.ConfigureAwait(false);
			screenCaptureUnavailableReason = windowResult.FailureReason;
			if (windowResult.Window is not null)
			{
				try
				{
					return await IosScreenCaptureVideoSession.StartAsync(
						helperPath,
						windowResult.Window,
						options,
						display,
						static () => { },
						cancellationToken,
						BuildCaptureFallbackDetail(framebufferUnavailableReason, null))
						.ConfigureAwait(false);
				}
				catch (Exception exception) when (exception is not OperationCanceledException)
				{
					screenCaptureUnavailableReason = exception.Message;
				}
			}
		}
		else
		{
			framebufferUnavailableReason =
				$"{ScreenCaptureHelper.ExecutableName} is unavailable, so native capture cannot start.";
		}

		var nativeFailure = BuildCaptureFallbackDetail(
			framebufferUnavailableReason,
			screenCaptureUnavailableReason);
		if (IdbCompanionLocator.Find() is null)
			throw BuildVideoUnavailableException(nativeFailure, "idb_companion is not installed.");

		try
		{
			var companion = await GetCompanionAsync(deviceId, cancellationToken).ConfigureAwait(false);
			return await companion.OpenVideoAsync(
					options,
					display,
					nativeFailure,
					cancellationToken)
				.ConfigureAwait(false);
		}
		catch (OperationCanceledException)
		{
			throw;
		}
		catch (Exception exception) when (IdbCompanionManager.IsAvailabilityFailure(exception))
		{
			throw BuildVideoUnavailableException(nativeFailure, exception.Message);
		}
	}

	internal static string? BuildCaptureFallbackDetail(
		string? framebufferReason,
		string? screenCaptureReason)
	{
		var details = new List<string>(2);
		if (!string.IsNullOrWhiteSpace(framebufferReason))
			details.Add($"Direct framebuffer capture unavailable: {framebufferReason}");
		if (!string.IsNullOrWhiteSpace(screenCaptureReason))
			details.Add($"ScreenCaptureKit fallback unavailable: {screenCaptureReason}");
		return details.Count == 0 ? null : string.Join(" ", details);
	}

	internal static DeviceCapabilityException BuildVideoUnavailableException(
		string? nativeFailure,
		string idbFailure)
	{
		var nativeDetail = string.IsNullOrWhiteSpace(nativeFailure)
			? "Native framebuffer and ScreenCaptureKit capture are unavailable."
			: nativeFailure;
		return new DeviceCapabilityException(
			$"iOS live video is unavailable. {nativeDetail} "
			+ $"Optional idb final fallback: {idbFailure}");
	}

	private async Task<CaptureWindowResult> FindCaptureWindowAsync(
		string nativeId,
		CancellationToken cancellationToken)
	{
		// Live capture must not turn a headless boot into a visible simulator host window. An already
		// visible window remains a valid fallback, but opening one is reserved for RevealAsync.
		var permissions = await ScreenCaptureHelper.GetDiagnosticsAsync(cancellationToken).ConfigureAwait(false);
		if (!permissions.ScreenRecordingGranted)
		{
			return new CaptureWindowResult(
				null,
				"Grant Screen Recording permission so ScreenCaptureKit can read the simulator host app.");
		}
		if (!permissions.AccessibilityGranted)
		{
			return new CaptureWindowResult(
				null,
				"Grant Accessibility permission so the device screen can be located precisely.");
		}

		return await MatchWindowAsync(nativeId, cancellationToken).ConfigureAwait(false);
	}

	private async Task<CaptureWindowResult> MatchWindowAsync(
		string nativeId,
		CancellationToken cancellationToken)
	{
		var windows = await ScreenCaptureHelper.ListAsync(cancellationToken).ConfigureAwait(false);
		if (windows.Count == 0)
		{
			return new CaptureWindowResult(
				null,
				"No simulator windows are open. Use Show simulator window to make this fallback available.");
		}

		var match = windows.FirstOrDefault(window =>
			string.Equals(window.Udid, nativeId, StringComparison.OrdinalIgnoreCase));
		if (match is null)
		{
			return new CaptureWindowResult(
				null,
				"The simulator host app is not showing this device. Use Show simulator window to make this fallback available.");
		}

		if (!match.HasExactGeometry)
		{
			// Without Accessibility we would capture Simulator chrome and the bezel, which breaks
			// input coordinate mapping. Degrading to idb is better than a misaligned picture.
			return new CaptureWindowResult(
				null,
				"Grant Accessibility permission so the device screen can be cropped exactly.");
		}

		return new CaptureWindowResult(match, null);
	}

	private readonly record struct CaptureWindowResult(
		ScreencapWindow? Window,
		string? FailureReason);

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
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		string? developerDirectory = null;
		try
		{
			developerDirectory = await XcodeDeveloperDirectory.ResolveSelectedAsync(
				_processRunner,
				cancellationToken).ConfigureAwait(false);
		}
		catch (OperationCanceledException)
		{
			throw;
		}
		catch (Exception exception) when (
			exception is ProcessExecutionException
				or InvalidOperationException
				or ArgumentException)
		{
			// The native reader reports a more specific framework/load error, and IDB remains usable.
		}

		var json = await IosAccessibilityFallback.ReadAsync(
			() => _accessibility.ReadAsync(device.NativeId, developerDirectory, cancellationToken),
			async () =>
			{
				var fallback = await GetCompanionAsync(deviceId, cancellationToken).ConfigureAwait(false);
				var payload = await fallback.GetAccessibilityJsonAsync(cancellationToken).ConfigureAwait(false);
				if (AccessibilityParser.Parse(payload) is null)
					throw new InvalidDataException("idb_companion returned an invalid accessibility hierarchy.");
				return payload;
			}).ConfigureAwait(false);

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

	#region Diagnostics

	public async Task<LogEntry[]> ReadLogAsync(
		string deviceId,
		LogQuery query,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);

		var predicates = new List<string>();

		if (!string.IsNullOrWhiteSpace(query.BundleId))
		{
			var process = await ResolveProcessNameAsync(device.NativeId, query.BundleId, cancellationToken)
				.ConfigureAwait(false);

			predicates.Add($"process == \"{process}\"");
		}

		if (OsLogParser.ToPredicate(query.MinimumLevel) is { } level)
			predicates.Add($"({level})");

		var arguments = new List<string>
		{
			"simctl", "spawn", device.NativeId, "log", "show",
			"--style", "ndjson",
			"--last", FormatDuration(query.Since),
		};

		if (predicates.Count > 0)
		{
			arguments.Add("--predicate");
			arguments.Add(string.Join(" AND ", predicates));
		}

		var result = await _processRunner.RunAsync(
			new ProcessRequest("xcrun", [.. arguments]),
			cancellationToken).ConfigureAwait(false);

		if (result.ExitCode != 0)
			throw new DeviceCapabilityException(
				$"Could not read the log from simulator '{device.NativeId}': "
				+ (result.StandardError.Trim() is { Length: > 0 } error ? error : $"log show exited with code {result.ExitCode}."));

		return OsLogParser.Parse(result.StandardOutput);
	}

	public Task<CrashReport[]> ListCrashesAsync(
		string deviceId,
		CancellationToken cancellationToken = default) =>
		Task.Run(() =>
		{
			var directory = CrashReportDirectory;
			if (!Directory.Exists(directory))
				return Array.Empty<CrashReport>();

			var reports = new List<(DateTime Written, CrashReport Report)>();
			foreach (var path in Directory.EnumerateFiles(directory, "*.ips"))
			{
				cancellationToken.ThrowIfCancellationRequested();

				var report = TryReadReportHeader(path);
				if (report is not null)
					reports.Add((File.GetLastWriteTimeUtc(path), report));
			}

			return reports
				.OrderByDescending(entry => entry.Written)
				.Select(entry => entry.Report)
				.ToArray();
		}, cancellationToken);

	public async Task<CrashDetailResult> GetCrashAsync(
		string deviceId,
		string crashId,
		CancellationToken cancellationToken = default)
	{
		// The ID is a file name, and it arrives from a caller, so it is resolved and then checked to
		// still be inside the reports directory. Without that "../../.." reads arbitrary files.
		var directory = Path.GetFullPath(CrashReportDirectory);
		var path = Path.GetFullPath(Path.Combine(directory, crashId));

		if (!path.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.Ordinal) || !File.Exists(path))
			throw new DeviceCapabilityException(
				$"No crash report named '{crashId}' exists. List crashes first to see the available IDs.");

		var report = TryReadReportHeader(path)
			?? throw new DeviceCapabilityException(
				$"'{crashId}' is not a simulator crash report.");

		var content = await File.ReadAllTextAsync(path, cancellationToken).ConfigureAwait(false);

		return new CrashDetailResult { DeviceId = deviceId, Report = report, Content = content };
	}

	/// <summary>
	/// Where the simulator writes crash reports -- alongside the host Mac's own, which is why every
	/// report is checked for <c>is_simulated</c> before it is reported as a device crash.
	/// </summary>
	private static string CrashReportDirectory => Path.Combine(
		Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
		"Library", "Logs", "DiagnosticReports");

	private static CrashReport? TryReadReportHeader(string path)
	{
		try
		{
			using var reader = new StreamReader(path);
			return OsLogParser.ParseReportHeader(reader.ReadLine(), Path.GetFileName(path));
		}
		catch (IOException)
		{
			return null;
		}
		catch (UnauthorizedAccessException)
		{
			return null;
		}
	}

	/// <summary>
	/// Turns a bundle ID into the process name the unified log records, which is the executable's name
	/// rather than the identifier.
	/// </summary>
	private async Task<string> ResolveProcessNameAsync(
		string udid,
		string bundleId,
		CancellationToken cancellationToken)
	{
		var container = await RunAsync(["get_app_container", udid, bundleId], cancellationToken)
			.ConfigureAwait(false);

		if (container.ExitCode != 0)
			throw new DeviceCapabilityException(
				$"'{bundleId}' is not installed on '{udid}', so it has no log output to read.");

		var path = container.StandardOutput.Trim();
		var name = Path.GetFileNameWithoutExtension(path);

		return string.IsNullOrEmpty(name)
			? throw new DeviceCapabilityException($"Could not work out the process name for '{bundleId}'.")
			: name;
	}

	/// <summary>Formats a window the way <c>log show --last</c> wants it.</summary>
	private static string FormatDuration(TimeSpan span)
	{
		var seconds = (int)Math.Max(1, Math.Round(span.TotalSeconds));
		return $"{seconds}s";
	}

	#endregion

	#region Files

	/// <summary>
	/// Lists a directory in an app's data container, or under the simulator's own filesystem.
	/// </summary>
	/// <remarks>
	/// A simulator's storage is just a directory on this Mac, so these are plain file operations rather
	/// than a transfer protocol. That is the whole reason the paths are resolved and then re-checked to
	/// still be inside their root: a device path is caller input, and here it addresses the host.
	/// </remarks>
	public async Task<FileListResult> ListFilesAsync(
		string deviceId,
		FileQuery query,
		CancellationToken cancellationToken = default)
	{
		var (root, directory) = await ResolveAsync(deviceId, query.BundleId, query.Path, cancellationToken)
			.ConfigureAwait(false);

		if (!Directory.Exists(directory))
		{
			throw new DeviceCapabilityException(File.Exists(directory)
				? $"'{query.Path}' is a file, not a directory."
				: $"No directory '{query.Path}' exists on '{deviceId}'.");
		}

		var files = new List<DeviceFile>();
		foreach (var path in Directory.EnumerateFileSystemEntries(directory))
		{
			cancellationToken.ThrowIfCancellationRequested();

			var info = new System.IO.FileInfo(path);
			var isDirectory = (info.Attributes & FileAttributes.Directory) != 0;

			files.Add(new DeviceFile
			{
				Name = info.Name,
				Path = Relative(root, path),
				IsDirectory = isDirectory,
				Size = isDirectory ? 0 : info.Length,
				Modified = info.LastWriteTimeUtc.ToString("yyyy-MM-dd HH:mm:ss"),
			});
		}

		return new FileListResult
		{
			DeviceId = deviceId,
			Platform = DevicePlatforms.Ios,
			Path = Relative(root, directory),
			Total = files.Count,
			Files = [.. files.OrderByDescending(file => file.IsDirectory).ThenBy(file => file.Name, StringComparer.OrdinalIgnoreCase)],
		};
	}

	public async Task<FileTransferResult> PullFileAsync(
		string deviceId,
		FileTransferRequest request,
		CancellationToken cancellationToken = default)
	{
		var (_, source) = await ResolveAsync(deviceId, request.BundleId, request.DevicePath, cancellationToken)
			.ConfigureAwait(false);

		if (!File.Exists(source))
			throw new DeviceCapabilityException(
				$"No file '{request.DevicePath}' exists on '{deviceId}'.");

		var destination = PrepareDestination(request.HostPath, Path.GetFileName(source));
		File.Copy(source, destination, overwrite: true);

		return new FileTransferResult
		{
			DeviceId = deviceId,
			DevicePath = request.DevicePath,
			HostPath = destination,
			Size = new System.IO.FileInfo(destination).Length,
			Operation = FileOperations.Pull,
		};
	}

	public async Task<FileTransferResult> PushFileAsync(
		string deviceId,
		FileTransferRequest request,
		CancellationToken cancellationToken = default)
	{
		var (_, destination) = await ResolveAsync(deviceId, request.BundleId, request.DevicePath, cancellationToken)
			.ConfigureAwait(false);

		// A destination naming a directory takes the source's file name, the way cp does.
		if (Directory.Exists(destination))
			destination = Path.Combine(destination, Path.GetFileName(request.HostPath));

		var parent = Path.GetDirectoryName(destination);
		if (parent is not null && !Directory.Exists(parent))
			throw new DeviceCapabilityException(
				$"No directory '{Path.GetDirectoryName(request.DevicePath)}' exists on '{deviceId}' to write into.");

		File.Copy(request.HostPath, destination, overwrite: true);

		return new FileTransferResult
		{
			DeviceId = deviceId,
			DevicePath = request.DevicePath,
			HostPath = request.HostPath,
			Size = new System.IO.FileInfo(destination).Length,
			Operation = FileOperations.Push,
		};
	}

	public async Task<FileMutationResult> DeleteFileAsync(
		string deviceId,
		FileMutationRequest request,
		CancellationToken cancellationToken = default)
	{
		var (root, target) = await ResolveAsync(deviceId, request.BundleId, request.Path, cancellationToken)
			.ConfigureAwait(false);

		// Deleting the container itself would take the app's storage with it and leave the app in a
		// state no reinstall produces, so the root is off limits however the path was written.
		if (target == root)
			throw new DeviceCapabilityException(
				"Refusing to delete the storage root itself. Name something inside it.");

		if (Directory.Exists(target))
		{
			if (!request.Recursive)
				throw new DeviceCapabilityException(
					$"'{request.Path}' is a directory. Pass recursive to delete it and its contents.");

			Directory.Delete(target, recursive: true);
		}
		else if (File.Exists(target))
		{
			File.Delete(target);
		}
		else
		{
			// Reporting success for a path that was never there would hide a typo, and a caller
			// clearing a fixture wants to know it cleared the thing it meant.
			throw new DeviceCapabilityException($"No file or directory '{request.Path}' exists on '{deviceId}'.");
		}

		return new FileMutationResult
		{
			DeviceId = deviceId,
			Platform = DevicePlatforms.Ios,
			Path = request.Path,
			Operation = FileOperations.Delete,
		};
	}

	public async Task<FileMutationResult> CreateDirectoryAsync(
		string deviceId,
		FileMutationRequest request,
		CancellationToken cancellationToken = default)
	{
		var (_, target) = await ResolveAsync(deviceId, request.BundleId, request.Path, cancellationToken)
			.ConfigureAwait(false);

		if (File.Exists(target))
			throw new DeviceCapabilityException($"'{request.Path}' already exists as a file on '{deviceId}'.");

		// CreateDirectory makes the parents too and is content with a directory that already exists,
		// which is what a caller preparing somewhere to write wants either way.
		Directory.CreateDirectory(target);

		return new FileMutationResult
		{
			DeviceId = deviceId,
			Platform = DevicePlatforms.Ios,
			Path = request.Path,
			Operation = FileOperations.MakeDirectory,
		};
	}

	/// <summary>
	/// Resolves a device path to a host path, and returns the root it must stay inside.
	/// </summary>
	private async Task<(string Root, string Path)> ResolveAsync(
		string deviceId,
		string? bundleId,
		string path,
		CancellationToken cancellationToken)
	{
		// Not RequireBooted: a shut-down simulator's storage is still on disk, and reading a file the
		// app wrote before it stopped is exactly when someone asks.
		var device = await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);

		var root = string.IsNullOrWhiteSpace(bundleId)
			? SimulatorDataRoot(device.NativeId)
			: await ResolveDataContainerAsync(device.NativeId, bundleId, cancellationToken).ConfigureAwait(false);

		root = Path.GetFullPath(root);

		if (!Directory.Exists(root))
			throw new DeviceCapabilityException(
				$"'{deviceId}' has no storage at '{root}'. Boot the simulator at least once.");

		var resolved = Path.GetFullPath(Path.Combine(root, path.TrimStart('/')));

		// The path came from a caller and addresses this Mac, so "../.." has to be caught here rather
		// than trusted to a sandbox that does not exist.
		if (resolved != root && !resolved.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
			throw new DeviceCapabilityException($"'{path}' points outside the device's storage.");

		return (root, resolved);
	}

	private async Task<string> ResolveDataContainerAsync(
		string udid,
		string bundleId,
		CancellationToken cancellationToken)
	{
		var result = await RunAsync(["get_app_container", udid, bundleId, "data"], cancellationToken)
			.ConfigureAwait(false);

		var path = result.StandardOutput.Trim();

		// simctl prints "(null)" and exits zero for an app with no data container of its own, which is
		// every built-in app. Treating that as a path would produce a listing of nothing at all.
		if (result.ExitCode != 0 || path.Length == 0 || path == "(null)")
			throw new DeviceCapabilityException(
				$"'{bundleId}' has no data container on '{udid}'. Built-in apps do not have one; "
				+ "check the bundle ID with `app list`.");

		return path;
	}

	private static string SimulatorDataRoot(string udid) => Path.Combine(
		Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
		"Library", "Developer", "CoreSimulator", "Devices", udid, "data");

	/// <summary>Expresses a host path the way the caller addressed it, so it can be passed back in.</summary>
	private static string Relative(string root, string path)
	{
		var relative = Path.GetRelativePath(root, path);
		return relative == "." ? "/" : "/" + relative.Replace(Path.DirectorySeparatorChar, '/');
	}

	/// <summary>
	/// Works out where a pull should land, creating the parent directory if it is missing.
	/// </summary>
	private static string PrepareDestination(string hostPath, string fileName)
	{
		var destination = Directory.Exists(hostPath) ? Path.Combine(hostPath, fileName) : hostPath;

		var parent = Path.GetDirectoryName(destination);
		if (!string.IsNullOrEmpty(parent))
			Directory.CreateDirectory(parent);

		return destination;
	}

	#endregion

	#region Permissions and settings

	/// <summary>
	/// Maps the names that mean the same thing on both platforms onto the ones simctl accepts.
	/// </summary>
	/// <remarks>
	/// <c>camera</c> is absent from <c>simctl help privacy</c> but works, verified against a running
	/// simulator. <c>notifications</c> is refused outright, so it is not offered here.
	/// </remarks>
	private static readonly Dictionary<string, string> PrivacyServices = new(StringComparer.OrdinalIgnoreCase)
	{
		[DevicePermissions.Camera] = "camera",
		[DevicePermissions.Microphone] = "microphone",
		[DevicePermissions.Location] = "location",
		[DevicePermissions.LocationAlways] = "location-always",
		[DevicePermissions.Contacts] = "contacts",
		[DevicePermissions.Calendar] = "calendar",
		[DevicePermissions.Reminders] = "reminders",
		[DevicePermissions.Photos] = "photos",
		[DevicePermissions.PhotosAdd] = "photos-add",
		[DevicePermissions.MediaLibrary] = "media-library",
		[DevicePermissions.Motion] = "motion",
	};

	/// <summary>
	/// The TCC row each simctl service writes, so a change can be read back.
	/// </summary>
	/// <remarks>
	/// Derived by granting each service in turn against a live simulator and reading the table, not
	/// from documentation. Two findings that a guess would have missed: <c>contacts</c> and
	/// <c>contacts-limited</c> write the same row, and location writes no TCC row at all.
	/// </remarks>
	private static readonly Dictionary<string, string> TccServices = new(StringComparer.OrdinalIgnoreCase)
	{
		["camera"] = "kTCCServiceCamera",
		["microphone"] = "kTCCServiceMicrophone",
		["contacts"] = "kTCCServiceAddressBook",
		["contacts-limited"] = "kTCCServiceAddressBook",
		["calendar"] = "kTCCServiceCalendar",
		["reminders"] = "kTCCServiceReminders",
		["photos"] = "kTCCServicePhotos",
		["photos-add"] = "kTCCServicePhotosAdd",
		["media-library"] = "kTCCServiceMediaLibrary",
		["motion"] = "kTCCServiceMotion",
		["siri"] = "kTCCServiceSiri",
	};

	public async Task<PermissionListResult> ListPermissionsAsync(
		string deviceId,
		string bundleId,
		CancellationToken cancellationToken = default)
	{
		var device = await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var state = await ReadPrivacyStateAsync(device.NativeId, bundleId, cancellationToken)
			.ConfigureAwait(false);

		var permissions = new List<DevicePermission>();
		foreach (var (canonical, service) in PrivacyServices)
		{
			permissions.Add(new DevicePermission
			{
				Name = canonical,
				PlatformName = service,
				Granted = state.GetValueOrDefault(service),
			});
		}

		return new PermissionListResult
		{
			DeviceId = deviceId,
			Platform = DevicePlatforms.Ios,
			BundleId = bundleId,
			Permissions = [.. permissions.OrderBy(permission => permission.Name, StringComparer.Ordinal)],
			Total = permissions.Count,
		};
	}

	public async Task<PermissionChangeResult> ChangePermissionAsync(
		string deviceId,
		PermissionChangeRequest request,
		CancellationToken cancellationToken = default)
	{
		var device = await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);

		// simctl accepts a bundle ID it has never seen and exits zero, writing a row for an app that
		// does not exist. Checking first is what turns a typo into a message.
		await RequireInstalledAsync(device.NativeId, request.BundleId, cancellationToken)
			.ConfigureAwait(false);

		var service = PrivacyServices.TryGetValue(request.Permission, out var mapped)
			? mapped
			: request.Permission;

		string[] arguments = request.Action == PermissionActions.Reset
			? ["privacy", device.NativeId, "reset", service, request.BundleId]
			: ["privacy", device.NativeId, request.Action, service, request.BundleId];

		var result = await RunAsync(arguments, cancellationToken).ConfigureAwait(false);

		// simctl reports a refused service on stderr and still exits zero -- 'notifications' answers
		// "Operation not permitted" that way -- so the exit code alone would call it done.
		var complaint = result.StandardError.Trim();
		if (result.ExitCode != 0 || complaint.Contains("error", StringComparison.OrdinalIgnoreCase))
			throw new DeviceCapabilityException(
				$"Could not {request.Action} '{request.Permission}' for '{request.BundleId}': "
				+ (complaint.Length > 0 ? complaint.Split('\n')[^1].Trim() : $"simctl exited with code {result.ExitCode}."));

		var state = await ReadPrivacyStateAsync(device.NativeId, request.BundleId, cancellationToken)
			.ConfigureAwait(false);

		return new PermissionChangeResult
		{
			DeviceId = deviceId,
			BundleId = request.BundleId,
			Permission = request.Permission,
			Action = request.Action,
			Permissions =
			[
				new DevicePermission
				{
					Name = request.Permission,
					PlatformName = service,
					Granted = state.GetValueOrDefault(service),
				},
			],
		};
	}

	/// <summary>
	/// Reads what the simulator currently believes about one app's privacy decisions.
	/// </summary>
	/// <remarks>
	/// <c>simctl privacy</c> only writes; there is no read. The state lives in two private stores
	/// instead -- a TCC sqlite database, and locationd's plist for location alone -- and both are read
	/// here rather than leaving every answer unknown. Because the schema is Apple's and undocumented,
	/// a failed read degrades to null (unknown) rather than raising: granting still works, it just
	/// cannot be confirmed.
	/// </remarks>
	private async Task<Dictionary<string, bool?>> ReadPrivacyStateAsync(
		string udid,
		string bundleId,
		CancellationToken cancellationToken)
	{
		var state = new Dictionary<string, bool?>(StringComparer.OrdinalIgnoreCase);

		var tcc = Path.Combine(SimulatorDataRoot(udid), "Library", "TCC", "TCC.db");
		if (File.Exists(tcc))
		{
			var query = "select service, auth_value from access where client = '"
				+ bundleId.Replace("'", "''", StringComparison.Ordinal) + "';";
			var read = await _processRunner.RunAsync(
				new ProcessRequest("sqlite3", [tcc, query]),
				cancellationToken).ConfigureAwait(false);

			if (read.ExitCode == 0)
			{
				foreach (var line in read.StandardOutput.Split('\n'))
				{
					var parts = line.Trim().Split('|');
					if (parts.Length == 2 && int.TryParse(parts[1], out var authorization))
					{
						// 0 denies and 2 allows; 3 is the limited grant photos and contacts can hold,
						// which is still access.
						foreach (var (service, tccName) in TccServices)
						{
							if (tccName.Equals(parts[0], StringComparison.OrdinalIgnoreCase))
								state[service] = authorization >= 2;
						}
					}
				}
			}
		}

		var location = await ReadLocationAuthorizationAsync(udid, bundleId, cancellationToken)
			.ConfigureAwait(false);
		if (location is not null)
		{
			state["location"] = location;
			state["location-always"] = location;
		}

		return state;
	}

	/// <summary>
	/// Reads location authorization, which locationd keeps outside TCC in its own plist.
	/// </summary>
	private async Task<bool?> ReadLocationAuthorizationAsync(
		string udid,
		string bundleId,
		CancellationToken cancellationToken)
	{
		var clients = Path.Combine(SimulatorDataRoot(udid), "Library", "Caches", "locationd", "clients.plist");
		if (!File.Exists(clients))
			return null;

		// -convert json fails on this whole file: locationd stores a type JSON cannot represent, and
		// one such value anywhere makes plutil refuse the entire document. xml1 round-trips everything.
		// plutil -extract is no use either -- its key path splits on '.', which every bundle ID contains.
		var read = await _processRunner.RunAsync(
			new ProcessRequest("plutil", ["-convert", "xml1", "-o", "-", clients]),
			cancellationToken).ConfigureAwait(false);

		return read.ExitCode == 0
			? ParseLocationAuthorization(read.StandardOutput, bundleId)
			: null;
	}

	/// <summary>
	/// Finds one app's Authorization value in locationd's client list.
	/// </summary>
	internal static bool? ParseLocationAuthorization(string xml, string bundleId)
	{
		// locationd keys each client "i<bundle-id>:", but the same dict repeats the plain bundle ID
		// under BundleId, so match on that rather than on a key format Apple can change.
		var clients = xml.Split("<key>", StringSplitOptions.None);
		for (var i = 0; i < clients.Length; i++)
		{
			if (!clients[i].StartsWith($"{bundleId}:", StringComparison.Ordinal)
				&& !clients[i].StartsWith($"i{bundleId}:", StringComparison.Ordinal))
			{
				continue;
			}

			// Read forward only to the end of this client's dict: the next client's key ends the scan,
			// so an app with no Authorization of its own never borrows the next app's.
			for (var j = i; j < clients.Length; j++)
			{
				if (j > i && (clients[j].StartsWith($"i", StringComparison.Ordinal)
					&& clients[j].Contains(":</key>", StringComparison.Ordinal)))
				{
					break;
				}

				if (!clients[j].StartsWith("Authorization</key>", StringComparison.Ordinal))
					continue;

				var match = Regex.Match(clients[j], @"<integer>(-?\d+)</integer>");
				if (match.Success && int.TryParse(match.Groups[1].Value, out var value))
				{
					// 0 not determined, 2 authorized, 3 authorized always, 4 when in use.
					return value >= 2;
				}
			}
		}

		return null;
	}

	private async Task RequireInstalledAsync(string udid, string bundleId, CancellationToken cancellationToken)
	{
		var result = await RunAsync(["get_app_container", udid, bundleId, "app"], cancellationToken)
			.ConfigureAwait(false);

		if (result.ExitCode != 0 || result.StandardOutput.Trim() is "" or "(null)")
			throw new DeviceCapabilityException(
				$"'{bundleId}' is not installed on '{udid}'. Check the bundle ID with `app list`.");
	}

	public async Task<DeviceSettings> GetSettingsAsync(
		string deviceId,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);

		var appearance = await ReadUiOptionAsync(device.NativeId, "appearance", cancellationToken)
			.ConfigureAwait(false);
		var contentSize = await ReadUiOptionAsync(device.NativeId, "content_size", cancellationToken)
			.ConfigureAwait(false);
		var contrast = await ReadUiOptionAsync(device.NativeId, "increase_contrast", cancellationToken)
			.ConfigureAwait(false);

		return new DeviceSettings
		{
			DeviceId = deviceId,
			Platform = DevicePlatforms.Ios,
			Appearance = DeviceAppearances.All.Contains(appearance) ? appearance : null,
			ContentSize = contentSize,
			IncreaseContrast = contrast switch
			{
				"enabled" => true,
				"disabled" => false,
				_ => null,
			},
		};
	}

	public async Task<DeviceSettings> UpdateSettingsAsync(
		string deviceId,
		DeviceSettingsRequest request,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);

		if (request.Appearance is { } appearance)
			await SetUiOptionAsync(device.NativeId, "appearance", appearance, cancellationToken).ConfigureAwait(false);

		if (request.ContentSize is { } contentSize)
			await SetUiOptionAsync(device.NativeId, "content_size", contentSize, cancellationToken).ConfigureAwait(false);

		if (request.IncreaseContrast is { } contrast)
			await SetUiOptionAsync(
				device.NativeId,
				"increase_contrast",
				contrast ? "enabled" : "disabled",
				cancellationToken).ConfigureAwait(false);

		if (request.FontScale is not null)
			throw new DeviceCapabilityException(
				"iOS sizes text by named category rather than by scale. Use content size instead, "
				+ "for example 'large' or 'accessibility-extra-large'.");

		return await GetSettingsAsync(deviceId, cancellationToken).ConfigureAwait(false);
	}

	private async Task<string?> ReadUiOptionAsync(string udid, string option, CancellationToken cancellationToken)
	{
		var result = await RunAsync(["ui", udid, option], cancellationToken).ConfigureAwait(false);
		if (result.ExitCode != 0)
			return null;

		var value = result.StandardOutput.Trim();

		// simctl answers 'unsupported' or 'unknown' for a runtime that cannot report the option, and
		// neither is a value a caller should act on.
		return value is "" or "unsupported" or "unknown" ? null : value;
	}

	private async Task SetUiOptionAsync(
		string udid,
		string option,
		string value,
		CancellationToken cancellationToken)
	{
		var result = await RunAsync(["ui", udid, option, value], cancellationToken).ConfigureAwait(false);
		if (result.ExitCode != 0 || result.StandardError.Contains("error", StringComparison.OrdinalIgnoreCase))
			throw new DeviceCapabilityException(
				$"Could not set {option} to '{value}': "
				+ (result.StandardError.Trim() is { Length: > 0 } error
					? error.Split('\n')[^1].Trim()
					: $"simctl exited with code {result.ExitCode}."));
	}

	#endregion

	#region Hardware simulation

	public async Task<HardwareState> GetHardwareStateAsync(
		string deviceId,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		return await ReadHardwareStateAsync(device, cancellationToken).ConfigureAwait(false);
	}

	public async Task SetLocationAsync(
		string deviceId,
		DeviceLocationRequest request,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);

		// simctl formats coordinates with the invariant separator; a host in a comma-decimal locale
		// would otherwise send "37,7749" and have it read as two arguments.
		var latitude = request.Latitude.ToString(CultureInfo.InvariantCulture);
		var longitude = request.Longitude.ToString(CultureInfo.InvariantCulture);

		await RequireSimctlAsync(
			["location", device.NativeId, "set", $"{latitude},{longitude}"],
			$"set the location to {latitude},{longitude}",
			cancellationToken).ConfigureAwait(false);
	}

	public async Task ClearLocationAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		await RequireSimctlAsync(
			["location", device.NativeId, "clear"],
			"clear the simulated location",
			cancellationToken).ConfigureAwait(false);
	}

	public async Task<HardwareState> SetBatteryAsync(
		string deviceId,
		BatteryRequest request,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);

		// `status_bar override` replaces the whole battery group rather than merging into it: sending
		// only a state resets the level to 100, and only a level resets the state to discharging. So
		// whichever half was not asked for is read back and re-sent, or the caller silently loses it.
		var current = await ReadHardwareStateAsync(device, cancellationToken).ConfigureAwait(false);
		var level = request.Level ?? current.BatteryLevel;
		var state = request.State ?? current.BatteryState;

		var arguments = new List<string> { "status_bar", device.NativeId, "override" };
		if (level is { } percentage)
		{
			arguments.Add("--batteryLevel");
			arguments.Add(percentage.ToString(CultureInfo.InvariantCulture));
		}

		if (state is not null)
		{
			arguments.Add("--batteryState");
			// simctl calls a full battery 'charged'; the shared vocabulary calls it full, because
			// Android's own word for the same state is 'full'.
			arguments.Add(state switch
			{
				BatteryStates.Full => "charged",
				_ => state,
			});
		}

		await RequireSimctlAsync(arguments, "change the battery", cancellationToken).ConfigureAwait(false);
		return await ReadHardwareStateAsync(device, cancellationToken).ConfigureAwait(false);
	}

	public async Task<HardwareState> SetNetworkAsync(
		string deviceId,
		NetworkRequest request,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);

		if (request.LatencyMs is not null)
		{
			throw new DeviceCapabilityException(
				"A simulator shares the host's network stack, so latency cannot be added to it. "
				+ "Use Network Link Conditioner on the host, or an Android emulator, to test a slow "
				+ "connection.");
		}

		var profile = request.Profile
			?? throw new DeviceCapabilityException("Name a network profile to show.");

		// simctl can only change what the status bar draws. The connection underneath is the host's
		// either way, so saying this plainly matters: an app tested against '3g' here still has
		// whatever speed the host has, and code that waits on a slow network will not be exercised.
		await RequireSimctlAsync(
			["status_bar", device.NativeId, "override", "--dataNetwork", MapDataNetwork(profile)],
			$"show '{profile}' in the status bar",
			cancellationToken).ConfigureAwait(false);

		return await ReadHardwareStateAsync(device, cancellationToken).ConfigureAwait(false);
	}

	/// <summary>
	/// Translates a shared profile name into one of simctl's status bar network types.
	/// </summary>
	private static string MapDataNetwork(string profile) => profile switch
	{
		NetworkProfiles.Gsm or NetworkProfiles.Gprs or NetworkProfiles.Edge => "3g",
		NetworkProfiles.Umts or NetworkProfiles.Hsdpa => "3g",
		NetworkProfiles.Lte => "lte",
		NetworkProfiles.Full => "5g",
		_ => profile,
	};

	private async Task<HardwareState> ReadHardwareStateAsync(
		DeviceTarget device,
		CancellationToken cancellationToken)
	{
		var overrides = await RunAsync(["status_bar", device.NativeId, "list"], cancellationToken)
			.ConfigureAwait(false);

		var (level, state) = overrides.ExitCode == 0
			? ParseStatusBarBattery(overrides.StandardOutput)
			: (null, null);

		return new HardwareState
		{
			DeviceId = device.Id,
			Platform = DevicePlatforms.Ios,
			BatteryLevel = level,
			BatteryState = state,
			NetworkIsIndicatorOnly = true,
			Unreadable =
			[
				// Only overrides are listed: with none set, the status bar shows the simulator's own
				// values, which simctl will not report. Reporting those as absent would be honest;
				// reporting them as zero would not.
				"battery, unless an override is set",
				"location, which simctl can set but never read",
				"network conditions, which a simulator does not simulate",
			],
		};
	}

	/// <summary>
	/// Reads a battery override out of <c>simctl status_bar list</c>.
	/// </summary>
	internal static (int? Level, string? State) ParseStatusBarBattery(string output)
	{
		var level = Regex.Match(output, @"Battery Level:\s*(\d+)");
		var state = Regex.Match(output, @"Battery State:\s*(\d+)");

		return (
			level.Success && int.TryParse(level.Groups[1].Value, out var value) ? value : null,
			state.Success
				? state.Groups[1].Value switch
				{
					// Measured by setting each state and reading the list back: discharging is 0, not
					// the 3 that UIDevice.BatteryState uses for the same idea.
					"0" => BatteryStates.Discharging,
					"1" => BatteryStates.Charging,
					"2" => BatteryStates.Full,
					_ => null,
				}
				: null);
	}

	public Task<AppOperationListResult> ListAppOperationsAsync(
		string deviceId,
		string bundleId,
		CancellationToken cancellationToken = default) =>
		throw new DeviceCapabilityException(
			"App operations are an Android idea. iOS keeps the equivalent decisions in the privacy "
			+ "database, which `permission list` reads.");

	public Task<AppOperationChangeResult> ChangeAppOperationAsync(
		string deviceId,
		AppOperationChangeRequest request,
		CancellationToken cancellationToken = default) =>
		throw new DeviceCapabilityException(
			"App operations are an Android idea. Use `permission set` to change what an iOS app is "
			+ "allowed to do.");

	public async Task<PresentationState> GetPresentationAsync(
		string deviceId,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		return await ReadPresentationAsync(device, cancellationToken).ConfigureAwait(false);
	}

	public async Task<PresentationState> SetPresentationAsync(
		string deviceId,
		PresentationRequest request,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);

		if (request.Enabled == false)
		{
			await RequireSimctlAsync(
				["status_bar", device.NativeId, "clear"],
				"return the status bar to the simulator's own values",
				cancellationToken).ConfigureAwait(false);

			return await ReadPresentationAsync(device, cancellationToken).ConfigureAwait(false);
		}

		// Every group has to be re-sent, not just the changed one: `override` replaces a group rather
		// than merging into it, so setting only a battery state resets a level of 42 to 100. Measured,
		// not assumed. Reading first and sending the whole picture is the only way a caller keeps what
		// it did not mention.
		var current = await ReadStatusBarAsync(device, cancellationToken).ConfigureAwait(false);
		var arguments = new List<string> { "status_bar", device.NativeId, "override" };

		Apply(arguments, "--time", request.Time ?? current.Time);
		Apply(arguments, "--wifiBars", (request.WifiBars ?? current.WifiBars)?.ToString(CultureInfo.InvariantCulture));
		Apply(arguments, "--cellularBars", (request.CellularBars ?? current.CellularBars)?.ToString(CultureInfo.InvariantCulture));
		Apply(arguments, "--operatorName", request.CarrierName ?? current.CarrierName);

		var level = request.BatteryLevel ?? current.BatteryLevel;
		var state = request.BatteryCharging switch
		{
			true => "charging",
			false => "discharging",
			null => current.BatteryState,
		};

		Apply(arguments, "--batteryLevel", level?.ToString(CultureInfo.InvariantCulture));
		Apply(arguments, "--batteryState", state);

		if (arguments.Count == 3)
			throw new DeviceCapabilityException(
				"Name something to show -- a time, a battery level, signal bars or a carrier. "
				+ "Turning presentation mode on by itself has nothing to override.");

		await RequireSimctlAsync(arguments, "fix the status bar", cancellationToken).ConfigureAwait(false);

		var after = await ReadPresentationAsync(device, cancellationToken).ConfigureAwait(false);
		if (!after.Enabled)
			throw new DeviceCapabilityException(
				$"simctl accepted the overrides for '{deviceId}' and then listed none.");

		return after;

		static void Apply(List<string> arguments, string flag, string? value)
		{
			if (string.IsNullOrWhiteSpace(value))
				return;

			arguments.Add(flag);
			arguments.Add(value);
		}
	}

	private async Task<PresentationState> ReadPresentationAsync(
		DeviceTarget device,
		CancellationToken cancellationToken)
	{
		var current = await ReadStatusBarAsync(device, cancellationToken).ConfigureAwait(false);
		var overrides = new List<PresentationOverride>();

		Add("time", current.Time);
		Add("batteryLevel", current.BatteryLevel?.ToString(CultureInfo.InvariantCulture));
		Add("batteryState", current.BatteryState);
		Add("wifiBars", current.WifiBars?.ToString(CultureInfo.InvariantCulture));
		Add("cellularBars", current.CellularBars?.ToString(CultureInfo.InvariantCulture));
		Add("carrierName", current.CarrierName);

		return new PresentationState
		{
			DeviceId = device.Id,
			Platform = DevicePlatforms.Ios,
			// simctl lists only what is overridden, so anything at all means the status bar is fixed.
			Enabled = overrides.Count > 0,
			Overrides = [.. overrides],
			Readable = true,
		};

		void Add(string name, string? value)
		{
			if (!string.IsNullOrWhiteSpace(value))
				overrides.Add(new PresentationOverride { Name = name, Value = value });
		}
	}

	private async Task<StatusBarOverrides> ReadStatusBarAsync(
		DeviceTarget device,
		CancellationToken cancellationToken)
	{
		var result = await RunAsync(["status_bar", device.NativeId, "list"], cancellationToken)
			.ConfigureAwait(false);

		return result.ExitCode == 0 ? ParseStatusBar(result.StandardOutput) : new StatusBarOverrides();
	}

	/// <summary>
	/// Reads every override out of <c>simctl status_bar list</c>.
	/// </summary>
	/// <remarks>
	/// Only overrides appear, so an absent value means the simulator is showing its own -- which
	/// simctl will not report. That is why every field is nullable rather than defaulted.
	/// </remarks>
	internal static StatusBarOverrides ParseStatusBar(string output)
	{
		var (level, state) = ParseStatusBarBattery(output);

		return new StatusBarOverrides
		{
			Time = Text(@"Time:\s*(.+?)\s*$"),
			WifiBars = Number(@"WiFi Bars:\s*(\d+)"),
			CellularBars = Number(@"Cell Bars:\s*(\d+)"),
			CarrierName = Text(@"Operator Name:\s*(.+?)\s*$"),
			BatteryLevel = level,
			BatteryState = state switch
			{
				// simctl calls a full battery 'charged'; re-sending the shared vocabulary's word for it
				// would be rejected.
				BatteryStates.Full => "charged",
				_ => state,
			},
		};

		string? Text(string pattern)
		{
			var match = Regex.Match(output, pattern, RegexOptions.Multiline);
			return match.Success && match.Groups[1].Value.Trim().Length > 0
				? match.Groups[1].Value.Trim()
				: null;
		}

		int? Number(string pattern)
		{
			var match = Regex.Match(output, pattern);
			return match.Success && int.TryParse(match.Groups[1].Value, out var value) ? value : null;
		}
	}

	/// <summary>What simctl currently overrides in the status bar, with null meaning "not overridden".</summary>
	internal sealed record StatusBarOverrides
	{
		public string? Time { get; init; }
		public int? BatteryLevel { get; init; }
		public string? BatteryState { get; init; }
		public int? WifiBars { get; init; }
		public int? CellularBars { get; init; }
		public string? CarrierName { get; init; }
	}

	/// <summary>
	/// Runs simctl and raises when it fails, which it does while still exiting zero.
	/// </summary>
	private async Task RequireSimctlAsync(
		IReadOnlyList<string> arguments,
		string attempt,
		CancellationToken cancellationToken)
	{
		var result = await RunAsync(arguments, cancellationToken).ConfigureAwait(false);

		// `status_bar override --batteryLevel 500` prints its complaint to stderr and exits 0, so the
		// exit code alone would report a rejected change as one that was made.
		var error = result.StandardError.Trim();
		if (result.ExitCode == 0 && error.Length == 0)
			return;

		throw new DeviceCapabilityException(
			$"Could not {attempt}: "
			+ (error.Length > 0
				? error.Split('\n')[^1].Trim()
				: $"simctl exited with code {result.ExitCode}."));
	}

	#endregion

	#region Interrupts

	public async Task SendPushNotificationAsync(
		string deviceId,
		PushNotificationRequest request,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);

		// `simctl push` answers "Notification sent to 'com.example.nope'" and exits 0 for an app that
		// was never installed, so without this the usual typo reads back as a delivered notification
		// the app chose to ignore.
		await RequireInstalledAsync(device.NativeId, request.BundleId, cancellationToken)
			.ConfigureAwait(false);

		// Being installed is not enough: iOS drops a push for an app that has never been granted
		// notification authorization, and `simctl push` reports success anyway. Verified by pushing
		// the same payload to a registered app and an unregistered one -- a banner appeared for one
		// and nothing at all for the other, and both said "Notification sent".
		await RequireNotificationsRegisteredAsync(device.NativeId, request.BundleId, cancellationToken)
			.ConfigureAwait(false);

		// Reading the payload from stdin keeps it out of a temp file, which matters because a payload
		// is often a fixture someone is iterating on.
		var result = await _processRunner.RunAsync(
			new ProcessRequest(
				"xcrun",
				["simctl", "push", device.NativeId, request.BundleId, "-"],
				StandardInput: request.Payload),
			cancellationToken).ConfigureAwait(false);

		if (result.ExitCode != 0 || result.StandardError.Trim().Length > 0)
		{
			throw new DeviceCapabilityException(
				$"Could not push to '{request.BundleId}': "
				+ (result.StandardError.Trim() is { Length: > 0 } error
					? error.Split('\n').Last(line => line.Trim().Length > 0).Trim()
					: $"simctl exited with code {result.ExitCode}."));
		}
	}

	/// <summary>
	/// Fails when an app has never been granted notification authorization, because iOS silently
	/// drops a push to such an app while <c>simctl push</c> still reports it sent.
	/// </summary>
	/// <remarks>
	/// BulletinBoard keeps a section per app that has registered for notifications, so an app absent
	/// from that list cannot receive one. There is no way to grant the authorization from outside --
	/// <c>simctl privacy grant notifications</c> answers "Operation not permitted" -- so the only fix
	/// is to launch the app and let it ask, which is what the message says.
	/// </remarks>
	private async Task RequireNotificationsRegisteredAsync(
		string udid,
		string bundleId,
		CancellationToken cancellationToken)
	{
		var sections = Path.Combine(
			SimulatorDataRoot(udid), "Library", "BulletinBoard", "VersionedSectionInfo.plist");

		// A simulator that has never shown a notification has no file at all. Treat that as unknown
		// rather than as "not registered": refusing to push on a missing file would turn a check that
		// prevents a silent failure into one that causes a loud one.
		if (!File.Exists(sections))
			return;

		var read = await _processRunner.RunAsync(
			new ProcessRequest("plutil", ["-convert", "xml1", "-o", "-", sections]),
			cancellationToken).ConfigureAwait(false);

		if (read.ExitCode != 0)
			return;

		// Bundle ids are dictionary keys in the converted plist, so match the whole element. A plain
		// substring test would let "com.foo" match a section belonging to "com.foo.beta" and wave
		// through a push that iOS then drops.
		if (read.StandardOutput.Contains($"<key>{bundleId}</key>", StringComparison.Ordinal))
			return;

		throw new DeviceCapabilityException(
			$"'{bundleId}' has never asked for notification permission, so iOS will drop this push "
			+ "without showing anything -- simctl reports success either way. Launch the app and let "
			+ "it request notification authorization first. This cannot be granted from outside: "
			+ "`simctl privacy grant notifications` answers 'Operation not permitted'.");
	}

	public Task SendSmsAsync(
		string deviceId,
		SmsRequest request,
		CancellationToken cancellationToken = default) =>
		throw new DeviceCapabilityException(
			"The iOS simulator has no way to deliver a text message. Messages arriving over the "
			+ "network are an Android emulator capability only.");

	public Task<CallStateResult> GetCallsAsync(
		string deviceId,
		CancellationToken cancellationToken = default) =>
		throw new DeviceCapabilityException(
			"The iOS simulator has no telephony stack, so it has no calls to report.");

	public Task<CallStateResult> ChangeCallAsync(
		string deviceId,
		CallRequest request,
		CancellationToken cancellationToken = default) =>
		throw new DeviceCapabilityException(
			"The iOS simulator has no telephony stack, so it cannot ring. Simulated calls are an "
			+ "Android emulator capability only.");

	public async Task<BiometricResult> SendBiometricAsync(
		string deviceId,
		BiometricRequest request,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var action = NormalizeBiometricAction(request.Action);
		var suffix = action == BiometricActions.Match ? "match" : "nomatch";

		// Which sensor a simulator has depends on the device it models, and posting to the one it
		// does not have is a no-op -- so posting both is more durable than a device-name heuristic
		// that would need revisiting every time Apple ships new hardware.
		foreach (var sensor in new[] { "pearl", "fingerTouch" })
		{
			await _processRunner.RunAsync(
				new ProcessRequest(
					"xcrun",
					["simctl", "spawn", device.NativeId, "notifyutil", "-p",
						$"com.apple.BiometricKit_Sim.{sensor}.{suffix}"]),
				cancellationToken).ConfigureAwait(false);
		}

		// notifyutil exits 0 for a key nobody is listening on -- and for a key that does not exist at
		// all -- so there is nothing here to check the scan against.
		return new BiometricResult
		{
			DeviceId = device.Id,
			Platform = DevicePlatforms.Ios,
			Action = action,
			Confirmed = false,
		};
	}

	public async Task<ClipboardResult> GetClipboardAsync(
		string deviceId,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var result = await RunAsync(["pbpaste", device.NativeId], cancellationToken)
			.ConfigureAwait(false);

		if (result.ExitCode != 0)
		{
			throw new DeviceCapabilityException(
				$"Could not read the pasteboard: {result.StandardError.Trim()}");
		}

		return new ClipboardResult
		{
			DeviceId = device.Id,
			Platform = DevicePlatforms.Ios,
			Text = result.StandardOutput,
		};
	}

	public async Task<ClipboardResult> SetClipboardAsync(
		string deviceId,
		string text,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);

		var result = await _processRunner.RunAsync(
			new ProcessRequest("xcrun", ["simctl", "pbcopy", device.NativeId], StandardInput: text),
			cancellationToken).ConfigureAwait(false);

		if (result.ExitCode != 0)
		{
			throw new DeviceCapabilityException(
				$"Could not write the pasteboard: {result.StandardError.Trim()}");
		}

		return await GetClipboardAsync(deviceId, cancellationToken).ConfigureAwait(false);
	}

	public async Task<MediaResult> AddMediaAsync(
		string deviceId,
		MediaRequest request,
		CancellationToken cancellationToken = default)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var paths = RequireMediaPaths(request);

		// `simctl addmedia` does not report a missing file -- it dies on an uncaught exception, which
		// surfaces as a signal rather than an error anyone can read.
		await RunMediaAsync(device, paths, cancellationToken).ConfigureAwait(false);

		return new MediaResult
		{
			DeviceId = device.Id,
			Platform = DevicePlatforms.Ios,
			Added = paths,
		};
	}

	private async Task RunMediaAsync(
		DeviceTarget device,
		IReadOnlyList<string> paths,
		CancellationToken cancellationToken)
	{
		var result = await RunAsync(["addmedia", device.NativeId, .. paths], cancellationToken)
			.ConfigureAwait(false);

		if (result.ExitCode == 0)
			return;

		// The per-file complaint ("File type unsupported") is on stdout; stderr only says that
		// several errors happened and to look elsewhere.
		var detail = result.StandardOutput
			.Split('\n')
			.Select(line => line.Trim())
			.FirstOrDefault(line => line.StartsWith("Failed to import", StringComparison.Ordinal));

		throw new DeviceCapabilityException(
			$"Could not add media: {detail ?? result.StandardError.Trim()}");
	}

	internal static string NormalizeBiometricAction(string action)
	{
		var normalized = action.Trim().ToLowerInvariant();
		if (!BiometricActions.All.Contains(normalized))
		{
			throw new DeviceCapabilityException(
				$"Unknown biometric action '{action}'. Use one of: {string.Join(", ", BiometricActions.All)}.");
		}

		return normalized;
	}

	internal static IReadOnlyList<string> RequireMediaPaths(MediaRequest request)
	{
		if (request.HostPaths.Count == 0)
			throw new DeviceCapabilityException("No media files were given.");

		var resolved = new List<string>(request.HostPaths.Count);
		foreach (var path in request.HostPaths)
		{
			var full = Path.GetFullPath(path);
			if (!File.Exists(full))
				throw new DeviceCapabilityException($"'{path}' does not exist on this machine.");

			resolved.Add(full);
		}

		return resolved;
	}

	#endregion

	public async ValueTask DisposeAsync()
	{
		await _recordings.DisposeAsync().ConfigureAwait(false);
		await _hid.DisposeAsync().ConfigureAwait(false);
		await _companions.DisposeAsync().ConfigureAwait(false);
		_activeTouches.Clear();
		_inputGates.Clear();
	}

	private async Task<ActiveHidRoute> SendInputAsync(
		string deviceId,
		IReadOnlyList<IosHidEvent> events,
		CancellationToken cancellationToken)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		return await SendInputAsync(device, events, cancellationToken).ConfigureAwait(false);
	}

	private async Task<ActiveHidRoute> SendInputAsync(
		DeviceTarget device,
		IReadOnlyList<IosHidEvent> events,
		CancellationToken cancellationToken)
	{
		var gate = _inputGates.GetOrAdd(device.NativeId, static _ => new SemaphoreSlim(1, 1));
		await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			ThrowIfInputSessionsAreBeingRemoved(device.NativeId);
			return await SendInputCoreAsync(device, events, cancellationToken).ConfigureAwait(false);
		}
		finally
		{
			gate.Release();
		}
	}

	private Task<ActiveHidRoute> SendInputCoreAsync(
		DeviceTarget device,
		IReadOnlyList<IosHidEvent> events,
		CancellationToken cancellationToken) =>
		IosHidFallback.SendAsync(
			async () =>
			{
				var session = await _hid.GetAsync(device.NativeId, cancellationToken)
					.ConfigureAwait(false);
				await session.SendAsync(events, cancellationToken).ConfigureAwait(false);
				return new ActiveHidRoute(
					"bundled CoreSimulator HID",
					session.SendAsync);
			},
			async () =>
			{
				var session = await _companions.GetForHidAsync(device.NativeId, cancellationToken)
					.ConfigureAwait(false);
				await session.SendIosHidAsync(events, cancellationToken).ConfigureAwait(false);
				return new ActiveHidRoute(
					"optional idb",
					session.SendIosHidAsync);
			});

	private async Task RemoveInputSessionsAsync(string nativeId)
	{
		await _inputRemovalGate.WaitAsync().ConfigureAwait(false);
		try
		{
			_removingInputSessions[nativeId] = true;
			var gate = _inputGates.GetOrAdd(nativeId, static _ => new SemaphoreSlim(1, 1));
			// Dispose first so an input call waiting for a helper/idb acknowledgement is forced to
			// complete and release the gate. Removing once more while holding the gate catches a
			// session whose startup raced the first removal.
			await Task.WhenAll(
				_hid.RemoveAsync(nativeId),
				_companions.RemoveAsync(nativeId)).ConfigureAwait(false);
			await gate.WaitAsync().ConfigureAwait(false);
			try
			{
				_activeTouches.TryRemove(nativeId, out _);
				await Task.WhenAll(
					_hid.RemoveAsync(nativeId),
					_companions.RemoveAsync(nativeId)).ConfigureAwait(false);
			}
			finally
			{
				gate.Release();
			}
		}
		finally
		{
			_removingInputSessions.TryRemove(nativeId, out _);
			_inputRemovalGate.Release();
		}
	}

	private void ThrowIfInputSessionsAreBeingRemoved(string nativeId)
	{
		if (_removingInputSessions.ContainsKey(nativeId))
		{
			throw new DeviceCapabilityException(
				$"Input sessions for simulator '{nativeId}' are being reset for a lifecycle operation.");
		}
	}

	private async Task<IdbCompanionSession> GetCompanionAsync(
		string deviceId,
		CancellationToken cancellationToken)
	{
		var device = await RequireBootedAsync(deviceId, cancellationToken).ConfigureAwait(false);
		return await _companions.GetAsync(device.NativeId, cancellationToken).ConfigureAwait(false);
	}

	private sealed record ActiveHidRoute(
		string Name,
		Func<IReadOnlyList<IosHidEvent>, CancellationToken, Task> SendAsync);

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
		string? xcodePath = null;
		string? xcodeFailure = null;
		try
		{
			xcodePath = await XcodeDeveloperDirectory.ResolveSelectedAsync(
				_processRunner,
				cancellationToken).ConfigureAwait(false);
		}
		catch (OperationCanceledException)
		{
			throw;
		}
		catch (Exception exception) when (
			exception is ProcessExecutionException
				or InvalidOperationException
				or ArgumentException)
		{
			xcodeFailure = exception.Message;
		}
		var xcodeReady = !string.IsNullOrWhiteSpace(xcodePath);
		var companion = IdbCompanionLocator.Find();
		checks.Add(new DependencyCheck
		{
			Name = "Xcode",
			Status = xcodeReady ? "ok" : "error",
			Message = xcodeReady
				? "Full Xcode developer directory is selected."
				: string.IsNullOrWhiteSpace(xcodeFailure)
					? "xcode-select did not return a developer directory."
					: xcodeFailure,
			Path = xcodePath,
		});

		var hid = await CoreSimulatorHidDoctor.ProbeAsync(
			_processRunner,
			xcodePath,
			cancellationToken).ConfigureAwait(false);
		var nativeHidReady = hid.Negotiable;
		checks.Add(BuildHidCheck(hid, companion));

		SimulatorKitInstallation? simulatorKit = null;
		if (xcodeReady)
			SimulatorKitLocator.TryResolve(xcodePath!, out simulatorKit);
		var simulatorKitRequired = string.Equals(
			hid.TransportPolicy,
			"indigo",
			StringComparison.OrdinalIgnoreCase);
		checks.Add(new DependencyCheck
		{
			Name = "SimulatorKit",
			Status = simulatorKit is not null
				? "ok"
				: simulatorKitRequired && companion is null
					? "error"
					: "warning",
			Message = simulatorKit is null
				? xcodeReady
					? SimulatorKitLocator.GetMissingFrameworkMessage(xcodePath!)
					: "Select a full Xcode installation before checking SimulatorKit.framework."
				: simulatorKit.Layout == SimulatorKitLayout.SharedFrameworks
					? "Xcode 27 shared-framework layout is available for HID interactions."
					: "Legacy Xcode private-framework layout is available for HID interactions.",
			Path = simulatorKit?.FrameworkPath,
		});

		// Report the permission-free primary source separately from the TCC-gated fallback. Missing
		// fallback grants only require attention when direct capture is unavailable.
		var screencap = await ScreenCaptureHelper.GetDiagnosticsAsync(cancellationToken)
			.ConfigureAwait(false);
		var screencapPath = ScreenCaptureHelper.Path;
		var framebufferReady = screencapPath is not null && screencap.FramebufferAvailable;
		checks.Add(new DependencyCheck
		{
			Name = "Simulator framebuffer",
			Status = framebufferReady ? "ok" : "warning",
			Message = screencapPath is null
				? "mobile-screencap was not found next to mobile-canvas; bundled video sources are unavailable."
				: framebufferReady
					? "Direct CoreSimulator IOSurface capture is available without TCC permissions."
					: string.IsNullOrWhiteSpace(screencap.FramebufferDetail)
						? "Direct CoreSimulator IOSurface capture is unavailable; using a fallback."
						: screencap.FramebufferDetail,
			Path = screencapPath,
		});
		checks.Add(BuildScreencapCheck(
			screencapPath,
			screencap,
			framebufferReady,
			companion is not null));

		return new HostDiagnostics
		{
			Platform = DevicePlatforms.Ios,
			Ready = xcodeReady && (nativeHidReady || companion is not null),
			Checks = checks.ToArray(),
		};
	}

	internal static DependencyCheck BuildHidCheck(
		CoreSimulatorHidDoctorResult hid,
		string? companion) =>
		new()
		{
			Name = "Bundled CoreSimulator HID",
			Status = hid.Negotiable ? "ok" : companion is null ? "error" : "warning",
			Message = hid.Negotiable
				? $"{hid.Detail} This is a static negotiability probe; a booted-device session "
					+ "becomes authoritative when it reports ready."
				: companion is null
					? $"{hid.Detail} The optional IDB input fallback is unavailable. "
						+ IdbCompanionLocator.InstallationGuidance
					: $"{hid.Detail} Input will use the optional IDB fallback.",
			Path = NativeHelperLocator.Path,
		};

	internal static DependencyCheck BuildScreencapCheck(
		string? path,
		ScreencapDiagnostics diagnostics,
		bool framebufferReady,
		bool idbAvailable)
	{
		var screenCaptureReady = path is not null
			&& diagnostics.ScreenRecordingGranted
			&& diagnostics.AccessibilityGranted;
		var fallbackNeeded = !framebufferReady && !screenCaptureReady;
		return new DependencyCheck
		{
			Name = "ScreenCaptureKit fallback",
			Status = fallbackNeeded
				? idbAvailable ? "warning" : "error"
				: "ok",
			Message = path is null
				? idbAvailable
					? "The native helper is unavailable; live video will use the optional IDB fallback."
					: "The native helper and optional IDB video fallback are unavailable. "
						+ IdbCompanionLocator.InstallationGuidance
				: screenCaptureReady
					? "ScreenCaptureKit and exact Accessibility geometry are available as a fallback."
					: framebufferReady
						? "Direct framebuffer capture is available without TCC permissions; "
							+ "ScreenCaptureKit fallback grants are optional."
						: BuildScreencapMessage(diagnostics, framebufferReady, idbAvailable),
			Path = path,
			Actions = path is not null && fallbackNeeded
				? BuildScreencapActions(diagnostics)
				: [],
		};
	}

	private static string BuildScreencapMessage(
		ScreencapDiagnostics diagnostics,
		bool framebufferReady,
		bool idbAvailable)
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
			+ (framebufferReady
				? "the ScreenCaptureKit fallback; direct framebuffer capture remains available."
				: idbAvailable
					? "ScreenCaptureKit video; until then live video uses the optional IDB fallback."
					: "ScreenCaptureKit video. The optional IDB fallback is also unavailable. "
						+ IdbCompanionLocator.InstallationGuidance);
	}

	internal static DiagnosticAction[] BuildScreencapActions(ScreencapDiagnostics diagnostics)
	{
		var actions = new List<DiagnosticAction>(2);
		if (!diagnostics.ScreenRecordingGranted)
		{
			actions.Add(new DiagnosticAction
			{
				Type = DiagnosticActionTypes.OpenSystemSettings,
				Target = SystemSettingsTargets.ScreenRecording,
				Label = "Open Screen Recording",
			});
		}

		if (!diagnostics.AccessibilityGranted)
		{
			actions.Add(new DiagnosticAction
			{
				Type = DiagnosticActionTypes.OpenSystemSettings,
				Target = SystemSettingsTargets.Accessibility,
				Label = "Open Accessibility",
			});
		}

		return [.. actions];
	}

	private static void EnsureSuccess(
		string fileName,
		IReadOnlyList<string> arguments,
		ProcessResult result)
	{
		if (result.ExitCode != 0)
			throw new ProcessExecutionException(fileName, arguments, result);
	}

}
