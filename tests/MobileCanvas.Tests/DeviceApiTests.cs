using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using MobileCanvas.Tool;

namespace MobileCanvas.Tests;

public sealed class DeviceApiTests
{
	[Theory]
	[InlineData("/")]
	[InlineData("/canvas-state.js")]
	[InlineData("/ailoha-canvas-state.js")]
	[InlineData("/ailoha-video-protocol.js")]
	[InlineData("/ailoha-video-receiver.js")]
	[InlineData("/ailoha-video-player.js")]
	[InlineData("/ailoha-workspace-view.js")]
	[InlineData("/ailoha-semantic-view.js")]
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
		foreach (var name in new[]
		{
			"canvas-state.js", "create-device-options.js", "ailoha-canvas-state.js",
			"ailoha-video-protocol.js", "ailoha-video-receiver.js", "ailoha-video-player.js",
			"ailoha-workspace-view.js",
			"ailoha-semantic-view.js",
		})
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
		Assert.False(DeviceApi.IsPublicPath(new PathString("/api/v1/workspace/inspection")));
		Assert.False(DeviceApi.IsPublicPath(
			new PathString("/api/v1/host/settings/screen-recording")));
	}

	[Fact]
	public async Task LegacyCanvas_ServesImportedSemanticModuleWithoutAuthentication()
	{
		var builder = WebApplication.CreateBuilder();
		builder.WebHost.UseUrls("http://127.0.0.1:0");
		builder.Services.AddSingleton(new HostSecurity("test-control-token"));
		builder.Services.AddSingleton<CanvasBootstrapStore>();
		await using var app = builder.Build();
		DeviceApi.Map(app);
		await app.StartAsync();
		try
		{
			var address = app.Services.GetRequiredService<IServer>()
				.Features.Get<IServerAddressesFeature>()!.Addresses.Single();
			using var client = new HttpClient();
			var script = await client.GetStringAsync(new Uri(new Uri(address), "/device-canvas.js"));
			Assert.Contains("./ailoha-semantic-view.js", script);
			using var response = await client.GetAsync(new Uri(new Uri(address), "/ailoha-semantic-view.js"));
			Assert.Equal(HttpStatusCode.OK, response.StatusCode);
			Assert.Equal("text/javascript", response.Content.Headers.ContentType?.MediaType);
			Assert.Contains("createSemanticInspectionView", await response.Content.ReadAsStringAsync());
		}
		finally
		{
			await app.StopAsync();
		}
	}
}
