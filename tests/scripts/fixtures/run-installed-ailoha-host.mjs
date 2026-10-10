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
import { copilotUi } from "./copilot-sdk-double.mjs";

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
process.env.MOBILE_CANVAS_BACKEND = "ailoha";
const scope = { sessionId: `live-test-session-${process.pid}`, viewId: `${host}-view` };
process.env.AILOHA_TEST_SESSION_ID = scope.sessionId;
const { createAilohaVideoReceiver } = await import(pathToFileURL(join(root, "web", "ailoha-video-receiver.js")).href);
const { createAilohaMcpDispatcher } = await import(pathToFileURL(join(root, "lib", "ailoha", "mcp-host.mjs")).href);
const { ARTIFACT_FEATURE_GATES } = await import(pathToFileURL(join(root, "lib", "ailoha", "artifact-features.mjs")).href);
const { createRuntimeCanvasHost, getRuntimeContextBinding } = await import(pathToFileURL(join(root, "lib", "ailoha", "runtime-backend.mjs")).href);
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
      mobile_device_file_pull: { deviceId: "opaque/target", path: "empty", output: "/owned/output" },
      mobile_device_file_delete: { deviceId: "opaque/target", path: "/directory", recursive: false },
      mobile_device_file_mkdir: { deviceId: "opaque/target", path: "/directory" },
    })) {
      const result = await emptyDispatcher.handle(mcpCall(name, input));
      assert.deepEqual(JSON.parse(result.result.content[0].text), {
        code: "artifact_contract_unavailable", message: ARTIFACT_FEATURE_GATES[name], status: 501,
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
  for (const [name, method, suffix] of [
    ["mobile_device_file_pull", "POST", "/files/pull"],
    ["mobile_device_file_delete", "POST", "/files/delete"],
    ["mobile_device_file_mkdir", "POST", "/files/mkdir"],
  ]) {
    const response = await api(`/api/v1/devices/opaque%2Ftarget${suffix}`, method,
      method === "POST" ? { path: "/directory" } : undefined);
    assert.equal(response.status, 501, name);
    assert.deepEqual(await response.json(), {
      code: "artifact_contract_unavailable", message: ARTIFACT_FEATURE_GATES[name], status: 501,
    });
  }
  assert.equal(scenario.calls.length, callsBefore);
}

async function checkArtifactReads(api, selection) {
  scenario.artifactReads = true;
  const target = "/api/v1/devices/opaque%2Ftarget";
  const files = await api(`${target}/files?bundleId=native-app&path=Documents`, "GET");
  assert.equal(files.status, 200);
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
    const extensionRoot = resolve(process.argv[4] ?? join(source, "vscode"));
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
    await checkArtifactApi(api);
    await checkArtifactReads(api, await (await api("/api/v1/selection")).json());
    await api("/api/v1/selection", "POST", { deviceId: "opaque/target" });
    const selected = await bridge.getSelectedDeviceContext();
    selectedContext = selected.selection;
    assert.equal(selected.deviceId, "opaque/target");
    returnedBinding(selected.selection);
    stagedEvidence = await checkArtifactStaging(api, selected.selection, {
      async answerConsent() {
        const count = vscode.testUi.pickers.length;
        await waitFor(() => vscode.testUi.pickers.length > count);
        const picker = vscode.testUi.pickers.at(-1);
        assert.match(picker.items[1].detail, /Documents\/empty\.txt/);
        assert.equal(picker.answer(true), true);
      },
    });
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
  const creationCalls = scenario.calls.slice(callsBeforeCreate).filter((call) => call.method === "POST");
  assert.equal(creationCalls.length, creationRecords.length);
  assert.equal(creationCalls.every((call) => call.path === "/api/v1/targets" && JSON.parse(call.body).start === true), true);
  assert.equal(creationCalls.every((call) => {
    const input = JSON.parse(call.body);
    return input.runtimeId === catalogIds.runtime && input.targetTypeId === catalogIds.type
      && [catalogIds.iosProvider, catalogIds.androidProvider].includes(input.providerId);
  }), true);
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
    stagedEvidence,
    connectionRefCapturedInternally: true, connectionRefNotSerialized: true,
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
  for (const name of ["empty.txt", "contact.vcf", "image.png"]) rmSync(join(scratch, name), { force: true });
  rmSync(scratch, { recursive: true, force: true });
}
