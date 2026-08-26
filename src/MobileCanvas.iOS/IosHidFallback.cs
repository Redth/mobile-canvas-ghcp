using MobileCanvas.Core;

namespace MobileCanvas.iOS;

internal static class IosHidFallback
{
	public static async Task SendAsync(
		Func<Task> sendNative,
		Func<Task> sendIdb)
	{
		await SendAsync(
			async () =>
			{
				await sendNative().ConfigureAwait(false);
				return true;
			},
			async () =>
			{
				await sendIdb().ConfigureAwait(false);
				return true;
			}).ConfigureAwait(false);
	}

	public static async Task<T> SendAsync<T>(
		Func<Task<T>> sendNative,
		Func<Task<T>> sendIdb)
	{
		try
		{
			return await sendNative().ConfigureAwait(false);
		}
		catch (CoreSimulatorHidException nativeException) when (nativeException.BeforeDelivery)
		{
			try
			{
				return await sendIdb().ConfigureAwait(false);
			}
			catch (IdbHidException idbException)
			{
				throw new DeviceCapabilityException(
					"iOS input is unavailable. "
					+ $"Bundled CoreSimulator HID: {nativeException.Message} "
					+ $"Optional idb fallback: {idbException.Message}");
			}
		}
	}
}
