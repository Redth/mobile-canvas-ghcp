using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using MobileCanvas.Contracts;
using MobileCanvas.Core;
using MobileCanvas.Tool;
using WindowsCanvas.Contracts;
using WindowsCanvas.Windows;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace WindowsCanvas.Tests;

/// <summary>
/// Exercises the Windows routes inside a running host, because scope is a pipeline concern: a
/// route that stopped being covered by the surface guard would still pass a handler-level test.
/// </summary>
public sealed class WindowsApiSurfaceTests : IAsyncLifetime
{
	private const string ControlToken = "control-token-for-tests";

	private readonly FakeWindowsNativeBridge bridge = new();
	private WebApplication app = null!;
	private HttpClient client = null!;

	public async Task InitializeAsync()
	{
		bridge.Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Fixture window"));
		bridge.Catalog = new WindowsHelperCatalog
		{
			SchemaVersion = 1,
			Ok = true,
			Entries = [Fixtures.Entry("a1", "Fixture", executablePath: "C:\\apps\\fixture.exe")],
		};

		var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = [] });
		builder.Logging.ClearProviders();
		builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
		builder.Services.ConfigureHttpJsonOptions(options =>
		{
			options.SerializerOptions.TypeInfoResolverChain.Insert(0, DeviceJsonContext.Default);
			options.SerializerOptions.TypeInfoResolverChain.Insert(1, WindowsJsonContext.Default);
		});
		builder.Services.AddSingleton(new DeviceService([]));
		builder.Services.AddSingleton<CanvasBootstrapStore>();
		builder.Services.AddSingleton<AutomationActivityHub>();
		builder.Services.AddSingleton(new HostSecurity(ControlToken));
		builder.Services.AddSingleton<IWindowsNativeBridge>(bridge);
		builder.Services.AddSingleton<IWindowsWindowController, FakeWindowController>();
		builder.Services.AddSingleton<IWindowsProcessLauncher, FakeProcessLauncher>();
		builder.Services.AddSingleton<IWindowsWindowGeometry>(new FakeWindowGeometry());
		builder.Services.AddSingleton<IWindowsInputController>(
			new FakeInputController { Foreground = 11 });
		builder.Services.AddSingleton<WindowsAppService>();

		app = builder.Build();
		app.UseWebSockets();
		DeviceApi.Map(app);
		WindowsApi.Map(app);
		await app.StartAsync();

		var address = app.Services.GetRequiredService<IServer>()
			.Features.Get<IServerAddressesFeature>()?.Addresses.Single()
			?? throw new InvalidOperationException("The test host did not publish an address.");
		// Cookies are set explicitly per request so one test can act as two different panels; the
		// handler's own jar would otherwise attach whichever session signed in last.
		client = new HttpClient(new HttpClientHandler { UseCookies = false })
		{
			BaseAddress = new Uri(address),
		};
	}

	public async Task DisposeAsync()
	{
		client.Dispose();
		await app.StopAsync();
		await app.DisposeAsync();
	}

	[Fact]
	public async Task WindowsPanel_ReachesTheWindowsSurface()
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Windows);

		using var capabilities = await SendAsync(HttpMethod.Get, "/api/v1/windows/capabilities", cookie);
		using var apps = await SendAsync(HttpMethod.Get, "/api/v1/windows/apps?text=fixture", cookie);
		using var windows = await SendAsync(HttpMethod.Get, "/api/v1/windows/windows", cookie);

		Assert.Equal(HttpStatusCode.OK, capabilities.StatusCode);
		Assert.Equal(HttpStatusCode.OK, apps.StatusCode);
		Assert.Equal(HttpStatusCode.OK, windows.StatusCode);

		var listed = await windows.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsWindowCandidateList);
		Assert.Equal("Fixture window", Assert.Single(listed!.Windows).Title);
	}

	[Theory]
	[InlineData("GET", "/api/v1/windows/capabilities")]
	[InlineData("GET", "/api/v1/windows/apps")]
	[InlineData("GET", "/api/v1/windows/windows")]
	[InlineData("GET", "/api/v1/windows/session")]
	[InlineData("GET", "/api/v1/windows/session/windows")]
	[InlineData("GET", "/api/v1/windows/session/windows/win_other/ui/snapshot")]
	[InlineData("POST", "/api/v1/windows/session/windows/win_other/ui/find")]
	[InlineData("POST", "/api/v1/windows/session/windows/win_other/ui/action")]
	[InlineData("POST", "/api/v1/windows/session/windows/win_other/ui/wait")]
	[InlineData("POST", "/api/v1/windows/session/release")]
	public async Task MobilePanel_IsRefusedByEveryWindowsRoute(string method, string path)
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Mobile);

		using var response = await SendAsync(new HttpMethod(method), path, cookie);

		Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
		Assert.Equal("surface_not_allowed", await ErrorCodeAsync(response));
	}

	[Fact]
	public async Task ControlToken_MustNameTheWindowsSurfaceToReachIt()
	{
		using var mobile = await ControlRequestAsync(
			HttpMethod.Get,
			"/api/v1/windows/windows?sessionId=session&instanceId=panel");
		using var windows = await ControlRequestAsync(
			HttpMethod.Get,
			"/api/v1/windows/windows?sessionId=session&instanceId=panel&surface=windows");

		Assert.Equal(HttpStatusCode.Forbidden, mobile.StatusCode);
		Assert.Equal("surface_not_allowed", await ErrorCodeAsync(mobile));
		Assert.Equal(HttpStatusCode.OK, windows.StatusCode);
	}

	[Fact]
	public async Task SessionRoutes_RequireACanvasContext()
	{
		using var response = await ControlRequestAsync(HttpMethod.Get, "/api/v1/windows/session");

		Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
		Assert.Equal("invalid_request", await ErrorCodeAsync(response));
	}

	[Fact]
	public async Task Unauthenticated_WindowsApiIsRefused()
	{
		using var response = await client.GetAsync("/api/v1/windows/capabilities");

		Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
	}

	[Fact]
	public async Task WindowsCanvasAssets_AreAnExactPublicAllowlist()
	{
		using var shell = await client.GetAsync(WindowsApi.CanvasPath);
		using var nested = await client.GetAsync("/windows/anything-else");

		Assert.Equal(HttpStatusCode.OK, shell.StatusCode);
		var html = await shell.Content.ReadAsStringAsync();
		Assert.Contains("<title>Windows App</title>", html, StringComparison.Ordinal);
		// The shell is useless without the modules it names, so those are public too.
		Assert.Contains("/windows/windows-canvas.css", html, StringComparison.Ordinal);
		Assert.Contains("/windows/windows-canvas.js", html, StringComparison.Ordinal);

		// The prefix is not public; only the exact asset paths are.
		Assert.Equal(HttpStatusCode.Unauthorized, nested.StatusCode);
	}

	[Theory]
	[InlineData("/windows/windows-canvas.css", "text/css")]
	[InlineData("/windows/windows-canvas.js", "text/javascript")]
	[InlineData("/windows/windows-state.js", "text/javascript")]
	// Annex-B framing is shared with the Mobile canvas, so it is served once from the root.
	[InlineData("/annexb.js", "text/javascript")]
	public async Task WindowsRendererModules_AreServedWithoutACredential(
		string path,
		string contentType)
	{
		using var response = await client.GetAsync(path);

		Assert.Equal(HttpStatusCode.OK, response.StatusCode);
		Assert.Equal(contentType, response.Content.Headers.ContentType?.MediaType);
		Assert.NotEmpty(await response.Content.ReadAsStringAsync());
	}

	[Fact]
	public async Task CanvasOpen_PointsAWindowsPanelAtTheWindowsShell()
	{
		var result = await OpenCanvasAsync("panel", CanvasSurfaces.Windows);

		Assert.Equal(CanvasSurfaces.Windows, result.Surface);
		Assert.Equal(CanvasTitles.WindowsPanel, result.Title);
		Assert.Contains("/windows/#", result.Url, StringComparison.Ordinal);
	}

	[Fact]
	public async Task CanvasOpen_LeavesTheMobilePanelAtTheRoot()
	{
		var result = await OpenCanvasAsync("panel", CanvasSurfaces.Mobile);

		Assert.Equal(CanvasTitles.Panel, result.Title);
		Assert.DoesNotContain("/windows/", result.Url, StringComparison.Ordinal);
	}

	[Fact]
	public async Task AttachAndRelease_FlowThroughTheGuardedService()
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Windows);
		using var listed = await SendAsync(HttpMethod.Get, "/api/v1/windows/windows", cookie);
		var candidates = await listed.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsWindowCandidateList);

		using var attached = await SendAsync(
			HttpMethod.Post,
			"/api/v1/windows/session/attach",
			cookie,
			JsonContent.Create(
				new WindowsAttachRequest { CandidateId = candidates!.Windows[0].Id },
				WindowsJsonContext.Default.WindowsAttachRequest));
		var session = await attached.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsAppSession);

		using var selection = await SendAsync(HttpMethod.Get, "/api/v1/windows/session", cookie);
		var selected = await selection.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsAppSelection);

		using var released = await SendAsync(HttpMethod.Post, "/api/v1/windows/session/release", cookie);
		using var afterRelease = await SendAsync(HttpMethod.Get, "/api/v1/windows/session", cookie);
		var empty = await afterRelease.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsAppSelection);

		Assert.Equal(HttpStatusCode.OK, attached.StatusCode);
		Assert.Equal("Fixture window", Assert.Single(session!.Windows).Title);
		Assert.True(selected!.HasSelection);
		Assert.Equal(session.Id, selected.Session!.Id);
		Assert.Equal(HttpStatusCode.OK, released.StatusCode);
		Assert.False(empty!.HasSelection);
	}

	[Fact]
	public async Task AnotherPanelsCandidate_IsRefusedWithAMachineReadableCode()
	{
		var first = await SignInAsync("panel-a", CanvasSurfaces.Windows);
		var second = await SignInAsync("panel-b", CanvasSurfaces.Windows);
		using var listed = await SendAsync(HttpMethod.Get, "/api/v1/windows/windows", first);
		var candidates = await listed.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsWindowCandidateList);

		using var response = await SendAsync(
			HttpMethod.Post,
			"/api/v1/windows/session/attach",
			second,
			JsonContent.Create(
				new WindowsAttachRequest { CandidateId = candidates!.Windows[0].Id },
				WindowsJsonContext.Default.WindowsAttachRequest));

		Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
		Assert.Equal(WindowsErrorCodes.CandidateNotFound, await ErrorCodeAsync(response));
	}

	[Fact]
	public async Task ExplicitLaunch_RefusesARelativePathWithItsOwnCode()
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Windows);

		using var response = await SendAsync(
			HttpMethod.Post,
			"/api/v1/windows/session/launch-executable",
			cookie,
			JsonContent.Create(
				new WindowsExecutableLaunchRequest { ExecutablePath = "notepad.exe" },
				WindowsJsonContext.Default.WindowsExecutableLaunchRequest));

		Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
		Assert.Equal(WindowsErrorCodes.InvalidRequest, await ErrorCodeAsync(response));
	}

	[Fact]
	public async Task Detach_DropsTheWindowsAuthorizationToo()
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Windows);
		using var listed = await SendAsync(HttpMethod.Get, "/api/v1/windows/windows", cookie);
		var candidates = await listed.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsWindowCandidateList);
		using var attached = await SendAsync(
			HttpMethod.Post,
			"/api/v1/windows/session/attach",
			cookie,
			JsonContent.Create(
				new WindowsAttachRequest { CandidateId = candidates!.Windows[0].Id },
				WindowsJsonContext.Default.WindowsAttachRequest));
		Assert.Equal(HttpStatusCode.OK, attached.StatusCode);

		using var detach = await SendAsync(HttpMethod.Post, "/api/v1/canvas/detach", cookie);
		Assert.Equal(HttpStatusCode.NoContent, detach.StatusCode);

		// The browser session is gone with the panel, so ask again as the control token for the
		// same canvas context: the app session must not have survived.
		using var session = await ControlRequestAsync(
			HttpMethod.Get,
			"/api/v1/windows/session?sessionId=session&instanceId=panel&surface=windows");
		var selection = await session.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsAppSelection);

		Assert.False(selection!.HasSelection);
	}

	[Fact]
	public async Task RevealWithoutABody_ActsOnTheSelectedWindow()
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Windows);
		using var listed = await SendAsync(HttpMethod.Get, "/api/v1/windows/windows", cookie);
		var candidates = await listed.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsWindowCandidateList);
		using var attached = await SendAsync(
			HttpMethod.Post,
			"/api/v1/windows/session/attach",
			cookie,
			JsonContent.Create(
				new WindowsAttachRequest { CandidateId = candidates!.Windows[0].Id },
				WindowsJsonContext.Default.WindowsAttachRequest));
		Assert.Equal(HttpStatusCode.OK, attached.StatusCode);

		// The window is optional, so a caller that means "the selected tab" sends no body at all.
		using var reveal = await SendAsync(
			HttpMethod.Post,
			"/api/v1/windows/session/windows/reveal",
			cookie);
		using var restore = await SendAsync(
			HttpMethod.Post,
			"/api/v1/windows/session/windows/restore",
			cookie,
			JsonContent.Create(
				new WindowsWindowActionRequest(),
				WindowsJsonContext.Default.WindowsWindowActionRequest));

		Assert.Equal(HttpStatusCode.OK, reveal.StatusCode);
		Assert.Equal(HttpStatusCode.OK, restore.StatusCode);
		var result = await reveal.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsOperationResult);
		Assert.Equal("reveal", result!.Operation);
		Assert.True(result.Success);
	}

	[Fact]
	public async Task RevealWithoutASession_IsANotFoundWithItsOwnCode()
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Windows);

		using var response = await SendAsync(
			HttpMethod.Post,
			"/api/v1/windows/session/windows/reveal",
			cookie);

		Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
		Assert.Equal(WindowsErrorCodes.SessionNotFound, await ErrorCodeAsync(response));
	}

	[Fact]
	public async Task UiRoutes_UseOpaqueWindowCapabilitiesAndReturnNormalizedContracts()
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Windows);
		using var listed = await SendAsync(HttpMethod.Get, "/api/v1/windows/windows", cookie);
		var candidates = await listed.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsWindowCandidateList);
		using var attached = await SendAsync(
			HttpMethod.Post,
			"/api/v1/windows/session/attach",
			cookie,
			JsonContent.Create(
				new WindowsAttachRequest { CandidateId = Assert.Single(candidates!.Windows).Id },
				WindowsJsonContext.Default.WindowsAttachRequest));
		var session = await attached.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsAppSession);
		var windowId = Assert.Single(session!.Windows).Id;

		using var snapshot = await SendAsync(
			HttpMethod.Get,
			$"/api/v1/windows/session/windows/{windowId}/ui/snapshot",
			cookie);
		using var find = await SendAsync(
			HttpMethod.Post,
			$"/api/v1/windows/session/windows/{windowId}/ui/find",
			cookie,
			JsonContent.Create(
				new WindowsUiQuery
				{
					Selector = new WindowsUiSelector
					{
						AutomationId = "save",
						ControlType = WindowsUiControlTypes.Button,
					},
				},
				WindowsJsonContext.Default.WindowsUiQuery));
		using var action = await SendAsync(
			HttpMethod.Post,
			$"/api/v1/windows/session/windows/{windowId}/ui/action",
			cookie,
			JsonContent.Create(
				new WindowsUiActionRequest
				{
					Action = WindowsUiActionKinds.Invoke,
					Selector = new WindowsUiSelector
					{
						AutomationId = "save",
						ControlType = WindowsUiControlTypes.Button,
					},
				},
				WindowsJsonContext.Default.WindowsUiActionRequest));
		using var wait = await SendAsync(
			HttpMethod.Post,
			$"/api/v1/windows/session/windows/{windowId}/ui/wait",
			cookie,
			JsonContent.Create(
				new WindowsUiWaitRequest
				{
					Condition = WindowsUiWaitConditions.NotExists,
					Selector = new WindowsUiSelector
					{
						AutomationId = "save",
						ControlType = WindowsUiControlTypes.Button,
					},
					TimeoutMilliseconds = 100,
					PollIntervalMilliseconds = 50,
				},
				WindowsJsonContext.Default.WindowsUiWaitRequest));

		Assert.Equal(HttpStatusCode.OK, snapshot.StatusCode);
		Assert.Equal(HttpStatusCode.OK, find.StatusCode);
		Assert.Equal(HttpStatusCode.OK, action.StatusCode);
		Assert.Equal(HttpStatusCode.OK, wait.StatusCode);
		var tree = await snapshot.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsUiSnapshot);
		var actionResult = await action.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsUiActionResult);
		var waitResult = await wait.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsUiWaitResult);
		Assert.Equal(WindowsUiControlTypes.Window, tree!.Root!.ControlType);
		Assert.True(actionResult!.Success);
		Assert.True(waitResult!.Satisfied);
	}

	[Fact]
	public async Task UiActionActivity_IsAddressedOnlyToItsOriginatingWindowsPanelAndRedactsText()
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Windows);
		using var listed = await SendAsync(HttpMethod.Get, "/api/v1/windows/windows", cookie);
		var candidates = await listed.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsWindowCandidateList);
		using var attached = await SendAsync(
			HttpMethod.Post,
			"/api/v1/windows/session/attach",
			cookie,
			JsonContent.Create(
				new WindowsAttachRequest { CandidateId = Assert.Single(candidates!.Windows).Id },
				WindowsJsonContext.Default.WindowsAttachRequest));
		var session = await attached.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsAppSession);
		var windowId = Assert.Single(session!.Windows).Id;
		bridge.OnAction = (_, request) => new WindowsUiActionResult
		{
			Success = true,
			Action = request.Action,
			Detail = "typed super-secret-text",
			Match = new WindowsUiMatch
			{
				Element = new WindowsUiElement
				{
					ControlType = WindowsUiControlTypes.Edit,
					Role = WindowsUiRoles.Field,
					Properties = new WindowsUiProperties
					{
						Password = true,
						Name = "Do not disclose",
						Value = "super-secret-text",
					},
				},
				Selector = new WindowsUiSelector
				{
					AutomationId = "password",
					ControlType = WindowsUiControlTypes.Edit,
				},
			},
		};
		var hub = app.Services.GetRequiredService<AutomationActivityHub>();
		using var origin = hub.Subscribe(
			new CanvasContextKey("session", "panel", CanvasSurfaces.Windows),
			out var originEvents);
		using var other = hub.Subscribe(
			new CanvasContextKey("session", "other", CanvasSurfaces.Windows),
			out var otherEvents);

		using var action = await SendAsync(
			HttpMethod.Post,
			$"/api/v1/windows/session/windows/{windowId}/ui/action",
			cookie,
			JsonContent.Create(
				new WindowsUiActionRequest
				{
					Action = WindowsUiActionKinds.SetValue,
					Value = "super-secret-text",
					Selector = new WindowsUiSelector
					{
						AutomationId = "password",
						ControlType = WindowsUiControlTypes.Edit,
					},
				},
				WindowsJsonContext.Default.WindowsUiActionRequest));
		var activity = await originEvents.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2));

		Assert.Equal(HttpStatusCode.OK, action.StatusCode);
		Assert.Equal(AutomationEventKinds.Semantic, activity.Kind);
		Assert.Equal("setValue password control", activity.Detail);
		Assert.Equal("super-secret-text".Length, activity.CharacterCount);
		Assert.DoesNotContain("super-secret-text", activity.Detail!, StringComparison.Ordinal);
		Assert.False(otherEvents.TryRead(out _));
	}

	[Fact]
	public async Task UiRoute_RejectsAWindowCapabilityMintedForAnotherPanel()
	{
		var first = await SignInAsync("panel-a", CanvasSurfaces.Windows);
		var second = await SignInAsync("panel-b", CanvasSurfaces.Windows);
		using var firstListed = await SendAsync(HttpMethod.Get, "/api/v1/windows/windows", first);
		var firstCandidates = await firstListed.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsWindowCandidateList);
		using var firstAttach = await SendAsync(
			HttpMethod.Post,
			"/api/v1/windows/session/attach",
			first,
			JsonContent.Create(
				new WindowsAttachRequest { CandidateId = Assert.Single(firstCandidates!.Windows).Id },
				WindowsJsonContext.Default.WindowsAttachRequest));
		var firstSession = await firstAttach.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsAppSession);
		var foreignWindow = Assert.Single(firstSession!.Windows).Id;

		using var secondListed = await SendAsync(HttpMethod.Get, "/api/v1/windows/windows", second);
		var secondCandidates = await secondListed.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsWindowCandidateList);
		using var secondAttach = await SendAsync(
			HttpMethod.Post,
			"/api/v1/windows/session/attach",
			second,
			JsonContent.Create(
				new WindowsAttachRequest { CandidateId = Assert.Single(secondCandidates!.Windows).Id },
				WindowsJsonContext.Default.WindowsAttachRequest));

		using var response = await SendAsync(
			HttpMethod.Post,
			$"/api/v1/windows/session/windows/{foreignWindow}/ui/find",
			second,
			JsonContent.Create(
				new WindowsUiQuery
				{
					Selector = new WindowsUiSelector
					{
						AutomationId = "save",
						ControlType = WindowsUiControlTypes.Button,
					},
				},
				WindowsJsonContext.Default.WindowsUiQuery));

		Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
		Assert.Equal(WindowsErrorCodes.WindowNotAuthorized, await ErrorCodeAsync(response));
	}

	private async Task<string> SignInAsync(string instanceId, string surface)
	{
		var result = await OpenCanvasAsync(instanceId, surface);
		var secret = new Uri(result.Url).Fragment.TrimStart('#')
			.Split('&')
			.Select(pair => pair.Split('=', 2))
			.Where(pair => pair[0] == "bootstrap")
			.Select(pair => Uri.UnescapeDataString(pair[1]))
			.Single();

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
		return response.Headers.GetValues("Set-Cookie").Single().Split(';', 2)[0];
	}

	private async Task<CanvasOpenResult> OpenCanvasAsync(string instanceId, string surface)
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
		return (await response.Content.ReadFromJsonAsync(
			DeviceJsonContext.Default.CanvasOpenResult))!;
	}

	private async Task<HttpResponseMessage> SendAsync(
		HttpMethod method,
		string path,
		string cookie,
		HttpContent? content = null)
	{
		using var request = new HttpRequestMessage(method, path) { Content = content };
		request.Headers.Add("Cookie", cookie);
		return await client.SendAsync(request);
	}

	[Fact]
	public async Task Screenshot_ReturnsPngBytesWithItsDescriptorBeside()
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Windows);
		var windowId = await AttachAsync(cookie);

		using var response = await SendAsync(
			HttpMethod.Get,
			$"/api/v1/windows/session/windows/{windowId}/screenshot",
			cookie);

		Assert.Equal(HttpStatusCode.OK, response.StatusCode);
		Assert.Equal("image/png", response.Content.Headers.ContentType?.MediaType);
		Assert.Equal(Fixtures.PngBytes, await response.Content.ReadAsByteArrayAsync());

		// The image travels as an image; its geometry travels beside it, because a coordinate read
		// off these pixels means nothing without the transform token.
		var descriptor = WindowsHostClient.DecodeDescriptor(response, Fixtures.PngBytes.Length);
		Assert.Equal(windowId, descriptor.WindowId);
		Assert.StartsWith("wct1_", descriptor.Geometry.TransformVersion, StringComparison.Ordinal);
		Assert.Equal(800, descriptor.Geometry.ContentWidth);
	}

	[Fact]
	public async Task Screenshot_PublishesActivityToItsOwnPanelOnly()
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Windows);
		var windowId = await AttachAsync(cookie);
		var hub = app.Services.GetRequiredService<AutomationActivityHub>();
		using var mine = hub.Subscribe(
			new CanvasContextKey("session", "panel", CanvasSurfaces.Windows),
			out var mineReader);
		using var theirs = hub.Subscribe(
			new CanvasContextKey("session", "other", CanvasSurfaces.Windows),
			out var theirsReader);

		using var response = await SendAsync(
			HttpMethod.Get,
			$"/api/v1/windows/session/windows/{windowId}/screenshot",
			cookie);

		Assert.Equal(HttpStatusCode.OK, response.StatusCode);
		Assert.True(mineReader.TryRead(out var observed));
		Assert.Equal(AutomationEventKinds.Screenshot, observed!.Kind);
		Assert.False(theirsReader.TryRead(out _));
	}

	[Fact]
	public async Task Input_ClickReachesTheServiceAndReportsItsPlace()
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Windows);
		var windowId = await AttachAsync(cookie);
		using var geometryResponse = await SendAsync(
			HttpMethod.Get,
			$"/api/v1/windows/session/windows/{windowId}/geometry",
			cookie);
		var geometry = await geometryResponse.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsCaptureGeometry);

		using var response = await SendAsync(
			HttpMethod.Post,
			$"/api/v1/windows/session/windows/{windowId}/input/click",
			cookie,
			JsonContent.Create(
				new WindowsClickRequest
				{
					TransformVersion = geometry!.TransformVersion,
					X = 12,
					Y = 34,
				},
				WindowsJsonContext.Default.WindowsClickRequest));

		Assert.Equal(HttpStatusCode.OK, response.StatusCode);
		var result = await response.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsInputResult);
		Assert.True(result!.Success);
		Assert.Equal("click:left", result.Operation);
		Assert.Equal(12, result.Point!.X);
	}

	[Fact]
	public async Task Input_RefusesAStaleTransformOverHttp()
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Windows);
		var windowId = await AttachAsync(cookie);

		using var response = await SendAsync(
			HttpMethod.Post,
			$"/api/v1/windows/session/windows/{windowId}/input/click",
			cookie,
			JsonContent.Create(
				new WindowsClickRequest { TransformVersion = "wct1_stale", X = 1, Y = 1 },
				WindowsJsonContext.Default.WindowsClickRequest));

		Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
		Assert.Equal(WindowsErrorCodes.InputTransformStale, await ErrorCodeAsync(response));
	}

	[Theory]
	[InlineData("GET", "/api/v1/windows/session/windows/win_other/screenshot")]
	[InlineData("GET", "/api/v1/windows/session/windows/win_other/geometry")]
	[InlineData("POST", "/api/v1/windows/session/windows/win_other/input/click")]
	[InlineData("POST", "/api/v1/windows/session/windows/win_other/input/pointer")]
	[InlineData("POST", "/api/v1/windows/session/windows/win_other/input/drag")]
	[InlineData("POST", "/api/v1/windows/session/windows/win_other/input/wheel")]
	[InlineData("POST", "/api/v1/windows/session/windows/win_other/input/key")]
	[InlineData("POST", "/api/v1/windows/session/windows/win_other/input/text")]
	[InlineData("GET", "/ws/windows/video")]
	[InlineData("GET", "/ws/windows/events")]
	public async Task MobilePanel_IsRefusedByEveryCaptureAndInputRoute(string method, string path)
	{
		var cookie = await SignInAsync("panel", CanvasSurfaces.Mobile);

		using var response = await SendAsync(new HttpMethod(method), path, cookie);

		Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
		Assert.Equal("surface_not_allowed", await ErrorCodeAsync(response));
	}

	[Fact]
	public async Task VideoSocket_RequiresAuthenticationAndAWebSocketUpgrade()
	{
		using var anonymous = await client.GetAsync("/ws/windows/video");
		var cookie = await SignInAsync("panel", CanvasSurfaces.Windows);
		await AttachAsync(cookie);
		using var authenticated = await SendAsync(HttpMethod.Get, "/ws/windows/video", cookie);

		Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
		// Authenticated, on the right surface, but a plain GET: the route exists and says what it
		// needs rather than pretending not to be there.
		Assert.Equal(HttpStatusCode.BadRequest, authenticated.StatusCode);
		Assert.Equal("invalid_request", await ErrorCodeAsync(authenticated));
	}

	/// <summary>
	/// The Windows panel has its own activity channel. Mobile's lives on the Mobile surface, so a
	/// Windows credential could never subscribe to it, and a panel with no channel would silently
	/// stop showing that an agent is driving its window.
	/// </summary>
	[Fact]
	public async Task ActivitySocket_IsAWindowsRouteOfItsOwn()
	{
		using var anonymous = await client.GetAsync("/ws/windows/events");
		var cookie = await SignInAsync("panel", CanvasSurfaces.Windows);
		using var authenticated = await SendAsync(HttpMethod.Get, "/ws/windows/events", cookie);
		using var mobileRoute = await SendAsync(HttpMethod.Get, "/ws/events", cookie);

		Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
		Assert.Equal(HttpStatusCode.BadRequest, authenticated.StatusCode);
		Assert.Equal("invalid_request", await ErrorCodeAsync(authenticated));
		Assert.Equal(HttpStatusCode.Forbidden, mobileRoute.StatusCode);
		Assert.Equal("surface_not_allowed", await ErrorCodeAsync(mobileRoute));
	}

	private async Task<string> AttachAsync(string cookie)
	{
		using var candidates = await SendAsync(HttpMethod.Get, "/api/v1/windows/windows", cookie);
		var listed = await candidates.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsWindowCandidateList);
		using var attached = await SendAsync(
			HttpMethod.Post,
			"/api/v1/windows/session/attach",
			cookie,
			JsonContent.Create(
				new WindowsAttachRequest { CandidateId = listed!.Windows[0].Id },
				WindowsJsonContext.Default.WindowsAttachRequest));
		attached.EnsureSuccessStatusCode();
		var session = await attached.Content.ReadFromJsonAsync(
			WindowsJsonContext.Default.WindowsAppSession);
		return session!.Windows[0].Id;
	}

	private async Task<HttpResponseMessage> ControlRequestAsync(HttpMethod method, string path)
	{
		using var request = new HttpRequestMessage(method, path);
		request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", ControlToken);
		return await client.SendAsync(request);
	}

	private static async Task<string?> ErrorCodeAsync(HttpResponseMessage response) =>
		JsonSerializer.Deserialize(
			await response.Content.ReadAsStringAsync(),
			DeviceJsonContext.Default.ApiError)?.Code;
}
