using MobileCanvas.Android;

namespace MobileCanvas.Tests;

public sealed class AndroidDiagnosticsTests
{
	[Fact]
	public void Check_DoesNotReportTransientEmulatorDiscoveryDirectory()
	{
		var checks = new AndroidSdkLocator().Check();

		Assert.DoesNotContain(checks, check => check.Name == "emulator-discovery");
	}
}
