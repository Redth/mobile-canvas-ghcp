import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { productModule } from "../ailoha-test-module.mjs";
const {
  ailohaDisplayGeometry,
  ailohaInputPayload,
  captureCanvasInvocation,
  isCanvasInvocationCurrent,
  pointInLogicalBounds,
} = await import(productModule("web/ailoha-canvas-state.js"));
const { supportsLegacyStreamOptions, shouldRetainAilohaStream } = await import(productModule("web/canvas-state.js"));

function state() {
  return {
    selected: { id: "opaque", backend: "ailoha", targetHostId: "host" },
    display: ailohaDisplayGeometry({
      geometryRevision: 13, bounds: { x: -10, y: 20, width: 48, height: 32 },
    }, "surface"),
    selectionVersion: 1,
  };
}

test("input coordinates use logical bounds and origin, never the encoded framebuffer", () => {
  const current = state();
  const point = pointInLogicalBounds({ clientX: 150, clientY: 150 },
    { left: 100, top: 100, width: 100, height: 100 }, current.display);
  assert.deepEqual(point, { x: 14, y: 36 });
  assert.equal(current.display.pixelWidth, null);
  assert.equal(current.display.coordinate, "window");
});

test("queued input captures its host/target/surface/revision tuple before selection can change", () => {
  const current = state();
  const invocation = captureCanvasInvocation(current);
  assert.equal(isCanvasInvocationCurrent(invocation, current), true);
  const payload = ailohaInputPayload(invocation, { x: 14, y: 36 });
  assert.equal(payload.geometryRevision, 13);
  current.display = { ...current.display, geometryRevision: 14 };
  assert.equal(isCanvasInvocationCurrent(invocation, current), false);
  assert.equal(invocation.display.geometryRevision, 13);
  current.display = invocation.display;
  current.selected = { ...current.selected, targetHostId: "another-host" };
  assert.equal(isCanvasInvocationCurrent(invocation, current), false);
});

test("missing observed geometry cannot manufacture a geometry-bound input request", () => {
  const current = state();
  current.display = null;
  assert.throws(() => ailohaInputPayload(captureCanvasInvocation(current), { x: 1, y: 1 }), /observed surface/);
});

test("legacy input payload and coordinate origin remain unchanged", () => {
  const current = { selected: { id: "legacy-id" }, display: { pointWidth: 390, pointHeight: 844 }, selectionVersion: 1 };
  const payload = { x: 12, y: 34 };
  assert.equal(ailohaInputPayload(captureCanvasInvocation(current), payload), payload);
  assert.deepEqual(pointInLogicalBounds({ clientX: 0, clientY: 0 },
    { left: 0, top: 0, width: 390, height: 844 }, current.display), { x: 0, y: 0 });
});

test("Ailoha dimensions/geometry updates never activate legacy scale-session recreation", () => {
  assert.equal(supportsLegacyStreamOptions({ backend: "ailoha" }), false);
  assert.equal(supportsLegacyStreamOptions({ backend: "legacy" }), true);
  assert.equal(supportsLegacyStreamOptions({ id: "old-runtime-device" }), true);
});

test("an unchanged named Ailoha selection announcement retains its one live resource", () => {
  const device = {
    backend: "ailoha", id: "target", targetHostId: "host", surfaceId: "surface",
    provider: "provider", providerState: "ready", state: "booted", capabilities: { liveStream: true },
  };
  assert.equal(shouldRetainAilohaStream(device, structuredClone(device)), true);
  for (const changed of [
    { targetHostId: "other-host" }, { id: "other-target" }, { surfaceId: "other-surface" },
    { state: "shutdown" }, { providerState: "unavailable" }, { capabilities: { liveStream: false } },
    { backend: "legacy" },
  ]) {
    assert.equal(shouldRetainAilohaStream(device, { ...device, ...changed }), false);
  }
  assert.equal(shouldRetainAilohaStream({ ...device, backend: "legacy" }, device), false);
});

test("actual legacy autoscale debounce still works and a queued callback cannot restart an Ailoha resource", () => {
  const source = readFileSync(new URL(productModule("web/device-canvas.js")), "utf8");
  const definition = /function reconcileAutoScale\(\) \{[\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(definition);
  const queued = [];
  let restarts = 0;
  const state = { selected: { backend: "legacy" }, socket: {}, activeScale: 0.5, scaleTimer: null };
  const reconcile = vm.runInNewContext(`(${definition})`, {
    state,
    elements: { scale: { value: "auto" } },
    supportsLegacyStreamOptions,
    resolveScale: () => 0.75,
    clearTimeout() {},
    setTimeout(callback, delay) { queued.push({ callback, delay }); return queued.length; },
    startStream() { restarts += 1; },
  });
  reconcile();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].delay, 400);
  queued[0].callback();
  assert.equal(restarts, 1);
  state.selected = { backend: "ailoha" };
  queued[0].callback();
  reconcile();
  assert.equal(restarts, 1);
  assert.equal(queued.length, 1);
});
