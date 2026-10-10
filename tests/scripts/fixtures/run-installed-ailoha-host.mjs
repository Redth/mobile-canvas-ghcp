import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { enableCatalogCreation, scenario, sourceSha } from "./ailoha-sdk-double.mjs";
import { catalogIds } from "./ailoha-catalog-creation.mjs";

const root = resolve(process.argv[2]);
const host = process.argv[3];
const source = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = join(source, ".build", `ailoha-installed-check-${process.pid}-${randomUUID()}`);
const pinPath = join(root, "lib", "ailoha", "runtime-package.json");
mkdirSync(scratch, { recursive: true });
let previousPin;
try { previousPin = readFileSync(pinPath); }
catch (error) { if (error.code !== "ENOENT") throw error; }
process.env.AILOHA_TEST_CONTEXT_STATE = join(scratch, "context.json");
process.env.MOBILE_CANVAS_BACKEND = "ailoha";
const scope = { sessionId: `live-test-session-${process.pid}`, viewId: `${host}-view` };
const { createAilohaVideoReceiver } = await import(pathToFileURL(join(root, "web", "ailoha-video-receiver.js")).href);
const { createAilohaMcpDispatcher } = await import(pathToFileURL(join(root, "lib", "ailoha", "mcp-host.mjs")).href);
const { createRuntimeCanvasHost, createRuntimeMobileBackend, getRuntimeContextBinding } =
  await import(pathToFileURL(join(root, "lib", "ailoha", "runtime-backend.mjs")).href);
let release;
let receiver;
let dispatcher;
let selectedContext;
let readCatalog;
let createFromHost;
let selectedFromHost;
const logs = [];
const units = [];

async function waitFor(condition) {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(condition(), true, "Installed host condition did not become ready.");
}

function returnedBinding(selection) {
  assert.deepEqual(selection.scope, scope);
  assert.equal(selection.contextBinding.ownerProcessId, process.pid);
  assert.equal(typeof selection.contextBinding.processStartedAt, "string");
  assert.equal(typeof selection.contextBinding.contextRef, "string");
  assert.equal(typeof selection.contextBinding.scopeEpoch, "string");
  assert.match(selection.contextBinding.revision, /^(0|[1-9][0-9]*)$/);
  return { ...selection.contextBinding, scope: selection.scope };
}

const mcpCall = (name, input = {}) => ({
  jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: input },
});

async function checkDeviceFeatures(api, selected) {
  const base = "/api/v1/devices/opaque%2Ftarget";
  const hardware = await api(`${base}/hardware`);
  assert.equal(hardware.status, 200);
  assert.deepEqual(await hardware.json(), {
    schemaVersion: "1.0", deviceId: "opaque/target", platform: "ios",
    batteryLevel: 80, batteryState: "charging", downloadBitsPerSecond: null,
    uploadBitsPerSecond: null, latencyMs: null, networkIsIndicatorOnly: false,
    unreadable: ["location"],
  });
  const clipboard = await api(`${base}/clipboard`);
  assert.equal((await clipboard.json()).text, "synthetic clipboard");
  const settings = await api(`${base}/settings`, "POST", { appearance: "dark" });
  assert.equal(settings.status, 200);
  assert.equal((await settings.json()).appearance, "dark");
  assert.equal((await (await api(`${base}/settings`)).json()).appearance, "dark");
  const clear = await api(`${base}/hardware/location`, "DELETE");
  assert.deepEqual(await clear.json(), { success: true, operation: "location-clear", deviceId: null });
  for (const [path, input] of [
    ["hardware/battery", { level: 80 }],
    ["hardware/network", { latencyMs: 100 }],
    ["hardware/network", { profile: "lte" }],
    ["hardware/location", { latitude: 1, longitude: 2 }],
    ["clipboard", { text: "text" }],
  ]) {
    assert.equal((await api(`${base}/${path}`, "POST", input)).status, 501);
  }
  for (const [path, method, input] of [
    ["calls", "GET"], ["calls", "POST", { action: "place", number: "+123" }],
    ["permissions?bundleId=com.example.synthetic", "GET"],
    ["permissions", "POST", { bundleId: "com.example.synthetic", permission: "camera" }],
  ]) assert.equal((await api(`${base}/${path}`, method, input)).status, 501);
  const direct = await createAilohaMcpDispatcher({ version: "synthetic-only", binding: returnedBinding(selected) });
  try {
    for (const [name, expected] of [
      ["mobile_device_hardware_get", "batteryLevel"],
      ["mobile_device_clipboard_get", "text"],
      ["mobile_device_settings_get", "appearance"],
    ]) {
      const reply = await direct.handle(mcpCall(name, { deviceId: "opaque/target" }));
      assert.notEqual(reply.result.isError, true);
      assert.equal(Object.hasOwn(reply.result.structuredContent, expected), true);
    }
    const scan = await direct.handle(mcpCall("mobile_device_biometric",
      { deviceId: "opaque/target", action: "nomatch" }));
    assert.deepEqual(scan.result.structuredContent, {
      schemaVersion: "1.0", deviceId: "opaque/target", platform: "ios",
      action: "nomatch", confirmed: false,
    });
    const push = await direct.handle(mcpCall("mobile_device_notification_push", {
      deviceId: "opaque/target", bundleId: "com.example.synthetic", payload: '{"aps":{"alert":"hi"}}',
    }));
    assert.deepEqual(push.result.structuredContent, {
      success: true, operation: "notification-push", deviceId: null,
    });
    assert.equal(scenario.calls.some((call) => call.path?.endsWith("/apps?includeSystem=true")), true);
    const gated = await direct.handle(mcpCall("mobile_device_battery_set",
      { deviceId: "opaque/target", level: 80 }));
    assert.equal(JSON.parse(gated.result.content[0].text).code, "capability_not_supported");
    for (const [name, input] of [
      ["mobile_device_calls", {}],
      ["mobile_device_call", { action: "place", number: "+123" }],
      ["mobile_device_permission_list", { bundleId: "com.example.synthetic" }],
      ["mobile_device_permission_set", { bundleId: "com.example.synthetic", permission: "camera" }],
    ]) {
      const reply = await direct.handle(mcpCall(name, { deviceId: "opaque/target", ...input }));
      assert.equal(JSON.parse(reply.result.content[0].text).code, "capability_not_supported");
    }
  } finally { await direct.dispose(); }
  assert.equal(scenario.calls.some((call) => call.method === "PUT"), false);
}

async function checkSourceConditionalFeatures(selected, androidId) {
  scenario.sourceFeatureContracts = true;
  const binding = returnedBinding(selected);
  const options = {
    scope, contextRef: binding.contextRef, scopeEpoch: binding.scopeEpoch,
    ownerProcessId: binding.ownerProcessId, allowContextReopen: false,
    featureOptions: { allowPut: true, allowNativeFidelity: true },
  };
  const sourceHost = createRuntimeCanvasHost(options);
  let api;
  let closeApi;
  if (host === "github") {
    const opened = await sourceHost.openCanvas();
    const url = new URL(opened.url);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const bootstrap = await fetch(new URL("/api/v1/auth/bootstrap", url), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: fragment.get("bootstrap"), sessionId: scope.sessionId, instanceId: scope.viewId }),
    });
    assert.equal(bootstrap.status, 204);
    const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
    api = (path, { method = "GET", body } = {}) => fetch(new URL(path, url), {
      method, headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body }),
    });
  } else {
    const require = createRequire(import.meta.url);
    const extensionRoot = resolve(process.argv[4] ?? join(source, "vscode"));
    const { HostBridge } = require(join(extensionRoot, "out", "hostBridge.js"));
    const messages = [];
    const bridge = new HostBridge(undefined, scope.sessionId, scope.viewId, {
      async postMessage(message) { messages.push(message); return true; },
    }, { appendLine() {} }, undefined, sourceHost);
    await bridge.handleMessage({ type: "ready" });
    api = async (path, { method = "GET", body } = {}) => {
      const id = randomUUID();
      await bridge.handleMessage({ type: "api", id, path, method, body });
      const result = messages.find((message) => message.id === id);
      assert.equal(result.type, "api-result");
      return new Response(result.body, { status: result.status, headers: result.headers });
    };
    closeApi = async () => { bridge.dispose(); await bridge.closed(); };
  }
  const sourceMcp = await createAilohaMcpDispatcher({
    binding, version: "source-contract-only", allowPut: true, allowNativeFidelity: true,
    createBackend: () => createRuntimeMobileBackend(options),
  });
  const ios = "opaque/target";
  const nativePackage = "com.example.synthetic";
  const cases = [
    ["hardware_get", ios, "hardware", "GET", {}, "batteryLevel", 80],
    ["battery_set", ios, "hardware/battery", "POST", { level: 75 }, "batteryLevel", 75],
    ["network_set", ios, "hardware/network", "POST", { profile: "wifi" }, "networkIsIndicatorOnly", true],
    ["location_set", ios, "hardware/location", "POST", { latitude: 2, longitude: -3 }, "operation", "location-set"],
    ["location_clear", ios, "hardware/location", "DELETE", {}, "operation", "location-clear"],
    ["clipboard_get", ios, "clipboard", "GET", {}, "text", "synthetic clipboard"],
    ["clipboard_set", ios, "clipboard", "POST", { text: "source clipboard" }, "text", "source clipboard"],
    ["settings_get", ios, "settings", "GET", {}, "appearance", "dark"],
    ["settings_set", ios, "settings", "POST", { appearance: "dark" }, "appearance", "dark"],
    ["biometric", ios, "biometric", "POST", { action: "nomatch" }, "confirmed", false],
    ["sms_send", ios, "sms", "POST", { from: "+123", body: "incoming" }, "operation", "sms-send"],
    ["notification_push", ios, "notifications", "POST",
      { bundleId: nativePackage, payload: '{"aps":{"alert":"source"}}' }, "operation", "notification-push"],
    ["permission_list", ios, `permissions?bundleId=${nativePackage}`, "GET",
      { bundleId: nativePackage }, "total", 1],
    ["permission_set", ios, "permissions", "POST",
      { bundleId: nativePackage, permission: "camera", action: "reset" }, "action", "reset"],
    ["calls", androidId, "calls", "GET", {}, "platform", "android"],
    ["call", androidId, "calls", "POST", { action: "place", number: "+123" }, "platform", "android"],
    ["network_set", androidId, "hardware/network", "POST",
      { profile: "lte", latencyMs: 175 }, "latencyMs", 175],
    ["network_set", androidId, "hardware/network", "POST", { latencyMs: 125 }, "latencyMs", 125],
    ["biometric", androidId, "biometric", "POST",
      { action: "match", fingerId: 7 }, "confirmed", true],
    ["permission_list", androidId, `permissions?bundleId=${nativePackage}`, "GET",
      { bundleId: nativePackage }, "total", 1],
    ["permission_set", androidId, "permissions", "POST",
      { bundleId: nativePackage, permission: "camera", action: "grant" }, "action", "grant"],
  ];
  try {
    for (const [name, id, path, method, input, field, value] of cases) {
      const route = `/api/v1/devices/${encodeURIComponent(id)}/${path}`;
      const response = await api(route, {
        method, ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify(input) }),
      });
      assert.equal(response.status, 200, `${host} source API ${name}: ${await response.clone().text()}`);
      const apiResult = await response.json();
      assert.equal(apiResult[field], value, `${host} source API ${name}`);
      const mcp = await sourceMcp.handle(mcpCall(`mobile_device_${name}`, { deviceId: id, ...input }));
      assert.notEqual(mcp.result.isError, true, `${host} source MCP ${name}: ${JSON.stringify(mcp.result)}`);
      assert.equal(mcp.result.structuredContent[field], value, `${host} source MCP ${name}`);
      for (const result of [apiResult, mcp.result.structuredContent]) {
        if (name === "calls" || name === "call") {
          assert.deepEqual(result.calls, [{ number: "+123", state: "RINGING" }]);
        }
        if (name === "permission_list") {
          assert.deepEqual(result.permissions, [{
            name: "camera", platformName: id === ios ? "camera" : "android.permission.CAMERA",
            granted: null,
          }]);
          assert.equal(result.bundleId, nativePackage);
        }
        if (name === "permission_set") {
          assert.equal(result.permissions.length, 2);
          assert.equal(result.permissions[0].granted, null);
          assert.equal(result.permissions[1].granted, true);
          assert.equal(result.bundleId, nativePackage);
        }
        if (name === "biometric") assert.equal(result.platform, id === ios ? "ios" : "android");
      }
    }
    const wire = scenario.calls;
    assert.equal(wire.some((call) => call.method === "PUT" && call.path?.endsWith("/battery")), true);
    assert.equal(wire.some((call) => call.method === "PUT" && call.path?.endsWith("/permissions/camera")
      && JSON.parse(call.body).appId === "canonical/resolved-app"), true);
    assert.equal(wire.some((call) => call.path?.endsWith("/push/notifications")
      && JSON.parse(call.body).appId === "canonical/resolved-app"), true);
    assert.equal(wire.some((call) => call.path?.endsWith("/biometrics/results")
      && call.path.includes(encodeURIComponent(androidId)) && JSON.parse(call.body).fingerId === 7), true);
    const missingEvidence = [
      ["calls", "calls", androidId, "GET", {}, "GET"],
      ["permissionName", "permission_list", ios, "GET", { bundleId: nativePackage }, "GET"],
      ["permissionFanout", "permission_set", androidId, "POST",
        { bundleId: nativePackage, permission: "contacts", action: "revoke" }, "PUT"],
      ["biometricConfirmed", "biometric", androidId, "POST",
        { action: "nomatch", fingerId: 11 }, "POST"],
      ["profileIndicator", "network_set", ios, "POST", { profile: "edge" }, "POST"],
    ];
    for (const [missing, name, id, method, input, wireMethod] of missingEvidence) {
      scenario.omitSourceEvidence = missing;
      const path = name === "permission_list" ? `permissions?bundleId=${nativePackage}`
        : name === "permission_set" ? "permissions"
        : name === "network_set" ? "hardware/network" : name;
      const route = `/api/v1/devices/${encodeURIComponent(id)}/${path}`;
      const before = wire.filter((call) => call.method === wireMethod).length;
      const request = () => api(route, {
        method, ...(method === "GET" ? {} : { body: JSON.stringify(input) }),
      });
      const response = await request();
      assert.equal(response.status, 501, `${host} missing ${missing}: ${await response.clone().text()}`);
      assert.equal((await response.json()).code, "capability_not_supported");
      if (method === "POST") {
        const repeated = await request();
        assert.equal(repeated.status, missing === "permissionFanout" ? 502 : 501,
          `${host} repeated ${missing}`);
        assert.equal((await repeated.json()).code,
          missing === "permissionFanout" ? "feature_outcome_uncertain" : "capability_not_supported");
        assert.equal(wire.filter((call) => call.method === wireMethod).length, before + 1,
          `${host} missing ${missing} must not replay`);
      }
      const mcp = await sourceMcp.handle(mcpCall(`mobile_device_${name}`, { deviceId: id, ...input }));
      assert.equal(mcp.result.isError, true);
      assert.equal(JSON.parse(mcp.result.content[0].text).code, "capability_not_supported");
    }
    scenario.omitSourceEvidence = null;
    return cases.length * 2;
  } finally {
    scenario.omitSourceEvidence = null;
    await sourceMcp.dispose();
    await closeApi?.();
    await sourceHost.closeCanvas();
    scenario.sourceFeatureContracts = false;
  }
}

async function checkEmptyContext(selection) {
  assert.equal(selection.hasSelection, false);
  assert.equal(Object.hasOwn(selection, "device"), false);
  const binding = returnedBinding(selection);
  const callsBeforeDiscovery = scenario.calls.length;
  const contextWrittenAt = statSync(process.env.AILOHA_TEST_CONTEXT_STATE, { bigint: true }).mtimeNs;
  assert.deepEqual(await getRuntimeContextBinding(scope), {
    contextRef: binding.contextRef, scopeEpoch: binding.scopeEpoch, scope: binding.scope, ownerProcessId: binding.ownerProcessId,
  });
  assert.equal(scenario.calls.length, callsBeforeDiscovery);
  const emptyDispatcher = await createAilohaMcpDispatcher({ version: "0.1.18", binding });
  try {
    const selected = await emptyDispatcher.handle(mcpCall("mobile_device_get_selected"));
    assert.notEqual(selected.result.isError, true);
    assert.equal(selected.result.structuredContent.hasSelection, false);
    assert.deepEqual(selected.result.structuredContent.contextBinding, selection.contextBinding);
    const catalog = await emptyDispatcher.handle(mcpCall("mobile_device_catalog"));
    assert.notEqual(catalog.result.isError, true);
    assert.equal(catalog.result.structuredContent.devices[0].nativeId, "native-deployment-not-opaque-target");
    const inventory = await emptyDispatcher.handle(mcpCall("mobile_device_list"));
    assert.notEqual(inventory.result.isError, true);
    assert.equal(inventory.result.structuredContent.result[0].id, "opaque/target");
    assert.deepEqual(JSON.parse(inventory.result.content[0].text), inventory.result.structuredContent);
    assert.equal(scenario.calls.some((call) => call.method === "POST" || call.method === "DELETE"), false);
    assert.equal(statSync(process.env.AILOHA_TEST_CONTEXT_STATE, { bigint: true }).mtimeNs, contextWrittenAt);
  } finally {
    await emptyDispatcher.dispose();
  }
}

try {
  rmSync(pinPath, { force: true });
  await assert.rejects(getRuntimeContextBinding(scope), { code: "ailoha_runtime_unavailable", status: 503 });
  const unavailable = createRuntimeCanvasHost({ scope });
  await assert.rejects(unavailable.openCanvas(), { code: "ailoha_runtime_unavailable", status: 503 });
  await unavailable.closeCanvas();
  assert.equal(existsSync(process.env.AILOHA_TEST_CONTEXT_STATE), false);
  assert.equal(scenario.calls.length, 0);
  writeFileSync(pinPath, JSON.stringify({ schema: "mobile-canvas.ailoha-runtime/v1", version: "synthetic-only", sourceSha }));
  await assert.rejects(getRuntimeContextBinding(scope), { code: "context_not_bound" });
  assert.equal(existsSync(process.env.AILOHA_TEST_CONTEXT_STATE), false);
  assert.equal(scenario.calls.length, 0);
  scenario.ensureFailureCode = "RuntimeStateInvalidLeaseLock";
  const locked = createRuntimeCanvasHost({ scope });
  try {
    await assert.rejects(locked.openCanvas(), (error) => {
      assert.equal(error.code, "RuntimeStateInvalidLeaseLock");
      assert.equal(error.status, 503);
      assert.equal(JSON.stringify(error).includes("private runtime diagnostic"), false);
      assert.equal(Object.hasOwn(error, "cause"), false);
      return true;
    });
    assert.equal(scenario.leases.size, 0);
    assert.equal(scenario.videos.size, 0);
    assert.equal(scenario.calls.some((call) => call.path || call.websocket), false);
  } finally {
    scenario.ensureFailureCode = undefined;
    await locked.closeCanvas();
  }
  const officialEvidence = scenario.connectionRef;
  function assertPrivateConnectionRefAbsent(value) {
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes("connectionRef"), false);
    assert.equal(serialized.includes(officialEvidence.serviceId), false);
    assert.equal(serialized.includes(officialEvidence.processStartedAt), false);
  }
  const missingEvidence = createRuntimeCanvasHost({ scope });
  scenario.connectionRef = undefined;
  const beforeInvalidEvidence = scenario.calls.length;
  try {
    await assert.rejects(missingEvidence.openCanvas(), { code: "runtime_connection_ref_invalid", status: 503 });
    assert.equal(scenario.leases.size, 0);
    assert.equal(scenario.calls.slice(beforeInvalidEvidence).some((call) => call.path || call.websocket), false);
  } finally {
    scenario.connectionRef = officialEvidence;
    await missingEvidence.closeCanvas();
  }
  const trustedHost = createRuntimeCanvasHost({ scope });
  try {
    await trustedHost.openCanvas();
    const captured = trustedHost.connectionRef;
    assert.deepEqual(captured, officialEvidence);
    assert.equal(Object.isFrozen(captured), true);
    officialEvidence.pid += 1;
    assert.notEqual(trustedHost.connectionRef.pid, officialEvidence.pid);
    officialEvidence.pid -= 1;
    assert.equal(JSON.stringify(trustedHost).includes("connectionRef"), false);
    const selected = await trustedHost.invokeAction("get_selected_device", {});
    assertPrivateConnectionRefAbsent(selected);
  } finally {
    await trustedHost.closeCanvas();
  }
  if (host === "github") {
    process.env.EXTENSION_PATH = join(scratch, "installed-plugins", "mobile-canvas", "extension.mjs");
    await import(pathToFileURL(join(root, "extensions", "mobile-canvas", "extension.mjs")).href);
    const registration = globalThis.ailohaTestCanvasRegistration;
    const canvas = registration.canvases[0];
    assert.equal(canvas.id, "mobile-device");
    assert.equal(canvas.actions.length, 25);
    assert.equal(canvas.actions.at(-1).name, "workspace_inspect");
    const baseline = JSON.parse(readFileSync(join(source, "tests/scripts/ailoha-compatibility-baseline.json"), "utf8"));
    assert.deepEqual(canvas.actions.slice(0, 24).map((entry) => entry.name).sort(), baseline.canvasActions);
    const context = { sessionId: scope.sessionId, instanceId: scope.viewId };
    const action = (name, input = {}) => canvas.actions.find((entry) => entry.name === name).handler({ ...context, input });
    readCatalog = () => action("get_device_catalog");
    createFromHost = (input) => action("create_device", input);
    selectedFromHost = () => action("get_selected_device");
    assert.equal(canvas.actions.find((entry) => entry.name === "create_device").inputSchema.properties.platform.default, "ios");
    const opened = await canvas.open(context);
    release = async () => {
      await canvas.onClose(context);
      await registration.hooks.onSessionEnd();
    };
    const devices = await action("list_devices");
    assert.equal(devices[0].nativeId, "native-deployment-not-opaque-target");
    assert.notEqual(devices[0].nativeId, devices[0].id);
    await checkEmptyContext(await action("get_selected_device"));
    await action("select_device", { deviceId: "opaque/target" });
    const selected = await action("get_selected_device");
    selectedContext = selected;
    assert.equal(selected.device.id, "opaque/target");
    assertPrivateConnectionRefAbsent(selected);
    returnedBinding(selected);
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
    await checkDeviceFeatures(async (path, method = "GET", body) => fetch(new URL(path, url), {
      method, headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), selected);
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
    assert.deepEqual(bridge.connectionRef, officialEvidence);
    assert.equal(bridge.connectionRef, hostAdapter.connectionRef);
    assert.equal(Object.isFrozen(bridge.connectionRef), true);
    async function api(path, method = "GET", body) {
      const id = randomUUID();
      await bridge.handleMessage({ type: "api", id, path, method, body: body === undefined ? undefined : JSON.stringify(body) });
      const result = messages.find((message) => message.id === id);
      assert.equal(result.type, "api-result");
      return new Response(result.body, { status: result.status, headers: result.headers });
    }
    readCatalog = async () => (await api("/api/v1/catalog")).json();
    createFromHost = async (input) => {
      const response = await api("/api/v1/devices", "POST", input);
      assert.equal(response.status, 200);
      return response.json();
    };
    selectedFromHost = async () => (await api("/api/v1/selection")).json();
    const catalog = await (await api("/api/v1/catalog")).json();
    assert.equal(catalog.devices[0].nativeId, "native-deployment-not-opaque-target");
    await checkEmptyContext(await (await api("/api/v1/selection")).json());
    await api("/api/v1/selection", "POST", { deviceId: "opaque/target" });
    const selected = await bridge.getSelectedDeviceContext();
    selectedContext = selected.selection;
    assert.equal(selected.deviceId, "opaque/target");
    returnedBinding(selected.selection);
    await checkDeviceFeatures(api, selected.selection);
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
    assertPrivateConnectionRefAbsent(messages);
  } else throw new Error("Unknown installed host test.");
  enableCatalogCreation();
  const creationCatalog = await readCatalog();
  assert.equal(creationCatalog.creationSupport.supported, true);
  const inputFor = (platform, name) => ({
    platform, name,
    runtimeId: creationCatalog.runtimes.find((runtime) =>
      runtime.catalogSelection.providerId === catalogIds[`${platform}Provider`]
      && runtime.catalogSelection.runtimeId === catalogIds.runtime).id,
    deviceTypeId: creationCatalog.deviceTypes.find((type) =>
      type.catalogSelection.providerId === catalogIds[`${platform}Provider`] && type.targetTypeId === catalogIds.type).id,
  });
  const creationRecords = [];
  const callsBeforeCreate = scenario.calls.length;
  for (const platform of ["ios", "android"]) {
    const input = inputFor(platform, `Owned installed ${platform}`);
    const created = await createFromHost(input);
    assert.equal(created.state, "booted");
    assert.equal(created.selectionApplied, true);
    assert.notEqual(created.nativeId, created.id);
    assert.equal(created.runtimeId, input.runtimeId);
    assert.equal(created.deviceTypeId, input.deviceTypeId);
    selectedContext = await selectedFromHost();
    assert.equal(selectedContext.device.id, created.id);
    assert.equal(selectedContext.device.nativeId, created.nativeId);
    creationRecords.push(created);
  }
  const androidMcp = await createAilohaMcpDispatcher({
    version: "synthetic-only", binding: returnedBinding(selectedContext),
  });
  try {
    const sms = await androidMcp.handle(mcpCall("mobile_device_sms_send", {
      deviceId: selectedContext.device.id, from: "+123", body: "android text",
    }));
    assert.deepEqual(sms.result.structuredContent, {
      success: true, operation: "sms-send", deviceId: selectedContext.device.id,
    });
    assert.equal(scenario.calls.some((call) => call.path?.endsWith("/telephony/sms")
      && JSON.parse(call.body).phoneNumber === "+123"), true);
    const unsupportedScan = await androidMcp.handle(mcpCall("mobile_device_biometric", {
      deviceId: selectedContext.device.id, action: "match", fingerId: 7,
    }));
    assert.equal(JSON.parse(unsupportedScan.result.content[0].text).code, "capability_not_supported");
    assert.equal(scenario.calls.some((call) => call.path?.endsWith("/biometrics/results")
      && call.path.includes(encodeURIComponent(selectedContext.device.id))), false);
  } finally { await androidMcp.dispose(); }
  const rawMcp = await createAilohaMcpDispatcher({ version: "synthetic-only", binding: returnedBinding(selectedContext) });
  try {
    const created = await rawMcp.handle({
      ...mcpCall("mobile_device_create"),
      params: { name: "mobile_device_create", arguments: inputFor("ios", "Owned installed raw MCP") },
    });
    assert.notEqual(created.result.isError, true);
    assert.equal(created.result.structuredContent.selectionApplied, false);
    assert.equal((await selectedFromHost()).device.id, selectedContext.device.id);
    creationRecords.push(created.result.structuredContent);
  } finally { await rawMcp.dispose(); }
  if (host === "vscode") {
    const followedMcp = await createAilohaMcpDispatcher({
      version: "synthetic-only", selectCreated: true, binding: returnedBinding(selectedContext),
    });
    try {
      const created = await followedMcp.handle({
        ...mcpCall("mobile_device_create"),
        params: { name: "mobile_device_create", arguments: inputFor("android", "Owned installed VS Code MCP") },
      });
      assert.notEqual(created.result.isError, true);
      assert.equal(created.result.structuredContent.selectionApplied, true);
      selectedContext = await selectedFromHost();
      assert.equal(selectedContext.device.id, created.result.structuredContent.id);
      creationRecords.push(created.result.structuredContent);
    } finally { await followedMcp.dispose(); }
  }
  const creationCalls = scenario.calls.slice(callsBeforeCreate)
    .filter((call) => call.method === "POST" && call.path === "/api/v1/targets");
  assert.equal(creationCalls.length, creationRecords.length);
  assert.equal(creationCalls.every((call) => call.path === "/api/v1/targets" && JSON.parse(call.body).start === true), true);
  assert.equal(creationCalls.every((call) => {
    const input = JSON.parse(call.body);
    return input.runtimeId === catalogIds.runtime && input.targetTypeId === catalogIds.type
      && [catalogIds.iosProvider, catalogIds.androidProvider].includes(input.providerId);
  }), true);
  const sourceFeatureResults = await checkSourceConditionalFeatures(
    selectedContext, creationRecords.find((record) => record.platform === "android").id,
  );
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
  assert.equal(contextCommands[0].contextRef, selectedContext.contextBinding.contextRef);
  assert.equal(contextCommands[0].scopeEpoch, selectedContext.contextBinding.scopeEpoch);
  dispatcher = await createAilohaMcpDispatcher({
    version: "0.1.18",
    binding: returnedBinding(selectedContext),
  });
  const mcpResult = await dispatcher.handle(mcpCall("mobile_device_get_selected"));
  assert.notEqual(mcpResult.result.isError, true);
  assert.equal(mcpResult.result.structuredContent.contextBinding.contextRef, selectedContext.contextBinding.contextRef);
  assert.equal(mcpResult.result.structuredContent.contextBinding.scopeEpoch, selectedContext.contextBinding.scopeEpoch);
  assert.deepEqual(mcpResult.result.structuredContent.scope, selectedContext.scope);
  assert.equal(mcpResult.result.structuredContent.device.id, selectedContext.device.id);
  assert.equal(mcpResult.result.structuredContent.device.nativeId, selectedContext.device.nativeId);
  contextCommands[0] = {
    ...contextCommands[0], state: "detached", selection: null, observed: null,
    revision: String(BigInt(contextCommands[0].revision) + 1n),
  };
  writeFileSync(process.env.AILOHA_TEST_CONTEXT_STATE, JSON.stringify(contextCommands));
  const callsBeforeRetirement = scenario.calls.length;
  const retiredTarget = await dispatcher.handle(mcpCall("mobile_device_get", { deviceId: "opaque/target" }));
  assert.equal(retiredTarget.result.isError, true);
  assert.equal(JSON.parse(retiredTarget.result.content[0].text).code, "view_closed");
  assert.equal(scenario.calls.length, callsBeforeRetirement);
  const retired = await dispatcher.handle(mcpCall("mobile_device_get_selected"));
  assert.equal(retired.result.isError, true);
  assert.equal(JSON.parse(retired.result.content[0].text).code, "view_closed");
  assert.equal(JSON.stringify(retired).includes("contextBinding"), false);
  await assert.rejects(getRuntimeContextBinding(scope), { code: "context_retired" });
  assert.equal(scenario.calls.length, callsBeforeRetirement);
  assert.equal(JSON.parse(readFileSync(process.env.AILOHA_TEST_CONTEXT_STATE, "utf8"))[0].state, "detached");
  await dispatcher.dispose();
  dispatcher = null;
  assert.equal(scenario.leases.size, 0);
  console.log(JSON.stringify({
    host, synthetic: true, selectedScope: scope, units, leaseCountAfterClose: scenario.leases.size,
    videoResourcesAfterClose: scenario.videos.size, operationPolls: scenario.calls.filter((call) => call.path?.startsWith("/api/v1/operations/")).length,
    nativeIdentityPreserved: true, returnedBindingConsumed: true, emptyContextInventory: true,
    externalRetirementRejected: true, readOnlyDiscovery: true, missingPublicPinRejected: true,
    runtimeLockFailureRejected: true, retiredDirectTargetReadRejected: true, noHostStop: true, logs,
    creationRecords: creationRecords.map((record) => ({
      id: record.id, platform: record.platform, nativeId: record.nativeId, state: record.state,
      selectionApplied: record.selectionApplied, operationId: record.acceptedOperation.operationId,
    })),
    createPosts: creationCalls.length, noSeparateBootPost: true,
    connectionRefCapturedInternally: true, connectionRefNotSerialized: true,
    deviceFeaturesValidated: true,
    sourceFeatureResults,
  }));
} finally {
  await dispatcher?.dispose();
  await receiver?.dispose();
  await release?.();
  if (previousPin) writeFileSync(pinPath, previousPin);
  else rmSync(pinPath, { force: true });
  rmSync(join(scratch, "screen.png"), { force: true });
  rmSync(join(scratch, "context.json"), { force: true });
  rmSync(scratch, { recursive: true, force: true });
}
