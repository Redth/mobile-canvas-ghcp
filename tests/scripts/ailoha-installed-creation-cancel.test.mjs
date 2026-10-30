import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import "./fixtures/ailoha-installed-hooks.mjs";
import * as sdk from "./fixtures/ailoha-sdk-double.mjs";
import { catalogIds } from "./fixtures/ailoha-catalog-creation.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { HostBridge } = require(join(root, "vscode/out/hostBridge.js"));
const { scenario, sourceSha } = sdk;
const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
};
const posts = () => scenario.calls.filter((call) => call.method === "POST" && call.path === "/api/v1/targets");
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(predicate(), true, "The owned installed host did not settle its cancellation.");
}

async function fixture(t, kind, product, mode) {
  const { createRuntimeCanvasHost, createRuntimeMobileBackend } = await import(
    pathToFileURL(join(product, "lib/ailoha/runtime-backend.mjs")).href);
  const { createAilohaMcpDispatcher } = await import(pathToFileURL(join(product, "lib/ailoha/mcp-host.mjs")).href);
  const scratch = join(process.env.AILOHA_TEST_ARTIFACT_ROOT ?? join(root, ".build"), `creation-cancel-${randomUUID()}`);
  mkdirSync(scratch, { recursive: true });
  const previousContext = process.env.AILOHA_TEST_CONTEXT_STATE;
  process.env.AILOHA_TEST_CONTEXT_STATE = join(scratch, "context.json");
  scenario.calls.length = 0;
  scenario.createdTargets.clear();
  scenario.targets.clear();
  scenario.operations.clear();
  scenario.status = "running";
  scenario.deleted = false;
  scenario.creationAcceptance = undefined;
  scenario.creationPollFailure = false;
  scenario.creationTargetStatus = undefined;
  sdk.enableCatalogCreation();
  const scope = { sessionId: randomUUID(), viewId: `${kind}-creation-cancel` };
  const runtime = async () => ({ sdk, pin: { version: "synthetic-only", sourceSha } });
  const errors = [];
  const host = createRuntimeCanvasHost({ scope, runtime, onError: (error) => errors.push(error) });
  const messages = [];
  const bridge = mode === "bridge" ? new HostBridge(undefined, scope.sessionId, scope.viewId, {
    async postMessage(message) { messages.push(message); return true; },
  }, { appendLine() {} }, undefined, host) : null;
  let dispatcher;
  t.after(async () => {
    scenario.beforeCatalogRead = undefined;
    scenario.beforeOperationRead = undefined;
    scenario.beforeCliLaunch = undefined;
    if (dispatcher) await dispatcher.dispose();
    if (bridge) { bridge.dispose(); await bridge.closed(); }
    else await host.closeCanvas();
    if (previousContext === undefined) delete process.env.AILOHA_TEST_CONTEXT_STATE;
    else process.env.AILOHA_TEST_CONTEXT_STATE = previousContext;
    rmSync(scratch, { recursive: true });
    assert.equal(scenario.leases.size, 0);
    assert.equal(scenario.videos.size, 0);
  });
  if (bridge) await bridge.handleMessage({ type: "ready" });
  const opened = await host.openCanvas();
  const url = new URL(opened.url);
  const parameters = new URLSearchParams(url.hash.slice(1));
  const bootstrap = await fetch(new URL("/api/v1/auth/bootstrap", url), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: parameters.get("bootstrap"), sessionId: scope.sessionId, instanceId: scope.viewId }),
  });
  assert.equal(bootstrap.status, 204);
  const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
  if (mode === "mcp") {
    const selected = await host.invokeAction("get_selected_device", {});
    dispatcher = await createAilohaMcpDispatcher({
      version: "synthetic-only", selectCreated: kind === "vscode",
      binding: { ...selected.contextBinding, scope },
      createBackend: (options) => createRuntimeMobileBackend({ ...options, runtime, allowContextReopen: false }),
    });
  }
  const catalog = await host.invokeAction("get_device_catalog", {});
  const input = {
    platform: "ios", name: `${kind}-${mode}-caller`,
    runtimeId: catalog.runtimes.find((runtime) => runtime.catalogSelection.providerId === catalogIds.iosProvider
      && runtime.catalogSelection.runtimeId === catalogIds.runtime).id,
    deviceTypeId: catalog.deviceTypes.find((type) => type.catalogSelection.providerId === catalogIds.iosProvider
      && type.targetTypeId === catalogIds.type).id,
  };
  async function create(signal, request = input) {
    if (mode === "action") return host.invokeAction("create_device", request, { signal });
    if (mode === "mcp") {
      const reply = await dispatcher.handle({
        jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: "mobile_device_create", arguments: request },
      }, { signal });
      if (reply.result.isError) throw Object.assign(new Error("Owned MCP creation rejected"),
        JSON.parse(reply.result.content[0].text));
      return reply.result.structuredContent;
    }
    if (bridge) {
      const id = randomUUID();
      const cancel = () => { void bridge.handleMessage({ type: "api-cancel", id }); };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        await bridge.handleMessage({ type: "api", id, path: "/api/v1/devices", method: "POST", body: JSON.stringify(request) });
      } finally { signal?.removeEventListener("abort", cancel); }
      const reply = messages.find((message) => message.id === id);
      if (reply.type !== "api-result") throw new Error(reply.message);
      const body = JSON.parse(new TextDecoder().decode(reply.body));
      if (reply.status >= 400) throw Object.assign(new Error(body.message), body);
      return body;
    }
    const reply = await fetch(new URL("/api/v1/devices", url), {
      method: "POST", signal, headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(request),
    });
    const body = await reply.json();
    if (!reply.ok) throw Object.assign(new Error(body.message), body);
    return body;
  }
  return { create, host, errors, input };
}

for (const [kind, product] of [
  ["github", join(root, ".build/copilot-plugin-thin/mobile-canvas")],
  ["vscode", join(root, "vscode/dist")],
]) {
  for (const mode of ["action", "api", "mcp", ...(kind === "vscode" ? ["bridge"] : [])]) {
    test(`${kind} installed ${mode} cancellation before admission cannot POST after a held catalog read`, async (t) => {
      const state = await fixture(t, kind, product, mode);
      const entered = deferred();
      const release = deferred();
      t.after(() => release.resolve());
      let readSignal;
      scenario.beforeCatalogRead = async (_path, options) => {
        readSignal = options.signal;
        entered.resolve();
        await release.promise;
      };
      const controller = new AbortController();
      const pending = state.create(controller.signal).then(
        (value) => ({ status: "fulfilled", value }), (error) => ({ status: "rejected", error }));
      await Promise.race([entered.promise, pending]);
      controller.abort();
      if (mode === "api") await waitFor(() => readSignal.aborted);
      release.resolve();
      const rejected = await pending;
      assert.equal(rejected.status, "rejected");
      assert.equal(readSignal.aborted, true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(posts().length, 0);
      assert.equal((await state.host.invokeAction("get_selected_device", {})).hasSelection, false);
      scenario.beforeCatalogRead = undefined;
      const created = await state.create(undefined, { ...state.input, name: `${state.input.name}-independent` });
      assert.equal(created.state, "booted");
      assert.equal(posts().length, 1);
      assert.equal(scenario.calls.some((call) => /\/actions\/start$/.test(call.path ?? "")), false);
    });

    test(`${kind} installed ${mode} cancellation after acceptance retains the original operation for recovery`, async (t) => {
      const state = await fixture(t, kind, product, mode);
      const entered = deferred();
      const release = deferred();
      t.after(() => release.resolve());
      scenario.beforeOperationRead = async () => { entered.resolve(); await release.promise; };
      const controller = new AbortController();
      const pending = state.create(controller.signal).then(
        (value) => ({ status: "fulfilled", value }), (error) => ({ status: "rejected", error }));
      await Promise.race([entered.promise, pending]);
      const operationId = [...scenario.operations.keys()].find((id) => id.startsWith("creation/"));
      assert.ok(operationId);
      controller.abort();
      const cancelled = await pending;
      assert.equal(cancelled.status, "rejected");
      if (mode === "api" || mode === "bridge") await waitFor(() => state.errors.some((error) => error.code === "cancelled"));
      release.resolve();
      scenario.beforeOperationRead = undefined;
      assert.equal((await state.host.invokeAction("get_selected_device", {})).hasSelection, false);
      const created = await state.create();
      assert.equal(created.acceptedOperation.operationId, operationId);
      assert.equal(created.state, "booted");
      assert.equal(posts().length, 1);
      assert.equal(scenario.calls.some((call) => /\/actions\/start$/.test(call.path ?? "")), false);
    });
  }
  for (const surviving of [false, true]) {
    test(`${kind} a cancelled MCP create during cold verified launch preserves shared initialization${surviving ? " for a same-key caller" : ""}`, async (t) => {
      const state = await fixture(t, kind, product, "mcp");
      const entered = deferred();
      const release = deferred();
      t.after(() => release.resolve());
      let held = true;
      scenario.beforeCliLaunch = async () => {
        if (held) { held = false; entered.resolve(); await release.promise; }
      };
      const controller = new AbortController();
      const cancelled = state.create(controller.signal).then(
        (value) => ({ status: "fulfilled", value }), (error) => ({ status: "rejected", error }));
      await Promise.race([entered.promise, cancelled]);
      const active = surviving ? state.create() : null;
      controller.abort();
      release.resolve();
      const rejected = await cancelled;
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.error.code, "cancelled");
      if (active) {
        assert.equal((await active).state, "booted");
        assert.equal(posts().length, 1);
      } else {
        assert.equal(posts().length, 0);
        assert.equal((await state.create()).state, "booted");
        assert.equal(posts().length, 1);
      }
      assert.equal(scenario.leases.size, 2);
      assert.equal(scenario.calls.some((call) => call.path === "/api/v1/host/stop"), false);
    });
  }
}
