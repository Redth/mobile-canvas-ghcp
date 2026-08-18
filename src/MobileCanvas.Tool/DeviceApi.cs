using System.Globalization;
using System.Net;
using System.Net.WebSockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MobileCanvas.Contracts;
using MobileCanvas.Core;
using WindowsCanvas.Contracts;
using WindowsCanvas.Windows;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace MobileCanvas.Tool;

internal static class DeviceApi
{
	private const string SessionCookie = "mobile_device_session";

	/// <summary>
	/// Every route this module maps serves the Mobile Canvas product unless it is marked neutral.
	/// </summary>
	internal const string Surface = CanvasSurfaces.Mobile;

	public static void Map(WebApplication app)
	{
		app.Use(ValidateLoopbackRequest);
		app.Use(WriteApiErrors);
		app.Use(Authenticate);
		CanvasScope.UseSurfaceGuard(app, Surface);

		MapAssets(app);
		MapHost(app);
		MapCatalog(app);
		MapSelection(app);
		MapLifecycle(app);
		MapInput(app);
		MapUi(app);
		MapApps(app);
		MapDiagnostics(app);
		MapFiles(app);
		MapSettings(app);
		MapHardware(app);
		MapInterrupts(app);
		MapMedia(app);
	}

	private static async Task ValidateLoopbackRequest(HttpContext context, RequestDelegate next)
	{
		var host = context.Request.Host.Host;
		if (!host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase) &&
			!host.Equals("localhost", StringComparison.OrdinalIgnoreCase))
		{
			context.Response.StatusCode = StatusCodes.Status403Forbidden;
			return;
		}

		var origin = context.Request.Headers.Origin.ToString();
		if (!string.IsNullOrWhiteSpace(origin))
		{
			if (!Uri.TryCreate(origin, UriKind.Absolute, out var originUri) ||
				(!originUri.Host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase) &&
				 !originUri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)) ||
				originUri.Port != context.Request.Host.Port)
			{
				context.Response.StatusCode = StatusCodes.Status403Forbidden;
				return;
			}
		}
		await next(context).ConfigureAwait(false);
	}

	private static async Task WriteApiErrors(HttpContext context, RequestDelegate next)
	{
		try
		{
			await next(context).ConfigureAwait(false);
		}
		catch (Exception exception) when (!context.Response.HasStarted)
		{
			var (status, code) = exception switch
			{
				UnauthorizedAccessException => (StatusCodes.Status401Unauthorized, "unauthorized"),
				CanvasSurfaceException => (StatusCodes.Status403Forbidden, "surface_not_allowed"),
				// Windows failures already carry the status and machine-readable code the caller
				// should branch on, so they are passed through rather than re-derived here.
				WindowsCanvasException windows => (windows.Status, windows.Code),
				DeviceNotFoundException => (StatusCodes.Status404NotFound, "device_not_found"),
				ArgumentException => (StatusCodes.Status400BadRequest, "invalid_request"),
				DeviceCapabilityException or NotSupportedException =>
					(StatusCodes.Status409Conflict, "capability_not_supported"),
				ProcessExecutionException => (StatusCodes.Status502BadGateway, "device_command_failed"),
				InvalidOperationException => (StatusCodes.Status409Conflict, "invalid_operation"),
				_ => (StatusCodes.Status500InternalServerError, "host_error"),
			};
			context.Response.StatusCode = status;
			context.Response.ContentType = "application/json; charset=utf-8";
			await JsonSerializer.SerializeAsync(
				context.Response.Body,
				new ApiError { Code = code, Message = exception.Message },
				DeviceJsonContext.Default.ApiError,
				context.RequestAborted).ConfigureAwait(false);
		}
	}

	private static async Task Authenticate(HttpContext context, RequestDelegate next)
	{
		if (IsPublicRequest(context.Request))
		{
			await next(context).ConfigureAwait(false);
			return;
		}

		var security = context.RequestServices.GetRequiredService<HostSecurity>();
		var authorization = context.Request.Headers.Authorization.ToString();
		if (authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) &&
			FixedTimeEquals(authorization[7..], security.ControlToken))
		{
			CanvasScope.Attach(context, new CanvasRequestScope { HasControlToken = true });
			await next(context).ConfigureAwait(false);
			return;
		}

		var bootstraps = context.RequestServices.GetRequiredService<CanvasBootstrapStore>();
		if (context.Request.Cookies.TryGetValue(SessionCookie, out var session) &&
			bootstraps.TryGetSession(session, out var key))
		{
			CanvasScope.Attach(context, new CanvasRequestScope { Session = key });
			await next(context).ConfigureAwait(false);
			return;
		}

		context.Response.StatusCode = StatusCodes.Status401Unauthorized;
	}

	private static bool IsPublicRequest(HttpRequest request) =>
		IsPublicPath(request.Path);

	internal static bool IsPublicPath(PathString path) =>
		path == "/" ||
		path == "/annexb.js" ||
		path == "/canvas-state.js" ||
		path == "/create-device-options.js" ||
		path == "/device-canvas.js" ||
		path == "/device-canvas.css" ||
		path == "/api/v1/auth/bootstrap" ||
		// Exact paths, never a prefix: the Windows canvas shell and its modules, which a browser has
		// to load before it can trade its bootstrap secret for a scoped session.
		WindowsApi.IsPublicPath(path);

	private static void MapAssets(WebApplication app)
	{
		app.MapGet("/", () => EmbeddedAsset("index.html", "text/html; charset=utf-8"));
		// Annex-B framing is shared by both canvases, so it is served once from the root and
		// imported by each renderer rather than duplicated per surface.
		app.MapGet(
			"/annexb.js",
			() => EmbeddedAsset("annexb.js", "text/javascript; charset=utf-8")).SurfaceNeutral();
		app.MapGet(
			"/canvas-state.js",
			() => EmbeddedAsset("canvas-state.js", "text/javascript; charset=utf-8"));
		app.MapGet(
			"/create-device-options.js",
			() => EmbeddedAsset("create-device-options.js", "text/javascript; charset=utf-8"));
		app.MapGet(
			"/device-canvas.js",
			() => EmbeddedAsset("device-canvas.js", "text/javascript; charset=utf-8"));
		app.MapGet(
			"/device-canvas.css",
			() => EmbeddedAsset("device-canvas.css", "text/css; charset=utf-8"));
	}

	private static void MapHost(WebApplication app)
	{
		app.MapPost(
			"/api/v1/auth/bootstrap",
			(CanvasBootstrapRequest request, CanvasBootstrapStore store, HttpContext context) =>
			{
				var session = store.Exchange(request);
				context.Response.Cookies.Append(
					SessionCookie,
					session,
					new CookieOptions
					{
						HttpOnly = true,
						IsEssential = true,
						SameSite = SameSiteMode.Strict,
						Secure = false,
						Path = "/",
						MaxAge = CanvasBootstrapStore.CredentialLifetime,
					});
				return Results.NoContent();
			}).SurfaceNeutral();

		app.MapGet(
			"/api/v1/status",
			() => new HostHealth
			{
				Status = "ok",
				Version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0",
				ProcessId = Environment.ProcessId,
			}).SurfaceNeutral();

		app.MapPost(
			"/api/v1/host/stop",
			(HttpContext context, IHostApplicationLifetime lifetime) =>
			{
				CanvasScope.RequireControl(context);
				lifetime.StopApplication();
				return Results.Accepted();
			}).SurfaceNeutral();

		app.MapPost(
			"/api/v1/canvas/open",
			(CanvasOpenRequest request, CanvasBootstrapStore store, HttpContext context) =>
			{
				CanvasScope.RequireControl(context);
				CanvasScope.ValidateContext(request.SessionId, request.InstanceId);
				var surface = CanvasSurfaces.Normalize(request.Surface);
				var secret = store.Create(
					new CanvasContextKey(request.SessionId, request.InstanceId, surface));
				var fragment =
					$"bootstrap={Uri.EscapeDataString(secret)}" +
					$"&sessionId={Uri.EscapeDataString(request.SessionId)}" +
					$"&instanceId={Uri.EscapeDataString(request.InstanceId)}" +
					$"&surface={Uri.EscapeDataString(surface)}";
				return new CanvasOpenResult
				{
					Url = $"http://127.0.0.1:{context.Request.Host.Port}{CanvasPathFor(surface)}#{fragment}",
					Title = CanvasTitleFor(surface),
					Surface = surface,
				};
			}).SurfaceNeutral();

		app.MapPost(
			"/api/v1/canvas/close",
			(CanvasCloseRequest request, CanvasBootstrapStore store, DeviceService devices, HttpContext context) =>
			{
				CanvasScope.RequireControl(context);
				CanvasScope.ValidateContext(request.SessionId, request.InstanceId);
				var key = new CanvasContextKey(
					request.SessionId,
					request.InstanceId,
					CanvasSurfaces.Normalize(request.Surface));
				// Host applications restore an open renderer without invoking canvas.open again.
				// Keep its grant and selection until explicit detach, but rotate the browser session.
				store.Close(key);
				return Results.NoContent();
			}).SurfaceNeutral();

		app.MapPost(
			"/api/v1/canvas/detach",
			(CanvasBootstrapStore store, DeviceService devices, HttpContext context) =>
			{
				var key = CanvasScope.RequireContext(context);
				devices.Detach(key);
				// Detaching must drop the panel's Windows authorizations too. A canvas that goes
				// away with an app still attached would otherwise leave the grant behind for a
				// later panel with the same identifiers to inherit. Resolved optionally so a host
				// built without the Windows surface keeps working unchanged.
				context.RequestServices.GetService<WindowsAppService>()?.Detach(key);
				store.Detach(key);
				context.Response.Cookies.Delete(SessionCookie);
				return Results.NoContent();
			}).SurfaceNeutral();

		app.MapPost(
			"/api/v1/host/settings/{target}",
			async (
				string target,
				MacSystemSettingsLauncher settings,
				CancellationToken cancellationToken) =>
			{
				await settings.OpenAsync(target, cancellationToken).ConfigureAwait(false);
				return Results.NoContent();
			});
	}

	private static void MapCatalog(WebApplication app)
	{
		app.MapGet(
			"/api/v1/catalog",
			(DeviceService devices, CancellationToken cancellationToken) =>
				devices.GetCatalogAsync(cancellationToken));
		app.MapGet(
			"/api/v1/devices",
			(DeviceService devices, CancellationToken cancellationToken) =>
				devices.ListDevicesAsync(cancellationToken));
		app.MapGet(
			"/api/v1/devices/{deviceId}",
			(string deviceId, DeviceService devices, CancellationToken cancellationToken) =>
				devices.GetDeviceAsync(deviceId, cancellationToken));
		app.MapGet(
			"/api/v1/devices/{deviceId}/display",
			(string deviceId, DeviceService devices, CancellationToken cancellationToken) =>
				devices.GetDisplayAsync(deviceId, cancellationToken));
	}

	private static void MapSelection(WebApplication app)
	{
		app.MapGet(
			"/api/v1/selection",
			(HttpContext context, DeviceService devices, CancellationToken cancellationToken) =>
				devices.GetSelectionAsync(CanvasScope.RequireContext(context), cancellationToken));
		app.MapPost(
			"/api/v1/selection",
			async (SelectDeviceRequest request, HttpContext context, DeviceService devices, CancellationToken cancellationToken) =>
			{
				var key = CanvasScope.RequireContext(context);
				var device = await devices
					.SelectAsync(key, request.DeviceId, cancellationToken)
					.ConfigureAwait(false);
				// Announced even when the panel asked for it: the echo costs one ignored message and it
				// keeps every other view of the same canvas honest.
				PublishSelection(context, key, device.Id);
				return device;
			});
	}

	private static void MapLifecycle(WebApplication app)
	{
		app.MapPost(
			"/api/v1/devices",
			async (CreateDeviceRequest request, HttpContext context, DeviceService devices, CancellationToken cancellationToken) =>
			{
				var target = await devices.CreateAsync(request, cancellationToken).ConfigureAwait(false);
				return await SelectIfContextAsync(target, context, devices, cancellationToken)
					.ConfigureAwait(false);
			});
		app.MapPost(
			"/api/v1/devices/{deviceId}/boot",
			async (string deviceId, HttpContext context, DeviceService devices, CancellationToken cancellationToken) =>
			{
				var target = await devices.BootAsync(deviceId, cancellationToken).ConfigureAwait(false);
				return await SelectIfContextAsync(target, context, devices, cancellationToken)
					.ConfigureAwait(false);
			});
		app.MapPost(
			"/api/v1/devices/{deviceId}/shutdown",
			async (string deviceId, HttpContext context, DeviceService devices, CancellationToken cancellationToken) =>
			{
				var target = await devices.ShutdownAsync(deviceId, cancellationToken).ConfigureAwait(false);
				return await SelectIfContextAsync(target, context, devices, cancellationToken)
					.ConfigureAwait(false);
			});
		app.MapPost(
			"/api/v1/devices/{deviceId}/restart",
			async (string deviceId, HttpContext context, DeviceService devices, CancellationToken cancellationToken) =>
			{
				var target = await devices.RestartAsync(deviceId, cancellationToken).ConfigureAwait(false);
				return await SelectIfContextAsync(target, context, devices, cancellationToken)
					.ConfigureAwait(false);
			});
		app.MapPost(
			"/api/v1/devices/{deviceId}/reveal",
			async (string deviceId, HttpContext context, DeviceService devices, CancellationToken cancellationToken) =>
			{
				var target = await devices.RevealAsync(deviceId, cancellationToken).ConfigureAwait(false);
				return await SelectIfContextAsync(target, context, devices, cancellationToken)
					.ConfigureAwait(false);
			});
		app.MapPost(
			"/api/v1/devices/{deviceId}/erase",
			async (string deviceId, ConfirmedOperationRequest request, HttpContext context, DeviceService devices, CancellationToken cancellationToken) =>
			{
				var target = await devices.EraseAsync(
					deviceId,
					request.Confirm,
					cancellationToken).ConfigureAwait(false);
				return await SelectIfContextAsync(target, context, devices, cancellationToken)
					.ConfigureAwait(false);
			});
		app.MapDelete(
			"/api/v1/devices/{deviceId}",
			async (string deviceId, ConfirmedOperationRequest request, DeviceService devices, CancellationToken cancellationToken) =>
			{
				await devices.DeleteAsync(deviceId, request.Confirm, cancellationToken).ConfigureAwait(false);
				return Results.NoContent();
			});
	}

	private static void MapInput(WebApplication app)
	{
		app.MapPost(
			"/api/v1/devices/{deviceId}/input/tap",
			async (string deviceId, TapRequest request, DeviceService devices, HttpContext context, CancellationToken cancellationToken) =>
			{
				await PublishAutomationAsync(
					context,
					new AutomationEvent
					{
						// A long press is a tap with a dwell, so classify it here rather than making the
						// canvas infer intent from a duration threshold it would have to keep in sync.
						Kind = request.Duration >= LongPressSeconds
							? AutomationEventKinds.LongPress
							: AutomationEventKinds.Tap,
						DeviceId = deviceId,
						X = request.X,
						Y = request.Y,
						Duration = request.Duration,
					},
					devices,
					cancellationToken).ConfigureAwait(false);
				await devices.TapAsync(deviceId, request, cancellationToken).ConfigureAwait(false);
				return Results.NoContent();
			});
		app.MapPost(
			"/api/v1/devices/{deviceId}/input/touch",
			async (string deviceId, TouchRequest request, DeviceService devices, HttpContext context, CancellationToken cancellationToken) =>
			{
				await PublishAutomationAsync(
					context,
					new AutomationEvent
					{
						Kind = AutomationEventKinds.Touch,
						DeviceId = deviceId,
						X = request.X,
						Y = request.Y,
						Detail = request.Phase,
					},
					devices,
					cancellationToken).ConfigureAwait(false);
				await devices.TouchAsync(deviceId, request, cancellationToken).ConfigureAwait(false);
				return Results.NoContent();
			});
		app.MapPost(
			"/api/v1/devices/{deviceId}/input/swipe",
			async (string deviceId, SwipeRequest request, DeviceService devices, HttpContext context, CancellationToken cancellationToken) =>
			{
				await PublishAutomationAsync(
					context,
					new AutomationEvent
					{
						Kind = AutomationEventKinds.Swipe,
						DeviceId = deviceId,
						X = request.StartX,
						Y = request.StartY,
						EndX = request.EndX,
						EndY = request.EndY,
						Duration = request.Duration,
					},
					devices,
					cancellationToken).ConfigureAwait(false);
				await devices.SwipeAsync(deviceId, request, cancellationToken).ConfigureAwait(false);
				return Results.NoContent();
			});
		app.MapPost(
			"/api/v1/devices/{deviceId}/input/text",
			async (string deviceId, TextInputRequest request, DeviceService devices, HttpContext context, CancellationToken cancellationToken) =>
			{
				await PublishAutomationAsync(
					context,
					new AutomationEvent
					{
						Kind = AutomationEventKinds.Text,
						DeviceId = deviceId,
						Detail = request.Text,
					},
					devices,
					cancellationToken).ConfigureAwait(false);
				await devices.TypeTextAsync(deviceId, request.Text, cancellationToken).ConfigureAwait(false);
				return Results.NoContent();
			});
		app.MapPost(
			"/api/v1/devices/{deviceId}/input/key",
			async (string deviceId, KeyInputRequest request, DeviceService devices, HttpContext context, CancellationToken cancellationToken) =>
			{
				await PublishAutomationAsync(
					context,
					new AutomationEvent
					{
						Kind = AutomationEventKinds.Key,
						DeviceId = deviceId,
						Detail = request.KeyCode.ToString(CultureInfo.InvariantCulture),
					},
					devices,
					cancellationToken).ConfigureAwait(false);
				await devices.PressKeyAsync(deviceId, request.KeyCode, cancellationToken).ConfigureAwait(false);
				return Results.NoContent();
			});
		app.MapPost(
			"/api/v1/devices/{deviceId}/input/button",
			async (string deviceId, ButtonInputRequest request, DeviceService devices, HttpContext context, CancellationToken cancellationToken) =>
			{
				await PublishAutomationAsync(
					context,
					new AutomationEvent
					{
						Kind = AutomationEventKinds.Button,
						DeviceId = deviceId,
						Detail = request.Button,
					},
					devices,
					cancellationToken).ConfigureAwait(false);
				await devices.PressButtonAsync(deviceId, request.Button, cancellationToken).ConfigureAwait(false);
				return Results.NoContent();
			});
		app.MapPost(
			"/api/v1/devices/{deviceId}/input/rotate",
			async (string deviceId, RotateRequest request, DeviceService devices, HttpContext context, CancellationToken cancellationToken) =>
			{
				await PublishAutomationAsync(
					context,
					new AutomationEvent
					{
						Kind = AutomationEventKinds.Rotate,
						DeviceId = deviceId,
						Detail = request.Orientation,
					},
					devices,
					cancellationToken).ConfigureAwait(false);
				await devices.RotateAsync(deviceId, request.Orientation, cancellationToken).ConfigureAwait(false);
				return Results.NoContent();
			});
	}

	/// <summary>A tap held at least this long reads as a long press rather than a click.</summary>
	private const double LongPressSeconds = 0.45;

	/// <summary>
	/// Announces input that arrived on the control token, which means an agent, the CLI, or the
	/// canvas extension issued it. Canvas requests authenticate with a session cookie and are
	/// deliberately skipped, so a person tapping the panel never summons the remote-control cursor.
	///
	/// When the caller named a canvas, the event is addressed to that canvas alone and the target
	/// device also becomes that canvas's selection. Agents address devices by ID rather than by
	/// whatever the panel happens to be showing, and a panel that stayed behind would render a
	/// cursor over the wrong screen. Input that named no canvas reaches the panels on this endpoint's
	/// own surface, because it speaks for no panel in particular.
	/// </summary>
	private static async Task PublishAutomationAsync(
		HttpContext context,
		AutomationEvent activity,
		DeviceService devices,
		CancellationToken cancellationToken)
	{
		if (!CanvasScope.HasControlToken(context)) return;
		var key = CanvasScope.TryGetContext(context);
		if (key is null)
		{
			Hub(context).PublishToSurface(
				CanvasScope.RequiredSurface(context, Surface) ?? Surface,
				activity);
			return;
		}

		// Selection first: the panel then has the right device on screen before the gesture lands.
		if (!string.IsNullOrEmpty(activity.DeviceId) && devices.GetSelectedId(key) != activity.DeviceId)
		{
			await devices.SelectAsync(key, activity.DeviceId, cancellationToken).ConfigureAwait(false);
			PublishSelection(context, key, activity.DeviceId);
		}

		Hub(context).Publish(
			key,
			activity with
			{
				SessionId = key.SessionId,
				InstanceId = key.InstanceId,
				Surface = key.Surface,
			});
	}

	private static void PublishSelection(HttpContext context, CanvasContextKey key, string deviceId) =>
		Hub(context).Publish(key, new AutomationEvent
		{
			Kind = AutomationEventKinds.Selection,
			DeviceId = deviceId,
			SessionId = key.SessionId,
			InstanceId = key.InstanceId,
			Surface = key.Surface,
		});

	private static AutomationActivityHub Hub(HttpContext context) =>
		context.RequestServices.GetRequiredService<AutomationActivityHub>();

	private static void MapUi(WebApplication app)
	{
		app.MapGet(
			"/api/v1/devices/{deviceId}/ui",
			(string deviceId, bool? raw, DeviceService devices, CancellationToken cancellationToken) =>
				devices.GetUiSnapshotAsync(deviceId, raw ?? false, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/ui/find",
			(string deviceId, UiQuery query, DeviceService devices, CancellationToken cancellationToken) =>
				devices.FindUiElementsAsync(deviceId, query, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/ui/tap",
			async (string deviceId, UiQuery query, DeviceService devices, HttpContext context, CancellationToken cancellationToken) =>
			{
				var result = await devices.TapUiElementAsync(deviceId, query, cancellationToken)
					.ConfigureAwait(false);
				// Announced after the fact because the coordinates are not known until the element is
				// found, and the canvas animates a real point rather than the query that produced it.
				await PublishAutomationAsync(
					context,
					new AutomationEvent
					{
						Kind = AutomationEventKinds.Tap,
						DeviceId = deviceId,
						X = result.Match?.CenterX ?? 0,
						Y = result.Match?.CenterY ?? 0,
						Detail = result.Match?.Element.Label,
					},
					devices,
					cancellationToken).ConfigureAwait(false);
				return result;
			});
	}

	private static void MapApps(WebApplication app)
	{
		app.MapGet(
			"/api/v1/devices/{deviceId}/apps",
			(string deviceId, string? text, bool? system, int? limit, DeviceService devices, CancellationToken cancellationToken) =>
				devices.ListAppsAsync(
					deviceId,
					new AppQuery { Text = text, IncludeSystem = system ?? false, Limit = limit ?? 100 },
					cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/apps/launch",
			(string deviceId, AppLaunchRequest request, DeviceService devices, CancellationToken cancellationToken) =>
				devices.LaunchAppAsync(deviceId, request, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/apps/{bundleId}/terminate",
			(string deviceId, string bundleId, DeviceService devices, CancellationToken cancellationToken) =>
				devices.TerminateAppAsync(deviceId, bundleId, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/apps/install",
			(string deviceId, AppInstallRequest request, DeviceService devices, CancellationToken cancellationToken) =>
				devices.InstallAppAsync(deviceId, request, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/apps/{bundleId}/uninstall",
			(string deviceId, string bundleId, bool? confirm, DeviceService devices, CancellationToken cancellationToken) =>
				devices.UninstallAppAsync(deviceId, bundleId, confirm ?? false, cancellationToken));
	}

	private static void MapDiagnostics(WebApplication app)
	{
		app.MapGet(
			"/api/v1/devices/{deviceId}/log",
			(string deviceId, string? bundleId, string? level, string? text, int? seconds, int? limit,
				DeviceService devices, CancellationToken cancellationToken) =>
				devices.ReadLogAsync(
					deviceId,
					new LogQuery
					{
						BundleId = bundleId,
						MinimumLevel = level,
						Text = text,
						Since = TimeSpan.FromSeconds(seconds ?? 300),
						Limit = limit ?? 200,
					},
					cancellationToken));
		app.MapGet(
			"/api/v1/devices/{deviceId}/crashes",
			(string deviceId, string? text, int? limit, DeviceService devices, CancellationToken cancellationToken) =>
				devices.ListCrashesAsync(
					deviceId,
					new CrashQuery { Text = text, Limit = limit ?? 25 },
					cancellationToken));
		app.MapGet(
			"/api/v1/devices/{deviceId}/crashes/{crashId}",
			(string deviceId, string crashId, DeviceService devices, CancellationToken cancellationToken) =>
				devices.GetCrashAsync(deviceId, crashId, cancellationToken));
	}

	private static void MapFiles(WebApplication app)
	{
		app.MapGet(
			"/api/v1/devices/{deviceId}/files",
			(string deviceId, string? bundleId, string? path,
				DeviceService devices, CancellationToken cancellationToken) =>
				devices.ListFilesAsync(
					deviceId,
					new FileQuery { BundleId = bundleId, Path = path ?? "" },
					cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/files/pull",
			(string deviceId, FileTransferRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
				devices.PullFileAsync(deviceId, request, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/files/push",
			(string deviceId, FileTransferRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
				devices.PushFileAsync(deviceId, request, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/files/delete",
			(string deviceId, FileMutationRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
				devices.DeleteFileAsync(deviceId, request, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/files/mkdir",
			(string deviceId, FileMutationRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
				devices.CreateDirectoryAsync(deviceId, request, cancellationToken));
	}

	private static void MapSettings(WebApplication app)
	{
		app.MapGet(
			"/api/v1/devices/{deviceId}/permissions",
			(string deviceId, string bundleId, DeviceService devices, CancellationToken cancellationToken) =>
				devices.ListPermissionsAsync(deviceId, bundleId, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/permissions",
			(string deviceId, PermissionChangeRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
				devices.ChangePermissionAsync(deviceId, request, cancellationToken));
		app.MapGet(
			"/api/v1/devices/{deviceId}/settings",
			(string deviceId, DeviceService devices, CancellationToken cancellationToken) =>
				devices.GetSettingsAsync(deviceId, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/settings",
			(string deviceId, DeviceSettingsRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
				devices.UpdateSettingsAsync(deviceId, request, cancellationToken));
		app.MapGet(
			"/api/v1/devices/{deviceId}/app-ops",
			(string deviceId, string bundleId, DeviceService devices, CancellationToken cancellationToken) =>
				devices.ListAppOperationsAsync(deviceId, bundleId, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/app-ops",
			(string deviceId, AppOperationChangeRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
				devices.ChangeAppOperationAsync(deviceId, request, cancellationToken));
		app.MapGet(
			"/api/v1/devices/{deviceId}/presentation",
			(string deviceId, DeviceService devices, CancellationToken cancellationToken) =>
				devices.GetPresentationAsync(deviceId, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/presentation",
			(string deviceId, PresentationRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
				devices.SetPresentationAsync(deviceId, request, cancellationToken));
	}

	private static void MapHardware(WebApplication app)
	{
		app.MapGet(
			"/api/v1/devices/{deviceId}/hardware",
			(string deviceId, DeviceService devices, CancellationToken cancellationToken) =>
				devices.GetHardwareStateAsync(deviceId, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/hardware/location",
			async (string deviceId, DeviceLocationRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
			{
				await devices.SetLocationAsync(deviceId, request, cancellationToken);
				return Results.Ok(new OperationResult { Operation = "location-set" });
			});
		app.MapDelete(
			"/api/v1/devices/{deviceId}/hardware/location",
			async (string deviceId, DeviceService devices, CancellationToken cancellationToken) =>
			{
				await devices.ClearLocationAsync(deviceId, cancellationToken);
				return Results.Ok(new OperationResult { Operation = "location-clear" });
			});
		app.MapPost(
			"/api/v1/devices/{deviceId}/hardware/battery",
			(string deviceId, BatteryRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
				devices.SetBatteryAsync(deviceId, request, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/hardware/network",
			(string deviceId, NetworkRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
				devices.SetNetworkAsync(deviceId, request, cancellationToken));
	}

	private static void MapInterrupts(WebApplication app)
	{
		app.MapPost(
			"/api/v1/devices/{deviceId}/notifications",
			async (string deviceId, PushNotificationRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
			{
				await devices.SendPushNotificationAsync(deviceId, request, cancellationToken);
				return Results.Ok(new OperationResult { Operation = "notification-push" });
			});
		app.MapPost(
			"/api/v1/devices/{deviceId}/sms",
			async (string deviceId, SmsRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
			{
				await devices.SendSmsAsync(deviceId, request, cancellationToken);
				return Results.Ok(new OperationResult { Operation = "sms-send" });
			});
		app.MapGet(
			"/api/v1/devices/{deviceId}/calls",
			(string deviceId, DeviceService devices, CancellationToken cancellationToken) =>
				devices.GetCallsAsync(deviceId, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/calls",
			(string deviceId, CallRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
				devices.ChangeCallAsync(deviceId, request, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/biometric",
			(string deviceId, BiometricRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
				devices.SendBiometricAsync(deviceId, request, cancellationToken));
		app.MapGet(
			"/api/v1/devices/{deviceId}/clipboard",
			(string deviceId, DeviceService devices, CancellationToken cancellationToken) =>
				devices.GetClipboardAsync(deviceId, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/clipboard",
			(string deviceId, ClipboardRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
				devices.SetClipboardAsync(deviceId, request.Text, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/media",
			(string deviceId, MediaRequest request,
				DeviceService devices, CancellationToken cancellationToken) =>
				devices.AddMediaAsync(deviceId, request, cancellationToken));
	}

	private static void MapMedia(WebApplication app)
	{
		app.MapGet(
			"/api/v1/devices/{deviceId}/screenshot",
			async (string deviceId, DeviceService devices, HttpContext context, CancellationToken cancellationToken) =>
			{
				// Agents usually alternate act/observe, so a screenshot counts as activity. Without
				// this the overlay would flicker off during the observe half of every loop.
				await PublishAutomationAsync(
					context,
					new AutomationEvent
					{
						Kind = AutomationEventKinds.Screenshot,
						DeviceId = deviceId,
					},
					devices,
					cancellationToken).ConfigureAwait(false);
				var bytes = await devices.ScreenshotAsync(deviceId, cancellationToken).ConfigureAwait(false);
				return Results.File(bytes, "image/png");
			});
		app.MapPost(
			"/api/v1/devices/{deviceId}/recording/start",
			(string deviceId, RecordingStartRequest request, DeviceService devices, CancellationToken cancellationToken) =>
				devices.StartRecordingAsync(deviceId, request, cancellationToken));
		app.MapPost(
			"/api/v1/devices/{deviceId}/recording/stop",
			(string deviceId, DeviceService devices, CancellationToken cancellationToken) =>
				devices.StopRecordingAsync(deviceId, cancellationToken));
		app.MapGet(
			"/api/v1/devices/{deviceId}/recording",
			(string deviceId, DeviceService devices, CancellationToken cancellationToken) =>
				devices.GetRecordingStatusAsync(deviceId, cancellationToken));

		app.Map(
			"/ws/events",
			async context =>
			{
				var lifetime = context.RequestServices.GetRequiredService<IHostApplicationLifetime>();
				using var stopping = CancellationTokenSource.CreateLinkedTokenSource(
					context.RequestAborted,
					lifetime.ApplicationStopping);
				var cancellationToken = stopping.Token;
				if (!context.WebSockets.IsWebSocketRequest)
					throw new ArgumentException("A WebSocket upgrade is required.");

				var hub = context.RequestServices.GetRequiredService<AutomationActivityHub>();
				// A subscriber has to say which panel it is: events are addressed, and a socket that
				// named no canvas would either see everything or nothing. The cookie already answers
				// this for a canvas; the control token has to name a panel in the query string.
				using var subscription = hub.Subscribe(CanvasScope.RequireContext(context), out var reader);
				using var socket = await context.WebSockets.AcceptWebSocketAsync().ConfigureAwait(false);

				try
				{
					await foreach (var activity in reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
					{
						var payload = JsonSerializer.SerializeToUtf8Bytes(
							activity,
							DeviceJsonContext.Default.AutomationEvent);
						await socket.SendAsync(
							payload,
							WebSocketMessageType.Text,
							endOfMessage: true,
							cancellationToken).ConfigureAwait(false);
					}
				}
				catch (OperationCanceledException)
				{
					// The panel closed or the host is stopping; both are ordinary shutdowns.
				}
			});

		app.Map(
			"/ws/video",
			async context =>
			{
				var lifetime = context.RequestServices.GetRequiredService<IHostApplicationLifetime>();
				using var stopping = CancellationTokenSource.CreateLinkedTokenSource(
				context.RequestAborted,
				lifetime.ApplicationStopping);
				var cancellationToken = stopping.Token;
				if (!context.WebSockets.IsWebSocketRequest)
				throw new ArgumentException("A WebSocket upgrade is required.");
				var deviceId = context.Request.Query["deviceId"].ToString();
				if (string.IsNullOrWhiteSpace(deviceId))
					throw new ArgumentException("deviceId is required.");
				var fps = ParseInt(context.Request.Query["fps"], 30, 1, 60);
				// Scale controls how many pixels are encoded; the client derives it from the rendered
				// canvas size so a narrow side panel does not pay to encode a full 3x framebuffer.
				// Quality under motion is governed by StreamOptions.AverageBitrate, not by scale.
				var scale = ParseDouble(context.Request.Query["scale"], 1, 0.1, 1);
				var devices = context.RequestServices.GetRequiredService<DeviceService>();
				await using var video = await devices.OpenVideoStreamAsync(
					deviceId,
					new StreamOptions
					{
						FramesPerSecond = fps,
						Scale = scale,
					},
					cancellationToken).ConfigureAwait(false);
				using var socket = await context.WebSockets.AcceptWebSocketAsync().ConfigureAwait(false);
				var descriptor = JsonSerializer.SerializeToUtf8Bytes(
					video.Descriptor,
					DeviceJsonContext.Default.StreamDescriptor);
				await socket.SendAsync(
					descriptor,
					WebSocketMessageType.Text,
					endOfMessage: true,
					cancellationToken).ConfigureAwait(false);
				await foreach (var chunk in video.ReadAsync(cancellationToken)
					.WithCancellation(cancellationToken).ConfigureAwait(false))
				{
					await socket.SendAsync(
						chunk,
						WebSocketMessageType.Binary,
						endOfMessage: true,
						cancellationToken).ConfigureAwait(false);
				}
			});
	}

	private static IResult EmbeddedAsset(string fileName, string contentType)
	{
		var resourceName = $"MobileCanvas.Web.{fileName}";
		var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName)
			?? throw new InvalidOperationException($"Embedded asset '{fileName}' was not found.");
		return Results.Stream(stream, contentType);
	}

	/// <summary>
	/// Where a canvas of one surface is served from. Mobile keeps the root path every shipped
	/// client already opens; a new surface gets its own path rather than a query parameter, so the
	/// browser origin, the asset allowlist, and the page itself line up.
	/// </summary>
	private static string CanvasPathFor(string surface) =>
		surface.Equals(CanvasSurfaces.Windows, StringComparison.Ordinal)
			? WindowsApi.CanvasPath
			: "/";

	private static string CanvasTitleFor(string surface) =>
		surface.Equals(CanvasSurfaces.Windows, StringComparison.Ordinal)
			? CanvasTitles.WindowsPanel
			: CanvasTitles.Panel;

	private static async Task<DeviceTarget> SelectIfContextAsync(
		DeviceTarget target,
		HttpContext context,
		DeviceService devices,
		CancellationToken cancellationToken)
	{
		var key = CanvasScope.TryGetContext(context);
		if (key is null)
			return target;
		var device = await devices.SelectAsync(key, target.Id, cancellationToken).ConfigureAwait(false);
		PublishSelection(context, key, device.Id);
		return device;
	}

	private static bool FixedTimeEquals(string left, string right)
	{
		var leftBytes = Encoding.UTF8.GetBytes(left);
		var rightBytes = Encoding.UTF8.GetBytes(right);
		return leftBytes.Length == rightBytes.Length &&
			CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
	}

	private static int ParseInt(string? value, int fallback, int minimum, int maximum) =>
		int.TryParse(value, out var parsed) ? Math.Clamp(parsed, minimum, maximum) : fallback;

	private static double ParseDouble(string? value, double fallback, double minimum, double maximum) =>
		double.TryParse(value, out var parsed) ? Math.Clamp(parsed, minimum, maximum) : fallback;
}
