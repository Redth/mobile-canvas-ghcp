import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
const { createAilohaVideoReceiver } = await import(productModule("web/ailoha-video-receiver.js"));

function packet(sequence, flags = 1, length = 4) {
  const bytes = new Uint8Array(28 + length);
  bytes.set([0x41, 0x4c, 0x48, 0x56, 1, flags]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, sequence);
  view.setBigUint64(12, 9n);
  view.setUint32(20, 1);
  view.setUint32(24, length);
  return bytes;
}

async function fixture(t, onFrame) {
  const errors = [];
  const receiver = createAilohaVideoReceiver({
    context: { ownerId: "owner", videoSessionId: "video" },
    onFrame,
    onControl() {},
    onError(error) { errors.push(error); },
  });
  t.after(() => receiver.dispose());
  const connection = receiver.attach({ protocol: "ailoha.video.v1", send() {}, close() {} });
  await connection.start();
  await connection.receive(JSON.stringify({
    type: "ready", videoSessionId: "video", codec: "h264",
    geometryRevision: 1, resumeFromSequence: 0, maxInFlightFrames: 1,
  }));
  await connection.receive(JSON.stringify({
    type: "geometryChanged", geometryRevision: 1, bounds: { x: 0, y: 0, width: 48, height: 32 },
  }));
  return { receiver, connection, errors };
}

test("ordinary scopes still expire on consumption; retained picture owners remain guarded until release", async (t) => {
  let scope;
  let retained;
  const state = await fixture(t, (_frame, delivery) => {
    scope = delivery;
    retained = delivery.retainPresentation();
    return true;
  });
  await state.connection.receive(packet(0));
  assert.equal(scope.isCurrent(), false);
  assert.equal(scope.commit(() => assert.fail()), false);
  assert.equal(retained.isCurrent(), true);
  assert.equal(retained.commit(() => {}), true);
  assert.equal(Object.isFrozen(retained.geometry.bounds), true);
  retained.release();
  retained.release();
  assert.equal(retained.isCurrent(), false);
});

test("config-only units cannot retain a decoder output lease", async (t) => {
  const state = await fixture(t, (_frame, scope) => {
    assert.throws(() => scope.retainPresentation(), /picture scope/);
    return true;
  });
  await state.connection.receive(packet(0, 2));
  assert.equal(state.errors.length, 0);
});

test("geometry/drop/close invalidate retained owners without changing consumed ACK history", async (t) => {
  const leases = [];
  const state = await fixture(t, (_frame, scope) => {
    if (scope.canPresent) leases.push(scope.retainPresentation());
    return true;
  });
  await state.connection.receive(packet(0));
  await state.connection.receive(JSON.stringify({ type: "backpressure", maxInFlight: 1, dropBeforeSequence: 2 }));
  assert.equal(leases[0].isCurrent(), false);
  await state.connection.receive(packet(2));
  await state.connection.close();
  assert.equal(leases[1].isCurrent(), false);
  assert.equal(state.receiver.lastAcknowledgedSequence, 2);
});

test("deferred ownership has hard count and encoded-byte bounds", async (t) => {
  const leases = [];
  const state = await fixture(t, (_frame, scope) => {
    leases.push(scope.retainPresentation());
    return true;
  });
  for (let sequence = 0; sequence < 64; sequence += 1) await state.connection.receive(packet(sequence));
  assert.equal(await state.connection.receive(packet(64)), false);
  assert.equal(state.errors[0].code, "QueueOverflow");
  assert.equal(leases.every((lease) => !lease.isCurrent()), true);

  const large = await fixture(t, (_frame, scope) => { scope.retainPresentation(); return true; });
  await large.connection.receive(packet(0, 1, 8 * 1024 * 1024));
  await large.connection.receive(packet(1, 1, 8 * 1024 * 1024));
  assert.equal(await large.connection.receive(packet(2)), false);
  assert.equal(large.errors[0].code, "QueueOverflow");
});
