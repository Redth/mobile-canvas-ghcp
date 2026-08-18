/**
 * The product-surface policy shared by the Mobile Canvas and Windows App VS Code views.
 *
 * This module is deliberately free of any `vscode` import so that the compiled CommonJS output
 * (`out/surfaces.js`) can be loaded directly by the Node test runner. It is the single source of
 * truth for two security-critical decisions:
 *
 *  1. Which host WebSocket route a renderer's *channel* maps to, and
 *  2. Which host HTTP paths a surface is allowed to reach.
 *
 * The renderer only ever names one of its two channels ("video" or "events"); it never names a
 * host route. The route table below is fixed per surface, so a compromised or buggy webview cannot
 * hand its host an arbitrary path and thereby widen its own reach across surfaces. Likewise every
 * API path is validated against a surface-specific prefix, so a Mobile panel can never call a
 * Windows endpoint and vice versa.
 */

export type SurfaceId = "mobile" | "windows";

export type SocketChannel = "video" | "events";

export interface SurfaceConfig {
  /** Stable surface identifier used in bootstrap grants, cookies, and activity events. */
  id: SurfaceId;
  /** Human-readable product name, used for log prefixes and user-facing error messages. */
  productName: string;
  /** The host asset root this surface's canvas is served from. */
  canvasPath: string;
  /** Fixed channel-to-route table. The renderer names a channel; only this maps it to a route. */
  socketRoutes: Record<SocketChannel, string>;
  /** True when this surface is permitted to reach the given host API path. */
  isAllowedApiPath(path: string): boolean;
}

/**
 * Base validation applied to every API path before the per-surface prefix test is meaningful.
 *
 * A legitimate API path is a bare, absolute host path under `/api/v1/`. Anything that looks like a
 * URL (`http://…`), a protocol-relative reference (`//host/…`), a traversal (`..`), or that carries
 * a query/fragment that could smuggle a different route past the prefix comparison is rejected here.
 */
function isSafeApiPath(path: string): boolean {
  if (typeof path !== "string") return false;
  // Must be an absolute host path under the API root. This single check also rejects protocol
  // schemes ("http://…") and protocol-relative prefixes ("//host/…"), neither of which start with
  // "/api/v1/".
  if (!path.startsWith("/api/v1/")) return false;
  if (path.startsWith("//")) return false;
  if (path.includes("://")) return false;
  if (path.includes("..")) return false;
  if (path.includes("?") || path.includes("#")) return false;
  return true;
}

export const MOBILE_SURFACE: SurfaceConfig = {
  id: "mobile",
  productName: "Mobile Canvas",
  canvasPath: "/",
  socketRoutes: {
    video: "/ws/video",
    events: "/ws/events",
  },
  isAllowedApiPath(path: string): boolean {
    // Mobile owns every `/api/v1/` endpoint except the Windows-scoped ones.
    return isSafeApiPath(path) && !path.startsWith("/api/v1/windows/");
  },
};

export const WINDOWS_SURFACE: SurfaceConfig = {
  id: "windows",
  productName: "Windows App",
  canvasPath: "/windows/",
  socketRoutes: {
    video: "/ws/windows/video",
    events: "/ws/windows/events",
  },
  isAllowedApiPath(path: string): boolean {
    // Windows is confined to its own `/api/v1/windows/` namespace.
    return isSafeApiPath(path) && path.startsWith("/api/v1/windows/");
  },
};

/**
 * Resolve the fixed host WebSocket route for a renderer-named channel.
 *
 * The renderer passes the *name* of one of its two channels, never a route. Any other value —
 * including a would-be host path such as "windows/video" or a traversal like "../../etc" — is
 * refused so a webview cannot choose where its socket connects.
 */
export function socketRouteFor(surface: SurfaceConfig, channel: string): string {
  if (channel === "video" || channel === "events") {
    return surface.socketRoutes[channel];
  }
  throw new Error(`Unknown ${surface.productName} socket channel: ${String(channel)}`);
}

/**
 * Throw unless the surface is permitted to reach the given host API path. Used as the enforcement
 * gate wherever a renderer-provided or bridge-internal path is about to be forwarded to the host.
 */
export function assertAllowedApiPath(surface: SurfaceConfig, path: string): void {
  if (!surface.isAllowedApiPath(path)) {
    throw new Error(`${surface.productName} refused the host path: ${String(path)}`);
  }
}
