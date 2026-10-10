import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import "../../tests/scripts/fixtures/ailoha-installed-hooks.mjs";
import { createAilohaCanvasHost } from "../../lib/ailoha/canvas-host.mjs";

const require = createRequire(import.meta.url);
const { HostBridge } = require(join(dirname(fileURLToPath(import.meta.url)), "../out/hostBridge.js"));

async function waitFor(condition) {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(condition(), true, "The actual compiled bridge did not reach the expected state.");
}

function fixture(options = {}) {
  const calls = [];
  const logs = [];
  const messages = [];
  const scope = { sessionId: randomUUID(), viewId: "host-bridge-view" };
  const host = createAilohaCanvasHost({
    scope,
    createBackend: async () => ({
      async ready() {},
      async request(path, request) {
        if (path === "/api/v1/devices/opaque%2Ftarget/reveal") {
          calls.push(["reveal-api", path]);
          return new Response(JSON.stringify({ id: "opaque/target", nativeId: "native-target" }),
            { headers: { "content-type": "application/json" } });
        }
        if (/\/ui(?:\/|$)/.test(path)) {
          if (options.uiResponse) return options.uiResponse(path, request);
          return new Response(JSON.stringify({ code: "ui_contract_unavailable" }),
            { status: 501, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify(path === "/api/v1/selection"
          ? { hasSelection: true, device: { id: "opaque/target", name: "Captured target" } }
          : { backend: "ailoha" }), { headers: { "content-type": "application/json" } });
      },
      async closeVideos() {},
      async openVideo(deviceId, onMessage) {
        calls.push(["open-video", deviceId]);
        onMessage('{"type":"ready"}');
        return {
          context: { ownerId: "owned-view", videoSessionId: "owned-video" },
          geometry: { geometryRevision: 1, bounds: { x: 0, y: 0, width: 48, height: 32 } },
          protocol: "ailoha.video.v1",
          async send(text) { calls.push(["send", text]); },
          async close() { calls.push(["close-video"]); },
        };
      },
      async dispose() { calls.push(["dispose"]); },
    }),
  });
  let closes = 0;
  const adapter = {
    openCanvas: (input) => host.openCanvas(input),
    invokeAction: (name, input) => host.invokeAction(name, input),
    async closeCanvas() {
      calls.push(["close-canvas"]);
      if (++closes <= (options.closeFailures ?? 0)) throw new Error("synthetic cleanup failure");
      await host.closeCanvas();
    },
  };
  const bridge = new HostBridge(undefined, scope.sessionId, scope.viewId, {
    async postMessage(message) {
      messages.push(message);
      if (options.postMessage) return options.postMessage(message);
      return true;
    },
  }, { appendLine(line) { logs.push(line); } }, undefined, adapter);
  return { bridge, host, calls, logs, messages };
}

test("compiled Ailoha bridge correlates actual control sends and retirement to its own socket", async (t) => {
  const state = fixture();
  t.after(async () => { state.bridge.dispose(); await state.bridge.closed(); });
  await state.bridge.handleMessage({ type: "ready" });
  await state.bridge.handleMessage({ type: "socket-open", id: "video-one", channel: "video", query: "deviceId=opaque%2Ftarget" });
  await waitFor(() => state.messages.some((message) => message.type === "socket-message"));
  assert.equal(state.messages.find((message) => message.type === "socket-opened").protocol, "ailoha.video.v1");
  await state.bridge.handleMessage({ type: "socket-send", id: "video-one", requestId: "send-one", data: '{"type":"hello"}' });
  assert.equal(state.messages.find((message) => message.id === "send-one").type, "operation-result");
  await waitFor(() => state.calls.some(([name]) => name === "send"));
  await state.bridge.handleMessage({ type: "socket-close", id: "video-one" });
  await waitFor(() => state.messages.some((message) => message.type === "socket-closed"));
  await state.bridge.handleMessage({ type: "socket-send", id: "video-one", requestId: "stale-send", data: '{"type":"ack","sequence":0}' });
  assert.equal(state.messages.find((message) => message.id === "stale-send").type, "operation-error");
  assert.equal(state.calls.filter(([name]) => name === "send").length, 1);
});

test("compiled VS Code bridge routes reveal and System UI negatives through the bound host API", async (t) => {
  const state = fixture();
  t.after(async () => { state.bridge.dispose(); await state.bridge.closed(); });
  await state.bridge.handleMessage({ type: "ready" });
  await state.bridge.handleMessage({ type: "api", id: "reveal", path: "/api/v1/devices/opaque%2Ftarget/reveal", method: "POST" });
  await state.bridge.handleMessage({ type: "api", id: "ui", path: "/api/v1/devices/opaque%2Ftarget/ui" });
  assert.equal(state.messages.find((message) => message.id === "reveal").status, 200);
  assert.equal(state.messages.find((message) => message.id === "ui").status, 501);
  assert.deepEqual(state.calls.filter(([kind]) => kind === "reveal-api").length, 1);
});

test("compiled VS Code bridge carries source-approved System UI dump/find/tap shapes through its bound API", async (t) => {
  const calls = [];
  const state = fixture({
    uiResponse(path, request) {
      calls.push([path, request]);
      const value = path.endsWith("/ui") ? { schemaVersion: "1.0", deviceId: "opaque/target",
        platform: "ios", root: null, elementCount: 0, raw: null }
        : path.endsWith("/ui/find") ? { schemaVersion: "1.0", deviceId: "opaque/target", matches: [], total: 0 }
          : { schemaVersion: "1.0", success: true, deviceId: "opaque/target", match: {
            element: { label: "Save" }, path: "1/0", centerX: 3, centerY: 5,
          }, total: 2 };
      return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    },
  });
  t.after(async () => { state.bridge.dispose(); await state.bridge.closed(); });
  await state.bridge.handleMessage({ type: "ready" });
  for (const [id, path, method] of [
    ["dump", "/api/v1/devices/opaque%2Ftarget/ui", "GET"],
    ["find", "/api/v1/devices/opaque%2Ftarget/ui/find", "POST"],
    ["tap", "/api/v1/devices/opaque%2Ftarget/ui/tap", "POST"],
  ]) {
    await state.bridge.handleMessage({
      type: "api", id, path, method,
      ...(method === "POST" ? { body: '{"text":"Save"}' } : {}),
    });
  }
  const result = (id) => JSON.parse(new TextDecoder().decode(state.messages.find((message) => message.id === id).body));
  assert.equal(result("dump").elementCount, 0);
  assert.equal(result("find").total, 0);
  assert.equal(result("tap").match.path, "1/0");
  assert.deepEqual(calls.map(([path]) => path.split("/").at(-1)), ["ui", "find", "tap"]);
});

for (const kind of ["false", "throw", "reject"]) {
  test(`actual renderer ${kind} delivery retires only the owned socket without unhandled failures`, async (t) => {
    const state = fixture({
      postMessage(message) {
        if (message.type !== "socket-opened") return true;
        if (kind === "false") return false;
        if (kind === "throw") throw new Error("synthetic protected renderer failure");
        return Promise.reject(new Error("synthetic protected renderer failure"));
      },
    });
    t.after(async () => { state.bridge.dispose(); await state.bridge.closed(); });
    await state.bridge.handleMessage({ type: "ready" });
    await state.bridge.handleMessage({ type: "socket-open", id: "video", channel: "video", query: "deviceId=opaque%2Ftarget" });
    await waitFor(() => state.messages.some((message) => message.type === "socket-closed"));
    assert.equal(state.logs.some((line) => /declined|failed/.test(line)), true);
    assert.equal(state.logs.some((line) => line.includes("protected renderer")), false);
    const id = "later-request";
    await state.bridge.handleMessage({ type: "api", id, path: "/api/v1/catalog" });
    assert.equal(state.messages.find((message) => message.id === id).status, 200);
  });
}

test("a failed visibility close remains observable and is retried before same-owner resume", async () => {
  const state = fixture({ closeFailures: 1 });
  await state.bridge.handleMessage({ type: "ready" });
  await assert.rejects(state.bridge.setVisible(false), /synthetic cleanup/);
  await state.bridge.setVisible(true);
  assert.equal(state.calls.filter(([name]) => name === "close-canvas").length, 2);
  assert.equal(state.messages.at(-1).type, "visibility");
  assert.equal(state.messages.at(-1).visible, true);
  state.bridge.dispose();
  await state.bridge.closed();
});
