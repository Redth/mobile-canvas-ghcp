using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using MobileCanvas.Contracts;
using MobileCanvas.Core;
using MobileCanvas.Tool;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace MobileCanvas.Tests;

/// <summary>
/// Exercises the running host rather than the handlers in isolation, because the scope guard is a
/// pipeline concern: a route that stops being covered by it would still pass a handler-level test.
/// </summary>
public sealed class DeviceApiSurfaceTests : IAsyncLifetime
{
	private const string ControlToken = "control-token-for-tests";

	private WebApplication app = null!;
	private HttpClient client = null!;

	public async Task InitializeAsync()
	{
		var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = [] });
		builder.Logging.ClearProviders();
		builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
		builder.Services.ConfigureHttpJsonOptions(options =>
			options.SerializerOptions.TypeInfoResolverChain.Insert(0, DeviceJsonContext.Default));
		builder.Services.AddSingleton(new DeviceService([]));
		builder.Services.AddSingleton<CanvasBootstrapStore>();
		builder.Services.AddSingleton<AutomationActivityHub>();
		builder.Services.AddSingleton(new HostSecurity(ControlToken));

		app = builder.Build();
		app.UseWebSockets();
		DeviceApi.Map(app);
		await app.StartAsync();

		var address = app.Services.GetRequiredService<IServer>()
			.Features.Get<IServerAddressesFeature>()?.Addresses.Single()
			?? throw new InvalidOperationException("The test host did not publish an address.");
		client = new HttpClient { BaseAddress = new Uri(address) };
	}

	public async Task DisposeAsync()
	{
		client.Dispose();
		await app.StopAsync();
		await app.DisposeAsync();
	}

	[Fact]
	public async Task MobilePanel_UsesTheMobileApi()
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Mobile);

		using var response = await GetAsync("/api/v1/selection", cookie);

		Assert.Equal(HttpStatusCode.OK, response.StatusCode);
	}

	[Theory]
	[InlineData("GET", "/api/v1/selection")]
	[InlineData("GET", "/api/v1/catalog")]
	[InlineData("GET", "/api/v1/devices")]
	[InlineData("GET", "/api/v1/devices/ios%3Aone/screenshot")]
	[InlineData("GET", "/ws/events")]
	[InlineData("GET", "/ws/video?deviceId=ios%3Aone")]
	[InlineData("POST", "/api/v1/host/settings/screen-recording")]
	public async Task WindowsPanel_IsRefusedByEveryMobileRoute(string method, string path)
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Windows);

		using var response = await SendAsync(new HttpMethod(method), path, cookie);

		Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
		Assert.Equal("surface_not_allowed", await ErrorCodeAsync(response));
	}

	[Theory]
	[InlineData("/ws/events")]
	[InlineData("/ws/video?deviceId=ios%3Aone")]
	public async Task MobilePanel_ReachesTheSocketRoutes(string path)
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Mobile);

		using var response = await GetAsync(path, cookie);

		// The guard let the request through; the endpoint itself then rejects a plain GET, which is
		// how this test tells "scope refused" apart from "route reached".
		Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
		Assert.Equal("invalid_request", await ErrorCodeAsync(response));
	}

	[Fact]
	public async Task SharedRoutes_StayAvailableToEverySurface()
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Windows);

		using var status = await GetAsync("/api/v1/status", cookie);
		using var detach = await PostAsync("/api/v1/canvas/detach", cookie);

		Assert.Equal(HttpStatusCode.OK, status.StatusCode);
		Assert.Equal(HttpStatusCode.NoContent, detach.StatusCode);
	}

	[Fact]
	public async Task ControlToken_WithoutASurface_KeepsWorkingOnMobileRoutes()
	{
		using var request = new HttpRequestMessage(
			HttpMethod.Get,
			"/api/v1/selection?sessionId=session&instanceId=panel");
		request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", ControlToken);

		using var response = await client.SendAsync(request);

		Assert.Equal(HttpStatusCode.OK, response.StatusCode);
	}

	[Fact]
	public async Task ControlToken_ScopedToWindows_IsRefusedByMobileRoutes()
	{
		using var request = new HttpRequestMessage(
			HttpMethod.Get,
			"/api/v1/selection?sessionId=session&instanceId=panel&surface=windows");
		request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", ControlToken);

		using var response = await client.SendAsync(request);

		Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
		Assert.Equal("surface_not_allowed", await ErrorCodeAsync(response));
	}

	[Fact]
	public async Task Bootstrap_RefusesToTradeAGrantForAnotherSurface()
	{
		var secret = await OpenCanvasAsync("panel", CanvasSurfaces.Mobile);

		using var response = await client.PostAsJsonAsync(
			"/api/v1/auth/bootstrap",
			new CanvasBootstrapRequest
			{
				Secret = secret,
				SessionId = "session",
				InstanceId = "panel",
				Surface = CanvasSurfaces.Windows,
			},
			DeviceJsonContext.Default.CanvasBootstrapRequest);

		Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
	}

	[Fact]
	public async Task CanvasOpen_RejectsAnUnknownSurface()
	{
		using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/canvas/open")
		{
			Content = JsonContent.Create(
				new CanvasOpenRequest
				{
					SessionId = "session",
					InstanceId = "panel",
					Surface = "linux",
				},
				DeviceJsonContext.Default.CanvasOpenRequest),
		};
		request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", ControlToken);

		using var response = await client.SendAsync(request);

		Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
	}

	[Fact]
	public async Task CanvasOpen_WithoutASurface_StaysMobile()
	{
		using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/canvas/open")
		{
			Content = new StringContent(
				"""{"sessionId":"session","instanceId":"panel"}""",
				System.Text.Encoding.UTF8,
				"application/json"),
		};
		request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", ControlToken);

		using var response = await client.SendAsync(request);
		var result = await response.Content.ReadFromJsonAsync(
			DeviceJsonContext.Default.CanvasOpenResult);

		Assert.Equal(HttpStatusCode.OK, response.StatusCode);
		Assert.Equal(CanvasSurfaces.Mobile, result!.Surface);
		Assert.Contains("surface=mobile", result.Url, StringComparison.Ordinal);
	}

	[Fact]
	public async Task PublicAssets_StayReachableWithoutCredentials()
	{
		using var response = await client.GetAsync("/");

		Assert.Equal(HttpStatusCode.OK, response.StatusCode);
	}

	private async Task<string> SignInAsync(string instanceId, string surface)
	{
		var secret = await OpenCanvasAsync(instanceId, surface);
		using var response = await client.PostAsJsonAsync(
			"/api/v1/auth/bootstrap",
			new CanvasBootstrapRequest
			{
				Secret = secret,
				SessionId = "session",
				InstanceId = instanceId,
				Surface = surface,
			},
			DeviceJsonContext.Default.CanvasBootstrapRequest);
		response.EnsureSuccessStatusCode();
		var cookie = response.Headers.GetValues("Set-Cookie").Single().Split(';', 2)[0];
		Assert.StartsWith("mobile_device_session=", cookie, StringComparison.Ordinal);
		return cookie;
	}

	private async Task<string> OpenCanvasAsync(string instanceId, string surface)
	{
		using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/canvas/open")
		{
			Content = JsonContent.Create(
				new CanvasOpenRequest
				{
					SessionId = "session",
					InstanceId = instanceId,
					Surface = surface,
				},
				DeviceJsonContext.Default.CanvasOpenRequest),
		};
		request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", ControlToken);
		using var response = await client.SendAsync(request);
		response.EnsureSuccessStatusCode();
		var result = await response.Content.ReadFromJsonAsync(
			DeviceJsonContext.Default.CanvasOpenResult);
		var fragment = new Uri(result!.Url).Fragment.TrimStart('#');
		return fragment.Split('&')
			.Select(pair => pair.Split('=', 2))
			.Where(pair => pair[0] == "bootstrap")
			.Select(pair => Uri.UnescapeDataString(pair[1]))
			.Single();
	}

	private Task<HttpResponseMessage> GetAsync(string path, string cookie) =>
		SendAsync(HttpMethod.Get, path, cookie);

	private Task<HttpResponseMessage> PostAsync(string path, string cookie) =>
		SendAsync(HttpMethod.Post, path, cookie);

	private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, string cookie)
	{
		using var request = new HttpRequestMessage(method, path);
		request.Headers.Add("Cookie", cookie);
		return await client.SendAsync(request);
	}

	private static async Task<string?> ErrorCodeAsync(HttpResponseMessage response) =>
		JsonSerializer.Deserialize(
			await response.Content.ReadAsStringAsync(),
			DeviceJsonContext.Default.ApiError)?.Code;
}
