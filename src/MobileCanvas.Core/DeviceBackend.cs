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
