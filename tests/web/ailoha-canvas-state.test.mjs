import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
const {
  ailohaDisplayGeometry,
  ailohaInputPayload,
  captureCanvasInvocation,
  isCanvasInvocationCurrent,
  pointInLogicalBounds,
} = await import(productModule("web/ailoha-canvas-state.js"));

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
