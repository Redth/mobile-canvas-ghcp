import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { scenario, sourceSha } from "./ailoha-sdk-double.mjs";

const root = resolve(process.argv[2]);
const host = process.argv[3];
const source = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = join(source, ".build", `ailoha-installed-check-${process.pid}-${randomUUID()}`);
const pinPath = join(root, "lib", "ailoha", "runtime-package.json");
mkdirSync(scratch, { recursive: true });
let previousPin;
try { previousPin = readFileSync(pinPath); }
catch (error) { if (error.code !== "ENOENT") throw error; }
writeFileSync(pinPath, JSON.stringify({ schema: "mobile-canvas.ailoha-runtime/v1", version: "synthetic-only", sourceSha }));
process.env.AILOHA_TEST_CONTEXT_STATE = join(scratch, "context.json");
process.env.MOBILE_CANVAS_BACKEND = "ailoha";
const scope = { sessionId: `live-test-session-${process.pid}`, viewId: `${host}-view` };
const { createAilohaVideoReceiver } = await import(pathToFileURL(join(root, "web", "ailoha-video-receiver.js")).href);
let release;
let receiver;
const logs = [];
const units = [];

async function waitFor(condition) {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(condition(), true, "Installed host condition did not become ready.");
}

try {
  if (host === "github") {
    process.env.EXTENSION_PATH = join(scratch, "installed-plugins", "mobile-canvas", "extension.mjs");
    await import(pathToFileURL(join(root, "extensions", "mobile-canvas", "extension.mjs")).href);
    const registration = globalThis.ailohaTestCanvasRegistration;
    const canvas = registration.canvases[0];
    assert.equal(canvas.id, "mobile-device");
    assert.equal(canvas.actions.length, 24);
    const context = { sessionId: scope.sessionId, instanceId: scope.viewId };
    const action = (name, input = {}) => canvas.actions.find((entry) => entry.name === name).handler({ ...context, input });
    const opened = await canvas.open(context);
    release = async () => {
      await canvas.onClose(context);
      await registration.hooks.onSessionEnd();
    };
    const devices = await action("list_devices");
    assert.equal(devices[0].nativeId, "native-deployment-not-opaque-target");
    assert.notEqual(devices[0].nativeId, devices[0].id);
    await action("select_device", { deviceId: "opaque/target" });
    assert.equal((await action("get_selected_device")).device.id, "opaque/target");
    assert.equal((await action("shutdown_device", { deviceId: "opaque/target" })).state, "shutdown");
    assert.equal((await action("boot_device", { deviceId: "opaque/target" })).state, "booted");
    const geometry = await action("get_display_geometry", { deviceId: "opaque/target" });
    await action("tap_device", { deviceId: "opaque/target", x: 12, y: 10, geometryRevision: geometry.geometryRevision });
    const screenshot = await action("take_screenshot", { deviceId: "opaque/target", output: join(scratch, "screen.png") });
    assert.equal(screenshot.mimeType, "image/png");
    assert.equal(readFileSync(screenshot.path).length, screenshot.bytes);
    await assert.rejects(action("start_recording", { deviceId: "opaque/target" }), { status: 501 });
    const url = new URL(opened.url);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const bootstrap = await fetch(new URL("/api/v1/auth/bootstrap", url), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: fragment.get("bootstrap"), sessionId: scope.sessionId, instanceId: scope.viewId }),
    });
    assert.equal(bootstrap.status, 204);
    const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
    const socketUrl = new URL("/ws/video?deviceId=opaque%2Ftarget", url);
    socketUrl.protocol = "ws:";
    const socket = new WebSocket(socketUrl, "ailoha.video.v1", { headers: { Cookie: cookie } });
    let connection;
    socket.on("error", (error) => logs.push(error.message));
    socket.on("message", (data, isBinary) => {
      if (!connection) {
        const descriptor = JSON.parse(data.toString());
        assert.equal(descriptor.type, "mobile-canvas-video");
        receiver = createAilohaVideoReceiver({
          context: descriptor.context,
          onFrame(frame) { units.push(frame.sequence); return true; },
          onControl() {},
          onError(error) { logs.push(error.code); },
        });
        connection = receiver.attach({
          protocol: socket.protocol,
          send: (text) => new Promise((resolve, reject) => socket.send(text, (error) => error ? reject(error) : resolve())),
          close: () => new Promise((resolve) => { socket.once("close", resolve); socket.close(); }),
        });
        void connection.start();
      } else void connection.receive(isBinary ? new Uint8Array(data) : data.toString());
    });
    await waitFor(() => receiver?.lastAcknowledgedSequence === 5);
    await receiver.dispose();
  } else if (host === "vscode") {
    const require = createRequire(import.meta.url);
    const extensionRoot = resolve(process.argv[4] ?? join(source, "vscode"));
    const { HostBridge } = require(join(extensionRoot, "out", "hostBridge.js"));
    const { createRuntimeCanvasHost } = await import(pathToFileURL(join(root, "lib", "ailoha", "runtime-backend.mjs")).href);
    const hostAdapter = createRuntimeCanvasHost({ scope, onError: (error) => logs.push(error.code) });
    const messages = [];
    let connection;
    let bridge;
    const sink = {
      async postMessage(message) {
        messages.push(message);
        if (message.type === "socket-message") {
          if (!connection) {
            const descriptor = JSON.parse(message.data);
            assert.equal(descriptor.type, "mobile-canvas-video");
            receiver = createAilohaVideoReceiver({
              context: descriptor.context,
              onFrame(frame) { units.push(frame.sequence); return true; },
              onControl() {}, onError(error) { logs.push(error.code); },
            });
            connection = receiver.attach({
              protocol: "ailoha.video.v1",
              async send(text) {
                const requestId = randomUUID();
                await bridge.handleMessage({ type: "socket-send", id: "video", requestId, data: text });
                const reply = messages.find((message) => message.id === requestId);
                if (reply.type === "operation-error") throw new Error(reply.message);
              },
              async close() { await bridge.handleMessage({ type: "socket-close", id: "video" }); },
            });
            void connection.start();
          } else void connection.receive(message.data);
        }
        return true;
      },
    };
    bridge = new HostBridge(undefined, scope.sessionId, scope.viewId, sink, { appendLine: (line) => logs.push(line) }, undefined, hostAdapter);
    release = async () => { bridge.dispose(); await bridge.closed(); };
    await bridge.handleMessage({ type: "ready" });
    async function api(path, method = "GET", body) {
      const id = randomUUID();
      await bridge.handleMessage({ type: "api", id, path, method, body: body === undefined ? undefined : JSON.stringify(body) });
      const result = messages.find((message) => message.id === id);
      assert.equal(result.type, "api-result");
      return new Response(result.body, { status: result.status, headers: result.headers });
    }
    const catalog = await (await api("/api/v1/catalog")).json();
    assert.equal(catalog.devices[0].nativeId, "native-deployment-not-opaque-target");
    await api("/api/v1/selection", "POST", { deviceId: "opaque/target" });
    assert.equal((await bridge.getSelectedDeviceContext()).deviceId, "opaque/target");
    const screenshot = await bridge.getSelectedScreenshot();
    assert.equal(screenshot.bytes[0], 137);
    assert.equal((await api("/api/v1/devices/opaque%2Ftarget/shutdown", "POST")).status, 200);
    assert.equal((await api("/api/v1/devices/opaque%2Ftarget/boot", "POST")).status, 200);
    const display = await (await api("/api/v1/devices/opaque%2Ftarget/display")).json();
    await api("/api/v1/devices/opaque%2Ftarget/input/tap", "POST", { x: 12, y: 10, geometryRevision: display.geometryRevision });
    assert.equal((await api("/api/v1/devices/opaque%2Ftarget/recording")).status, 501);
    await bridge.handleMessage({ type: "socket-open", id: "video", channel: "video", query: "deviceId=opaque%2Ftarget" });
    await waitFor(() => receiver?.lastAcknowledgedSequence === 5);
    await receiver.dispose();
    await waitFor(() => scenario.videos.size === 0);
    await bridge.setVisible(false);
    assert.equal(scenario.leases.size, 0);
    await bridge.setVisible(true);
    await api("/api/v1/catalog");
    assert.equal((await bridge.getSelectedDeviceContext()).deviceId, "opaque/target");
    assert.equal(messages.some((message) => JSON.stringify(message).includes("controlCredential")), false);
  } else throw new Error("Unknown installed host test.");
  await release();
  release = null;
  assert.deepEqual(units, [0, 1, 2, 3, 4, 5]);
  assert.equal(scenario.videos.size, 0);
  assert.equal(scenario.leases.size, 0);
  assert.equal(scenario.calls.some((call) => call.path === "/api/v1/host/stop"), false);
  const body = scenario.calls.find((call) => call.path?.endsWith("/input/actions/tap")).body;
  assert.equal(JSON.parse(body).geometryRevision, 13);
  assert.equal(scenario.calls.filter((call) => call.path?.startsWith("/api/v1/operations/")).length >= 3, true);
  const contextCommands = JSON.parse(readFileSync(process.env.AILOHA_TEST_CONTEXT_STATE, "utf8"));
  assert.equal(contextCommands.length, 1);
  assert.deepEqual(contextCommands[0].scope, scope);
  assert.equal(contextCommands[0].state, "open");
  console.log(JSON.stringify({
    host, synthetic: true, selectedScope: scope, units, leaseCountAfterClose: scenario.leases.size,
    videoResourcesAfterClose: scenario.videos.size, operationPolls: scenario.calls.filter((call) => call.path?.startsWith("/api/v1/operations/")).length,
    nativeIdentityPreserved: true, noHostStop: true, logs,
  }));
} finally {
  await receiver?.dispose();
  await release?.();
  if (previousPin) writeFileSync(pinPath, previousPin);
  else rmSync(pinPath, { force: true });
  rmSync(join(scratch, "screen.png"), { force: true });
  rmSync(join(scratch, "context.json"), { force: true });
  rmSync(scratch, { recursive: true, force: true });
}
