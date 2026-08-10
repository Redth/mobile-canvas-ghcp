using MobileCanvas.Contracts;
using MobileCanvas.Tool;

namespace MobileCanvas.Tests;

public sealed class DeviceHostClientTests
{
	[Theory]
	[InlineData("0.1.9", true)]
	[InlineData("0.1.10", true)]
	[InlineData("1.0.0", true)]
	[InlineData("0.1.8", false)]
	[InlineData("", false)]
	[InlineData("not-a-version", false)]
	public void IsHostCompatible_RejectsOlderOrInvalidHosts(string hostVersion, bool expected)
	{
		var metadata = new HostMetadata { Version = hostVersion };

		Assert.Equal(
			expected,
			DeviceHostClient.IsHostCompatible(metadata, new Version(0, 1, 9)));
	}

	[Fact]
	public void IsHostCompatible_RejectsAnotherProtocol()
	{
		var metadata = new HostMetadata
		{
			SchemaVersion = "999",
			Version = "0.1.9",
		};

		Assert.False(DeviceHostClient.IsHostCompatible(metadata, new Version(0, 1, 9)));
	}

	[Fact]
	public void CreateHostStartInfo_UsesStableHomeDirectory()
	{
		var startInfo = DeviceHostClient.CreateHostStartInfo(
			Path.Combine(Path.GetTempPath(), "mobile-canvas"),
			Path.GetTempPath());

		Assert.Equal(DevicePaths.Home, startInfo.WorkingDirectory);
		Assert.Equal(["host", "run"], startInfo.ArgumentList);
		Assert.Equal("1", startInfo.Environment["MOBILE_CANVAS_HOST_PROCESS"]);
	}
}
