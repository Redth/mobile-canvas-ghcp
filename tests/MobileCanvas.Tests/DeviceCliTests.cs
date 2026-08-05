using MobileCanvas.Tool;

namespace MobileCanvas.Tests;

public sealed class DeviceCliTests
{
	[Theory]
	[InlineData("ios:core-simulator:ABC", "ios-20260805-105037.png")]
	[InlineData("android:android-emulator:Pixel_8", "android-20260805-105037.png")]
	public void CreateScreenshotFileName_UsesDevicePlatform(string deviceId, string expected)
	{
		var timestamp = new DateTimeOffset(2026, 8, 5, 10, 50, 37, TimeSpan.Zero);

		Assert.Equal(expected, DeviceCli.CreateScreenshotFileName(deviceId, timestamp));
	}
}
