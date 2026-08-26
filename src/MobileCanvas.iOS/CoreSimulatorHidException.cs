namespace MobileCanvas.iOS;

internal sealed class CoreSimulatorHidException : InvalidOperationException
{
	public CoreSimulatorHidException(string message, bool beforeDelivery, Exception? innerException = null)
		: base(message, innerException)
	{
		BeforeDelivery = beforeDelivery;
	}

	public bool BeforeDelivery { get; }
}
