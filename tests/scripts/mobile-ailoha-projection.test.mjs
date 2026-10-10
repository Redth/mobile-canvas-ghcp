import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
const {
  assertLogicalPoint,
  assertObservedGeometry,
  captureInvocation,
  hasOperation,
  projectMobileTarget,
  projectSurfaceGeometry,
  requireSurface,
} = await import(productModule("lib/ailoha/mobile-projection.mjs"));

const surface = {
  surfaceId: "opaque/display",
  kind: "display",
  bounds: { x: -10, y: 20, width: 390, height: 844 },
  geometryRevision: 9,
  capabilities: [],
};
const provider = { providerId: "provider", name: "Provider", version: "1", state: "ready", capabilities: [] };
const target = {
  targetId: "opaque-id-not-a-UDID",
  providerId: "provider",
  targetTypeId: "opaque-type",
  status: "running",
  surfaces: [surface],
};
const project = (changes = {}) => projectMobileTarget({
  hostId: "host",
  target,
  provider,
  ...changes,
});

test("opaque host/target IDs never become invented native deployment IDs", () => {
  const device = project();
  assert.equal(device.id, target.targetId);
  assert.equal(device.targetHostId, "host");
  assert.equal(device.nativeId, null);
  assert.equal(device.platform, "unknown");
  assert.equal(Object.hasOwn(device, "udid"), false);
  assert.equal(Object.hasOwn(device, "isVirtual"), false);
  assert.equal(Object.values(device.capabilities).every((value) => value === false), true);
});

test("native deployment identity and provider provenance remain separate", () => {
  const nativeIdentity = { platform: "android", nativeId: "Pixel_AVD", serial: "emulator-5562", provider: "adb", isVirtual: true };
  const device = project({ target: { ...target, nativeIdentity }, supported: { tap: true, liveStream: true } });
  assert.equal(device.nativeId, "Pixel_AVD");
  assert.equal(device.serial, "emulator-5562");
  assert.equal(device.provider, "provider");
  assert.deepEqual(device.nativeIdentity, nativeIdentity);
  assert.equal(device.capabilities.tap, true);
  assert.equal(device.capabilities.recording, false);
  assert.throws(() => project({ provider: { ...provider, providerId: "other" } }), { code: "provider_identity_mismatch" });
});

test("missing and multiple surfaces are explicit and disable positional compatibility", () => {
  const multiple = { ...target, surfaces: [surface, { ...surface, surfaceId: "other" }] };
  assert.throws(() => requireSurface(multiple), { code: "surface_ambiguous" });
  assert.throws(() => requireSurface(target, "missing"), { code: "surface_unavailable" });
  const device = project({ target: multiple, supported: { tap: true, screenshot: true, boot: true } });
  assert.equal(device.surfaceStatus, "ambiguous");
  assert.equal(device.capabilities.tap, false);
  assert.equal(device.capabilities.boot, true);
  assert.equal(project({ target: multiple, surfaceId: "other" }).surfaceId, "other");
});

test("logical geometry preserves its observed origin/revision without inventing density", () => {
  const geometry = projectSurfaceGeometry(surface);
  assert.equal(geometry.coordinate, "window");
  assert.equal(geometry.pointX, -10);
  assert.equal(geometry.pointY, 20);
  assert.equal(geometry.scale, null);
  assert.equal(geometry.pixelWidth, null);
  assert.equal(geometry.geometryRevision, 9);
  assertLogicalPoint(geometry, -10, 20);
  assertLogicalPoint(geometry, 380, 864);
  assert.throws(() => assertLogicalPoint(geometry, 390, 0), { code: "invalid_coordinates" });
});

test("invocations own immutable view/target/surface/geometry tuples", () => {
  const mutable = structuredClone(surface);
  const device = project();
  const scope = { sessionId: "session", viewId: "unique-live-view" };
  const invocation = captureInvocation({ scope, device, selectionGeneration: 2, surface: mutable });
  mutable.bounds.width = 1;
  mutable.geometryRevision = 10;
  scope.viewId = "different";
  assert.equal(invocation.geometry.pointWidth, 390);
  assert.equal(invocation.scope.viewId, "unique-live-view");
  assert.equal(Object.isFrozen(invocation.geometry.bounds), true);
  assertObservedGeometry(invocation, device.display);
  for (const changes of [{ geometryRevision: 10 }, { surfaceId: "other" }, { coordinate: "screen" }]) {
    assert.throws(() => assertObservedGeometry(invocation, { ...device.display, ...changes }), { code: "stale_geometry" });
  }
});

test("operation support requires explicit operation evidence at a supported capability version", () => {
  assert.equal(hasOperation([{ id: "lifecycle", version: 1, features: ["startTarget"] }], "startTarget"), true);
  assert.equal(hasOperation([{ id: "startTarget", version: 1 }], "startTarget"), false);
  assert.equal(hasOperation([{ id: "lifecycle", version: 2, features: ["startTarget"] }], "startTarget"), false);
});
