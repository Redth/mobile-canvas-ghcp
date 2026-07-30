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
