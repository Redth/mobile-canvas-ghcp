import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

test("bridges bootstrap, API responses, and socket frames", async () => {
  const outbound = [];
  const listeners = new Map();
  let nextId = 0;
  const window = {
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
  };
  class TestCloseEvent extends Event {
    constructor(type, init = {}) {
      super(type);
      this.code = init.code ?? 0;
      this.reason = init.reason ?? "";
    }
  }
  const sandbox = {
    window,
    acquireVsCodeApi: () => ({
      postMessage: (message) => outbound.push(message),
    }),
    crypto: { randomUUID: () => `request-${++nextId}` },
    WebSocket: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
    EventTarget,
    Event,
    MessageEvent,
    CloseEvent: TestCloseEvent,
    Response,
    ArrayBuffer,
    Blob,
    Uint8Array,
    console,
  };
  const script = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "media", "vscode-transport.js"),
    "utf8",
  );
  vm.runInNewContext(script, sandbox);
  const transport = window.mobileCanvasTransport;
  const receive = (data) => {
    for (const listener of listeners.get("message") ?? []) listener({ data });
  };

  const bootstrap = transport.bootstrap();
  assert.equal(outbound.shift().type, "ready");
  receive({ type: "context", sessionId: "session", instanceId: "view" });
  const context = await bootstrap;
  assert.equal(context.sessionId, "session");
  assert.equal(context.instanceId, "view");

  const api = transport.api("/api/v1/catalog");
  const apiRequest = outbound.shift();
  assert.equal(apiRequest.type, "api");
  receive({
    type: "api-result",
    id: apiRequest.id,
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode('{"devices":[]}').buffer,
  });
  assert.deepEqual((await (await api).json()).devices, []);

  const socket = transport.createSocket("events");
  const socketRequest = outbound.shift();
  let opened = false;
  let frame;
  let visible;
  let refreshed = false;
  let automation;
  socket.addEventListener("open", () => { opened = true; });
  socket.addEventListener("message", (event) => { frame = event.data; });
  transport.onVisibilityChanged((value) => { visible = value; });
  receive({ type: "socket-opened", id: socketRequest.id });
  receive({
    type: "socket-message",
    id: socketRequest.id,
    data: new Uint8Array([1, 2, 3]).buffer,
  });
  receive({ type: "visibility", visible: false });
  receive({ type: "refresh" });
  receive({
    type: "automation",
    activity: { kind: "tap", deviceId: "ios:phone", x: 1, y: 2 },
  });
  transport.onRefreshRequested(() => { refreshed = true; });
  transport.onAutomationRequested((activity) => { automation = activity; });
  assert.equal(opened, true);
  assert.equal(frame.byteLength, 3);
  assert.equal(visible, false);
  assert.equal(refreshed, true);
  assert.equal(automation.deviceId, "ios:phone");

  const clipboard = transport.copyText("copied");
  const clipboardRequest = outbound.shift();
  assert.equal(clipboardRequest.type, "copy");
  assert.equal(clipboardRequest.text, "copied");
  receive({ type: "operation-result", id: clipboardRequest.id });
  await clipboard;

  const save = transport.saveBlob(
    new Blob(["png"], { type: "image/png" }),
    "screen.png",
  );
  await new Promise((resolve) => setImmediate(resolve));
  const saveRequest = outbound.shift();
  assert.equal(saveRequest.type, "save");
  assert.equal(saveRequest.suggestedName, "screen.png");
  assert.equal(saveRequest.bytes.byteLength, 3);
  receive({ type: "operation-result", id: saveRequest.id });
  await save;

  transport.setViewTitle("Pixel 6", "Android 15 · booted");
  const titleRequest = outbound.shift();
  assert.equal(titleRequest.type, "view-title");
  assert.equal(titleRequest.title, "Pixel 6");
  assert.equal(titleRequest.description, "Android 15 · booted");

  socket.close();
  assert.equal(outbound.shift().type, "socket-close");
});
