using System.Net.WebSockets;
using System.Reflection;
using System.Text.Json;
using MobileCanvas.Contracts;
using WindowsCanvas.Contracts;
using WindowsCanvas.Windows;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace MobileCanvas.Tool;

/// <summary>
/// The Windows App Canvas HTTP surface. It is a separate module from <see cref="DeviceApi"/> on
/// purpose: the two products share a host process, a loopback listener, and a bootstrap flow, but
/// nothing else. Every route here is tagged with the Windows surface, so the shared scope guard
/// refuses a Mobile Canvas credential before a handler ever runs, and every session or window
/// route resolves through <see cref="WindowsAppService"/> rather than touching a handle itself.
///
/// This module maps routes only. The pipeline it runs in — loopback validation, error shaping,
/// authentication, and the surface guard — is installed once by <see cref="DeviceApi.Map"/>.
/// </summary>
internal static class WindowsApi
{
	internal const string Surface = CanvasSurfaces.Windows;

	/// <summary>
	/// Response header that carries a screenshot's descriptor beside its bytes. Base64 of the
	/// descriptor JSON, so the image stays an image and the geometry still reaches the caller.
	/// </summary>
	internal const string DescriptorHeader = WindowsCaptureHeaders.Descriptor;

	/// <summary>The canvas open URL for this surface. Mobile keeps the root path it has always had.</summary>
	internal const string CanvasPath = "/windows/";

	/// <summary>
	/// The renderer's own assets, listed exactly. This is an allowlist of complete paths rather than
	/// a prefix: making "/windows/" unauthenticated as a prefix would put every future file under it
	/// outside the credential check by default.
	/// </summary>
	private static readonly (string Path, string Resource, string ContentType)[] Assets =
	[
		(CanvasPath, "windows.index.html", "text/html; charset=utf-8"),
		("/windows/windows-canvas.css", "windows.windows-canvas.css", "text/css; charset=utf-8"),
		("/windows/windows-canvas.js", "windows.windows-canvas.js", "text/javascript; charset=utf-8"),
		("/windows/windows-state.js", "windows.windows-state.js", "text/javascript; charset=utf-8"),
	];

	public static void Map(WebApplication app)
	{
		MapAssets(app);
		MapCapabilities(app);
		MapDiscovery(app);
		MapSession(app);
		MapWindows(app);
		MapUiAutomation(app);
		MapCapture(app);
		MapInput(app);
		MapActivity(app);
	}

	/// <summary>
	/// The Windows paths served without a credential, each an exact path rather than a prefix. A
	/// browser has to load the shell and its modules before it can exchange its bootstrap secret for
	/// a session, exactly as the Mobile canvas does at "/".
	/// </summary>
	internal static bool IsPublicPath(PathString path) =>
		Array.Exists(Assets, asset => path == asset.Path);

	private static void MapAssets(WebApplication app)
	{
		foreach (var (path, resource, contentType) in Assets)
			app.MapGet(path, () => EmbeddedAsset(resource, contentType)).WindowsSurface();
	}

	private static void MapCapabilities(WebApplication app) =>
		app.MapGet(
			"/api/v1/windows/capabilities",
			(WindowsAppService windows, CancellationToken cancellationToken) =>
				windows.GetPreflightAsync(cancellationToken)).WindowsSurface();

	private static void MapDiscovery(WebApplication app)
	{
		app.MapGet(
			"/api/v1/windows/apps",
			(
				string? text,
				int? limit,
				bool? ambiguous,
				WindowsAppService windows,
				CancellationToken cancellationToken) =>
				windows.ListCatalogAsync(
					new WindowsCatalogQuery
					{
						Text = text,
						Limit = limit ?? 100,
						AmbiguousOnly = ambiguous ?? false,
					},
					cancellationToken)).WindowsSurface();

		app.MapGet(
			"/api/v1/windows/windows",
			(HttpContext context, WindowsAppService windows, CancellationToken cancellationToken) =>
				windows.ListWindowCandidatesAsync(
					CanvasScope.RequireContext(context),
					cancellationToken)).WindowsSurface();

		// A preview of a window the panel was offered, so a picker can show what a window looks
		// like before anybody attaches it. It lives under the discovery path rather than the
		// session path on purpose: there is no session yet, and nothing here creates one. The image
		// travels as an image and its descriptor travels beside it in the same header a screenshot
		// uses, except that the identifier it names is the candidate ID, not an authorized window.
		app.MapGet(
			"/api/v1/windows/windows/{candidateId}/thumbnail",
			async (
				string candidateId,
				int? maximumDimension,
				HttpContext context,
				WindowsAppService windows,
				CancellationToken cancellationToken) =>
			{
				var thumbnail = await windows.CaptureCandidateThumbnailAsync(
					CanvasScope.RequireContext(context),
					candidateId,
					maximumDimension ?? 0,
					cancellationToken).ConfigureAwait(false);

				// Deliberately no activity event: looking at a picker card is not an agent driving
				// somebody's desktop, and lighting the automation overlay for it would say it was.
				context.Response.Headers[DescriptorHeader] = EncodeDescriptor(thumbnail.Descriptor);
				return Results.File(thumbnail.Png, "image/png");
			}).WindowsSurface();
	}

	private static void MapSession(WebApplication app)
	{
		app.MapPost(
			"/api/v1/windows/session/launch",
			(
				WindowsCatalogLaunchRequest request,
				HttpContext context,
				WindowsAppService windows,
				CancellationToken cancellationToken) =>
				windows.LaunchCatalogAppAsync(
					CanvasScope.RequireContext(context),
					request,
					cancellationToken)).WindowsSurface();

		app.MapPost(
			"/api/v1/windows/session/launch-executable",
			(
				WindowsExecutableLaunchRequest request,
				HttpContext context,
				WindowsAppService windows,
				CancellationToken cancellationToken) =>
				windows.LaunchExecutableAsync(
					CanvasScope.RequireContext(context),
					request,
					cancellationToken)).WindowsSurface();

		app.MapPost(
			"/api/v1/windows/session/attach",
			(
				WindowsAttachRequest request,
				HttpContext context,
				WindowsAppService windows,
				CancellationToken cancellationToken) =>
				windows.AttachAsync(
					CanvasScope.RequireContext(context),
					request,
					cancellationToken)).WindowsSurface();

		app.MapGet(
			"/api/v1/windows/session",
			(HttpContext context, WindowsAppService windows, CancellationToken cancellationToken) =>
				windows.GetSelectionAsync(
					CanvasScope.RequireContext(context),
					cancellationToken)).WindowsSurface();

		app.MapPost(
			"/api/v1/windows/session/release",
			(HttpContext context, WindowsAppService windows, CancellationToken cancellationToken) =>
				windows.ReleaseAsync(
					CanvasScope.RequireContext(context),
					cancellationToken)).WindowsSurface();
	}

	private static void MapWindows(WebApplication app)
	{
		app.MapGet(
			"/api/v1/windows/session/windows",
			(HttpContext context, WindowsAppService windows, CancellationToken cancellationToken) =>
				windows.ListSessionWindowsAsync(
					CanvasScope.RequireContext(context),
					cancellationToken)).WindowsSurface();

		app.MapPost(
			"/api/v1/windows/session/windows/select",
			(
				WindowsSelectWindowRequest request,
				HttpContext context,
				WindowsAppService windows,
				CancellationToken cancellationToken) =>
				windows.SelectWindowAsync(
					CanvasScope.RequireContext(context),
					request,
					cancellationToken)).WindowsSurface();

		app.MapPost(
			"/api/v1/windows/session/windows/reveal",
			(
				WindowsWindowActionRequest? request,
				HttpContext context,
				WindowsAppService windows,
				CancellationToken cancellationToken) =>
				windows.RevealAsync(
					CanvasScope.RequireContext(context),
					request,
					cancellationToken)).WindowsSurface();

		app.MapPost(
			"/api/v1/windows/session/windows/restore",
			(
				WindowsWindowActionRequest? request,
				HttpContext context,
				WindowsAppService windows,
				CancellationToken cancellationToken) =>
				windows.RestoreAsync(
					CanvasScope.RequireContext(context),
					request,
					cancellationToken)).WindowsSurface();
	}

	private static void MapUiAutomation(WebApplication app)
	{
		app.MapGet(
			"/api/v1/windows/session/windows/{windowId}/ui/snapshot",
			(
				string windowId,
				int? maximumDepth,
				int? maximumNodes,
				int? timeoutMilliseconds,
				HttpContext context,
				WindowsAppService windows,
				CancellationToken cancellationToken) =>
				windows.GetUiSnapshotAsync(
					CanvasScope.RequireContext(context),
					windowId,
					new WindowsUiSnapshotRequest
					{
						MaximumDepth = maximumDepth ?? 0,
						MaximumNodes = maximumNodes ?? 0,
						TimeoutMilliseconds = timeoutMilliseconds ?? 0,
					},
					cancellationToken)).WindowsSurface();

		app.MapPost(
			"/api/v1/windows/session/windows/{windowId}/ui/find",
			(
				string windowId,
				WindowsUiQuery request,
				HttpContext context,
				WindowsAppService windows,
				CancellationToken cancellationToken) =>
				windows.FindUiAsync(
					CanvasScope.RequireContext(context),
					windowId,
					request,
					cancellationToken)).WindowsSurface();

		app.MapPost(
			"/api/v1/windows/session/windows/{windowId}/ui/action",
			async (
				string windowId,
				WindowsUiActionRequest request,
				HttpContext context,
				WindowsAppService windows,
				AutomationActivityHub activity,
				CancellationToken cancellationToken) =>
			{
				var key = CanvasScope.RequireContext(context);
				var result = await windows.ActUiAsync(key, windowId, request, cancellationToken)
					.ConfigureAwait(false);
				PublishSemanticActivity(activity, key, windowId, result);
				return result;
			}).WindowsSurface();

		app.MapPost(
			"/api/v1/windows/session/windows/{windowId}/ui/wait",
			async (
				string windowId,
				WindowsUiWaitRequest request,
				HttpContext context,
				WindowsAppService windows,
				AutomationActivityHub activity,
				CancellationToken cancellationToken) =>
			{
				var key = CanvasScope.RequireContext(context);
				var result = await windows.WaitUiAsync(key, windowId, request, cancellationToken)
					.ConfigureAwait(false);
				PublishSemanticActivity(activity, key, windowId, result);
				return result;
			}).WindowsSurface();
	}

	/// <summary>
	/// Still frames and live video.
	///
	/// A screenshot answers with the PNG itself, because that is what a browser and an agent both
	/// want, and carries its descriptor in a base64 response header rather than wrapping the image
	/// in JSON. The descriptor is what makes the pixels mean something: without its geometry and
	/// transform token, a coordinate read off the image is a guess.
	/// </summary>
	private static void MapCapture(WebApplication app)
	{
		app.MapGet(
			"/api/v1/windows/session/windows/{windowId}/screenshot",
			async (
				string windowId,
				double? scale,
				int? maximumDimension,
				bool? cursor,
				HttpContext context,
				WindowsAppService windows,
				AutomationActivityHub activity,
				CancellationToken cancellationToken) =>
			{
				var key = CanvasScope.RequireContext(context);
				var screenshot = await windows.CaptureScreenshotAsync(
					key,
					new WindowsScreenshotRequest
					{
						WindowId = windowId,
						Scale = scale ?? WindowsCaptureLimits.DefaultScale,
						MaximumDimension = maximumDimension ?? 0,
						IncludeCursor = cursor ?? false,
					},
					cancellationToken).ConfigureAwait(false);

				// Observing counts as activity: an agent alternates acting and looking, and without
				// this the panel's overlay would blink off during every look.
				activity.Publish(
					key,
					new AutomationEvent
					{
						Kind = AutomationEventKinds.Screenshot,
						DeviceId = screenshot.Descriptor.WindowId,
						SessionId = key.SessionId,
						InstanceId = key.InstanceId,
						Surface = key.Surface,
					});

				context.Response.Headers[DescriptorHeader] = EncodeDescriptor(screenshot.Descriptor);
				return Results.File(screenshot.Png, "image/png");
			}).WindowsSurface();

		app.MapGet(
			"/api/v1/windows/session/windows/{windowId}/geometry",
			(
				string windowId,
				HttpContext context,
				WindowsAppService windows,
				CancellationToken cancellationToken) =>
				windows.GetGeometryAsync(
					CanvasScope.RequireContext(context),
					windowId,
					cancellationToken)).WindowsSurface();

		app.Map(
			"/ws/windows/video",
			async context =>
			{
				var lifetime = context.RequestServices.GetRequiredService<IHostApplicationLifetime>();
				using var stopping = CancellationTokenSource.CreateLinkedTokenSource(
					context.RequestAborted,
					lifetime.ApplicationStopping);
				var cancellationToken = stopping.Token;
				if (!context.WebSockets.IsWebSocketRequest)
					throw new ArgumentException("A WebSocket upgrade is required.");

				var key = CanvasScope.RequireContext(context);
				var windows = context.RequestServices.GetRequiredService<WindowsAppService>();
				var windowId = context.Request.Query["windowId"].ToString();
				await using var video = await windows.OpenVideoStreamAsync(
					key,
					new WindowsStreamRequest
					{
						WindowId = string.IsNullOrWhiteSpace(windowId) ? null : windowId,
						FramesPerSecond = ParseInt(
							context.Request.Query["fps"],
							WindowsCaptureLimits.DefaultFramesPerSecond,
							WindowsCaptureLimits.MinimumFramesPerSecond,
							WindowsCaptureLimits.MaximumFramesPerSecond),
						// Scale controls how many pixels are encoded, not the coordinate space: the
						// descriptor reports both sizes so a scaled stream stays clickable.
						Scale = ParseDouble(
							context.Request.Query["scale"],
							WindowsCaptureLimits.DefaultScale,
							WindowsCaptureLimits.MinimumScale,
							WindowsCaptureLimits.MaximumScale),
						AverageBitrate = ParseLong(
							context.Request.Query["bitrate"],
							WindowsCaptureLimits.DefaultBitrate,
							WindowsCaptureLimits.MinimumBitrate,
							WindowsCaptureLimits.MaximumBitrate),
						IncludeCursor = context.Request.Query["cursor"] == "true",
					},
					cancellationToken).ConfigureAwait(false);

				using var socket = await context.WebSockets.AcceptWebSocketAsync()
					.ConfigureAwait(false);
				await SendJsonAsync(
					socket,
					JsonSerializer.SerializeToUtf8Bytes(
						video.Descriptor,
						WindowsJsonContext.Default.WindowsStreamDescriptor),
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

				// A stream always ends for a stated reason. The browser needs it to decide between
				// reconnecting for a fresh descriptor and keyframe, and showing an error.
				await SendJsonAsync(
					socket,
					JsonSerializer.SerializeToUtf8Bytes(
						video.End,
						WindowsJsonContext.Default.WindowsStreamEnd),
					cancellationToken).ConfigureAwait(false);
			}).WindowsSurface();
	}

	/// <summary>
	/// Screenshot-guided pointer and keyboard input.
	///
	/// Every route here is a fallback for content that has no semantic tree; the UI Automation
	/// routes above are the preferred path. Each request carries the transform token it measured
	/// against, and the service refuses a stale one rather than clicking where that place used to
	/// be.
	/// </summary>
	private static void MapInput(WebApplication app)
	{
		app.MapPost(
			"/api/v1/windows/session/windows/{windowId}/input/click",
			(
				string windowId,
				WindowsClickRequest request,
				HttpContext context,
				WindowsAppService windows,
				AutomationActivityHub activity,
				CancellationToken cancellationToken) =>
				InputAsync(
					context,
					activity,
					key => windows.ClickAsync(
						key,
						request with { WindowId = windowId },
						cancellationToken))).WindowsSurface();

		app.MapPost(
			"/api/v1/windows/session/windows/{windowId}/input/pointer",
			(
				string windowId,
				WindowsPointerRequest request,
				HttpContext context,
				WindowsAppService windows,
				AutomationActivityHub activity,
				CancellationToken cancellationToken) =>
				InputAsync(
					context,
					activity,
					key => windows.PointerAsync(
						key,
						request with { WindowId = windowId },
						cancellationToken))).WindowsSurface();

		app.MapPost(
			"/api/v1/windows/session/windows/{windowId}/input/drag",
			(
				string windowId,
				WindowsDragRequest request,
				HttpContext context,
				WindowsAppService windows,
				AutomationActivityHub activity,
				CancellationToken cancellationToken) =>
				InputAsync(
					context,
					activity,
					key => windows.DragAsync(
						key,
						request with { WindowId = windowId },
						cancellationToken))).WindowsSurface();

		app.MapPost(
			"/api/v1/windows/session/windows/{windowId}/input/wheel",
			(
				string windowId,
				WindowsWheelRequest request,
				HttpContext context,
				WindowsAppService windows,
				AutomationActivityHub activity,
				CancellationToken cancellationToken) =>
				InputAsync(
					context,
					activity,
					key => windows.WheelAsync(
						key,
						request with { WindowId = windowId },
						cancellationToken))).WindowsSurface();

		app.MapPost(
			"/api/v1/windows/session/windows/{windowId}/input/key",
			(
				string windowId,
				WindowsKeyRequest request,
				HttpContext context,
				WindowsAppService windows,
				AutomationActivityHub activity,
				CancellationToken cancellationToken) =>
				InputAsync(
					context,
					activity,
					key => windows.KeyAsync(
						key,
						request with { WindowId = windowId },
						cancellationToken))).WindowsSurface();

		app.MapPost(
			"/api/v1/windows/session/windows/{windowId}/input/text",
			(
				string windowId,
				WindowsTypeTextRequest request,
				HttpContext context,
				WindowsAppService windows,
				AutomationActivityHub activity,
				CancellationToken cancellationToken) =>
				InputAsync(
					context,
					activity,
					key => windows.TypeTextAsync(
						key,
						request with { WindowId = windowId },
						cancellationToken))).WindowsSurface();
	}

	/// <summary>
	/// The Windows panel's agent-activity channel.
	///
	/// It is a separate route from the Mobile one rather than a shared socket, because the surface
	/// guard is what keeps a Windows credential off Mobile endpoints and a shared route would have
	/// to be neutral to serve both. The hub already partitions delivery by canvas context and
	/// surface, so a subscriber here receives only its own panel's Windows activity.
	/// </summary>
	private static void MapActivity(WebApplication app) =>
		app.Map(
			"/ws/windows/events",
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
				using var subscription = hub.Subscribe(
					CanvasScope.RequireContext(context),
					out var reader);
				using var socket = await context.WebSockets.AcceptWebSocketAsync()
					.ConfigureAwait(false);

				try
				{
					await foreach (var activity in reader.ReadAllAsync(cancellationToken)
						.ConfigureAwait(false))
					{
						await socket.SendAsync(
							JsonSerializer.SerializeToUtf8Bytes(
								activity,
								DeviceJsonContext.Default.AutomationEvent),
							WebSocketMessageType.Text,
							endOfMessage: true,
							cancellationToken).ConfigureAwait(false);
					}
				}
				catch (OperationCanceledException)
				{
					// A canvas closing its panel is the ordinary way this socket ends.
				}
			}).WindowsSurface();

	private static async Task<WindowsInputResult> InputAsync(
		HttpContext context,
		AutomationActivityHub activity,
		Func<CanvasContextKey, Task<WindowsInputResult>> operation)
	{
		var key = CanvasScope.RequireContext(context);
		var result = await operation(key).ConfigureAwait(false);
		PublishInputActivity(activity, key, result);
		return result;
	}

	/// <summary>
	/// Tells one panel that an agent is driving its window.
	///
	/// The event carries where the pointer went and a safe label for what happened. It never
	/// carries typed text or key names: a Windows canvas types into the user's real session, where
	/// the same field could hold a password. Text reports only how many characters it was.
	/// </summary>
	private static void PublishInputActivity(
		AutomationActivityHub activity,
		CanvasContextKey key,
		WindowsInputResult result)
	{
		var (kind, detail) = DescribeInput(result);
		activity.Publish(
			key,
			new AutomationEvent
			{
				Kind = kind,
				DeviceId = result.WindowId,
				X = result.Point?.X,
				Y = result.Point?.Y,
				EndX = result.EndPoint?.X,
				EndY = result.EndPoint?.Y,
				Detail = detail,
				CharacterCount = result.CharacterCount,
				// The panel this belongs to travels with the event. A renderer applies its own gate
				// on top of the hub's addressing, and an event with no identity would be dropped.
				SessionId = key.SessionId,
				InstanceId = key.InstanceId,
				Surface = key.Surface,
			});
	}

	private static (string Kind, string? Detail) DescribeInput(WindowsInputResult result)
	{
		var operation = result.Operation;
		if (operation.StartsWith("text", StringComparison.Ordinal))
			return (AutomationEventKinds.Text, null);
		if (operation.StartsWith("key:", StringComparison.Ordinal))
		{
			// Key names are omitted on purpose: a per-character key request would otherwise spell
			// out exactly what a text request is careful not to disclose.
			var action = operation["key:".Length..];
			return (
				AutomationEventKinds.Key,
				$"{action} {result.KeyCount ?? 0} key{(result.KeyCount == 1 ? "" : "s")}");
		}
		if (operation.StartsWith("drag", StringComparison.Ordinal))
			return (AutomationEventKinds.Drag, operation);
		if (operation.StartsWith("wheel", StringComparison.Ordinal))
			return (AutomationEventKinds.Wheel, operation);
		if (operation.StartsWith("pointer:", StringComparison.Ordinal))
			return (AutomationEventKinds.Pointer, operation);
		return (AutomationEventKinds.Tap, operation);
	}

	/// <summary>
	/// The screenshot descriptor, base64-encoded so a header can never carry a control character
	/// or a line break that a helper's diagnostic text happened to contain.
	/// </summary>
	internal static string EncodeDescriptor(WindowsScreenshotDescriptor descriptor) =>
		Convert.ToBase64String(
			JsonSerializer.SerializeToUtf8Bytes(
				descriptor,
				WindowsJsonContext.Default.WindowsScreenshotDescriptor));

	private static async Task SendJsonAsync(
		WebSocket socket,
		byte[] payload,
		CancellationToken cancellationToken) =>
		await socket.SendAsync(
			payload,
			WebSocketMessageType.Text,
			endOfMessage: true,
			cancellationToken).ConfigureAwait(false);

	private static int ParseInt(string? value, int fallback, int minimum, int maximum) =>
		int.TryParse(value, out var parsed) ? Math.Clamp(parsed, minimum, maximum) : fallback;

	private static long ParseLong(string? value, long fallback, long minimum, long maximum) =>
		long.TryParse(value, out var parsed) ? Math.Clamp(parsed, minimum, maximum) : fallback;

	private static double ParseDouble(string? value, double fallback, double minimum, double maximum) =>
		double.TryParse(value, out var parsed) ? Math.Clamp(parsed, minimum, maximum) : fallback;

	private static void PublishSemanticActivity(
		AutomationActivityHub activity,
		CanvasContextKey key,
		string windowId,
		WindowsUiActionResult result) =>		PublishSemanticActivity(
			activity,
			key,
			windowId,
			result.Action,
			result.Match?.Element,
			result.ValueLength);

	private static void PublishSemanticActivity(
		AutomationActivityHub activity,
		CanvasContextKey key,
		string windowId,
		WindowsUiWaitResult result) =>
		PublishSemanticActivity(
			activity,
			key,
			windowId,
			$"wait:{result.Condition}",
			result.Match?.Element,
			characterCount: null);

	private static void PublishSemanticActivity(
		AutomationActivityHub activity,
		CanvasContextKey key,
		string windowId,
		string operation,
		WindowsUiElement? element,
		int? characterCount)
	{
		// The hub addresses this exact context (including the Windows surface). Never put a typed
		// value in Detail: SetValue only reports its count, and a password or absent element gets a
		// generic target even when a buggy provider returned a name.
		var detail = DescribeSemanticTarget(operation, element);
		activity.Publish(
			key,
			new AutomationEvent
			{
				Kind = AutomationEventKinds.Semantic,
				DeviceId = windowId,
				Detail = detail,
				CharacterCount = characterCount,
				SessionId = key.SessionId,
				InstanceId = key.InstanceId,
				Surface = key.Surface,
			});
	}

	private static string DescribeSemanticTarget(string operation, WindowsUiElement? element)
	{
		if (element?.Properties.Password == true)
			return $"{operation} password control";
		if (element is not null && element.Properties.Password != false)
			return $"{operation} protected control";

		var role = SafeActivityText(element?.Role, 48);
		var name = element?.Properties.Name;
		name = SafeActivityText(name, 96);
		if (role is not null && name is not null)
			return $"{operation} {role} '{name}'";
		if (role is not null)
			return $"{operation} {role}";
		return $"{operation} control";
	}

	private static string? SafeActivityText(string? value, int maximumLength)
	{
		if (string.IsNullOrWhiteSpace(value))
			return null;
		var trimmed = value.Trim();
		if (trimmed.Any(char.IsControl))
			return null;
		return trimmed.Length <= maximumLength ? trimmed : trimmed[..maximumLength];
	}

	private static IResult EmbeddedAsset(string name, string contentType)
	{
		var resourceName = $"MobileCanvas.Web.{name}";
		var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName)
			?? throw new InvalidOperationException(
				$"Embedded asset '{resourceName}' was not found.");
		return Results.Stream(stream, contentType);
	}
}

internal static class WindowsEndpointConventions
{
	/// <summary>
	/// Declares that an endpoint belongs to the Windows surface. The guard reads this metadata, so
	/// a route that moves or is added later keeps its scope without anyone remembering a path
	/// prefix.
	/// </summary>
	public static TBuilder WindowsSurface<TBuilder>(this TBuilder builder)
		where TBuilder : IEndpointConventionBuilder
	{
		builder.WithMetadata(new CanvasSurfaceRequirement(CanvasSurfaces.Windows));
		return builder;
	}
}
