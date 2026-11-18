import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scenario, sourceSha } from "./ailoha-sdk-double.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const product = resolve(process.argv[2]);
const kind = process.argv[3];
const scratch = join(source, ".build", `app-mcp-${process.pid}-${randomUUID()}`);
mkdirSync(scratch, { recursive: true });
const contextPath = join(scratch, "context.json");
const signalPath = join(scratch, "view-signal.jsonl");
process.env.AILOHA_TEST_CONTEXT_STATE = contextPath;
process.env.AILOHA_TEST_SEMANTIC_CONTEXT = "1";
writeFileSync(signalPath, "");
const pinPath = join(product, "lib/ailoha/runtime-package.json");
const previousPin = existsSync(pinPath) ? readFileSync(pinPath) : undefined;
writeFileSync(pinPath, JSON.stringify({ schema: "mobile-canvas.ailoha-runtime/v1", version: "synthetic-only", sourceSha }));
const hosts = [];
const bridges = [];
const children = [];
const entries = [];
const appNames = ["mobile_app_tree", "mobile_app_query", "mobile_app_status"];
const log = () => existsSync(`${contextPath}.semantic.jsonl`)
  ? readFileSync(`${contextPath}.semantic.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
function replaceContext(change) {
  const contexts = JSON.parse(readFileSync(contextPath, "utf8"));
  change(contexts);
  const temporary = `${contextPath}.pending`;
  writeFileSync(temporary, JSON.stringify(contexts));
  renameSync(temporary, contextPath);
}
async function launch(binding, scope) {
  const child = spawn(process.execPath, [
    "--import", join(source, "tests/scripts/fixtures/ailoha-installed-hooks.mjs"),
    join(product, kind === "github" ? "scripts/mcp.mjs" : "scripts/mcp-vscode.mjs"),
    "--session", scope.sessionId, "--instance", scope.viewId,
    "--context", binding.contextRef, "--context-epoch", binding.scopeEpoch,
    "--owner-process", String(binding.ownerProcessId),
  ], { env: { ...process.env, MOBILE_CANVAS_BACKEND: "ailoha", MOBILE_CANVAS_VSCODE_REFRESH_SIGNAL: signalPath },
    stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buffer = "";
  let diagnostic = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); waiter.resolve(message); }
    }
  });
  child.stderr.on("data", (chunk) => { diagnostic += chunk.toString(); });
  const exited = new Promise((complete) => child.once("close", (code) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`Synthetic MCP exited ${code}: ${diagnostic}`));
    pending.clear();
    complete(code);
  }));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  let id = 0;
  async function request(method, params) {
    const requestId = ++id;
    const response = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
    const timeout = setTimeout(() => pending.get(requestId)?.reject(new Error(`Synthetic MCP timed out: ${diagnostic}`)), 10_000);
    send({ jsonrpc: "2.0", id: requestId, method, params });
    try { return await response; } finally { clearTimeout(timeout); pending.delete(requestId); }
  }
  const entry = { child, exited, request, send, lastId: () => id,
    call: (name, args = {}, extra = {}) => request("tools/call", { name, arguments: args, ...extra }) };
  children.push(entry);
  return entry;
}
function failure(response, code) {
  assert.equal(response.result.isError, true);
  const error = JSON.parse(response.result.content[0].text);
  assert.equal(error.code, code);
  assert.doesNotMatch(response.result.content[0].text, /private-fixture-detail/);
}
try {
  if (kind === "vscode") {
    const { McpVsCodeContextProxy } = await import(pathToFileURL(join(product, "lib/mcp-vscode-proxy.mjs")).href);
    const effects = [];
    const proxy = new McpVsCodeContextProxy({
      sessionId: "trusted", instanceId: "trusted",
      selectDevice: async () => effects.push("select"),
      refreshView: async () => effects.push("refresh"),
      showAutomation: async () => effects.push("automation"),
    });
    for (const name of appNames) {
      const message = { jsonrpc: "2.0", id: name, method: "tools/call",
        params: { name, arguments: { deviceId: "must-not-follow" } } };
      await proxy.clientMessage(message);
      await proxy.serverMessage({ jsonrpc: "2.0", id: name, result: { isError: true } });
    }
    assert.deepEqual(effects, []);
  }
  const { createRuntimeCanvasHost } = await import(pathToFileURL(join(product, "lib/ailoha/runtime-backend.mjs")).href);
  const { HostBridge } = createRequire(import.meta.url)(join(source, "vscode/out/hostBridge.js"));
  for (let index = 0; index < 2; index += 1) {
    const scope = { sessionId: randomUUID(), viewId: `${kind}-app-mcp-${index}` };
    const host = createRuntimeCanvasHost({ scope });
    hosts.push(host);
    const opened = new URL((await host.openCanvas()).url);
    await host.invokeAction("select_device", { deviceId: "opaque/target" });
    const selected = await host.invokeAction("get_selected_device", {});
    let request;
    if (kind === "github") {
      const grant = await fetch(new URL("/api/v1/auth/bootstrap", opened), {
        method: "POST", body: JSON.stringify({
          secret: new URLSearchParams(opened.hash.slice(1)).get("bootstrap"),
          sessionId: scope.sessionId, instanceId: scope.viewId,
        }),
      });
      const cookie = grant.headers.get("set-cookie").split(";", 1)[0];
      request = async (method, body) => {
        const response = await fetch(new URL("/api/v1/semantic/inspection", opened), {
          method, headers: { Cookie: cookie }, ...(body ? { body: JSON.stringify(body) } : {}),
        });
        assert.equal(response.status, 200);
        return response.json();
      };
    } else {
      const messages = [];
      const bridge = new HostBridge(undefined, scope.sessionId, scope.viewId,
        { async postMessage(message) { messages.push(message); return true; } }, { appendLine() {} }, undefined, host);
      bridges.push(bridge);
      request = async (method, body) => {
        const id = randomUUID();
        await bridge.handleMessage({ type: "api", id, path: "/api/v1/semantic/inspection", method,
          ...(body ? { body: JSON.stringify(body) } : {}) });
        const response = messages.find((message) => message.id === id);
        assert.equal(response.status, 200);
        return JSON.parse(new TextDecoder().decode(response.body));
      };
    }
    const mcp = await launch(selected.contextBinding, scope);
    entries.push({ scope, host, request, mcp, binding: selected.contextBinding });
    const initial = await mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    assert.match(initial.result.instructions, /require-agent/);
    const listed = await mcp.request("tools/list", {});
    assert.equal(listed.result.tools.length, 64);
    assert.deepEqual(listed.result.tools.slice(61).map((tool) => tool.name), appNames);
    for (const name of appNames) failure(await mcp.call(name, name === "mobile_app_query" ? { text: "OK" } : {}), "semantic_app_unavailable");
  }
  assert.equal(log().length, 0);
  const bind = async (entry, runtimeInstanceId) => {
    const current = await entry.request("GET");
    const selected = await entry.request("POST", { operation: "bind", bindingToken: current.binding.token,
      runtimeInstanceId, agentId: `agent-${runtimeInstanceId}` });
    assert.equal(selected.appAvailable, true);
  };
  await bind(entries[0], "chosen-one");
  failure(await entries[1].mcp.call("mobile_app_status"), "semantic_app_unavailable");
  await bind(entries[1], "chosen-two");
  const contextBeforeReads = readFileSync(contextPath, "utf8");
  for (const [index, entry] of entries.entries()) {
    for (const name of appNames) {
      const response = await entry.mcp.call(name, name === "mobile_app_query" ? { text: "OK", type: "Button" } : {});
      assert.notEqual(response.result.isError, true);
      const output = response.result.structuredContent;
      assert.deepEqual(output.scope, entry.scope);
      assert.equal(output.selection.runtimeInstanceId, index ? "chosen-two" : "chosen-one");
      assert.equal(output.result.route.runtimeInstanceId, output.selection.runtimeInstanceId);
      assert.equal(output.result.route.owner, "agent");
      assert.equal(output.result.provenance.runtimeInstanceEvidence, "verified-native-instance");
      assert.equal(output.result.route.executionContext.contextRef, entry.binding.contextRef);
    }
    for (const selector of ["targetId", "deviceId", "runtimeInstanceId", "agentId", "route", "contextRef", "ownerProcessId"]) {
      failure(await entry.mcp.call("mobile_app_status", { [selector]: "must-not-follow" }), "invalid_request");
    }
    failure(await entry.mcp.call("mobile_app_status", {}, { task: { ttl: 1000 } }), "mcp_tasks_unsupported");
  }
  assert.equal(readFileSync(contextPath, "utf8"), contextBeforeReads);
  assert.equal(readFileSync(signalPath, "utf8"), "");
  const failureFile = `${contextPath}.semantic-failures.json`;
  for (const code of ["AgentNotFound", "AgentInstanceMismatch"]) {
    writeFileSync(failureFile, JSON.stringify({ [entries[0].binding.contextRef]: code }));
    failure(await entries[0].mcp.call("mobile_app_tree"), code);
    assert.notEqual((await entries[1].mcp.call("mobile_app_status")).result.isError, true);
    const device = await entries[0].mcp.call("mobile_device_get", { deviceId: "opaque/target" });
    assert.equal(device.result.structuredContent.id, "opaque/target");
  }
  rmSync(failureFile);
  const waiting = entries[0].mcp.call("mobile_app_query", { text: "wait" });
  const requestId = entries[0].mcp.lastId();
  const deadline = Date.now() + 5000;
  while (!log().some((entry) => entry.arguments.text === "wait")) {
    if (Date.now() > deadline) throw new Error("Synthetic canonical read did not begin.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const pid = log().find((entry) => entry.arguments.text === "wait").pid;
  entries[0].mcp.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } });
  failure(await waiting, "cancelled");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  replaceContext((contexts) => { contexts.find((entry) => entry.contextRef === entries[0].binding.contextRef).state = "detached"; });
  failure(await entries[0].mcp.call("mobile_app_status"), "semantic_target_unavailable");
  assert.notEqual((await entries[1].mcp.call("mobile_app_status")).result.isError, true);
  assert.equal(log().every((entry) => entry.arguments.route === "require-agent"), true);
  assert.equal(readFileSync(signalPath, "utf8"), "");
  assert.equal(scenario.calls.some((entry) => entry.method === "POST"
    && /\/actions\/(start|stop|reboot|reset|delete)/.test(entry.path)), false);
  process.stdout.write(JSON.stringify({
    synthetic: true, host: kind, explicitTrustedLaunchFlags: true, realSdkLaunchRegistration: false,
    listed: 64, legacyDeviceIdentities: 61, appTools: appNames, uiSelectedExactInstance: true,
    viewIsolation: true, missingStaleDisconnectedFailClosed: true, selectorsRejected: true,
    noSystemFallback: true, noReadonlySelectionOrAutomation: true, cancelledCanonicalChildClosed: true,
    deviceReadsSurviveMissingAgent: true, realDeviceMutation: false,
  }));
} finally {
  for (const entry of children) {
    if (entry.child.exitCode === null) entry.child.stdin.end();
    await entry.exited;
  }
  for (const bridge of bridges) { bridge.dispose(); await bridge.closed(); }
  for (const host of hosts) await host.closeCanvas();
  if (previousPin) writeFileSync(pinPath, previousPin);
  else rmSync(pinPath, { force: true });
  rmSync(scratch, { recursive: true });
}
