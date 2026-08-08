import assert from "node:assert/strict";
import test from "node:test";
import {
  clearStoredDeviceId,
  readStoredDeviceId,
  resumeAuthenticatedPanel,
  storeDeviceId,
} from "../../web/canvas-state.js";

test("persists and clears the selected device used after a host restart", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };

  assert.equal(readStoredDeviceId(storage, "panel-a"), null);
  storeDeviceId(storage, "panel-a", "ios:phone");
  storeDeviceId(storage, "panel-b", "android:pixel");
  assert.equal(readStoredDeviceId(storage, "panel-a"), "ios:phone");
  assert.equal(readStoredDeviceId(storage, "panel-b"), "android:pixel");
  clearStoredDeviceId(storage, "panel-a");
  assert.equal(readStoredDeviceId(storage, "panel-a"), null);
  assert.equal(readStoredDeviceId(storage, "panel-b"), "android:pixel");
});

test("rejects an empty selected device ID", () => {
  const storage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };

  assert.throws(() => storeDeviceId(storage, "panel", ""), /selected device ID/);
  assert.throws(() => readStoredDeviceId(storage, ""), /canvas instance ID/);
});

test("authenticates before reconnecting a resumed panel", async () => {
  let finishAuthentication;
  const authentication = new Promise((resolve) => {
    finishAuthentication = resolve;
  });
  const calls = [];
  const result = resumeAuthenticatedPanel({
    authenticate: async () => {
      calls.push("authenticate");
      await authentication;
    },
    isActive: () => true,
    resume: () => calls.push("resume"),
  });

  await Promise.resolve();
  assert.deepEqual(calls, ["authenticate"]);
  finishAuthentication();
  assert.equal(await result, true);
  assert.deepEqual(calls, ["authenticate", "resume"]);
});

test("does not reconnect a panel hidden while authentication is pending", async () => {
  let finishAuthentication;
  let active = true;
  let resumed = false;
  const authentication = new Promise((resolve) => {
    finishAuthentication = resolve;
  });
  const result = resumeAuthenticatedPanel({
    authenticate: () => authentication,
    isActive: () => active,
    resume: () => {
      resumed = true;
    },
  });

  active = false;
  finishAuthentication();
  assert.equal(await result, false);
  assert.equal(resumed, false);
});
