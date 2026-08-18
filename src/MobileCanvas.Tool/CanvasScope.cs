using MobileCanvas.Contracts;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace MobileCanvas.Tool;

/// <summary>
/// Raised when an authenticated caller is scoped to a different product surface than the endpoint
/// it asked for. This is an authorization failure rather than an authentication failure: the
/// credential is valid, it just was not issued for this product.
/// </summary>
internal sealed class CanvasSurfaceException(string message) : Exception(message);

/// <summary>
/// The product surface an endpoint belongs to, attached as endpoint metadata. Guards read this
/// instead of inspecting request paths: a route that moves, or a route added later, must not
/// silently lose its scope because a handler stopped matching a path prefix.
/// </summary>
internal sealed record CanvasSurfaceRequirement(string? Surface)
{
	/// <summary>Endpoints that belong to every product, such as health and bootstrap.</summary>
	public static readonly CanvasSurfaceRequirement Neutral = new((string?)null);
}

/// <summary>
/// Who a request is authenticated as: the host control token, a browser session bound to one
/// canvas panel, or both. Resolved once per request so the guard and the handlers agree.
/// </summary>
internal sealed class CanvasRequestScope
{
	public bool HasControlToken { get; init; }

	/// <summary>The panel a browser session cookie was issued to.</summary>
	public CanvasContextKey? Session { get; init; }
}

internal static class CanvasScope
{
	private const string ScopeItem = "mobile-canvas-scope";
	private const string ContextItem = "mobile-canvas-context";

	public static void Attach(HttpContext context, CanvasRequestScope scope) =>
		context.Items[ScopeItem] = scope;

	public static CanvasRequestScope? TryGetScope(HttpContext context) =>
		context.Items.TryGetValue(ScopeItem, out var item) ? item as CanvasRequestScope : null;

	public static bool HasControlToken(HttpContext context) =>
		TryGetScope(context)?.HasControlToken == true;

	public static void RequireControl(HttpContext context)
	{
		if (!HasControlToken(context))
			throw new UnauthorizedAccessException("This endpoint requires the host control token.");
	}

	/// <summary>
	/// The canvas panel this request speaks for: the panel its session cookie was issued to, or the
	/// panel a control-token caller named in the query string. Control-token callers that name no
	/// panel speak for nobody, which is a normal state for the bare CLI.
	/// </summary>
	public static CanvasContextKey? TryGetContext(HttpContext context)
	{
		if (context.Items.TryGetValue(ContextItem, out var cached))
			return cached as CanvasContextKey;

		var key = ResolveContext(context);
		context.Items[ContextItem] = key;
		return key;
	}

	public static CanvasContextKey RequireContext(HttpContext context) =>
		TryGetContext(context)
		?? throw new ArgumentException("A canvas sessionId and instanceId are required.");

	/// <summary>
	/// The surface an endpoint serves: its own declared requirement, or the surface of the API
	/// module that mapped it. A null result means the endpoint is shared by every product.
	/// </summary>
	public static string? RequiredSurface(HttpContext context, string moduleSurface)
	{
		var endpoint = context.GetEndpoint();
		return endpoint is null
			? moduleSurface
			: endpoint.Metadata.GetMetadata<CanvasSurfaceRequirement>() is { } requirement
				? requirement.Surface
				: moduleSurface;
	}

	/// <summary>
	/// Rejects a caller whose credential was issued for a different product surface. Unauthenticated
	/// public assets carry no scope and are left alone; the authentication middleware already
	/// decided they need none.
	/// </summary>
	public static void Enforce(HttpContext context, string moduleSurface)
	{
		var required = RequiredSurface(context, moduleSurface);
		if (required is null || TryGetScope(context) is null)
			return;

		var actual = TryGetContext(context);
		if (actual is not null && !actual.Surface.Equals(required, StringComparison.Ordinal))
		{
			throw new CanvasSurfaceException(
				$"This canvas session is scoped to the '{actual.Surface}' surface and cannot use " +
				$"'{required}' endpoints.");
		}
	}

	/// <summary>
	/// Declares that every endpoint mapped afterwards serves one product surface unless it opts out
	/// with <see cref="CanvasSurfaceRequirement.Neutral"/>. Routing is enabled explicitly so the
	/// guard can read endpoint metadata rather than guessing from the request path.
	/// </summary>
	public static void UseSurfaceGuard(WebApplication app, string moduleSurface)
	{
		var surface = CanvasSurfaces.Normalize(moduleSurface);
		app.UseRouting();
		app.Use(async (context, next) =>
		{
			Enforce(context, surface);
			await next(context).ConfigureAwait(false);
		});
	}

	public static TBuilder SurfaceNeutral<TBuilder>(this TBuilder builder)
		where TBuilder : IEndpointConventionBuilder
	{
		builder.WithMetadata(CanvasSurfaceRequirement.Neutral);
		return builder;
	}

	private static CanvasContextKey? ResolveContext(HttpContext context)
	{
		var scope = TryGetScope(context);
		if (scope?.Session is { } session)
			return session;
		if (scope?.HasControlToken != true)
			return null;

		var sessionId = context.Request.Query["sessionId"].ToString();
		var instanceId = context.Request.Query["instanceId"].ToString();
		if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(instanceId))
			return null;
		var surface = CanvasSurfaces.Normalize(context.Request.Query["surface"].ToString());
		ValidateContext(sessionId, instanceId);
		return new CanvasContextKey(sessionId, instanceId, surface);
	}

	public static void ValidateContext(string sessionId, string instanceId)
	{
		if (string.IsNullOrWhiteSpace(sessionId) || sessionId.Length > 200)
			throw new ArgumentException("A valid sessionId is required.");
		if (string.IsNullOrWhiteSpace(instanceId) || instanceId.Length > 200)
			throw new ArgumentException("A valid instanceId is required.");
	}
}
