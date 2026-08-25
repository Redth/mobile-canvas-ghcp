import assert from "node:assert/strict";
import test from "node:test";
import {
  createFramePrimer,
  shouldRetainDeviceFrame,
} from "../../web/canvas-state.js";

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function closableFrame() {
  return {
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

test("retains a painted frame only when reconnecting the same device", () => {
  assert.equal(shouldRetainDeviceFrame("ios:phone", "ios:phone"), true);
  assert.equal(shouldRetainDeviceFrame("ios:phone", "android:pixel"), false);
  assert.equal(shouldRetainDeviceFrame(null, "ios:phone"), false);
  assert.equal(shouldRetainDeviceFrame(null, null), false);
});

test("primes an empty device frame from a screenshot", async () => {
  const calls = [];
  const frame = closableFrame();
  const primer = createFramePrimer({
    capture: async (deviceId) => {
      calls.push(["capture", deviceId]);
      return "screenshot";
    },
    decode: async (source) => {
      calls.push(["decode", source]);
      return frame;
    },
    isCurrent: (deviceId) => deviceId === "ios:phone",
  });

  const painted = await primer.prime("ios:phone", (value) => {
    calls.push(["paint", value]);
  });

  assert.equal(painted, true);
  assert.deepEqual(calls, [
    ["capture", "ios:phone"],
    ["decode", "screenshot"],
    ["paint", frame],
  ]);
  assert.equal(frame.closed, true);
});

test("does not decode a screenshot after the selected device changes", async () => {
  const screenshot = deferred();
  let selectedDeviceId = "ios:phone";
  let decoded = false;
  let painted = false;
  const primer = createFramePrimer({
    capture: () => screenshot.promise,
    decode: async () => {
      decoded = true;
      return closableFrame();
    },
    isCurrent: (deviceId) => deviceId === selectedDeviceId,
  });

  const result = primer.prime("ios:phone", () => {
    painted = true;
  });
  selectedDeviceId = "android:pixel";
  screenshot.resolve("stale screenshot");

  assert.equal(await result, false);
  assert.equal(decoded, false);
  assert.equal(painted, false);
});

test("discards a decoded screenshot when the panel becomes hidden", async () => {
  const decoding = deferred();
  const decodeStarted = deferred();
  const frame = closableFrame();
  let visible = true;
  let painted = false;
  const primer = createFramePrimer({
    capture: async () => "screenshot",
    decode: () => {
      decodeStarted.resolve();
      return decoding.promise;
    },
    isCurrent: () => visible,
  });

  const result = primer.prime("ios:phone", () => {
    painted = true;
  });
  await decodeStarted.promise;
  visible = false;
  decoding.resolve(frame);

  assert.equal(await result, false);
  assert.equal(painted, false);
  assert.equal(frame.closed, true);
});

test("discards a screenshot when a live frame arrives first", async () => {
  const decoding = deferred();
  const decodeStarted = deferred();
  const frame = closableFrame();
  let painted = false;
  const primer = createFramePrimer({
    capture: async () => "screenshot",
    decode: () => {
      decodeStarted.resolve();
      return decoding.promise;
    },
    isCurrent: () => true,
  });

  const result = primer.prime("ios:phone", () => {
    painted = true;
  });
  await decodeStarted.promise;
  primer.invalidate();
  decoding.resolve(frame);

  assert.equal(await result, false);
  assert.equal(painted, false);
  assert.equal(frame.closed, true);
});
