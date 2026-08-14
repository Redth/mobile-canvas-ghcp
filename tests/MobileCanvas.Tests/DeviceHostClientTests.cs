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
	public void HostPaths_AreIsolatedByProtocolVersion()
	{
		var home = Path.Combine(Path.GetTempPath(), "mobile-canvas");

		var versionOne = DevicePaths.HostDirectoryFor(home, "1.0");
		var versionTwo = DevicePaths.HostDirectoryFor(home, "2.0");

		Assert.Equal(Path.Combine(home, "hosts", "v1.0"), versionOne);
		Assert.Equal(Path.Combine(home, "hosts", "v2.0"), versionTwo);
		Assert.NotEqual(versionOne, versionTwo);
	}

	[Fact]
	public void ProtocolLock_DoesNotConflictWithLegacyInstall()
	{
		var home = Path.Combine(Path.GetTempPath(), $"mobile-canvas-{Guid.NewGuid():N}");
		var protocolHome = DevicePaths.HostDirectoryFor(home, MobileCanvasProtocol.Version);
		Directory.CreateDirectory(protocolHome);
		try
		{
			using var legacy = new FileStream(
				Path.Combine(home, "host.lock"),
				FileMode.OpenOrCreate,
				FileAccess.ReadWrite,
				FileShare.None);
			using var current = new FileStream(
				Path.Combine(protocolHome, "host.lock"),
				FileMode.OpenOrCreate,
				FileAccess.ReadWrite,
				FileShare.None);

			Assert.True(legacy.CanWrite);
			Assert.True(current.CanWrite);
		}
		finally
		{
			Directory.Delete(home, recursive: true);
		}
	}

	[Fact]
	public void CreateHostStartInfo_UsesProtocolHomeDirectory()
	{
		var startInfo = DeviceHostClient.CreateHostStartInfo(
			Path.Combine(Path.GetTempPath(), "mobile-canvas"),
			Path.GetTempPath());

		Assert.Equal(DevicePaths.HostHome, startInfo.WorkingDirectory);
		Assert.Equal(["host", "run"], startInfo.ArgumentList);
		Assert.Equal("1", startInfo.Environment["MOBILE_CANVAS_HOST_PROCESS"]);
	}
}
