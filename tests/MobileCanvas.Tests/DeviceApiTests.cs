using Microsoft.AspNetCore.Http;
using MobileCanvas.Tool;

namespace MobileCanvas.Tests;

public sealed class DeviceApiTests
{
	[Theory]
	[InlineData("/")]
	[InlineData("/create-device-options.js")]
	[InlineData("/device-canvas.js")]
	[InlineData("/device-canvas.css")]
	[InlineData("/api/v1/auth/bootstrap")]
	public void BootstrapAssets_ArePublic(string path)
	{
		Assert.True(DeviceApi.IsPublicPath(new PathString(path)));
	}

	[Fact]
	public void CreateDeviceOptions_IsEmbedded()
	{
		using var stream = typeof(DeviceApi).Assembly.GetManifestResourceStream(
			"MobileCanvas.Web.create-device-options.js");

		Assert.NotNull(stream);
		Assert.True(stream.Length > 0);
	}

	[Fact]
	public void DeviceApi_RemainsProtected()
	{
		Assert.False(DeviceApi.IsPublicPath(new PathString("/api/v1/catalog")));
	}
}
