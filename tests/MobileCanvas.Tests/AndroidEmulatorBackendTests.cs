using MobileCanvas.Android;

namespace MobileCanvas.Tests;

public sealed class AndroidEmulatorBackendTests
{
	[Fact]
	public void HiddenLaunch_IncludesNoWindow()
	{
		var arguments = AndroidEmulatorBackend.BuildLaunchArguments(
			"Test_Device",
			8555,
			wipeData: false,
			showWindow: false);

		Assert.Contains("-no-window", arguments);
	}

	[Fact]
	public void VisibleLaunch_OmitsNoWindow()
	{
		var arguments = AndroidEmulatorBackend.BuildLaunchArguments(
			"Test_Device",
			8555,
			wipeData: false,
			showWindow: true);

		Assert.DoesNotContain("-no-window", arguments);
	}
}
