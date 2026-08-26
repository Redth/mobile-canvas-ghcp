namespace MobileCanvas.iOS;

internal sealed class IdbHidException(string message, Exception? innerException = null)
	: InvalidOperationException(message, innerException);
