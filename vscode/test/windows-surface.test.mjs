import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The policy is validated through its compiled CommonJS output (`out/surfaces.js`) so this test runs
// against exactly the code the extension loads. `npm run compile` produces it before the tests run.
const require = createRequire(import.meta.url);
const surfacesPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "out",
  "surfaces.js",
);
const {
  MOBILE_SURFACE,
  WINDOWS_SURFACE,
  socketRouteFor,
  assertAllowedApiPath,
} = require(surfacesPath);

test("each surface has its own fixed socket route table", () => {
  assert.equal(MOBILE_SURFACE.socketRoutes.video, "/ws/video");
  assert.equal(MOBILE_SURFACE.socketRoutes.events, "/ws/events");
  assert.equal(WINDOWS_SURFACE.socketRoutes.video, "/ws/windows/video");
  assert.equal(WINDOWS_SURFACE.socketRoutes.events, "/ws/windows/events");

  const routes = [
    MOBILE_SURFACE.socketRoutes.video,
    MOBILE_SURFACE.socketRoutes.events,
    WINDOWS_SURFACE.socketRoutes.video,
    WINDOWS_SURFACE.socketRoutes.events,
  ];
  // The four routes are pairwise distinct, so no channel on one surface collides with the other.
  assert.equal(new Set(routes).size, 4);
  assert.notEqual(MOBILE_SURFACE.socketRoutes.video, WINDOWS_SURFACE.socketRoutes.video);
  assert.notEqual(MOBILE_SURFACE.socketRoutes.events, WINDOWS_SURFACE.socketRoutes.events);
});

test("socketRouteFor maps only the two channel names", () => {
  assert.equal(socketRouteFor(MOBILE_SURFACE, "video"), "/ws/video");
  assert.equal(socketRouteFor(MOBILE_SURFACE, "events"), "/ws/events");
  assert.equal(socketRouteFor(WINDOWS_SURFACE, "video"), "/ws/windows/video");
  assert.equal(socketRouteFor(WINDOWS_SURFACE, "events"), "/ws/windows/events");
});

test("socketRouteFor refuses anything that is not a channel name", () => {
  for (const surface of [MOBILE_SURFACE, WINDOWS_SURFACE]) {
    // Unknown channel names and, crucially, raw host paths are rejected: a renderer names a channel,
    // never a route, so it can never point its socket at an arbitrary path.
    assert.throws(() => socketRouteFor(surface, "audio"));
    assert.throws(() => socketRouteFor(surface, "windows/video"));
    assert.throws(() => socketRouteFor(surface, "/ws/video"));
    assert.throws(() => socketRouteFor(surface, "../../etc"));
    assert.throws(() => socketRouteFor(surface, ""));
  }
});

test("mobile and windows API namespaces do not overlap", () => {
  // Mobile owns every /api/v1 path except the Windows namespace.
  assert.equal(MOBILE_SURFACE.isAllowedApiPath("/api/v1/devices"), true);
  assert.equal(MOBILE_SURFACE.isAllowedApiPath("/api/v1/selection"), true);
  assert.equal(MOBILE_SURFACE.isAllowedApiPath("/api/v1/windows/session"), false);
  assert.throws(() => assertAllowedApiPath(MOBILE_SURFACE, "/api/v1/windows/session"));

  // Windows is confined to /api/v1/windows.
  assert.equal(WINDOWS_SURFACE.isAllowedApiPath("/api/v1/windows/session"), true);
  assert.equal(WINDOWS_SURFACE.isAllowedApiPath("/api/v1/devices"), false);
  assert.equal(WINDOWS_SURFACE.isAllowedApiPath("/api/v1/selection"), false);
  assert.throws(() => assertAllowedApiPath(WINDOWS_SURFACE, "/api/v1/devices"));
  assert.throws(() => assertAllowedApiPath(WINDOWS_SURFACE, "/api/v1/selection"));
});

test("both surfaces reject non-API, cross-origin, and traversal paths", () => {
  for (const surface of [MOBILE_SURFACE, WINDOWS_SURFACE]) {
    for (const path of [
      "/windows/windows-canvas.js",
      "http://evil/api/v1/x",
      "//evil/api/v1/x",
      "/api/v1/../../x",
      "/api/v1/windows/../devices",
      "/api/v1/windows/session?x=1",
      "/api/v1/windows/session#frag",
    ]) {
      assert.equal(surface.isAllowedApiPath(path), false, `${surface.id} must reject ${path}`);
      assert.throws(() => assertAllowedApiPath(surface, path), `${surface.id} must throw for ${path}`);
    }
  }
});

test("the two surfaces are configured as distinct products", () => {
  assert.notEqual(MOBILE_SURFACE.id, WINDOWS_SURFACE.id);
  assert.equal(MOBILE_SURFACE.id, "mobile");
  assert.equal(WINDOWS_SURFACE.id, "windows");
  assert.notEqual(MOBILE_SURFACE.canvasPath, WINDOWS_SURFACE.canvasPath);
  assert.equal(MOBILE_SURFACE.canvasPath, "/");
  assert.equal(WINDOWS_SURFACE.canvasPath, "/windows/");
});
