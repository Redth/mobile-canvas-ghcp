import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
const { openLiveInputChannel } = await import(productModule("lib/ailoha/live-input.mjs"));

const PATH = "/ws/v1/targets/t/surfaces/s/input";

function host({ readyRevision = 3, onInput } = {}) {
  const state = { sent: [], closed: 0, listeners: null };
  const emit = (message) => state.listeners.onMessage(new TextEncoder().encode(JSON.stringify(message)), false);
  const transport = {
    async websocket(path, listeners) {
      assert.equal(path, PATH);
      state.listeners = listeners;
      return {
        send(text) {
          const message = JSON.parse(text);
          state.sent.push(message);
          if (message.type === "hello") {
            queueMicrotask(() => emit({
              type: "ready", resumeFromSequence: 0, geometryRevision: readyRevision, maxInFlight: 8, maxActivePointers: 1,
            }));
          } else if (onInput) queueMicrotask(() => onInput(message, emit));
          else queueMicrotask(() => emit({ type: "ack", acknowledgedSequence: message.sequence }));
        },
        async close() { state.closed += 1; },
      };
    },
  };
  return { state, transport, emit };
}

test("batches are sequenced, carry the captured geometry and settle on their own acknowledgement", async () => {
  const { state, transport } = host();
  const channel = await openLiveInputChannel(transport, PATH, { geometryRevision: 3 });
  assert.equal(channel.open, true);
  await channel.send([{ type: "pointerDown", pointerId: 0, x: 10, y: 20 }]);
  await channel.send([{ type: "pointerMove", pointerId: 0, x: 11, y: 21 }]);
  await channel.send([{ type: "pointerUp", pointerId: 0 }]);
  assert.deepEqual(state.sent.map((message) => [message.type, message.sequence, message.geometryRevision]), [
    ["hello", undefined, 3], ["input", 0, 3], ["input", 1, 3], ["input", 2, 3],
  ]);
  await channel.close();
  await channel.close();
  assert.equal(state.closed, 1);
  await assert.rejects(channel.send([{ type: "pointerDown", pointerId: 0, x: 1, y: 1 }]), { code: "live_input_closed" });
});

test("a ready at another geometry revision refuses to start and closes the socket", async () => {
  const { state, transport } = host({ readyRevision: 4 });
  await assert.rejects(openLiveInputChannel(transport, PATH, { geometryRevision: 3 }), { code: "stale_geometry" });
  assert.equal(state.closed, 1);
});

test("a refused batch, geometry change or disconnect retires the channel so the host releases the finger", async () => {
  for (const [reply, code] of [
    [{ type: "error", terminal: false, sequence: 0, problem: { status: 400, title: "Invalid", detail: "Pointer 0 is not down." } }, "live_input_rejected"],
    [{ type: "geometryChanged", geometryRevision: 4, bounds: { x: 0, y: 0, width: 1, height: 1 } }, "stale_geometry"],
    [{ type: "pointersReleased", pointerIds: [0], reason: "geometryChanged" }, "live_input_released"],
  ]) {
    const { state, transport } = host({ onInput: (_message, emit) => emit(reply) });
    const channel = await openLiveInputChannel(transport, PATH, { geometryRevision: 3 });
    await assert.rejects(channel.send([{ type: "pointerDown", pointerId: 0, x: 1, y: 1 }]), { code });
    assert.equal(channel.open, false);
    assert.equal(state.closed, 1);
    await assert.rejects(channel.send([{ type: "pointerUp", pointerId: 0 }]), { code });
  }
  const { state, transport } = host({ onInput: () => state.listeners.onClose(1006, "") });
  const channel = await openLiveInputChannel(transport, PATH, { geometryRevision: 3 });
  await assert.rejects(channel.send([{ type: "pointerDown", pointerId: 0, x: 1, y: 1 }]), { code: "live_input_disconnected" });
});

test("an unacknowledged batch times out instead of waiting forever", async () => {
  const { transport } = host({ onInput() {} });
  const channel = await openLiveInputChannel(transport, PATH, { geometryRevision: 3, ackTimeoutMs: 20 });
  await assert.rejects(channel.send([{ type: "pointerDown", pointerId: 0, x: 1, y: 1 }]), { code: "live_input_timeout" });
  assert.equal(channel.open, false);
});

test("only pointer actions are accepted", async () => {
  const { transport } = host();
  const channel = await openLiveInputChannel(transport, PATH, { geometryRevision: 3 });
  await assert.rejects(channel.send([{ type: "pause", duration: 10 }]), TypeError);
  await assert.rejects(channel.send([]), TypeError);
  await assert.rejects(openLiveInputChannel(transport, PATH, {}), TypeError);
});
