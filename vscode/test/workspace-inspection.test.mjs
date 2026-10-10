import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import "../../tests/scripts/fixtures/ailoha-installed-hooks.mjs";
import { createWorkspaceInspectionController } from "../../lib/ailoha/workspace-inspection.mjs";
import { createAilohaCanvasHost } from "../../lib/ailoha/canvas-host.mjs";
import { createRuntimeCanvasHost } from "../../lib/ailoha/runtime-backend.mjs";
import { workspaceInspectionFixture } from "../../tests/scripts/fixtures/workspace-inspection-fixture.mjs";

const require = createRequire(import.meta.url);
const vscode = require("vscode");
const { HostBridge } = require("../out/hostBridge.js");
const { createWorkspaceRootAdapter } = require("../out/workspaceRoots.js");
const scope = { sessionId: "compiled-workspace-session", viewId: "compiled-workspace-view" };
const folder = (name, path, overrides = {}) => ({
  name, index: 0, uri: { ...vscode.Uri.file(path), ...overrides },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
};

function reset() {
  vscode.workspace.isTrusted = true;
  vscode.workspace.workspaceFolders = [folder("First", "/explicit-first"), folder("Second", "/explicit-second")];
  vscode.env.remoteName = undefined;
  vscode.window.showQuickPick = async (items) => items[1];
}

test("compiled native root adapter requires explicit choice for both multi-root and a sole local folder", async () => {
  reset();
  let choices;
  vscode.window.showQuickPick = async (items) => { choices = items; return items[1]; };
  const adapter = createWorkspaceRootAdapter();
  assert.deepEqual(await adapter.choose(), { path: "/explicit-second" });
  assert.equal(choices.length, 2);
  assert.equal(adapter.validate("/explicit-second"), undefined);
  assert.equal(adapter.validate("/").code, "workspace_root_changed");
  assert.equal(adapter.validate("/explicit-second/child").code, "workspace_root_changed");
  vscode.workspace.workspaceFolders = [folder("Sole", "/explicit-sole")];
  let calls = 0;
  vscode.window.showQuickPick = async (items) => { calls += 1; return items[0]; };
  assert.deepEqual(await adapter.choose(), { path: "/explicit-sole" });
  assert.equal(calls, 1);
  vscode.window.showQuickPick = async () => undefined;
  assert.equal(await adapter.choose(), undefined);
  vscode.workspace.workspaceFolders = [];
  assert.equal((await adapter.choose()).error.code, "workspace_root_not_selected");
});

for (const [name, prepare, expected] of [
  ["untrusted workspace", () => { vscode.workspace.isTrusted = false; }, "workspace_untrusted"],
  ["SSH window", () => { vscode.env.remoteName = "ssh-remote"; }, "workspace_remote_unsupported"],
  ["non-file URI", () => { vscode.workspace.workspaceFolders = [folder("Remote", "/remote", { scheme: "vscode-remote" })]; }, "workspace_uri_unsupported"],
  ["file URI authority", () => { vscode.workspace.workspaceFolders = [folder("Remote", "/remote", { authority: "remote-host" })]; }, "workspace_uri_unsupported"],
]) {
  test(`compiled root adapter positively refuses ${name}`, async () => {
    reset();
    prepare();
    let choices = 0;
    vscode.window.showQuickPick = async (items) => { choices += 1; return items[0]; };
    const adapter = createWorkspaceRootAdapter();
    assert.equal((await adapter.choose()).error.code, expected);
    assert.notEqual(adapter.validate("/remote"), undefined);
    if (expected === "workspace_untrusted" || expected === "workspace_remote_unsupported") assert.equal(choices, 0);
  });
}

test("native folder/trust changes during the picker are not silently adopted", async () => {
  reset();
  const pending = deferred();
  let items;
  vscode.window.showQuickPick = (choices) => { items = choices; return pending.promise; };
  const result = createWorkspaceRootAdapter().choose();
  vscode.workspace.workspaceFolders = [];
  pending.resolve(items[1]);
  assert.equal((await result).error.code, "workspace_root_changed");
  reset();
  vscode.window.showQuickPick = async (choices) => {
    vscode.workspace.isTrusted = false;
    return choices[1];
  };
  assert.equal((await createWorkspaceRootAdapter().choose()).error.code, "workspace_untrusted");
});

function bridgeFixture(runCli) {
  reset();
  const calls = [];
  const roots = createWorkspaceRootAdapter();
  const inspection = createWorkspaceInspectionController({
    scope, validateRoot: roots.validate,
    runCli: runCli ?? (async (args) => {
      calls.push(args);
      return JSON.stringify(workspaceInspectionFixture(args[3]));
    }),
  });
  const host = createAilohaCanvasHost({
    scope, workspaceInspection: inspection,
    createBackend() { calls.push("device-backend"); throw new Error("Inspection must not open the device backend."); },
  });
  const messages = [];
  const logs = [];
  const bridge = new HostBridge(undefined, scope.sessionId, scope.viewId, {
    async postMessage(message) { messages.push(message); return true; },
  }, { appendLine: (line) => logs.push(line) }, undefined, host, undefined, roots);
  async function api(path, method = "GET", body) {
    const id = `request-${messages.length}`;
    await bridge.handleMessage({ type: "api", id, path, method, body: body === undefined ? undefined : JSON.stringify(body) });
    const reply = messages.find((message) => message.id === id);
    assert.equal(reply?.type, "api-result");
    return { status: reply.status, value: JSON.parse(new TextDecoder().decode(reply.body)) };
  }
  return { bridge, host, inspection, calls, messages, logs, api };
}

test("actual compiled bridge chooses a native root and inspects independently of device/context connection", async (t) => {
  const state = bridgeFixture();
  t.after(async () => { state.bridge.dispose(); await state.bridge.closed(); });
  assert.equal((await state.api("/api/v1/workspace/inspection")).value.status, "not-selected");
  const chosen = await state.api("/api/v1/workspace/root", "POST");
  assert.equal(chosen.value.root, "/explicit-second");
  assert.deepEqual(state.calls, []);
  const result = await state.api("/api/v1/workspace/inspection", "POST", { generation: chosen.value.generation });
  assert.equal(result.value.status, "complete");
  assert.equal(result.value.inspection.applications.length, 8);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0], ["workspace", "inspect", "--path", "/explicit-second", "--json"]);
  assert.deepEqual(result.value.scope, scope);
  assert.equal(state.messages.some((message) => message.type === "context"), false);
  assert.equal(JSON.stringify(state.messages).includes("getVerifiedCliLaunch"), false);
  await state.bridge.setVisible(false);
  assert.equal(state.inspection.snapshot().status, "suspended");
  assert.equal(state.calls.includes("device-backend"), false);
});

test("compiled bridge refuses renderer root enlargement, stale root generations and unknown routes without launching", async (t) => {
  const state = bridgeFixture();
  t.after(async () => { state.bridge.dispose(); await state.bridge.closed(); });
  const chosen = (await state.api("/api/v1/workspace/root", "POST")).value;
  for (const path of ["/api/v1/workspace/root", "/api/v1/workspace/inspection"]) {
    const rejected = await state.api(path, "POST", { path: "/" });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.value.code, "workspace_root_authority_required");
  }
  assert.equal((await state.api("/api/v1/workspace/inspection", "POST")).status, 400);
  assert.equal((await state.api("/api/v1/workspace/inspection?path=/")).status, 400);
  assert.equal((await state.api("/api/v1/workspace/not-a-route")).status, 400);
  state.inspection.bindRoot("/explicit-first");
  const stale = await state.api("/api/v1/workspace/inspection", "POST", { generation: chosen.generation });
  assert.equal(stale.status, 409);
  assert.equal(stale.value.code, "workspace_view_changed");
  assert.equal(state.inspection.snapshot().root, "/explicit-first");
  assert.equal(state.calls.length, 0);
});

test("folder and trust events retire pending compiled bridge results and subscriptions are disposed", async () => {
  const pending = deferred();
  let signal;
  const state = bridgeFixture((_args, options) => { signal = options.signal; return pending.promise; });
  const chosen = (await state.api("/api/v1/workspace/root", "POST")).value;
  const result = state.api("/api/v1/workspace/inspection", "POST", { generation: chosen.generation });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vscode.__test.listenerCount(), 2);
  vscode.workspace.workspaceFolders = [];
  vscode.__test.foldersChanged();
  assert.equal(signal.aborted, true);
  pending.resolve(JSON.stringify(workspaceInspectionFixture("/explicit-second")));
  assert.equal((await result).value.status, "not-selected");
  assert.equal(state.inspection.snapshot().inspection, null);
  vscode.workspace.isTrusted = true;
  vscode.__test.trustGranted();
  assert.equal(state.inspection.snapshot().root, null);
  state.bridge.dispose();
  await state.bridge.closed();
  assert.equal(vscode.__test.listenerCount(), 0);
});

test("late native root choice after hide is answered but cannot bind or restore cards", async (t) => {
  const state = bridgeFixture();
  t.after(async () => { state.bridge.dispose(); await state.bridge.closed(); });
  const choice = deferred();
  let items;
  vscode.window.showQuickPick = (entries) => { items = entries; return choice.promise; };
  const result = state.api("/api/v1/workspace/root", "POST");
  await state.bridge.setVisible(false);
  choice.resolve(items[1]);
  assert.equal((await result).value.status, "suspended");
  assert.equal(state.inspection.snapshot().root, null);
  assert.equal(state.calls.length, 0);
});

test("actual missing SDK ready failure still exposes read-only root state and an explicit unavailable inspection", async (t) => {
  reset();
  const roots = createWorkspaceRootAdapter();
  const messages = [];
  const logs = [];
  const host = createRuntimeCanvasHost({ scope, validateWorkspaceRoot: roots.validate, onError: (error) => logs.push(error.code) });
  const bridge = new HostBridge(undefined, scope.sessionId, scope.viewId, {
    async postMessage(message) { messages.push(message); return true; },
  }, { appendLine: (line) => logs.push(line) }, undefined, host, undefined, roots);
  t.after(async () => { bridge.dispose(); await bridge.closed(); });
  await bridge.handleMessage({ type: "ready" });
  assert.equal(messages[0].type, "workspace-inspection");
  assert.equal(messages[0].state.status, "not-selected");
  assert.equal(messages.some((message) => message.type === "fatal"), true);
  const chosen = host.workspaceInspection.bindRoot("/explicit-second");
  await bridge.handleMessage({
    type: "api", id: "missing-sdk", path: "/api/v1/workspace/inspection", method: "POST",
    body: JSON.stringify({ generation: chosen.generation }),
  });
  const reply = messages.find((message) => message.id === "missing-sdk");
  assert.equal(reply.status, 503);
  assert.equal(JSON.parse(new TextDecoder().decode(reply.body)).error.code, "ailoha_runtime_unavailable");
  assert.equal(logs.some((line) => line.includes("Legacy was not started")), true);
});
