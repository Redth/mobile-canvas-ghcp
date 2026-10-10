import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
const {
  assertLogicalPoint,
  assertObservedGeometry,
  captureConnectionRef,
  captureInvocation,
  hasOperation,
  projectMobileTarget,
  projectSurfaceGeometry,
  requireSurface,
  sameConnectionRef,
  publicSnapshot,
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
const connectionRef = {
  schema: "ailoha.target-host.connection/v1",
  serviceId: "service/opaque",
  pid: 12345,
  startedAt: "2026-10-09T23:00:00.1234567Z",
  processStartedAt: "2026-10-09T22:59:59.1234567Z",
};

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

test("canonical execution context revision is captured separately from mutable local selection generation", () => {
  const context = {
    contextRef: "ctx-canonical", scopeEpoch: "captured-epoch", revision: "12345678901234567890", ownerProcessId: 1234,
  };
  const invocation = captureInvocation({
    scope: { sessionId: "session", viewId: "view" }, device: project(),
    selectionGeneration: 2, surface, context,
  });
  context.scopeEpoch = "another-epoch";
  context.revision = "999";
  assert.equal(invocation.executionContext.scopeEpoch, "captured-epoch");
  assert.equal(invocation.executionContext.revision, "12345678901234567890");
  assert.equal(invocation.executionContext.ownerProcessId, 1234);
  assert.equal(Object.isFrozen(invocation.executionContext), true);
});

test("official connection evidence is captured completely without parsing or normalizing its identity", () => {
  const source = { ...connectionRef };
  const captured = captureConnectionRef(source);
  source.pid += 1;
  assert.deepEqual(captured, connectionRef);
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(captureConnectionRef(captured), captured);
  assert.equal(sameConnectionRef(captured, { ...connectionRef }), true);
  assert.equal(sameConnectionRef(captured, {
    processStartedAt: connectionRef.processStartedAt, startedAt: connectionRef.startedAt,
    pid: connectionRef.pid, serviceId: connectionRef.serviceId, schema: connectionRef.schema,
  }), true);
  for (const changed of [
    { serviceId: "another-service" }, { pid: connectionRef.pid + 1 },
    { startedAt: "2026-10-09T23:00:01Z" }, { processStartedAt: "2026-10-09T23:00:00Z" },
    { schema: "another-schema" },
  ]) assert.equal(sameConnectionRef(captured, { ...connectionRef, ...changed }), false);
  assert.equal(sameConnectionRef({}, {}), false);
  assert.equal(sameConnectionRef(captured, undefined), false);
});

test("incomplete, accessor or untrusted connection evidence is an explicit error", () => {
  const accessor = { ...connectionRef };
  Object.defineProperty(accessor, "pid", { enumerable: true, get() { throw new Error("Do not invoke"); } });
  for (const invalid of [
    undefined, null, {}, [], accessor,
    { ...connectionRef, pid: 0 }, { ...connectionRef, pid: 1.5 },
    { ...connectionRef, serviceId: "" }, { ...connectionRef, startedAt: "not-a-timestamp" },
    { ...connectionRef, processStartedAt: undefined }, { ...connectionRef, credential: "do-not-copy" },
    { ...connectionRef, hostInstanceId: "invented-alias" },
  ]) assert.throws(() => captureConnectionRef(invalid), { code: "runtime_connection_ref_invalid", status: 503 });
});

test("invocation connection evidence survives trusted capture but never crosses public projection", () => {
  const captured = captureConnectionRef(connectionRef);
  const invocation = captureInvocation({
    scope: { sessionId: "session", viewId: "view" }, device: project(),
    selectionGeneration: 2, surface, connectionRef: captured,
  });
  assert.equal(invocation.connectionRef, captured);
  assert.equal(Object.isFrozen(invocation), true);
  assert.equal(Object.getOwnPropertyDescriptor(invocation, "connectionRef").enumerable, false);
  assert.throws(() => { invocation.connectionRef.pid = 1; }, TypeError);
  for (const output of [{ ...invocation }, structuredClone(invocation), publicSnapshot(invocation), JSON.parse(JSON.stringify(invocation))]) {
    assert.equal(Object.hasOwn(output, "connectionRef"), false);
    assert.equal(output.targetId, target.targetId);
  }
  assert.equal(JSON.stringify(invocation).includes("processStartedAt"), false);
});
