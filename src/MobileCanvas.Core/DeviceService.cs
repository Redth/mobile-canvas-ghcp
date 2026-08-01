using System.Collections.Concurrent;
using MobileCanvas.Contracts;

namespace MobileCanvas.Core;

public sealed class DeviceService(IEnumerable<IDeviceBackend> backends)
{
	private readonly IReadOnlyDictionary<string, IDeviceBackend> _backends = backends.ToDictionary(
		backend => backend.Platform,
		StringComparer.OrdinalIgnoreCase);
	private readonly ConcurrentDictionary<string, string> _selections = new(StringComparer.Ordinal);

	public async Task<DeviceCatalog> GetCatalogAsync(CancellationToken cancellationToken = default)
	{
		var catalogs = await Task.WhenAll(_backends.Values.Select(
			backend => backend.GetCatalogAsync(cancellationToken))).ConfigureAwait(false);

		return new DeviceCatalog
		{
			Devices = catalogs.SelectMany(catalog => catalog.Devices)
				.OrderByDescending(device => device.State == DeviceStates.Booted)
				.ThenBy(device => device.Name, StringComparer.OrdinalIgnoreCase)
				.ToArray(),
			Runtimes = catalogs.SelectMany(catalog => catalog.Runtimes).ToArray(),
			DeviceTypes = catalogs.SelectMany(catalog => catalog.DeviceTypes).ToArray(),
			Diagnostics = catalogs.SelectMany(catalog => catalog.Diagnostics).ToArray(),
		};
	}

	public async Task<DeviceTarget[]> ListDevicesAsync(CancellationToken cancellationToken = default)
	{
		var results = await Task.WhenAll(_backends.Values.Select(
			backend => backend.ListDevicesAsync(cancellationToken))).ConfigureAwait(false);

		return results.SelectMany(devices => devices)
			.OrderByDescending(device => device.State == DeviceStates.Booted)
			.ThenBy(device => device.Name, StringComparer.OrdinalIgnoreCase)
			.ToArray();
	}

	public Task<DeviceTarget> GetDeviceAsync(string deviceId, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).GetDeviceAsync(deviceId, cancellationToken);

	public Task<DisplayGeometry> GetDisplayAsync(string deviceId, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).GetDisplayAsync(deviceId, cancellationToken);

	public Task<DeviceTarget> CreateAsync(CreateDeviceRequest request, CancellationToken cancellationToken = default) =>
		GetBackendForPlatform(request.Platform).CreateAsync(request, cancellationToken);

	public async Task<DeviceTarget> SelectAsync(
		string sessionId,
		string instanceId,
		string deviceId,
		CancellationToken cancellationToken = default)
	{
		var device = await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
		_selections[SelectionKey(sessionId, instanceId)] = device.Id;
		return device;
	}

	public Task<DeviceTarget> SelectAsync(
		CanvasContextKey key,
		string deviceId,
		CancellationToken cancellationToken = default) =>
		SelectAsync(key.SessionId, key.InstanceId, deviceId, cancellationToken);

	/// <summary>
	/// The selected device ID, without asking a backend to describe it. Input runs on every tap, so it
	/// needs a way to notice the canvas is pointed elsewhere that costs nothing when it is not.
	/// </summary>
	public string? GetSelectedId(CanvasContextKey key) =>
		_selections.TryGetValue(SelectionKey(key.SessionId, key.InstanceId), out var deviceId)
			? deviceId
			: null;

	public async Task<DeviceSelection> GetSelectionAsync(
		string sessionId,
		string instanceId,
		CancellationToken cancellationToken = default)
	{
		if (!_selections.TryGetValue(SelectionKey(sessionId, instanceId), out var deviceId))
			return DeviceSelection.None;

		try
		{
			return DeviceSelection.For(
				await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false));
		}
		catch (DeviceNotFoundException)
		{
			_selections.TryRemove(SelectionKey(sessionId, instanceId), out _);
			return DeviceSelection.None;
		}
	}

	public Task<DeviceSelection> GetSelectionAsync(
		CanvasContextKey key,
		CancellationToken cancellationToken = default) =>
		GetSelectionAsync(key.SessionId, key.InstanceId, cancellationToken);

	public async Task<DeviceTarget?> GetSelectedAsync(
		string sessionId,
		string instanceId,
		CancellationToken cancellationToken = default) =>
		(await GetSelectionAsync(sessionId, instanceId, cancellationToken).ConfigureAwait(false)).Device;

	public Task<DeviceTarget?> GetSelectedAsync(
		CanvasContextKey key,
		CancellationToken cancellationToken = default) =>
		GetSelectedAsync(key.SessionId, key.InstanceId, cancellationToken);

	public void Detach(string sessionId, string instanceId) =>
		_selections.TryRemove(SelectionKey(sessionId, instanceId), out _);

	public void Detach(CanvasContextKey key) => Detach(key.SessionId, key.InstanceId);

	public Task<DeviceTarget> BootAsync(string deviceId, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).BootAsync(deviceId, cancellationToken);

	public Task<DeviceTarget> ShutdownAsync(string deviceId, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).ShutdownAsync(deviceId, cancellationToken);

	public Task<DeviceTarget> RestartAsync(string deviceId, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).RestartAsync(deviceId, cancellationToken);

	public Task<DeviceTarget> RevealAsync(string deviceId, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).RevealAsync(deviceId, cancellationToken);

	public Task<DeviceTarget> EraseAsync(
		string deviceId,
		bool confirm,
		CancellationToken cancellationToken = default)
	{
		RequireConfirmation("erase", confirm);
		return GetBackend(deviceId).EraseAsync(deviceId, cancellationToken);
	}

	public async Task DeleteAsync(
		string deviceId,
		bool confirm,
		CancellationToken cancellationToken = default)
	{
		RequireConfirmation("delete", confirm);
		await GetBackend(deviceId).DeleteAsync(deviceId, cancellationToken).ConfigureAwait(false);

		foreach (var selection in _selections.Where(selection => selection.Value == deviceId).ToArray())
			_selections.TryRemove(selection.Key, out _);
	}

	public Task TapAsync(string deviceId, TapRequest request, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).TapAsync(deviceId, request, cancellationToken);

	public Task TouchAsync(string deviceId, TouchRequest request, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).TouchAsync(deviceId, request, cancellationToken);

	public Task SwipeAsync(string deviceId, SwipeRequest request, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).SwipeAsync(deviceId, request, cancellationToken);

	public Task TypeTextAsync(string deviceId, string text, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).TypeTextAsync(deviceId, text, cancellationToken);

	public Task PressKeyAsync(string deviceId, ulong keyCode, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).PressKeyAsync(deviceId, keyCode, cancellationToken);

	public Task PressButtonAsync(string deviceId, string button, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).PressButtonAsync(deviceId, button, cancellationToken);

	public Task RotateAsync(string deviceId, string orientation, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).RotateAsync(deviceId, orientation, cancellationToken);

	public Task<byte[]> ScreenshotAsync(string deviceId, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).ScreenshotAsync(deviceId, cancellationToken);

	public Task<ILiveVideoSession> OpenVideoStreamAsync(
		string deviceId,
		StreamOptions options,
		CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).OpenVideoStreamAsync(deviceId, options, cancellationToken);

	public Task<RecordingStatus> StartRecordingAsync(
		string deviceId,
		RecordingStartRequest request,
		CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).StartRecordingAsync(deviceId, request, cancellationToken);

	public Task<RecordingStatus> StopRecordingAsync(string deviceId, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).StopRecordingAsync(deviceId, cancellationToken);

	public Task<RecordingStatus> GetRecordingStatusAsync(string deviceId, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).GetRecordingStatusAsync(deviceId, cancellationToken);

	public Task<UiSnapshot> GetUiSnapshotAsync(
		string deviceId,
		bool includeRaw = false,
		CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).GetUiSnapshotAsync(deviceId, includeRaw, cancellationToken);

	public async Task<UiQueryResult> FindUiElementsAsync(
		string deviceId,
		UiQuery query,
		CancellationToken cancellationToken = default)
	{
		var snapshot = await GetUiSnapshotAsync(deviceId, false, cancellationToken).ConfigureAwait(false);
		var matches = UiTree.Find(snapshot.Root, query);

		return new UiQueryResult
		{
			DeviceId = deviceId,
			Total = matches.Count,
			Matches = [.. matches.Take(Math.Max(1, query.Limit))],
		};
	}

	/// <summary>
	/// Taps the first element a query matches.
	/// </summary>
	/// <remarks>
	/// Capture and tap are joined here rather than left to the caller because the screen can change
	/// between the two, and because it turns the common "press the button called X" into one call.
	/// The number of matches comes back so an over-broad query is visible rather than silently
	/// resolving to whichever element happened to be first.
	/// </remarks>
	public async Task<UiTapResult> TapUiElementAsync(
		string deviceId,
		UiQuery query,
		CancellationToken cancellationToken = default)
	{
		var found = await FindUiElementsAsync(deviceId, query, cancellationToken).ConfigureAwait(false);
		if (found.Matches.Length == 0)
			throw new UiElementNotFoundException(Describe(query));

		var match = found.Matches[0];
		if (match.Element.Frame is null)
			throw new DeviceCapabilityException(
				$"The element matching {Describe(query)} reported no on-screen position, so it cannot be tapped.");

		await TapAsync(
			deviceId,
			new TapRequest { X = match.CenterX, Y = match.CenterY },
			cancellationToken).ConfigureAwait(false);

		return new UiTapResult { DeviceId = deviceId, Match = match, Total = found.Total };
	}

	/// <summary>
	/// Lists installed apps, applying the text and limit filters here so both platforms search the
	/// same way and a backend only has to answer "what is installed".
	/// </summary>
	public async Task<AppListResult> ListAppsAsync(
		string deviceId,
		AppQuery query,
		CancellationToken cancellationToken = default)
	{
		var apps = await GetBackend(deviceId)
			.ListAppsAsync(deviceId, query.IncludeSystem, cancellationToken)
			.ConfigureAwait(false);

		var matched = apps.Where(app => Matches(app, query.Text))
			.OrderBy(app => app.Kind == AppKinds.System)
			.ThenBy(app => app.Name ?? app.BundleId, StringComparer.OrdinalIgnoreCase)
			.ToArray();

		return new AppListResult
		{
			DeviceId = deviceId,
			Platform = DeviceIdentity.GetPlatform(deviceId),
			Total = matched.Length,
			Apps = [.. matched.Take(Math.Max(1, query.Limit))],
		};
	}

	public Task<AppOperationResult> LaunchAppAsync(
		string deviceId,
		AppLaunchRequest request,
		CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).LaunchAppAsync(
			deviceId,
			request with { BundleId = RequireBundleId(request.BundleId) },
			cancellationToken);

	public Task<AppOperationResult> TerminateAppAsync(
		string deviceId,
		string bundleId,
		CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).TerminateAppAsync(deviceId, RequireBundleId(bundleId), cancellationToken);

	public Task<AppOperationResult> InstallAppAsync(
		string deviceId,
		AppInstallRequest request,
		CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrWhiteSpace(request.Path))
			throw new ArgumentException("An app path is required to install.", nameof(request));

		// Checked here rather than left to the platform tool, whose own message for a missing file is
		// buried in installer output and does not name the path the caller actually passed.
		var path = System.IO.Path.GetFullPath(request.Path);
		if (!File.Exists(path) && !Directory.Exists(path))
			throw new FileNotFoundException($"No app bundle or package exists at '{path}'.", path);

		return GetBackend(deviceId).InstallAppAsync(deviceId, request with { Path = path }, cancellationToken);
	}

	public Task<AppOperationResult> UninstallAppAsync(
		string deviceId,
		string bundleId,
		bool confirm,
		CancellationToken cancellationToken = default)
	{
		RequireConfirmation("uninstall", confirm);
		return GetBackend(deviceId).UninstallAppAsync(deviceId, RequireBundleId(bundleId), cancellationToken);
	}

	private static bool Matches(InstalledApp app, string? text)
	{
		if (string.IsNullOrWhiteSpace(text))
			return true;

		return app.BundleId.Contains(text, StringComparison.OrdinalIgnoreCase)
			|| (app.Name?.Contains(text, StringComparison.OrdinalIgnoreCase) ?? false);
	}

	/// <summary>
	/// Reads the device log. Text matching and the limit are applied here, so both platforms narrow the
	/// same way even though each filters differently at the source.
	/// </summary>
	public async Task<LogResult> ReadLogAsync(
		string deviceId,
		LogQuery query,
		CancellationToken cancellationToken = default)
	{
		if (query.MinimumLevel is { Length: > 0 } level && LogLevels.Rank(level) < 0)
			throw new ArgumentException(
				$"'{level}' is not a log level. Use one of: {string.Join(", ", LogLevels.Ordered)}.",
				nameof(query));

		var entries = await GetBackend(deviceId)
			.ReadLogAsync(deviceId, query, cancellationToken)
			.ConfigureAwait(false);

		var matched = string.IsNullOrWhiteSpace(query.Text)
			? entries
			: [.. entries.Where(entry => entry.Message.Contains(query.Text, StringComparison.OrdinalIgnoreCase))];

		// The newest lines are the ones worth keeping, so an over-long log is trimmed from the front.
		var limit = Math.Max(1, query.Limit);

		return new LogResult
		{
			DeviceId = deviceId,
			Platform = DeviceIdentity.GetPlatform(deviceId),
			Total = matched.Length,
			Entries = matched.Length <= limit ? matched : [.. matched.Skip(matched.Length - limit)],
		};
	}

	/// <summary>
	/// Lists crash reports, newest first.
	/// </summary>
	public async Task<CrashListResult> ListCrashesAsync(
		string deviceId,
		CrashQuery query,
		CancellationToken cancellationToken = default)
	{
		var crashes = await GetBackend(deviceId)
			.ListCrashesAsync(deviceId, cancellationToken)
			.ConfigureAwait(false);

		var matched = crashes.Where(crash => Matches(crash, query.Text)).ToArray();

		return new CrashListResult
		{
			DeviceId = deviceId,
			Platform = DeviceIdentity.GetPlatform(deviceId),
			Total = matched.Length,
			Crashes = [.. matched.Take(Math.Max(1, query.Limit))],
		};
	}

	public Task<CrashDetailResult> GetCrashAsync(
		string deviceId,
		string crashId,
		CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrWhiteSpace(crashId))
			throw new ArgumentException("A crash ID is required.", nameof(crashId));

		return GetBackend(deviceId).GetCrashAsync(deviceId, crashId.Trim(), cancellationToken);
	}

	private static bool Matches(CrashReport crash, string? text)
	{
		if (string.IsNullOrWhiteSpace(text))
			return true;

		return crash.Name.Contains(text, StringComparison.OrdinalIgnoreCase)
			|| (crash.BundleId?.Contains(text, StringComparison.OrdinalIgnoreCase) ?? false);
	}

	/// <summary>
	/// Lists a directory on the device, or inside one app's data container.
	/// </summary>
	public Task<FileListResult> ListFilesAsync(
		string deviceId,
		FileQuery query,
		CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).ListFilesAsync(deviceId, query, cancellationToken);

	/// <summary>
	/// Copies a file off the device. The destination is resolved here so the path in the result is the
	/// one a caller can hand to another tool.
	/// </summary>
	public Task<FileTransferResult> PullFileAsync(
		string deviceId,
		FileTransferRequest request,
		CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrWhiteSpace(request.DevicePath))
			throw new ArgumentException("A device path is required.", nameof(request));
		if (string.IsNullOrWhiteSpace(request.HostPath))
			throw new ArgumentException("A host path to write to is required.", nameof(request));

		return GetBackend(deviceId).PullFileAsync(
			deviceId,
			request with { HostPath = Path.GetFullPath(request.HostPath) },
			cancellationToken);
	}

	/// <summary>
	/// Copies a file onto the device.
	/// </summary>
	public Task<FileTransferResult> PushFileAsync(
		string deviceId,
		FileTransferRequest request,
		CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrWhiteSpace(request.DevicePath))
			throw new ArgumentException("A device path is required.", nameof(request));
		if (string.IsNullOrWhiteSpace(request.HostPath))
			throw new ArgumentException("A host path to push is required.", nameof(request));

		// Resolved against the host's working directory, which by the time a platform tool sees it is
		// not the directory the caller was in.
		var source = Path.GetFullPath(request.HostPath);
		if (!File.Exists(source))
			throw new FileNotFoundException($"No file exists at '{source}'.", source);

		return GetBackend(deviceId).PushFileAsync(
			deviceId,
			request with { HostPath = source },
			cancellationToken);
	}

	/// <summary>
	/// Removes a file, or a directory when the request allows it.
	/// </summary>
	public Task<FileMutationResult> DeleteFileAsync(
		string deviceId,
		FileMutationRequest request,
		CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrWhiteSpace(request.Path))
			throw new ArgumentException("A device path is required.", nameof(request));

		return GetBackend(deviceId).DeleteFileAsync(deviceId, request, cancellationToken);
	}

	/// <summary>
	/// Creates a directory, and any missing parent above it.
	/// </summary>
	public Task<FileMutationResult> CreateDirectoryAsync(
		string deviceId,
		FileMutationRequest request,
		CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrWhiteSpace(request.Path))
			throw new ArgumentException("A device path is required.", nameof(request));

		return GetBackend(deviceId).CreateDirectoryAsync(deviceId, request, cancellationToken);
	}

	/// <summary>
	/// Reports the permissions one app holds.
	/// </summary>
	public Task<PermissionListResult> ListPermissionsAsync(
		string deviceId,
		string bundleId,
		CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).ListPermissionsAsync(deviceId, RequireBundleId(bundleId), cancellationToken);

	/// <summary>
	/// Grants, revokes or resets one permission.
	/// </summary>
	public Task<PermissionChangeResult> ChangePermissionAsync(
		string deviceId,
		PermissionChangeRequest request,
		CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrWhiteSpace(request.Permission))
			throw new ArgumentException(
				$"A permission is required. Names that work on both platforms: "
				+ $"{string.Join(", ", DevicePermissions.All)}. A platform's own name also works.",
				nameof(request));

		var action = request.Action.Trim().ToLowerInvariant();
		if (!PermissionActions.All.Contains(action))
			throw new ArgumentException(
				$"'{request.Action}' is not an action. Use one of: {string.Join(", ", PermissionActions.All)}.",
				nameof(request));

		return GetBackend(deviceId).ChangePermissionAsync(
			deviceId,
			request with
			{
				BundleId = RequireBundleId(request.BundleId),
				Permission = request.Permission.Trim(),
				Action = action,
			},
			cancellationToken);
	}

	/// <summary>
	/// Reads the device's display and accessibility settings.
	/// </summary>
	public Task<DeviceSettings> GetSettingsAsync(
		string deviceId,
		CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).GetSettingsAsync(deviceId, cancellationToken);

	/// <summary>
	/// Applies the settings named in the request.
	/// </summary>
	public Task<DeviceSettings> UpdateSettingsAsync(
		string deviceId,
		DeviceSettingsRequest request,
		CancellationToken cancellationToken = default)
	{
		if (request.Appearance is null && request.FontScale is null
			&& request.ContentSize is null && request.IncreaseContrast is null)
		{
			throw new ArgumentException("Name at least one setting to change.", nameof(request));
		}

		var appearance = request.Appearance?.Trim().ToLowerInvariant();
		if (appearance is not null && !DeviceAppearances.All.Contains(appearance))
			throw new ArgumentException(
				$"'{request.Appearance}' is not an appearance. Use one of: "
				+ $"{string.Join(", ", DeviceAppearances.All)}.",
				nameof(request));

		// A negative or zero scale would be accepted by the platform and render nothing readable.
		if (request.FontScale is { } scale && (scale <= 0 || scale > 10))
			throw new ArgumentException(
				$"A font scale of {scale} is out of range; 1.0 is the platform default.",
				nameof(request));

		return GetBackend(deviceId).UpdateSettingsAsync(
			deviceId,
			request with { Appearance = appearance },
			cancellationToken);
	}

	/// <summary>
	/// Reads what the device reports about its simulated hardware.
	/// </summary>
	public Task<HardwareState> GetHardwareStateAsync(
		string deviceId,
		CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).GetHardwareStateAsync(deviceId, cancellationToken);

	/// <summary>
	/// Moves the device to a simulated position.
	/// </summary>
	public Task SetLocationAsync(
		string deviceId,
		DeviceLocationRequest request,
		CancellationToken cancellationToken = default)
	{
		// simctl takes a latitude and longitude that are not numbers without complaint and without
		// exiting non-zero, so a typo would otherwise look like a fix that was applied.
		if (request.Latitude is < -90 or > 90 || double.IsNaN(request.Latitude))
			throw new ArgumentException(
				$"A latitude of {request.Latitude} is not on Earth; it must be between -90 and 90.",
				nameof(request));

		if (request.Longitude is < -180 or > 180 || double.IsNaN(request.Longitude))
			throw new ArgumentException(
				$"A longitude of {request.Longitude} is not on Earth; it must be between -180 and 180.",
				nameof(request));

		return GetBackend(deviceId).SetLocationAsync(deviceId, request, cancellationToken);
	}

	/// <summary>
	/// Returns the device to the host's real position.
	/// </summary>
	public Task ClearLocationAsync(string deviceId, CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).ClearLocationAsync(deviceId, cancellationToken);

	/// <summary>
	/// Simulates a battery level or charging state.
	/// </summary>
	public Task<HardwareState> SetBatteryAsync(
		string deviceId,
		BatteryRequest request,
		CancellationToken cancellationToken = default)
	{
		if (request.Level is null && request.State is null)
			throw new ArgumentException("Name a battery level or a state to change.", nameof(request));

		if (request.Level is { } level && level is < 0 or > 100)
			throw new ArgumentOutOfRangeException(
				nameof(request),
				level,
				"A battery level is a percentage, so it must be between 0 and 100.");

		var state = request.State?.Trim().ToLowerInvariant();
		if (state is not null && !BatteryStates.All.Contains(state))
			throw new ArgumentException(
				$"'{request.State}' is not a battery state. Use one of: {string.Join(", ", BatteryStates.All)}.",
				nameof(request));

		return GetBackend(deviceId).SetBatteryAsync(
			deviceId,
			request with { State = state },
			cancellationToken);
	}

	/// <summary>
	/// Simulates network conditions.
	/// </summary>
	public Task<HardwareState> SetNetworkAsync(
		string deviceId,
		NetworkRequest request,
		CancellationToken cancellationToken = default)
	{
		if (request.Profile is null && request.LatencyMs is null)
			throw new ArgumentException("Name a network profile or a latency to change.", nameof(request));

		if (request.LatencyMs is { } latency && latency < 0)
			throw new ArgumentOutOfRangeException(
				nameof(request),
				latency,
				"Latency cannot be negative. Use 0 to remove the delay.");

		return GetBackend(deviceId).SetNetworkAsync(
			deviceId,
			request with { Profile = request.Profile?.Trim().ToLowerInvariant() },
			cancellationToken);
	}

	public Task SendPushNotificationAsync(
		string deviceId,
		PushNotificationRequest request,
		CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrWhiteSpace(request.Payload))
			throw new ArgumentException("A push notification needs a payload.", nameof(request));

		// The platform rejects a payload without an `aps` key, but only after the app has been
		// resolved, so catching it here keeps the complaint about the thing that is actually wrong.
		if (!request.Payload.Contains("\"aps\"", StringComparison.Ordinal))
			throw new ArgumentException(
				"A push payload must contain an 'aps' key, for example "
				+ """{"aps":{"alert":{"title":"Hello","body":"World"}}}.""",
				nameof(request));

		return GetBackend(deviceId).SendPushNotificationAsync(
			deviceId,
			request with { BundleId = RequireBundleId(request.BundleId) },
			cancellationToken);
	}

	public Task SendSmsAsync(
		string deviceId,
		SmsRequest request,
		CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrWhiteSpace(request.From))
			throw new ArgumentException("A text message needs a sender.", nameof(request));

		if (string.IsNullOrEmpty(request.Body))
			throw new ArgumentException("A text message needs a body.", nameof(request));

		return GetBackend(deviceId).SendSmsAsync(
			deviceId,
			request with { From = request.From.Trim() },
			cancellationToken);
	}

	public Task<CallStateResult> GetCallsAsync(
		string deviceId,
		CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).GetCallsAsync(deviceId, cancellationToken);

	public Task<CallStateResult> ChangeCallAsync(
		string deviceId,
		CallRequest request,
		CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrWhiteSpace(request.Action))
			throw new ArgumentException("A call action is required.", nameof(request));

		return GetBackend(deviceId).ChangeCallAsync(
			deviceId,
			request with { Number = request.Number?.Trim() },
			cancellationToken);
	}

	public Task<BiometricResult> SendBiometricAsync(
		string deviceId,
		BiometricRequest request,
		CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrWhiteSpace(request.Action))
			throw new ArgumentException("A biometric action is required.", nameof(request));

		return GetBackend(deviceId).SendBiometricAsync(deviceId, request, cancellationToken);
	}

	public Task<ClipboardResult> GetClipboardAsync(
		string deviceId,
		CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).GetClipboardAsync(deviceId, cancellationToken);

	public Task<ClipboardResult> SetClipboardAsync(
		string deviceId,
		string text,
		CancellationToken cancellationToken = default) =>
		GetBackend(deviceId).SetClipboardAsync(deviceId, text ?? "", cancellationToken);

	public Task<MediaResult> AddMediaAsync(
		string deviceId,
		MediaRequest request,
		CancellationToken cancellationToken = default)
	{
		if (request.HostPaths.Count == 0)
			throw new ArgumentException("Name at least one file to add.", nameof(request));

		return GetBackend(deviceId).AddMediaAsync(deviceId, request, cancellationToken);
	}

	private static string RequireBundleId(string bundleId) =>
		string.IsNullOrWhiteSpace(bundleId)
			? throw new ArgumentException(
				"A bundle ID (iOS) or package name (Android) is required.",
				nameof(bundleId))
			: bundleId.Trim();

	private static string Describe(UiQuery query)
	{
		var terms = new List<string>();
		if (!string.IsNullOrWhiteSpace(query.Text))
			terms.Add($"text '{query.Text}'");
		if (!string.IsNullOrWhiteSpace(query.Identifier))
			terms.Add($"identifier '{query.Identifier}'");
		if (!string.IsNullOrWhiteSpace(query.Role))
			terms.Add($"role '{query.Role}'");
		return terms.Count == 0 ? "an empty query" : string.Join(" and ", terms);
	}

	private IDeviceBackend GetBackend(string deviceId) =>
		GetBackendForPlatform(DeviceIdentity.GetPlatform(deviceId));

	private IDeviceBackend GetBackendForPlatform(string platform) =>
		_backends.TryGetValue(platform, out var backend)
			? backend
			: throw new DeviceCapabilityException($"Platform '{platform}' is not available on this host.");

	private static string SelectionKey(string sessionId, string instanceId) => $"{sessionId}\n{instanceId}";

	private static void RequireConfirmation(string operation, bool confirm)
	{
		if (!confirm)
			throw new InvalidOperationException(
				$"The destructive '{operation}' operation requires explicit confirmation.");
	}
}
