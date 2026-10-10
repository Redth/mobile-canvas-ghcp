import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { scenario, sourceSha } from "./ailoha-sdk-double.mjs";

const preparedProduct = resolve(process.argv[2]);
const kind = process.argv[3];
const source = resolve(process.argv[4]);
const scratch = join(source, ".build", `installed-workspace-${process.pid}-${randomUUID()}`);
const product = join(scratch, "product");
const pinPath = join(product, "lib/ailoha/runtime-package.json");
mkdirSync(scratch, { recursive: true });
cpSync(preparedProduct, product, { recursive: true });
let previous;
try { previous = readFileSync(pinPath); }
catch (error) { if (error.code !== "ENOENT") throw error; }
writeFileSync(pinPath, JSON.stringify({ schema: "mobile-canvas.ailoha-runtime/v1", version: "synthetic-only", sourceSha }));
process.env.AILOHA_TEST_CONTEXT_STATE = join(scratch, "context.json");
process.env.AILOHA_TEST_INSPECTION_LOG = join(scratch, "inspection.jsonl");
process.env.MOBILE_CANVAS_BACKEND = "ailoha";
const root = join(scratch, "explicit-synthetic-root");
mkdirSync(root);
const scope = { sessionId: randomUUID(), viewId: `${kind}-workspace-view` };
const logs = [];
const states = [];
let release;
let inspect;
let bind;
let cancel;
let selected;
let retiring;

function assertStatic(value) {
  assert.equal(value.schema, "mobile-canvas.workspace-view/v1");
  assert.equal(value.root, root);
  assert.deepEqual(value.scope, scope);
  if (value.inspection) {
    for (const app of value.inspection.applications) {
      assert.equal(app.liveCapabilityEvidence, null);
      assert.equal(app.instrumentation.liveConnection.state, "not-evaluated");
      assert.equal(app.instrumentation.correlation.state, "not-evaluated");
    }
  }
  states.push(value.status);
}

try {
  if (kind === "github") {
    process.env.EXTENSION_PATH = join(scratch, "installed-plugins/mobile-canvas/extension.mjs");
    await import(pathToFileURL(join(product, "extensions/mobile-canvas/extension.mjs")).href);
    const registration = globalThis.ailohaTestCanvasRegistration;
    const canvas = registration.canvases[0];
    const context = { sessionId: scope.sessionId, instanceId: scope.viewId, session: { workingDirectory: "/not-authority" } };
    const action = (name, input = {}) => canvas.actions.find((entry) => entry.name === name).handler({ ...context, input });
    assert.equal(canvas.actions.length, 25);
    assert.equal(canvas.actions.at(-1).name, "workspace_inspect");
    inspect = async () => action("workspace_inspect", { path: root, exclusions: ["excluded/**"] });
    const offline = await inspect();
    assertStatic(offline);
    assert.equal(offline.status, "complete");
    assert.equal(scenario.calls.length, 0);
    assert.throws(() => readFileSync(process.env.AILOHA_TEST_CONTEXT_STATE), { code: "ENOENT" });
    const opened = await canvas.open({ ...context, input: { workspaceRoot: root, workspaceExclusions: ["excluded/**"] } });
    await action("select_device", { deviceId: "opaque/target" });
    release = async () => { await canvas.onClose(context); await registration.hooks.onSessionEnd(); };
    selected = async () => action("get_selected_device");
    const url = new URL(opened.url);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const grant = await fetch(new URL("/api/v1/auth/bootstrap", url), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: fragment.get("bootstrap"), sessionId: scope.sessionId, instanceId: scope.viewId }),
    });
    const cookie = grant.headers.get("set-cookie").split(";", 1)[0];
    const api = async (method, body) => {
      const response = await fetch(new URL("/api/v1/workspace/inspection", url), {
        method, headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, value: await response.json() };
    };
    bind = async (path = root) => {
      // Explicit provider action is the root authority; the renderer route cannot choose roots.
      return action("workspace_inspect", { path, exclusions: ["excluded/**"] });
    };
    inspect = async () => {
      const current = (await api("GET")).value;
      return (await api("POST", { generation: current.generation })).value;
    };
    cancel = async () => {
      const current = (await api("GET")).value;
      return (await api("DELETE", { generation: current.generation })).value;
    };
    assert.equal((await api("POST", { path: "/" })).status, 403);
    retiring = async () => {
      const response = await fetch(new URL("/api/v1/canvas/suspend", url), { method: "POST", headers: { Cookie: cookie } });
      assert.equal(response.status, 204);
    };
  } else if (kind === "vscode") {
    const require = createRequire(import.meta.url);
    const vscode = require("vscode");
    const { HostBridge } = require(join(source, "vscode/out/hostBridge.js"));
    const { createWorkspaceRootAdapter } = require(join(source, "vscode/out/workspaceRoots.js"));
    const { resolveAilohaCanvasHost } = require(join(source, "vscode/out/runtime.js"));
    vscode.workspace.workspaceFolders = [{
      name: "Synthetic root", index: 0, uri: vscode.Uri.file(root),
    }, { name: "Never infer first", index: 1, uri: vscode.Uri.file(join(scratch, "other")) }];
    vscode.window.showQuickPick = async (items) => items[0];
    const roots = createWorkspaceRootAdapter();
    const host = await resolveAilohaCanvasHost({
      asAbsolutePath: (path) => join(product, path.replace(/^dist\//, "")),
    }, scope, (error) => logs.push(error), roots.validate);
    const messages = [];
    const bridge = new HostBridge(undefined, scope.sessionId, scope.viewId, {
      async postMessage(message) { messages.push(message); return true; },
    }, { appendLine: (line) => logs.push(line) }, undefined, host, undefined, roots);
    release = async () => { bridge.dispose(); await bridge.closed(); };
    const api = async (path, method = "GET", body) => {
      const id = randomUUID();
      await bridge.handleMessage({ type: "api", id, path, method, body: body === undefined ? undefined : JSON.stringify(body) });
      const response = messages.find((entry) => entry.id === id);
      assert.equal(response.type, "api-result");
      return { status: response.status, value: JSON.parse(new TextDecoder().decode(response.body)) };
    };
    assert.equal((await api("/api/v1/workspace/inspection")).value.status, "not-selected");
    bind = async () => (await api("/api/v1/workspace/root", "POST")).value;
    await bind();
    inspect = async () => {
      const current = (await api("/api/v1/workspace/inspection")).value;
      return (await api("/api/v1/workspace/inspection", "POST", { generation: current.generation })).value;
    };
    cancel = async () => {
      const current = (await api("/api/v1/workspace/inspection")).value;
      return (await api("/api/v1/workspace/inspection", "DELETE", { generation: current.generation })).value;
    };
    assertStatic(await inspect());
    assert.equal(scenario.calls.length, 0);
    assert.throws(() => readFileSync(process.env.AILOHA_TEST_CONTEXT_STATE), { code: "ENOENT" });
    await bridge.handleMessage({ type: "ready" });
    await api("/api/v1/selection", "POST", { deviceId: "opaque/target" });
    selected = () => bridge.getSelectedDeviceContext();
    assert.equal((await api("/api/v1/workspace/inspection", "POST", { path: "/" })).status, 403);
    retiring = () => bridge.setVisible(false);
  } else throw new Error("Unknown prepared host.");

  const contextBefore = readFileSync(process.env.AILOHA_TEST_CONTEXT_STATE, "utf8");
  const targetBefore = await selected();
  const callsBefore = scenario.calls.length;
  process.env.AILOHA_TEST_INSPECTION_MODE = "complete";
  const complete = await inspect();
  assertStatic(complete);
  assert.equal(complete.inspection.applications.length, 8);
  assert.equal(scenario.calls.length, callsBefore);
  assert.equal(readFileSync(process.env.AILOHA_TEST_CONTEXT_STATE, "utf8"), contextBefore);
  assert.deepEqual(await selected(), targetBefore);
  process.env.AILOHA_TEST_INSPECTION_MODE = "incomplete";
  const incomplete = await inspect();
  assertStatic(incomplete);
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.inspection.diagnostics[0].code, "malformed-json");
  process.env.AILOHA_TEST_INSPECTION_MODE = "unknown-schema";
  const unknown = await inspect();
  assertStatic(unknown);
  assert.equal(unknown.error.code, "workspace_inspection_schema_unsupported");
  process.env.AILOHA_TEST_INSPECTION_MODE = "empty";
  const empty = await inspect();
  assertStatic(empty);
  assert.equal(empty.inspection.applications.length, 0);
  process.env.AILOHA_TEST_INSPECTION_MODE = "complete";
  process.env.AILOHA_TEST_INSPECTION_DELAY_MS = "150";
  const pending = inspect();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await cancel()).status, "cancelled");
  assert.equal((await pending).inspection, null);
  assert.equal(readFileSync(process.env.AILOHA_TEST_CONTEXT_STATE, "utf8"), contextBefore);
  process.env.AILOHA_TEST_INSPECTION_DELAY_MS = "0";
  await bind();
  const hiddenPending = inspect();
  await retiring();
  await hiddenPending;
  await release();
  release = null;
  assert.equal(scenario.leases.size, 0);
  assert.equal(scenario.videos.size, 0);
  assert.equal(scenario.calls.some((call) => call.path === "/api/v1/host/stop"), false);
  const commands = readFileSync(process.env.AILOHA_TEST_INSPECTION_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(commands.every((entry) => entry.args[0] === "workspace" && entry.args[1] === "inspect" && entry.args[3] === root), true);
  console.log(JSON.stringify({
    host: kind, syntheticSdkHooks: true, canonicalFixtureOutput: true,
    offlineInspectionDidNotOpenContextOrHost: true, contextUnchangedByInspection: true,
    explicitRootAndExclusions: true, states, canonicalCliCalls: commands.length,
    noDeviceAgentOrProjectScripts: true, leasesAfterClose: scenario.leases.size,
    videoResourcesAfterClose: scenario.videos.size, publicSdkAvailable: false, logs,
  }));
} finally {
  await release?.();
  if (previous) writeFileSync(pinPath, previous);
  else rmSync(pinPath, { force: true });
  rmSync(scratch, { recursive: true, force: true });
}
