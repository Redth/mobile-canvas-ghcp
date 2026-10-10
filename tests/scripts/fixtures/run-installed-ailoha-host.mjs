import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { enableCatalogCreation, scenario, sourceSha } from "./ailoha-sdk-double.mjs";
import { catalogIds } from "./ailoha-catalog-creation.mjs";
import { stageEvents } from "./ailoha-native-stage-double.mjs";
import { guardedEvents } from "./ailoha-native-file-double.mjs";
import { copilotUi } from "./copilot-sdk-double.mjs";

const focusedText = process.argv.includes("--focused-text");
scenario.focusedText = focusedText;
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
process.env.AILOHA_TEST_STAGE_JOURNAL = join(scratch, "native-stage.jsonl");
process.env.AILOHA_TEST_GUARDED_JOURNAL = join(scratch, "native-file.jsonl");
process.env.AILOHA_TEST_GUARDED_ROOT = scratch;
process.env.MOBILE_CANVAS_BACKEND = "ailoha";
const scope = { sessionId: `live-test-session-${process.pid}`, viewId: `${host}-view` };
process.env.AILOHA_TEST_SESSION_ID = scope.sessionId;
const { createAilohaVideoReceiver } = await import(pathToFileURL(join(root, "web", "ailoha-video-receiver.js")).href);
const { createAilohaMcpDispatcher } = await import(pathToFileURL(join(root, "lib", "ailoha", "mcp-host.mjs")).href);
const { createRuntimeCanvasHost, createRuntimeMobileBackend, getRuntimeContextBinding } =
  await import(pathToFileURL(join(root, "lib", "ailoha", "runtime-backend.mjs")).href);
const { AilohaMobileBackend } = await import(pathToFileURL(join(root, "lib", "ailoha", "mobile-backend.mjs")).href);
const { ARTIFACT_FEATURE_GATES } = await import(pathToFileURL(join(root, "lib", "ailoha", "artifact-features.mjs")).href);
let release;
let receiver;
let dispatcher;
let selectedContext;
let readCatalog;
let createFromHost;
let selectedFromHost;
let requestFromHost;
let presentationApi;
let recordThroughHost;
let stopThroughHost;
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
    api = (path, { method = "GET", body, signal } = {}) => fetch(new URL(path, url), {
      method, headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      signal,
      ...(body === undefined ? {} : { body }),
    });
  } else {
    const require = createRequire(import.meta.url);
    const extensionRoot = resolve(process.argv[4]?.startsWith("--") ? join(source, "vscode") : process.argv[4] ?? join(source, "vscode"));
    const { HostBridge } = require(join(extensionRoot, "out", "hostBridge.js"));
    const messages = [];
    const bridge = new HostBridge(undefined, scope.sessionId, scope.viewId, {
      async postMessage(message) { messages.push(message); return true; },
    }, { appendLine() {} }, undefined, sourceHost);
    await bridge.handleMessage({ type: "ready" });
    api = async (path, { method = "GET", body, signal } = {}) => {
      const id = randomUUID();
      const abort = () => { void bridge.handleMessage({ type: "api-cancel", id }); };
      signal?.addEventListener("abort", abort, { once: true });
      try { await bridge.handleMessage({ type: "api", id, path, method, body }); }
      finally { signal?.removeEventListener("abort", abort); }
      const result = messages.find((message) => message.id === id);
      if (result.type === "api-error") throw new Error(result.message);
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
  async function verifyCancelledCapture(channel) {
    let resumeCapture;
    let enteredCapture;
    const gate = new Promise((resolve) => { resumeCapture = resolve; });
    const entered = new Promise((resolve) => { enteredCapture = resolve; });
    const controller = new AbortController();
    const before = scenario.calls.filter(({ method }) => ["POST", "PUT"].includes(method)).length;
    let captureSignal;
    scenario.beforeFeatureRead = async (signal) => {
      captureSignal = signal;
      enteredCapture();
      await gate;
    };
    const route = `/api/v1/devices/${encodeURIComponent(ios)}/${channel === "api"
      ? "hardware/battery" : "notifications"}`;
    const input = channel === "api" ? { level: 37 }
      : { bundleId: nativePackage, payload: '{"aps":{"alert":"cancel"}}' };
    let pending;
    const originalTimeout = AbortSignal.timeout;
    try {
      if (host === "vscode" && channel === "api") {
        AbortSignal.timeout = () => controller.signal;
      }
      pending = channel === "api"
        ? api(route, { method: "POST", body: JSON.stringify(input), signal: controller.signal })
        : sourceMcp.handle(mcpCall("mobile_device_notification_push", { deviceId: ios, ...input }),
          { signal: controller.signal });
      const outcome = pending.then((result) => ({ result }), (error) => ({ error }));
      await entered;
      controller.abort();
      if (channel === "api") {
        const deadline = Date.now() + 1_000;
        while (!captureSignal?.aborted && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      assert.equal(captureSignal?.aborted, true,
        `${host} installed ${channel} must retire the captured canonical read on caller cancellation`);
      if (channel === "mcp") {
        resumeCapture();
        const { result, error } = await outcome;
        if (error) throw error;
        assert.ok(["cancelled", "request_cancelled"].includes(JSON.parse(result.result.content[0].text).code));
      } else {
        const { result, error } = await outcome;
        if (error) {
          assert.equal(controller.signal.aborted, true);
          assert.match(String(error), /abort/i);
        } else assert.ok(["cancelled", "request_cancelled"].includes((await result.json()).code));
        resumeCapture();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(scenario.calls.filter(({ method }) => ["POST", "PUT"].includes(method)).length, before,
        `${host} installed ${channel} cannot mutate after cancelled capture: ${JSON.stringify(scenario.calls.filter(({ method }) => ["POST", "PUT"].includes(method)).slice(before))}`);
    } finally {
      AbortSignal.timeout = originalTimeout;
      resumeCapture();
      scenario.beforeFeatureRead = null;
    }
  }
  async function verifyAcceptedFeaturePeer({ sole = false } = {}) {
    const originalRequest = AilohaMobileBackend.prototype.request;
    let releasePoll;
    try {
      let enteredPoll;
      const entered = new Promise((resolve) => { enteredPoll = resolve; });
      const gate = new Promise((resolve) => { releasePoll = resolve; });
      let gated = false;
      scenario.beforeOperationRead = async () => {
        if (!gated) { gated = true; enteredPoll(); await gate; }
      };
      let seen = 0;
      let firstSignal;
      let peerEntered;
      const peerEntry = new Promise((resolve) => { peerEntered = resolve; });
      AilohaMobileBackend.prototype.request = function (path, options) {
        const pending = originalRequest.call(this, path, options);
        if (options?.method === "POST" && path.endsWith("/sms")) {
          if (++seen === 1) firstSignal = options.signal;
          if (seen === 2) peerEntered();
        }
        return pending;
      };
      const before = scenario.calls.filter((entry) => entry.method === "POST"
        && entry.path?.endsWith("/telephony/sms")).length;
      const controller = new AbortController();
      const request = {
        method: "POST", body: JSON.stringify({ from: "+123", body: "accepted peer" }),
      };
      const route = `/api/v1/devices/${encodeURIComponent(ios)}/sms`;
      const first = api(route, { ...request, signal: controller.signal });
      const firstResult = first.then((response) => ({ response }), (error) => ({ error }));
      await entered;
      const peer = sole ? null : api(route, request);
      if (peer) await peerEntry;
      controller.abort();
      const cancelled = await firstResult;
      assert.ok(cancelled.error, `${host} cancelled feature caller cannot return success`);
      assert.match(`${cancelled.error.name} ${cancelled.error.message}`, /cancel|abort/i);
      if (sole) await waitFor(() => firstSignal?.aborted === true);
      releasePoll();
      if (sole) await new Promise((resolve) => setImmediate(resolve));
      const response = await (peer ?? api(route, request));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).operation, "sms-send");
      assert.equal(scenario.calls.filter((entry) => entry.method === "POST"
        && entry.path?.endsWith("/telephony/sms")).length, before + 1);
    } finally {
      AilohaMobileBackend.prototype.request = originalRequest;
      releasePoll?.();
      scenario.beforeOperationRead = null;
    }
  }
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
    await verifyCancelledCapture("api");
    await verifyCancelledCapture("mcp");
    await verifyAcceptedFeaturePeer();
    await verifyAcceptedFeaturePeer({ sole: true });
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
    const callsBeforeGates = scenario.calls.length;
    for (const [name, input] of Object.entries({
      mobile_device_file_pull: { deviceId: "opaque/target", path: "/Documents/empty", output: "/owned/output" },
    })) {
      const result = await emptyDispatcher.handle(mcpCall(name, input));
      assert.deepEqual(JSON.parse(result.result.content[0].text), {
        code: "consent_not_supported",
        message: "This MCP client cannot request genuine captured form approval; confirm=true is not authorization.",
        status: 501,
      });
    }
    assert.equal(scenario.calls.length, callsBeforeGates);
    assert.equal(statSync(process.env.AILOHA_TEST_CONTEXT_STATE, { bigint: true }).mtimeNs, contextWrittenAt);
  } finally {
    await emptyDispatcher.dispose();
  }
}

async function checkArtifactApi(api) {
  const callsBefore = scenario.calls.length;
  const response = await api("/api/v1/devices/opaque%2Ftarget/files/pull", "POST",
    { devicePath: "", hostPath: "" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid_request");
  assert.equal(scenario.calls.length, callsBefore);
}

async function checkGuardedFiles(api, selection, { answerConsent, approvalCount }) {
  scenario.artifactGuarded = true;
  const target = "/api/v1/devices/opaque%2Ftarget";
  const before = guardedEvents().length;
  const mkdir = await api(`${target}/files/mkdir`, "POST", { path: "/Documents/owned" });
  const mkdirBody = await mkdir.json();
  assert.equal(mkdir.status, 200, JSON.stringify(mkdirBody));
  assert.deepEqual(mkdirBody, {
    schemaVersion: "1.0", success: true, deviceId: "opaque/target", platform: "ios",
    path: "/Documents/owned", operation: "mkdir",
  });
  const deleteCount = approvalCount();
  const deletion = api(`${target}/files/delete`, "POST", { path: "/Documents/owned", recursive: true });
  await answerConsent("/Documents/owned", deleteCount);
  const removed = await deletion;
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).path, "/Documents/owned");
  assert.deepEqual(guardedEvents().slice(before).map((event) => event.action),
    ["prepare", "continue", "recover", "prepare", "continue", "recover"]);

  const elicitationMessages = [];
  const dispatcher = await createAilohaMcpDispatcher({
    version: "synthetic-only", binding: returnedBinding(selection),
    async requestElicitation(request) {
      elicitationMessages.push(request.message);
      return { action: "accept", content: { decision: "approve" } };
    },
  });
  try {
    await dispatcher.handle({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: { elicitation: { form: {} } } },
    });
    const created = await dispatcher.handle(mcpCall("mobile_device_file_mkdir",
      { deviceId: "opaque/target", path: "/Documents/from-mcp" }));
    assert.equal(created.result.isError, undefined);
    assert.equal(created.result.structuredContent.path, "/Documents/from-mcp");
    const deleted = await dispatcher.handle(mcpCall("mobile_device_file_delete",
      { deviceId: "opaque/target", path: "/Documents/from-mcp", recursive: false }));
    assert.equal(deleted.result.isError, undefined);
    assert.equal(deleted.result.structuredContent.path, "/Documents/from-mcp");
  } finally {
    await dispatcher.dispose();
  }
  assert.deepEqual(guardedEvents().slice(before).map((event) => event.action),
    Array(4).fill(["prepare", "continue", "recover"]).flat());
  const emptyDestination = join(scratch, "empty");
  writeFileSync(emptyDestination, "old-content");
  const emptyRequest = { devicePath: "/Documents/empty", hostPath: emptyDestination };
  const emptyCount = approvalCount();
  const emptyWork = api(`${target}/files/pull`, "POST", emptyRequest);
  let earlyEmpty;
  void emptyWork.then((reply) => { earlyEmpty = reply; });
  await waitFor(() => approvalCount() > emptyCount || !!earlyEmpty);
  if (earlyEmpty) throw new Error(`Export returned before consent: ${earlyEmpty.status} ${JSON.stringify(await earlyEmpty.json())}`);
  await answerConsent(emptyDestination, emptyCount);
  const emptyReply = await emptyWork;
  assert.equal(emptyReply.status, 200);
  assert.deepEqual(await emptyReply.json(), {
    schemaVersion: "1.0", success: true, deviceId: "opaque/target",
    devicePath: "/Documents/empty", hostPath: emptyDestination, size: 0, operation: "pull",
  });
  assert.equal(readFileSync(emptyDestination).length, 0);

  const deniedDestination = join(scratch, "denied");
  writeFileSync(deniedDestination, "not-overwritten");
  const denialCount = approvalCount();
  const deniedWork = api(`${target}/files/pull`, "POST", {
    devicePath: "/Documents/denied", hostPath: deniedDestination,
  });
  await answerConsent(deniedDestination, denialCount, false);
  const denied = await deniedWork;
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "consent_denied");
  assert.equal(readFileSync(deniedDestination, "utf8"), "not-overwritten");

  const fiveDestination = join(scratch, "five");
  writeFileSync(fiveDestination, "prior");
  const fiveRequest = { bundleId: "native-app", devicePath: "Documents/five", hostPath: scratch };
  process.env.AILOHA_TEST_GUARDED_LOST_REPLY = "1";
  try {
    const fiveCount = approvalCount();
    const first = api(`${target}/files/pull`, "POST", fiveRequest);
    let earlyFive;
    void first.then((reply) => { earlyFive = reply; });
    await waitFor(() => approvalCount() > fiveCount || !!earlyFive);
    if (earlyFive) throw new Error(`Export returned before consent: ${earlyFive.status} ${JSON.stringify(await earlyFive.json())}`);
    await answerConsent(fiveDestination, fiveCount);
    assert.equal((await first).status, 502);
    assert.equal(readFileSync(fiveDestination, "utf8"), "abcde");
    writeFileSync(fiveDestination, "human-edited");
    const changed = await api(`${target}/files/pull`, "POST", fiveRequest);
    assert.equal(changed.status, 502);
    assert.equal((await changed.json()).code, "GuardedDestinationChanged");
    assert.equal(readFileSync(fiveDestination, "utf8"), "human-edited");
    writeFileSync(fiveDestination, "abcde");
    const recovered = await api(`${target}/files/pull`, "POST", fiveRequest);
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), {
      schemaVersion: "1.0", success: true, deviceId: "opaque/target",
      devicePath: "Documents/five", hostPath: fiveDestination, size: 5, operation: "pull",
    });
  } finally {
    delete process.env.AILOHA_TEST_GUARDED_LOST_REPLY;
  }

  const mcpDestination = join(scratch, "mcp");
  const pullDispatcher = await createAilohaMcpDispatcher({
    version: "synthetic-only", binding: returnedBinding(selection),
    async requestElicitation(request) {
      elicitationMessages.push(request.message);
      return { action: "accept", content: { decision: "approve" } };
    },
  });
  try {
    await pullDispatcher.handle({
      jsonrpc: "2.0", id: 3, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: { elicitation: { form: {} } } },
    });
    const pulled = await pullDispatcher.handle(mcpCall("mobile_device_file_pull", {
      deviceId: "opaque/target", path: "/Documents/mcp", output: mcpDestination,
    }));
    assert.equal(pulled.result.isError, undefined);
    assert.equal(pulled.result.structuredContent.devicePath, "/Documents/mcp");
    assert.equal(pulled.result.structuredContent.hostPath, mcpDestination);
    assert.equal(pulled.result.structuredContent.size, 5);
    assert.equal(readFileSync(mcpDestination, "utf8"), "abcde");
  } finally {
    await pullDispatcher.dispose();
  }
  assert.equal(elicitationMessages.some((message) => message.includes(`Host destination: ${mcpDestination}`)), true);
  const allEvents = guardedEvents().slice(before);
  assert.equal(allEvents.filter((event) => event.action === "continue").length, 7);
  assert.equal(allEvents.filter((event) => event.action === "recover").length, 9);
  assert.equal(allEvents.filter((event) => event.contentGet).length, 3);
  assert.equal(allEvents.filter((event) => event.receipt.kind === "export"
    && event.action === "continue").length, 3);
  const noElicitation = await createAilohaMcpDispatcher({
    version: "synthetic-only", binding: returnedBinding(selection),
  });
  try {
    await noElicitation.handle({
      jsonrpc: "2.0", id: 2, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {} },
    });
    const blocked = await noElicitation.handle(mcpCall("mobile_device_file_delete",
      { deviceId: "opaque/target", path: "/Documents/without-consent" }));
    assert.equal(blocked.result.isError, true);
    assert.equal(JSON.parse(blocked.result.content[0].text).code, "consent_not_supported");
    const noPull = await noElicitation.handle(mcpCall("mobile_device_file_pull", {
      deviceId: "opaque/target", path: "/Documents/empty", output: join(scratch, "blocked"),
    }));
    assert.equal(JSON.parse(noPull.result.content[0].text).code, "consent_not_supported");
  } finally {
    await noElicitation.dispose();
  }
  assert.equal(guardedEvents().length, before + allEvents.length);
  scenario.artifactGuarded = false;
  return { mutations: 7, submissions: 7, readbacks: 9, contentGets: 3 };
}

async function checkArtifactReads(api, selection) {
  scenario.artifactReads = true;
  const target = "/api/v1/devices/opaque%2Ftarget";
  const files = await api(`${target}/files?bundleId=native-app&path=Documents`, "GET");
  assert.equal(files.status, 200, JSON.stringify({ response: await files.clone().json(),
    calls: scenario.calls.slice(-10).map((call) => call.path) }));
  assert.deepEqual((await files.json()).files[0], {
    name: "empty.db", path: "/Documents/empty.db", isDirectory: false, size: 0, modified: null,
  });
  const logs = await api(`${target}/log?bundleId=native-app&level=fatal&limit=2`, "GET");
  assert.equal(logs.status, 200);
  assert.deepEqual((await logs.json()).entries.map((entry) => entry.level), ["verbose", "fatal"]);
  for (const blank of ["", " \t"]) {
    const reply = await api(`${target}/log?text=${encodeURIComponent(blank)}`, "GET");
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).total, 2);
    const query = scenario.calls.findLast((call) => call.path?.includes("/logs/query?")).path;
    assert.equal(new URL(query, "http://localhost").searchParams.get("text"), blank);
  }
  const crashes = await api(`${target}/crashes?text=App&limit=1`, "GET");
  assert.equal(crashes.status, 200);
  assert.equal((await crashes.json()).total, 2);
  const detail = await api(`${target}/crashes/report`, "GET");
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).content, "full stack");
  const dispatcher = await createAilohaMcpDispatcher({
    version: "synthetic-only", binding: returnedBinding(selection),
  });
  try {
    for (const [name, input, expected] of [
      ["mobile_device_file_list", { deviceId: "opaque/target", bundleId: "native-app", path: "Documents" }, "empty.db"],
      ["mobile_device_log", { deviceId: "opaque/target", level: "fatal", limit: 2 }, "verbose"],
      ["mobile_device_log", { deviceId: "opaque/target", text: " \t" }, "verbose"],
      ["mobile_device_crashes", { deviceId: "opaque/target", text: "App", limit: 1 }, "App"],
      ["mobile_device_crash_report", { deviceId: "opaque/target", crashId: "report" }, "full stack"],
    ]) {
      const response = await dispatcher.handle(mcpCall(name, input));
      assert.notEqual(response.result.isError, true, name);
      const output = response.result.structuredContent;
      assert.deepEqual(JSON.parse(response.result.content[0].text), output);
      assert.equal(JSON.stringify(output).includes(expected), true, name);
    }
  } finally {
    await dispatcher.dispose();
    scenario.artifactReads = false;
  }
  assert.equal(scenario.calls.filter((call) => call.method === "POST"
    && /\/(files|logs|crashes|media)/.test(call.path ?? "")).length, 0);
}

async function checkArtifactStaging(api, selection, { answerConsent } = {}) {
  scenario.artifactStaging = true;
  const target = "/api/v1/devices/opaque%2Ftarget";
  const empty = join(scratch, "empty.txt");
  const contact = join(scratch, "contact.vcf");
  const image = join(scratch, "image.png");
  writeFileSync(empty, "");
  writeFileSync(contact, "BEGIN:VCARD\nVERSION:3.0\nEND:VCARD\n");
  writeFileSync(image, Buffer.from([137, 80, 78, 71]));
  const media = async (paths) => {
    const reply = await api(`${target}/media`, "POST", { hostPaths: paths });
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), {
      schemaVersion: "1.0", deviceId: "opaque/target", platform: "ios", added: paths,
    });
  };
  const pushInput = { hostPath: empty, devicePath: "/Documents/empty.txt" };
  const pushMcpInput = { deviceId: "opaque/target", input: empty, path: pushInput.devicePath };
  try {
    await media([contact, image]);
    const before = stageEvents().length;
    const pending = api(`${target}/files/push`, "POST", pushInput);
    await answerConsent();
    const result = await pending;
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      schemaVersion: "1.0", success: true, deviceId: "opaque/target",
      devicePath: pushInput.devicePath, hostPath: empty, size: 0, operation: "push",
    });
    assert.deepEqual(stageEvents().slice(before).map((event) => event.action),
      ["stage", "continue", "cleanup"]);
    const requests = [];
    const dispatcher = await createAilohaMcpDispatcher({
      version: "synthetic-only", binding: returnedBinding(selection),
      async requestElicitation(params) {
        requests.push(params);
        assert.equal(params.requestedSchema.properties.decision.default, "cancel");
        assert.match(params.message, /Documents\/(?:empty|uncertain)\.txt/);
        assert.match(params.message, /native-deployment-not-opaque-target/);
        return { action: "accept", content: { decision: "approve" } };
      },
    });
    try {
      const initialized = await dispatcher.handle({
        jsonrpc: "2.0", id: randomUUID(), method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: { elicitation: { form: {} } } },
      });
      assert.equal(initialized.result.protocolVersion, "2025-06-18");
      const mediaOutput = await dispatcher.handle(mcpCall("mobile_device_media_add",
        { deviceId: "opaque/target", paths: [contact, image] }));
      assert.notEqual(mediaOutput.result.isError, true);
      assert.deepEqual(mediaOutput.result.structuredContent.added, [contact, image]);
      assert.deepEqual(JSON.parse(mediaOutput.result.content[0].text), mediaOutput.result.structuredContent);
      scenario.failStageOperationReadOnce = true;
      const first = await dispatcher.handle(mcpCall("mobile_device_file_push", pushMcpInput));
      assert.equal(first.result.isError, true);
      const beforeRecovery = stageEvents().length;
      const second = await dispatcher.handle(mcpCall("mobile_device_file_push", pushMcpInput));
      assert.notEqual(second.result.isError, true, JSON.stringify(second.result));
      assert.deepEqual(second.result.structuredContent, {
        schemaVersion: "1.0", success: true, deviceId: "opaque/target",
        devicePath: pushInput.devicePath, hostPath: empty, size: 0, operation: "push",
      });
      assert.deepEqual(JSON.parse(second.result.content[0].text), second.result.structuredContent);
      assert.equal(stageEvents().length - beforeRecovery, 1);
      assert.equal(stageEvents().at(-1).action, "cleanup");
      assert.equal(requests.length, 1, "A recovered device operation cannot request approval twice.");
      const uncertainInput = { ...pushMcpInput, path: "/Documents/uncertain.txt" };
      process.env.AILOHA_TEST_STAGE_UNCERTAIN = "1";
      const uncertain = await dispatcher.handle(mcpCall("mobile_device_file_push", uncertainInput));
      assert.equal(uncertain.result.isError, true);
      assert.equal(JSON.parse(uncertain.result.content[0].text).code, "device_acceptance_unknown");
      const afterAttempt = stageEvents();
      assert.equal(afterAttempt.at(-1).action, "continue");
      assert.equal(afterAttempt.at(-1).uncertain, true);
      const repeated = await dispatcher.handle(mcpCall("mobile_device_file_push", uncertainInput));
      assert.equal(repeated.result.isError, true);
      assert.equal(JSON.parse(repeated.result.content[0].text).code, "device_acceptance_unknown");
      assert.deepEqual(stageEvents(), afterAttempt, "An uncertain device attempt cannot stage or POST again.");
      assert.equal(requests.length, 2, "One scoped approval per original device attempt.");
    } finally { await dispatcher.dispose(); }
    const stages = stageEvents();
    assert.deepEqual(stages.filter((event) => event.action === "stage").map((event) => event.sources),
      [[contact, image], [empty], [contact, image], [empty], [empty]]);
    const host = scenario.connectionRef;
    const ticks = (value) => (BigInt(Date.parse(value)) + 62135596800000n) * 10000n;
    const expectedHost = `host-${createHash("sha256").update(
      `${host.serviceId}\0${host.pid}\0${ticks(host.startedAt)}\0${ticks(host.processStartedAt)}`,
    ).digest("hex")}`;
    for (const stage of stages.filter((event) => event.action === "stage")) {
      assert.equal(stage.receipt.artifacts.every((entry) =>
        entry.proof.contextRef === selection.contextBinding.contextRef
          && entry.proof.scopeEpoch === selection.contextBinding.scopeEpoch
          && entry.proof.revision === selection.contextBinding.revision
          && entry.proof.ownerProcessId === process.pid
          && entry.proof.targetHostId === "synthetic-host"
          && entry.proof.providerId === scenario.providerId
          && entry.proof.nativeTargetId === scenario.nativeId
          && entry.proof.hostInstanceId === expectedHost), true);
      assert.equal(stages.filter((event) => event.action === "continue"
        && event.receipt.artifacts[0].proof.stageId === stage.receipt.artifacts[0].proof.stageId).length, 1);
    }
    return { mediaBatches: stages.filter((event) => event.action === "continue"
      && event.receipt.kind === "media").length, approvals: requests.length,
    uncertainPosts: stages.filter((event) => event.action === "continue" && event.uncertain).length };
  } finally {
    scenario.artifactStaging = false;
    delete process.env.AILOHA_TEST_STAGE_UNCERTAIN;
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
    assert.equal((await action("press_key", { deviceId: "opaque/target", keyCode: 40 })).operation, "press-key");
    assert.equal((await action("press_button", { deviceId: "opaque/target", button: "SIDE" })).operation, "press-button");
    if (focusedText) {
      assert.equal((await action("type_text", { deviceId: "opaque/target", text: "literal \u2603" })).operation, "type-text");
      await assert.rejects(action("type_text", { deviceId: "opaque/target", text: "\0" }), { status: 400 });
    } else await assert.rejects(action("type_text", { deviceId: "opaque/target", text: "literal \u2603" }), { status: 501 });
    assert.equal((await action("rotate_device", { deviceId: "opaque/target", orientation: "portrait" })).operation, "rotate");
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
    requestFromHost = (path, method = "GET", body) => fetch(new URL(path, url), {
      method, headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await checkArtifactApi((path, method, body) => fetch(new URL(path, url), {
      method, headers: { Cookie: cookie, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }));
    await checkArtifactReads((path, method) => fetch(new URL(path, url), {
      method, headers: { Cookie: cookie },
    }), selected);
    var stagedEvidence = await checkArtifactStaging((path, method, body) => fetch(new URL(path, url), {
      method, headers: { Cookie: cookie, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }), selected, {
      async answerConsent() {
        const count = copilotUi.prompts.length;
        await waitFor(() => copilotUi.prompts.length > count);
        const prompt = copilotUi.prompts.at(-1);
        assert.match(prompt.message, /Documents\/empty\.txt/);
        assert.equal(prompt.requestedSchema.properties.decision.default, "cancel");
        assert.equal(copilotUi.respond(prompt.requestId,
          { action: "accept", content: { decision: "approve" } }), true);
      },
    });
    var guardedEvidence = await checkGuardedFiles((path, method, body) => fetch(new URL(path, url), {
      method, headers: { Cookie: cookie, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }), selected, {
      approvalCount: () => copilotUi.prompts.length,
      async answerConsent(subject, count, approved = true) {
        await waitFor(() => copilotUi.prompts.length > count);
        const prompt = copilotUi.prompts.at(-1);
        assert.equal(prompt.message.includes(subject), true);
        assert.equal(copilotUi.respond(prompt.requestId,
          { action: "accept", content: { decision: approved ? "approve" : "cancel" } }), true);
      },
    });
    presentationApi = (deviceId, method = "GET", input) => fetch(
      new URL(`/api/v1/devices/${encodeURIComponent(deviceId)}/presentation`, url), {
        method, headers: { Cookie: cookie, "Content-Type": "application/json" },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
    const presentationRoute = new URL("/api/v1/devices/opaque%2Ftarget/presentation", url);
    const updateStatus = await fetch(presentationRoute, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, time: "09:41" }),
    });
    assert.equal(updateStatus.status, 200);
    assert.equal((await updateStatus.json()).enabled, true);
    const readStatus = await fetch(presentationRoute, { headers: { Cookie: cookie } });
    assert.equal((await readStatus.json()).overrides[0].value, "09:41");
    recordThroughHost = async (outputPath) => {
      const started = await action("start_recording", { deviceId: "opaque/target", outputPath, timeoutSeconds: 180 });
      assert.equal(started.isRecording, true);
      const response = await fetch(new URL("/api/v1/devices/opaque%2Ftarget/recording", url), { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).outputPath, outputPath);
    };
    stopThroughHost = () => action("stop_recording", { deviceId: "opaque/target" });
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
    const vscode = require("vscode");
    const extensionRoot = resolve(process.argv[4]?.startsWith("--") ? join(source, "vscode") : process.argv[4] ?? join(source, "vscode"));
    const { HostBridge } = require(join(extensionRoot, "out", "hostBridge.js"));
    const { createRuntimeCanvasHost } = await import(pathToFileURL(join(root, "lib", "ailoha", "runtime-backend.mjs")).href);
    const { createDestructivePrompt } = require(join(extensionRoot, "out", "destructiveConsent.js"));
    const hostAdapter = createRuntimeCanvasHost({
      scope, onError: (error) => logs.push(error.code), confirmDestructive: createDestructivePrompt(),
    });
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
      assert.equal(result.type, "api-result", `${path}: ${result.message ?? ""}`);
      return new Response(result.body, { status: result.status, headers: result.headers });
    }
    presentationApi = (deviceId, method = "GET", input) =>
      api(`/api/v1/devices/${encodeURIComponent(deviceId)}/presentation`, method, input);
    readCatalog = async () => (await api("/api/v1/catalog")).json();
    createFromHost = async (input) => {
      const response = await api("/api/v1/devices", "POST", input);
      assert.equal(response.status, 200);
      return response.json();
    };
    selectedFromHost = async () => (await api("/api/v1/selection")).json();
    requestFromHost = api;
    const catalog = await (await api("/api/v1/catalog")).json();
    assert.equal(catalog.devices[0].nativeId, "native-deployment-not-opaque-target");
    await checkEmptyContext(await (await api("/api/v1/selection")).json());
    await checkArtifactApi(api);
    await checkArtifactReads(api, await (await api("/api/v1/selection")).json());
    await api("/api/v1/selection", "POST", { deviceId: "opaque/target" });
    const selected = await bridge.getSelectedDeviceContext();
    selectedContext = selected.selection;
    assert.equal(selected.deviceId, "opaque/target");
    returnedBinding(selected.selection);
    await checkDeviceFeatures(api, selected.selection);
    stagedEvidence = await checkArtifactStaging(api, selected.selection, {
      async answerConsent() {
        const count = vscode.testUi.pickers.length;
        await waitFor(() => vscode.testUi.pickers.length > count);
        const picker = vscode.testUi.pickers.at(-1);
        assert.match(picker.items[1].detail, /Documents\/empty\.txt/);
        assert.equal(picker.answer(true), true);
      },
    });
    guardedEvidence = await checkGuardedFiles(api, selected.selection, {
      approvalCount: () => vscode.testUi.pickers.length,
      async answerConsent(subject, count, approved = true) {
        await waitFor(() => vscode.testUi.pickers.length > count);
        const picker = vscode.testUi.pickers.at(-1);
        assert.equal(picker.items[1].detail.includes(subject), true);
        assert.equal(picker.answer(approved), true);
      },
    });
    const screenshot = await bridge.getSelectedScreenshot();
    assert.equal(screenshot.bytes[0], 137);
    assert.equal((await api("/api/v1/devices/opaque%2Ftarget/shutdown", "POST")).status, 200);
    assert.equal((await api("/api/v1/devices/opaque%2Ftarget/boot", "POST")).status, 200);
    const display = await (await api("/api/v1/devices/opaque%2Ftarget/display")).json();
    await api("/api/v1/devices/opaque%2Ftarget/input/tap", "POST", { x: 12, y: 10, geometryRevision: display.geometryRevision });
    for (const [kind, input] of [
      ["key", { keyCode: 40 }], ["button", { button: "SIDE" }],
      ["rotate", { orientation: "portrait" }],
    ]) {
      assert.equal((await api(`/api/v1/devices/opaque%2Ftarget/input/${kind}`, "POST", input)).status, 200);
    }
    assert.equal((await api("/api/v1/devices/opaque%2Ftarget/input/text", "POST",
      { text: "literal \u2603" })).status, focusedText ? 200 : 501);
    if (focusedText) assert.equal((await api("/api/v1/devices/opaque%2Ftarget/input/text", "POST",
      { text: "\0" })).status, 400);
    const changedStatus = await api("/api/v1/devices/opaque%2Ftarget/presentation", "POST",
      { enabled: true, time: "09:41" });
    assert.equal((await changedStatus.json()).enabled, true);
    const readStatus = await api("/api/v1/devices/opaque%2Ftarget/presentation");
    assert.equal((await readStatus.json()).overrides[0].value, "09:41");
    const emptyRecording = await api("/api/v1/devices/opaque%2Ftarget/recording");
    assert.equal(emptyRecording.status, 200);
    assert.equal((await emptyRecording.json()).isRecording, false);
    recordThroughHost = async (outputPath) => {
      const response = await api("/api/v1/devices/opaque%2Ftarget/recording/start", "POST", { timeoutSeconds: 180, outputPath });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).isRecording, true);
      const status = await (await api("/api/v1/devices/opaque%2Ftarget/recording")).json();
      assert.equal(status.outputPath, outputPath);
    };
    stopThroughHost = async () => {
      const response = await api("/api/v1/devices/opaque%2Ftarget/recording/stop", "POST");
      assert.equal(response.status, 200);
      return response.json();
    };
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
  scenario.recordingEnabled = true;
  const recorded = join(scratch, "owned-recording.mp4");
  const finalizedOnClose = join(scratch, "owned-close.mp4");
  await recordThroughHost(recorded);
  const recordingMcp = await createAilohaMcpDispatcher({ version: "synthetic-only", binding: returnedBinding(selectedContext) });
  try {
    const tools = await recordingMcp.handle({ jsonrpc: "2.0", id: randomUUID(), method: "tools/list" });
    const recordingStatus = tools.result.tools.find((tool) => tool.name === "mobile_device_recording_status");
    assert.equal(recordingStatus.annotations.readOnlyHint, false);
    assert.equal(recordingStatus.annotations.destructiveHint, false);
    const status = await recordingMcp.handle(mcpCall("mobile_device_recording_status", { deviceId: "opaque/target" }));
    assert.equal(status.result.structuredContent.isRecording, true);
  } finally { await recordingMcp.dispose(); }
  const stopped = await stopThroughHost();
  assert.equal(stopped.isRecording, false);
  assert.equal(stopped.outputPath, recorded);
  assert.equal(existsSync(recorded), true);
  await recordThroughHost(finalizedOnClose);
  scenario.recordingEnabled = false;
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
    const androidDeviceId = selectedContext.device.id;
    const androidUnfixed = {
      schemaVersion: "1.0", deviceId: androidDeviceId, platform: "android",
      enabled: false, readable: false, overrides: [],
    };
    const androidFixed = { ...androidUnfixed, enabled: true };
    const androidRead = await presentationApi(androidDeviceId);
    assert.equal(androidRead.status, 200);
    assert.deepEqual(await androidRead.json(), androidUnfixed);
    const androidWrite = await presentationApi(androidDeviceId, "POST", {
      enabled: true, time: "09:41", batteryLevel: 75,
    });
    assert.equal(androidWrite.status, 200);
    assert.deepEqual(await androidWrite.json(), androidFixed);
    const androidReadback = await presentationApi(androidDeviceId);
    assert.equal(androidReadback.status, 200);
    assert.deepEqual(await androidReadback.json(), androidFixed);
    const button = await rawMcp.handle(mcpCall("mobile_device_press_button",
      { deviceId: selectedContext.device.id, button: "VolumeUp" }));
    assert.equal(button.result.structuredContent.operation, "press-button");
    const typed = await rawMcp.handle(mcpCall("mobile_device_type_text",
      { deviceId: selectedContext.device.id, text: "literal ascii" }));
    assert.equal(typed.result.isError === true, !focusedText);
    if (focusedText) assert.equal(typed.result.structuredContent.operation, "type-text");
    const presentation = await rawMcp.handle(mcpCall("mobile_device_presentation_get",
      { deviceId: selectedContext.device.id }));
    assert.deepEqual(presentation.result.structuredContent, androidFixed);
    const restored = await rawMcp.handle(mcpCall("mobile_device_presentation_set",
      { deviceId: androidDeviceId, enabled: false }));
    assert.deepEqual(restored.result.structuredContent, androidUnfixed);
    const restoredRead = await presentationApi(androidDeviceId);
    assert.equal(restoredRead.status, 200);
    assert.deepEqual(await restoredRead.json(), androidUnfixed);
    const androidSettingsPath = `/api/v1/targets/${encodeURIComponent(androidDeviceId)}/settings/status-bar`;
    const androidSettingsCalls = scenario.calls.filter((call) => call.path === androidSettingsPath);
    assert.deepEqual(androidSettingsCalls.map((call) => call.method), ["GET", "PATCH", "GET", "GET", "PATCH", "GET"]);
    assert.deepEqual(JSON.parse(androidSettingsCalls[1].body), {
      values: { enabled: true, time: "09:41", batteryLevel: 75 },
    });
    assert.deepEqual(JSON.parse(androidSettingsCalls[4].body), { values: { enabled: false } });
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
  scenario.appResponses = true;
  const appTargetId = selectedContext.device.id;
  const appRoot = `/api/v1/devices/${encodeURIComponent(appTargetId)}`;
  const appList = await requestFromHost(`${appRoot}/apps`);
  assert.equal(appList.status, 200);
  assert.deepEqual((await appList.json()).apps, [{
    bundleId: "com.example.native", name: "Synthetic native app", version: "1", build: "2",
    kind: "user", running: true, processId: 4321,
    path: "/apps/example.app", dataContainer: "/containers/example",
  }]);
  const launch = await requestFromHost(`${appRoot}/apps/launch`, "POST", { bundleId: "com.example.native" });
  assert.equal(launch.status, 200, JSON.stringify(await launch.clone().json()));
  assert.deepEqual(await launch.json(), {
    schemaVersion: "1.0", success: true, deviceId: appTargetId,
    bundleId: "com.example.native", operation: "launch", processId: 4321,
    detail: "com.example.native/.Main",
  });
  const appMcp = await createAilohaMcpDispatcher({
    version: "synthetic-only", binding: returnedBinding(selectedContext),
  });
  try {
    const inventory = await appMcp.handle(mcpCall("mobile_device_app_list", { deviceId: appTargetId }));
    assert.notEqual(inventory.result.isError, true);
    assert.equal(inventory.result.structuredContent.apps[0].bundleId, "com.example.native");
    const ops = await appMcp.handle(mcpCall("mobile_device_app_op_list", {
      deviceId: appTargetId, bundleId: "com.example.native",
    }));
    assert.notEqual(ops.result.isError, true);
    assert.deepEqual(ops.result.structuredContent.operations,
      [{ name: "SYSTEM_ALERT_WINDOW", mode: "default", uidScoped: true }]);
    const terminated = await appMcp.handle(mcpCall("mobile_device_app_terminate", {
      deviceId: appTargetId, bundleId: "com.example.native",
    }));
    assert.notEqual(terminated.result.isError, true);
    assert.equal(terminated.result.structuredContent.operation, "terminate");
    const appCallsBeforeGates = scenario.calls.length;
    for (const [name, input] of [
      ["mobile_device_app_install", { deviceId: appTargetId, path: "/host/synthetic.apk" }],
      ["mobile_device_app_uninstall", { deviceId: appTargetId, bundleId: "com.example.native", confirm: true }],
      ["mobile_device_app_op_set", {
        deviceId: appTargetId, bundleId: "com.example.native",
        operation: "SYSTEM_ALERT_WINDOW", mode: "allow",
      }],
      ["mobile_device_app_op_list", { deviceId: "opaque/target", bundleId: "com.example.native" }],
    ]) {
      const gated = await appMcp.handle(mcpCall(name, input));
      assert.equal(gated.result.isError, true, name);
      assert.equal(JSON.parse(gated.result.content[0].text).code, "capability_not_supported", name);
    }
    assert.equal(scenario.calls.slice(appCallsBeforeGates).some((call) =>
      call.method === "POST" || call.method === "PUT" || call.method === "DELETE"), false);
  } finally { await appMcp.dispose(); }
  const nativeApps = scenario.calls.filter((call) => call.path?.includes("/apps"));
  assert.equal(nativeApps.some((call) => call.path?.endsWith("/apps?includeSystem=false")), true);
  assert.equal(nativeApps.some((call) => call.path?.includes("/synthetic%2Fapp%25id/actions/launch")
    && call.method === "POST"), true);
  assert.equal(nativeApps.some((call) => call.path?.includes("/synthetic%2Fapp%25id/actions/terminate")
    && call.method === "POST"), true);
  await release();
  release = null;
  assert.equal(existsSync(finalizedOnClose), true);
  let recordingCommands = readFileSync(`${process.env.AILOHA_TEST_CONTEXT_STATE}.recording-calls`, "utf8").trim().split("\n");
  assert.equal(recordingCommands.filter((command) => command === "start").length, 2);
  assert.equal(recordingCommands.filter((command) => command === "stop").length, 2);
  assert.equal(recordingCommands.filter((command) => command === "recover").length, 2);
  assert.equal(existsSync(`${process.env.AILOHA_TEST_CONTEXT_STATE}.recording`), false);
  assert.deepEqual(units, [0, 1, 2, 3, 4, 5]);
  assert.equal(scenario.videos.size, 0);
  assert.equal(scenario.leases.size, 0);
  assert.equal(scenario.calls.some((call) => call.path === "/api/v1/host/stop"), false);
  const body = scenario.calls.find((call) => call.path?.endsWith("/input/actions/tap")).body;
  assert.equal(JSON.parse(body).geometryRevision, 13);
  assert.equal(scenario.calls.filter((call) => call.path?.endsWith("/input/actions/key")).length >= 3, true);
  assert.equal(scenario.calls.some((call) => call.path?.endsWith("/input/actions/key")
    && JSON.parse(call.body).key === "side"), true);
  assert.equal(scenario.calls.some((call) => call.path?.endsWith("/input/actions/key")
    && JSON.parse(call.body).key === "volumeup"), true);
  assert.equal(scenario.calls.some((call) => call.path?.endsWith("/input/actions/fill")), false);
  const focusedCalls = scenario.calls.filter((call) => call.path?.endsWith("/input/actions/type-focused-text"));
  assert.equal(focusedCalls.length, focusedText ? 2 : 0);
  if (focusedText) {
    assert.equal(focusedCalls.every((call) => call.method === "POST"), true);
    assert.deepEqual(focusedCalls.map((call) => JSON.parse(call.body)), [
      { text: "literal \u2603" }, { text: "literal ascii" },
    ]);
  }
  assert.equal(scenario.calls.some((call) => call.method === "PATCH" && call.path?.endsWith("/presentation")), true);
  assert.equal(scenario.calls.some((call) => call.method === "PATCH" && call.path?.endsWith("/settings/status-bar")), true);
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
  scenario.recordingEnabled = true;
  const mcpOutput = join(scratch, "owned-mcp.mp4");
  const startedMcp = await dispatcher.handle(mcpCall("mobile_device_recording_start", {
    deviceId: selectedContext.device.id, outputPath: mcpOutput,
  }));
  assert.notEqual(startedMcp.result.isError, true, JSON.stringify(startedMcp.result));
  assert.equal(startedMcp.result.structuredContent.isRecording, true);
  const stoppingMcp = await createAilohaMcpDispatcher({
    version: "synthetic-only", binding: returnedBinding(selectedContext),
  });
  try {
    const status = await stoppingMcp.handle(mcpCall("mobile_device_recording_status", { deviceId: selectedContext.device.id }));
    assert.equal(status.result.structuredContent.isRecording, true);
    const foreignStop = await stoppingMcp.handle(mcpCall("mobile_device_recording_stop", { deviceId: selectedContext.device.id }));
    assert.equal(foreignStop.result.isError, true);
    assert.equal(JSON.parse(foreignStop.result.content[0].text).code, "recording_not_tracked");
    assert.equal(existsSync(`${process.env.AILOHA_TEST_CONTEXT_STATE}.recording`), true);
  } finally { await stoppingMcp.dispose(); }
  const stoppedMcp = await dispatcher.handle(mcpCall("mobile_device_recording_stop", { deviceId: selectedContext.device.id }));
  assert.equal(stoppedMcp.result.structuredContent.outputPath, mcpOutput);
  assert.equal(stoppedMcp.result.structuredContent.isRecording, false);
  assert.equal(existsSync(mcpOutput), true);
  recordingCommands = readFileSync(`${process.env.AILOHA_TEST_CONTEXT_STATE}.recording-calls`, "utf8").trim().split("\n");
  assert.equal(recordingCommands.filter((command) => command === "start").length, 3);
  assert.equal(recordingCommands.filter((command) => command === "stop").length, 3);
  assert.equal(recordingCommands.filter((command) => command === "recover").length, 3);
  const recoveringMcp = await createAilohaMcpDispatcher({
    version: "synthetic-only", binding: returnedBinding(selectedContext),
  });
  try {
    const pendingOutput = join(scratch, "owned-recover.mp4");
    const started = await recoveringMcp.handle(mcpCall("mobile_device_recording_start", {
      deviceId: selectedContext.device.id, outputPath: pendingOutput,
    }));
    assert.notEqual(started.result.isError, true);
    process.env.AILOHA_TEST_RECORDING_REPLACED_HOST = "1";
    const wrongHost = await recoveringMcp.handle(mcpCall("mobile_device_recording_stop", {
      deviceId: selectedContext.device.id,
    }));
    assert.equal(wrongHost.result.isError, true);
    assert.equal(JSON.parse(wrongHost.result.content[0].text).code, "recording_owner_mismatch");
    delete process.env.AILOHA_TEST_RECORDING_REPLACED_HOST;
    process.env.AILOHA_TEST_RECORDING_DOWNLOAD_FAILED = "1";
    const failedDownload = await recoveringMcp.handle(mcpCall("mobile_device_recording_stop", {
      deviceId: selectedContext.device.id,
    }));
    assert.equal(failedDownload.result.isError, true);
    assert.equal(JSON.parse(failedDownload.result.content[0].text).code, "recording_recovery_download_failed");
    delete process.env.AILOHA_TEST_RECORDING_DOWNLOAD_FAILED;
    const recovered = await recoveringMcp.handle(mcpCall("mobile_device_recording_stop", {
      deviceId: selectedContext.device.id,
    }));
    assert.notEqual(recovered.result.isError, true);
    assert.equal(recovered.result.structuredContent.outputPath, pendingOutput);
    assert.equal(existsSync(pendingOutput), true);
  } finally {
    delete process.env.AILOHA_TEST_RECORDING_REPLACED_HOST;
    delete process.env.AILOHA_TEST_RECORDING_DOWNLOAD_FAILED;
    await recoveringMcp.dispose();
  }
  recordingCommands = readFileSync(`${process.env.AILOHA_TEST_CONTEXT_STATE}.recording-calls`, "utf8").trim().split("\n");
  assert.equal(recordingCommands.filter((command) => command === "start").length, 4);
  assert.equal(recordingCommands.filter((command) => command === "stop").length, 4);
  assert.equal(recordingCommands.filter((command) => command === "recover").length, 6);
  process.env.AILOHA_TEST_RECOVERY_COMMANDS = "missing";
  let withoutRecovery;
  try {
    withoutRecovery = await createRuntimeMobileBackend({
      scope: { sessionId: scope.sessionId, viewId: `${scope.viewId}-without-recovery` },
    });
    await withoutRecovery.select("opaque/target");
    assert.equal((await withoutRecovery.getDevice("opaque/target")).capabilities.recording, false);
    const blocked = await withoutRecovery.request("/api/v1/devices/opaque%2Ftarget/recording/start", {
      method: "POST", body: JSON.stringify({ outputPath: join(scratch, "unsupported.mp4") }),
    });
    assert.equal(blocked.status, 501);
    assert.equal((await blocked.json()).code, "capability_not_supported");
    assert.equal(readFileSync(`${process.env.AILOHA_TEST_CONTEXT_STATE}.recording-calls`, "utf8").trim().split("\n").length,
      recordingCommands.length);
  } finally {
    await withoutRecovery?.dispose();
    delete process.env.AILOHA_TEST_RECOVERY_COMMANDS;
  }
  for (const mode of ["malformed", "fail"]) {
    process.env.AILOHA_TEST_RECOVERY_COMMANDS = mode;
    try {
      await assert.rejects(createRuntimeMobileBackend({
        scope: { sessionId: scope.sessionId, viewId: `${scope.viewId}-${mode}-recovery` },
      }), { code: mode === "malformed" ? "ailoha_commands_invalid" : "ailoha_cli_failed" });
    } finally {
      delete process.env.AILOHA_TEST_RECOVERY_COMMANDS;
    }
  }
  scenario.recordingEnabled = false;
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
    host, synthetic: true, focusedText, focusedPosts: focusedCalls.length,
    selectedScope: scope, units, leaseCountAfterClose: scenario.leases.size,
    videoResourcesAfterClose: scenario.videos.size, operationPolls: scenario.calls.filter((call) => call.path?.startsWith("/api/v1/operations/")).length,
    nativeIdentityPreserved: true, returnedBindingConsumed: true, emptyContextInventory: true,
    externalRetirementRejected: true, readOnlyDiscovery: true, missingPublicPinRejected: true,
    runtimeLockFailureRejected: true, retiredDirectTargetReadRejected: true, noHostStop: true, logs,
    creationRecords: creationRecords.map((record) => ({
      id: record.id, platform: record.platform, nativeId: record.nativeId, state: record.state,
      selectionApplied: record.selectionApplied, operationId: record.acceptedOperation.operationId,
    })),
    createPosts: creationCalls.length, noSeparateBootPost: true,
    stagedEvidence, guardedEvidence,
    recordingCommands, recordingFinalizedOnClose: true, recordingWithoutRecoveryRejected: true,
    connectionRefCapturedInternally: true, connectionRefNotSerialized: true,
    deviceFeaturesValidated: true,
    sourceFeatureResults,
    installedAppRoutes: true, noUnsupportedAppMutations: true,
  }));
} finally {
  await dispatcher?.dispose();
  await receiver?.dispose();
  await release?.();
  if (previousPin) writeFileSync(pinPath, previousPin);
  else rmSync(pinPath, { force: true });
  rmSync(join(scratch, "screen.png"), { force: true });
  rmSync(join(scratch, "context.json"), { force: true });
  rmSync(join(scratch, "native-stage.jsonl"), { force: true });
  rmSync(join(scratch, "native-file.jsonl"), { force: true });
  for (const name of ["empty.txt", "contact.vcf", "image.png"]) rmSync(join(scratch, name), { force: true });
  rmSync(scratch, { recursive: true, force: true });
}
