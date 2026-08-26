import assert from "node:assert/strict";
import test from "node:test";
import {
  canBootDeviceState,
  clearStoredDeviceId,
  deviceStatusPresentation,
  formatDeviceState,
  organizeDiagnostics,
  readStoredDeviceId,
  resumeAuthenticatedPanel,
  shouldDrainIdleDecoder,
  storeDeviceId,
} from "../../web/canvas-state.js";

test("drains codecs whose streams can stop with buffered frames", () => {
  assert.equal(shouldDrainIdleDecoder("idb"), true);
  assert.equal(shouldDrainIdleDecoder("emulator-grpc"), true);
  assert.equal(shouldDrainIdleDecoder("framebuffer"), false);
  assert.equal(shouldDrainIdleDecoder("screencapturekit"), false);
});

test("boots stable non-running states but not lifecycle transitions", () => {
  assert.equal(canBootDeviceState("shutdown"), true);
  assert.equal(canBootDeviceState("unknown"), true);
  assert.equal(canBootDeviceState(undefined), true);
  assert.equal(canBootDeviceState("booted"), false);
  assert.equal(canBootDeviceState("booting"), false);
  assert.equal(canBootDeviceState("shutting-down"), false);
});

test("presents readable device state labels", () => {
  assert.equal(formatDeviceState("booted"), "Running");
  assert.equal(formatDeviceState("shutdown"), "Powered off");
  assert.equal(formatDeviceState("shutting-down"), "Powering off");
  assert.equal(formatDeviceState("waiting-for-host"), "Waiting For Host");
});

test("presents actionable and progress device states", () => {
  const offline = deviceStatusPresentation("offline", {
    deviceName: "Pixel 6",
    platform: "android",
  });
  assert.equal(offline.title, "Emulator is powered off");
  assert.match(offline.detail, /Pixel 6/);
  assert.deepEqual(offline.action, {
    id: "boot",
    label: "Start emulator",
    icon: "#icon-play",
  });

  const connecting = deviceStatusPresentation("connecting", {
    deviceName: "iPhone 16 Pro",
    platform: "ios",
  });
  assert.equal(connecting.busy, true);
  assert.equal(connecting.action, undefined);
  assert.match(connecting.title, /iPhone 16 Pro/);
  assert.equal(connecting.detail, "Waiting for the first frame.");

  const disconnected = deviceStatusPresentation("disconnected", {
    platform: "ios",
    detail: "The stream closed unexpectedly.",
  });
  assert.equal(disconnected.tone, "warning");
  assert.equal(disconnected.detail, "The stream closed unexpectedly.");
  assert.equal(disconnected.action.id, "retry-stream");
});

test("falls back to a recoverable unavailable device state", () => {
  const unavailable = deviceStatusPresentation("future-backend-state", {
    platform: "android",
  });
  assert.equal(unavailable.title, "Emulator isn't available");
  assert.equal(unavailable.action.id, "refresh");
});

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

test("refreshes device state before reconnecting a resumed panel", async () => {
  const calls = [];

  const result = await resumeAuthenticatedPanel({
    authenticate: async () => calls.push("authenticate"),
    isActive: () => true,
    refresh: async () => calls.push("refresh"),
    resume: () => calls.push("resume"),
  });

  assert.equal(result, true);
  assert.deepEqual(calls, ["authenticate", "refresh", "resume"]);
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

test("does not reconnect a panel hidden while device state refreshes", async () => {
  let finishRefresh;
  let active = true;
  let resumed = false;
  const refresh = new Promise((resolve) => {
    finishRefresh = resolve;
  });
  const result = resumeAuthenticatedPanel({
    authenticate: async () => {},
    isActive: () => active,
    refresh: () => refresh,
    resume: () => {
      resumed = true;
    },
  });

  await Promise.resolve();
  active = false;
  finishRefresh();
  assert.equal(await result, false);
  assert.equal(resumed, false);
});

test("promotes actionable diagnostics into main notices", () => {
  const actionable = {
    name: "ScreenCaptureKit fallback",
    status: "warning",
    message: "Grant Screen Recording.",
    actions: [
      {
        type: "open-system-settings",
        target: "screen-recording",
        label: "Open Screen Recording",
      },
      {
        type: "unsupported",
        target: "ignored",
        label: "Ignore",
      },
    ],
  };
  const ordinary = {
    name: "Xcode",
    status: "error",
    message: "Select Xcode.",
  };

  const result = organizeDiagnostics([
    {
      checks: [
        actionable,
        ordinary,
        { name: "Ready", status: "ok", message: "Ready." },
      ],
    },
  ]);

  assert.equal(result.notices.length, 1);
  assert.equal(result.notices[0].name, actionable.name);
  assert.deepEqual(result.notices[0].actions, [actionable.actions[0]]);
  assert.deepEqual(result.popover, [ordinary]);
});

test("keeps unsupported diagnostic actions in the selector", () => {
  const check = {
    name: "Unknown",
    status: "warning",
    message: "Needs attention.",
    actions: [{ type: "unsupported", target: "x", label: "Do something" }],
  };

  assert.deepEqual(organizeDiagnostics([{ checks: [check] }]), {
    notices: [],
    popover: [check],
  });
  assert.deepEqual(organizeDiagnostics(null), { notices: [], popover: [] });
});
