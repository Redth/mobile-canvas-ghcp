using Microsoft.AspNetCore.Http;
using MobileCanvas.Tool;

namespace MobileCanvas.Tests;

public sealed class DeviceApiTests
{
	[Theory]
	[InlineData("/")]
	[InlineData("/canvas-state.js")]
	[InlineData("/create-device-options.js")]
	[InlineData("/device-canvas.js")]
	[InlineData("/device-canvas.css")]
	[InlineData("/api/v1/auth/bootstrap")]
	public void BootstrapAssets_ArePublic(string path)
	{
		Assert.True(DeviceApi.IsPublicPath(new PathString(path)));
	}

	[Fact]
	public void WebModules_AreEmbedded()
	{
		foreach (var name in new[] { "canvas-state.js", "create-device-options.js" })
		{
			using var stream = typeof(DeviceApi).Assembly.GetManifestResourceStream(
				$"MobileCanvas.Web.{name}");
			Assert.NotNull(stream);
			Assert.True(stream.Length > 0);
		}
	}

	[Fact]
	public void DeviceApi_RemainsProtected()
	{
		Assert.False(DeviceApi.IsPublicPath(new PathString("/api/v1/catalog")));
	}
}
