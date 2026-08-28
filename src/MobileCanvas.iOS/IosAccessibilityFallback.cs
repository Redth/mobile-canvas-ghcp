using MobileCanvas.Core;

namespace MobileCanvas.iOS;

internal static class IosAccessibilityFallback
{
	public static async Task<T> ReadAsync<T>(
		Func<Task<T>> readNative,
		Func<Task<T>> readIdb)
	{
		try
		{
			return await readNative().ConfigureAwait(false);
		}
		catch (NativeAccessibilityException nativeException)
		{
			try
			{
				return await readIdb().ConfigureAwait(false);
			}
			catch (OperationCanceledException)
			{
				throw;
			}
			catch (Exception idbException) when (IdbCompanionManager.IsAvailabilityFailure(idbException))
			{
				throw BuildUnavailableException(nativeException.Message, idbException.Message);
			}
		}
	}

	internal static DeviceCapabilityException BuildUnavailableException(
		string nativeFailure,
		string idbFailure) =>
		new(
			"iOS accessibility hierarchy is unavailable. "
			+ $"Bundled CoreSimulator accessibility: {nativeFailure} "
			+ $"Optional IDB fallback: {idbFailure}");
}
