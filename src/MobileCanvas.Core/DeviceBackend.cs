using MobileCanvas.Contracts;

namespace MobileCanvas.Core;

public interface IDeviceBackend
{
	string Platform { get; }

	Task<DeviceCatalog> GetCatalogAsync(CancellationToken cancellationToken = default);
	Task<DeviceTarget[]> ListDevicesAsync(CancellationToken cancellationToken = default);
	Task<DeviceTarget> GetDeviceAsync(string deviceId, CancellationToken cancellationToken = default);
	Task<DisplayGeometry> GetDisplayAsync(string deviceId, CancellationToken cancellationToken = default);
	Task<DeviceTarget> CreateAsync(CreateDeviceRequest request, CancellationToken cancellationToken = default);
	Task<DeviceTarget> BootAsync(string deviceId, CancellationToken cancellationToken = default);
	Task<DeviceTarget> ShutdownAsync(string deviceId, CancellationToken cancellationToken = default);
	Task<DeviceTarget> RestartAsync(string deviceId, CancellationToken cancellationToken = default);
	Task<DeviceTarget> EraseAsync(string deviceId, CancellationToken cancellationToken = default);
	Task DeleteAsync(string deviceId, CancellationToken cancellationToken = default);
	Task<DeviceTarget> RevealAsync(string deviceId, CancellationToken cancellationToken = default);
	Task TapAsync(string deviceId, TapRequest request, CancellationToken cancellationToken = default);

	Task TouchAsync(string deviceId, TouchRequest request, CancellationToken cancellationToken = default);
	Task SwipeAsync(string deviceId, SwipeRequest request, CancellationToken cancellationToken = default);
	Task TypeTextAsync(string deviceId, string text, CancellationToken cancellationToken = default);
	Task PressKeyAsync(string deviceId, ulong keyCode, CancellationToken cancellationToken = default);
	Task PressButtonAsync(string deviceId, string button, CancellationToken cancellationToken = default);
	Task RotateAsync(string deviceId, string orientation, CancellationToken cancellationToken = default);
	Task<byte[]> ScreenshotAsync(string deviceId, CancellationToken cancellationToken = default);

	/// <summary>
	/// Captures the on-screen element tree, letting a caller locate a control by name instead of
	/// guessing coordinates from a screenshot.
	/// </summary>
	Task<UiSnapshot> GetUiSnapshotAsync(string deviceId, bool includeRaw, CancellationToken cancellationToken = default);

	/// <summary>
	/// Lists installed apps. <paramref name="includeSystem"/> is passed down rather than filtered by
	/// the caller because skipping the platform's built-in apps saves a whole query on Android, where
	/// they outnumber a developer's own apps many times over.
	/// </summary>
	Task<InstalledApp[]> ListAppsAsync(string deviceId, bool includeSystem, CancellationToken cancellationToken = default);

	Task<AppOperationResult> LaunchAppAsync(string deviceId, AppLaunchRequest request, CancellationToken cancellationToken = default);
	Task<AppOperationResult> TerminateAppAsync(string deviceId, string bundleId, CancellationToken cancellationToken = default);
	Task<AppOperationResult> InstallAppAsync(string deviceId, AppInstallRequest request, CancellationToken cancellationToken = default);
	Task<AppOperationResult> UninstallAppAsync(string deviceId, string bundleId, CancellationToken cancellationToken = default);

	/// <summary>
	/// Reads the device log. The query is passed down rather than applied afterwards because both
	/// platforms can filter at the source, and the volume makes that the difference between a bounded
	/// answer and tens of thousands of lines.
	/// </summary>
	Task<LogEntry[]> ReadLogAsync(string deviceId, LogQuery query, CancellationToken cancellationToken = default);

	/// <summary>Lists crash reports the device recorded, newest first.</summary>
	Task<CrashReport[]> ListCrashesAsync(string deviceId, CancellationToken cancellationToken = default);

	/// <summary>Reads one crash report in full, given an <see cref="CrashReport.Id"/>.</summary>
	Task<CrashDetailResult> GetCrashAsync(string deviceId, string crashId, CancellationToken cancellationToken = default);

	/// <summary>Lists a directory on the device, or inside one app's data container.</summary>
	Task<FileListResult> ListFilesAsync(string deviceId, FileQuery query, CancellationToken cancellationToken = default);

	/// <summary>Copies a file off the device onto this machine.</summary>
	Task<FileTransferResult> PullFileAsync(string deviceId, FileTransferRequest request, CancellationToken cancellationToken = default);

	/// <summary>Copies a file from this machine onto the device.</summary>
	Task<FileTransferResult> PushFileAsync(string deviceId, FileTransferRequest request, CancellationToken cancellationToken = default);

	/// <summary>Removes a file, or a directory when the request allows it.</summary>
	Task<FileMutationResult> DeleteFileAsync(string deviceId, FileMutationRequest request, CancellationToken cancellationToken = default);

	/// <summary>Creates a directory, and any missing parent above it.</summary>
	Task<FileMutationResult> CreateDirectoryAsync(string deviceId, FileMutationRequest request, CancellationToken cancellationToken = default);

	/// <summary>Reports the permissions one app holds.</summary>
	Task<PermissionListResult> ListPermissionsAsync(string deviceId, string bundleId, CancellationToken cancellationToken = default);

	/// <summary>
	/// Grants, revokes or resets one permission, then reads back what actually changed.
	/// </summary>
	Task<PermissionChangeResult> ChangePermissionAsync(string deviceId, PermissionChangeRequest request, CancellationToken cancellationToken = default);

	/// <summary>Reads the device's display and accessibility settings.</summary>
	Task<DeviceSettings> GetSettingsAsync(string deviceId, CancellationToken cancellationToken = default);

	/// <summary>Applies the settings named in the request, leaving the rest alone.</summary>
	Task<DeviceSettings> UpdateSettingsAsync(string deviceId, DeviceSettingsRequest request, CancellationToken cancellationToken = default);

	/// <summary>Reads what the device will report about its simulated hardware.</summary>
	Task<HardwareState> GetHardwareStateAsync(string deviceId, CancellationToken cancellationToken = default);

	/// <summary>
	/// Moves the device to a simulated position. Neither platform can read one back, so this
	/// returns nothing to check against.
	/// </summary>
	Task SetLocationAsync(string deviceId, DeviceLocationRequest request, CancellationToken cancellationToken = default);

	/// <summary>Returns the device to the host's real position.</summary>
	Task ClearLocationAsync(string deviceId, CancellationToken cancellationToken = default);

	/// <summary>Simulates a battery level or charging state, then reads back what took.</summary>
	Task<HardwareState> SetBatteryAsync(string deviceId, BatteryRequest request, CancellationToken cancellationToken = default);

	/// <summary>Simulates network conditions, then reads back what took.</summary>
	Task<HardwareState> SetNetworkAsync(string deviceId, NetworkRequest request, CancellationToken cancellationToken = default);

	/// <summary>
	/// Delivers a simulated remote push notification to one app.
	/// </summary>
	Task SendPushNotificationAsync(string deviceId, PushNotificationRequest request, CancellationToken cancellationToken = default);

	/// <summary>Delivers an inbound text message.</summary>
	Task SendSmsAsync(string deviceId, SmsRequest request, CancellationToken cancellationToken = default);

	/// <summary>Reads the calls the device's telephony stack currently knows about.</summary>
	Task<CallStateResult> GetCallsAsync(string deviceId, CancellationToken cancellationToken = default);

	/// <summary>Places or changes a call, then reads the call list back.</summary>
	Task<CallStateResult> ChangeCallAsync(string deviceId, CallRequest request, CancellationToken cancellationToken = default);

	/// <summary>Presents a simulated fingerprint or face scan.</summary>
	Task<BiometricResult> SendBiometricAsync(string deviceId, BiometricRequest request, CancellationToken cancellationToken = default);

	/// <summary>Reads the device pasteboard.</summary>
	Task<ClipboardResult> GetClipboardAsync(string deviceId, CancellationToken cancellationToken = default);

	/// <summary>Writes the device pasteboard, then reads it back.</summary>
	Task<ClipboardResult> SetClipboardAsync(string deviceId, string text, CancellationToken cancellationToken = default);

	/// <summary>Adds photos or videos from this machine to the device's library.</summary>
	Task<MediaResult> AddMediaAsync(string deviceId, MediaRequest request, CancellationToken cancellationToken = default);

	Task<ILiveVideoSession> OpenVideoStreamAsync(string deviceId, StreamOptions options, CancellationToken cancellationToken = default);
	Task<RecordingStatus> StartRecordingAsync(string deviceId, RecordingStartRequest request, CancellationToken cancellationToken = default);
	Task<RecordingStatus> StopRecordingAsync(string deviceId, CancellationToken cancellationToken = default);
	Task<RecordingStatus> GetRecordingStatusAsync(string deviceId, CancellationToken cancellationToken = default);
}

public interface ILiveVideoSession : IAsyncDisposable
{
	StreamDescriptor Descriptor { get; }
	IAsyncEnumerable<ReadOnlyMemory<byte>> ReadAsync(CancellationToken cancellationToken = default);
}

public sealed class DeviceCapabilityException(string message) : InvalidOperationException(message);

/// <summary>
/// Raised when a UI query matches nothing. Distinct from a capability failure because the usual cause
/// is a screen that has not finished changing, which a caller can retry.
/// </summary>
public sealed class UiElementNotFoundException(string description)
	: KeyNotFoundException($"No on-screen element matched {description}.");


public sealed class DeviceNotFoundException(string deviceId)
	: KeyNotFoundException($"Device '{deviceId}' was not found.");

public static class DeviceIdentity
{
	public static string Create(string platform, string provider, string nativeId) =>
		$"{platform}:{provider}:{nativeId}";

	public static string GetPlatform(string deviceId)
	{
		var separator = deviceId.IndexOf(':');
		if (separator <= 0)
			throw new ArgumentException($"Invalid device ID '{deviceId}'.", nameof(deviceId));

		return deviceId[..separator];
	}

	public static string GetNativeId(string deviceId)
	{
		var separator = deviceId.LastIndexOf(':');
		if (separator < 0 || separator == deviceId.Length - 1)
			throw new ArgumentException($"Invalid device ID '{deviceId}'.", nameof(deviceId));

		return deviceId[(separator + 1)..];
	}
}
