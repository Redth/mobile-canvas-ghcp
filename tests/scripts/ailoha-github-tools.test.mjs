import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { productModule } from "../ailoha-test-module.mjs";
import { closeAilohaGithubOwners, createAilohaGithubTools } from "../../lib/ailoha/github-tools.mjs";
import { withAilohaCanvas } from "../../lib/ailoha/github-adapter.mjs";
import * as sdkDouble from "./fixtures/ailoha-sdk-double.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const descriptor = {
  name: "mobile_device_screenshot", description: "Captured screen",
  inputSchema: {
    type: "object", properties: { deviceId: { type: "string" } }, required: ["deviceId"],
  },
};
const scope = (sessionId, viewId) => ({ sessionId, viewId });
const invocation = (sessionId, signal) => ({ sessionId, signal });
const input = (instanceId) => ({ instanceId, deviceId: "target" });

test("SDK tools bind only the explicitly opened instance in the invoking session, preserving image and failure results", async () => {
  const bound = [];
  const tools = createAilohaGithubTools({
    descriptors: [descriptor],
    async getBinding(selected) { bound.push(selected); return { scope: selected }; },
    async createDispatcher({ binding }) {
      return {
        async handle(message) {
          assert.deepEqual(message.params.arguments, { deviceId: "target" });
          if (binding.scope.viewId === "other") return {
            result: { isError: true, content: [{ type: "text", text: '{"code":"not_available"}' }] },
          };
          return { result: { content: [
            { type: "text", text: '{"context":"captured"}' },
            { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
          ] } };
        },
        async dispose() {},
      };
    },
  });
  const screenshot = tools.tools[0];
  assert.deepEqual(screenshot.parameters.required, ["deviceId", "instanceId"]);
  assert.equal((await screenshot.handler(input("one"), invocation("session"))).resultType, "failure");
  tools.opened(scope("session", "one"));
  tools.opened(scope("session", "other"));
  assert.equal((await screenshot.handler(input("one"), invocation("wrong-session"))).resultType, "failure");
  assert.equal((await screenshot.handler({ ...input("one"), sessionId: "session" }, invocation("session"))).resultType, "failure");
  const image = await screenshot.handler(input("one"), invocation("session"));
  assert.equal(image.resultType, "success");
  assert.deepEqual(image.binaryResultsForLlm, [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }]);
  const error = await screenshot.handler(input("other"), invocation("session"));
  assert.equal(error.resultType, "failure");
  assert.match(error.error, /not_available/);
  assert.deepEqual(bound, [scope("session", "one"), scope("session", "other")]);
  await tools.closing(scope("session", "one"));
  assert.equal((await screenshot.handler(input("one"), invocation("session"))).resultType, "failure");
  assert.equal((await screenshot.handler(input("other"), invocation("session"))).resultType, "failure");
  await tools.closeAll();
});

test("source-local SDK names do not collide with installed plugin names while forwarding canonical tools", async () => {
  const names = ["mobile_device_screenshot", "mobile_app_status"];
  const descriptors = names.map((name) => ({ ...descriptor, name }));
  const options = {
    descriptors,
    async getBinding(selected) { return { scope: selected }; },
    async createDispatcher() {
      return {
        async handle(message) {
          assert.ok(names.includes(message.params.name));
          return { result: { content: [{ type: "text", text: "ok" }] } };
        },
        async dispose() {},
      };
    },
  };
  const installed = createAilohaGithubTools(options);
  const local = createAilohaGithubTools({
    ...options,
    nameForDescriptor: (name) => name.replace(/^mobile_(device|app)_/, "mobile_$1_local_"),
  });
  assert.deepEqual(installed.tools.map((tool) => tool.name), names);
  assert.deepEqual(local.tools.map((tool) => tool.name), ["mobile_device_local_screenshot", "mobile_app_local_status"]);
  assert.equal(new Set([...installed.tools, ...local.tools].map((tool) => tool.name)).size, 4);
  local.opened(scope("session", "view"));
  assert.equal((await local.tools[0].handler(input("view"), invocation("session"))).resultType, "success");
  await local.closeAll();
});

test("closing a view during binding cannot retarget its pending call to a reopened instance", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const dispatched = [];
  let reads = 0;
  const tools = createAilohaGithubTools({
    descriptors: [descriptor],
    async getBinding(selected) {
      reads += 1;
      if (reads === 1) await gate;
      return { scope: selected, generation: reads };
    },
    async createDispatcher({ binding }) {
      dispatched.push(binding.generation);
      return {
        async handle() { return { result: { content: [{ type: "text", text: "ok" }] } }; },
        async dispose() {},
      };
    },
  });
  const selected = scope("session", "same");
  tools.opened(selected);
  const old = tools.tools[0].handler(input("same"), invocation("session"));
  const closing = tools.closing(selected);
  assert.throws(() => tools.opened(selected), { code: "view_cleanup_pending" });
  release();
  assert.equal((await old).resultType, "failure");
  await closing;
  tools.opened(selected);
  assert.equal((await tools.tools[0].handler(input("same"), invocation("session"))).resultType, "success");
  assert.deepEqual(dispatched, [2]);
  await tools.closeAll();
});

test("failed SDK dispatcher disposal retains its aborted owner for explicit close retry", async () => {
  let disposals = 0;
  let created = 0;
  const tools = createAilohaGithubTools({
    descriptors: [descriptor],
    async getBinding(selected) { return { scope: selected }; },
    createDispatcher() {
      created += 1;
      return {
        async handle() { return { result: { content: [{ type: "text", text: "ok" }] } }; },
        async dispose() {
          if (++disposals === 1) throw new Error("owned lease cleanup failed");
        },
      };
    },
  });
  const selected = scope("session", "view");
  tools.opened(selected);
  const tool = tools.tools[0];
  assert.equal((await tool.handler(input("view"), invocation("session"))).resultType, "success");
  await assert.rejects(tools.closing(selected), /owned lease cleanup failed/);
  assert.equal((await tool.handler(input("view"), invocation("session"))).resultType, "failure");
  assert.throws(() => tools.opened(selected), { code: "view_cleanup_pending" });
  await tools.closing(selected);
  assert.equal(disposals, 2);
  tools.opened(selected);
  assert.equal((await tool.handler(input("view"), invocation("session"))).resultType, "success");
  assert.equal(created, 2);
  await tools.closeAll();
});

test("session-end cleanup tries peer SDK owners and every UI host before surfacing a failed lease", async () => {
  const disposed = [];
  const hosts = [];
  let fail = true;
  let failHost = true;
  const tools = createAilohaGithubTools({
    descriptors: [descriptor],
    async getBinding(selected) { return { scope: selected }; },
    createDispatcher({ binding }) {
      return {
        async handle() { return { result: { content: [{ type: "text", text: "ok" }] } }; },
        async dispose() {
          disposed.push(binding.scope.viewId);
          if (binding.scope.viewId === "failed" && fail) {
            fail = false;
            throw new Error("SDK lease cleanup failed");
          }
        },
      };
    },
  });
  for (const viewId of ["failed", "peer"]) {
    tools.opened(scope("session", viewId));
    assert.equal((await tools.tools[0].handler(input(viewId), invocation("session"))).resultType, "success");
  }
  const uiHosts = ["failed", "peer"].map((id) => ({
    closeCanvas() {
      hosts.push(id);
      if (id === "failed" && failHost) {
        failHost = false;
        throw new Error("UI host cleanup failed");
      }
    },
  }));
  await assert.rejects(closeAilohaGithubOwners(tools, uiHosts), (error) =>
    error instanceof AggregateError && error.errors.some((entry) => /SDK lease cleanup failed/.test(entry.message))
      && error.errors.some((entry) => /UI host cleanup failed/.test(entry.message)));
  assert.deepEqual(new Set(hosts), new Set(["failed", "peer"]));
  assert.deepEqual(new Set(disposed), new Set(["failed", "peer"]));
  assert.equal((await tools.tools[0].handler(input("failed"), invocation("session"))).resultType, "failure");
  assert.throws(() => tools.opened(scope("session", "failed")), { code: "view_closed" });
  await closeAilohaGithubOwners(tools, uiHosts);
  assert.equal(disposed.filter((id) => id === "failed").length, 2);
});

test("concurrent explicit canvas reopens join one failed SDK cleanup retry without another onClose", async () => {
  let fail = true;
  let hostCloses = 0;
  let hostOpens = 0;
  const tools = createAilohaGithubTools({
    descriptors: [descriptor],
    async getBinding(selected) { return { scope: selected }; },
    createDispatcher() {
      return {
        async handle() { return { result: { content: [{ type: "text", text: "ok" }] } }; },
        async dispose() {
          if (fail) { fail = false; throw new Error("retained SDK cleanup"); }
        },
      };
    },
  });
  const canvas = withAilohaCanvas({
    inputSchema: { type: "object", properties: {} }, actions: [],
  }, {
    backend: "ailoha",
    createHost: () => ({
      async openCanvas() { return { title: "Mobile", url: `http://127.0.0.1/${++hostOpens}` }; },
      async closeCanvas() { hostCloses += 1; },
    }),
    onHostOpened: (selected) => tools.opened(selected),
    onHostClosing: (selected) => tools.closing(selected),
  });
  const context = { sessionId: "session", instanceId: "view" };
  await canvas.open(context);
  assert.equal((await tools.tools[0].handler(input("view"), invocation("session"))).resultType, "success");
  await assert.rejects(canvas.onClose(context), /retained SDK cleanup/);
  assert.equal(hostCloses, 1);
  assert.equal((await tools.tools[0].handler(input("view"), invocation("session"))).resultType, "failure");
  const reopens = await Promise.all([canvas.open(context), canvas.open(context)]);
  assert.deepEqual(reopens.map((result) => result.url), ["http://127.0.0.1/2", "http://127.0.0.1/3"]);
  assert.equal(hostCloses, 2);
  await canvas.onClose(context);
  await tools.closeAll();
});

test("a still-failing explicit reopen does not admit SDK tools or reopen the old host", async () => {
  let failures = 2;
  let openings = 0;
  let closings = 0;
  const tools = createAilohaGithubTools({
    descriptors: [descriptor],
    async getBinding(selected) { return { scope: selected }; },
    createDispatcher() {
      return {
        async handle() { return { result: { content: [{ type: "text", text: "ok" }] } }; },
        async dispose() {
          if (failures-- > 0) throw new Error("cleanup still failed");
        },
      };
    },
  });
  const canvas = withAilohaCanvas({
    inputSchema: { type: "object", properties: {} }, actions: [],
  }, {
    backend: "ailoha",
    createHost: () => ({
      async openCanvas() { openings += 1; return { title: "Mobile", url: `http://127.0.0.1/${openings}` }; },
      async closeCanvas() { closings += 1; },
    }),
    onHostOpened: (selected) => tools.opened(selected),
    onHostClosing: (selected) => tools.closing(selected),
  });
  const context = { sessionId: "session", instanceId: "view" };
  await canvas.open(context);
  assert.equal((await tools.tools[0].handler(input("view"), invocation("session"))).resultType, "success");
  await assert.rejects(canvas.onClose(context), /cleanup still failed/);
  await assert.rejects(canvas.open(context), /cleanup still failed/);
  assert.equal(openings, 1);
  assert.equal(closings, 2);
  assert.equal((await tools.tools[0].handler(input("view"), invocation("session"))).resultType, "failure");
  assert.equal((await canvas.open(context)).url, "http://127.0.0.1/2");
  assert.equal(closings, 3);
  await canvas.onClose(context);
  await tools.closeAll();
});

test("an explicit open waits for an in-flight close and retries its failed SDK cleanup once", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let disposed = 0;
  let openings = 0;
  const tools = createAilohaGithubTools({
    descriptors: [descriptor],
    async getBinding(selected) { return { scope: selected }; },
    createDispatcher() {
      return {
        async handle() { return { result: { content: [{ type: "text", text: "ok" }] } }; },
        async dispose() {
          if (++disposed === 1) { await gate; throw new Error("late SDK cleanup failure"); }
        },
      };
    },
  });
  const canvas = withAilohaCanvas({
    inputSchema: { type: "object", properties: {} }, actions: [],
  }, {
    backend: "ailoha",
    createHost: () => ({
      async openCanvas() { return { title: "Mobile", url: `http://127.0.0.1/${++openings}` }; },
      async closeCanvas() {},
    }),
    onHostOpened: (selected) => tools.opened(selected),
    onHostClosing: (selected) => tools.closing(selected),
  });
  const context = { sessionId: "session", instanceId: "view" };
  await canvas.open(context);
  assert.equal((await tools.tools[0].handler(input("view"), invocation("session"))).resultType, "success");
  const closing = canvas.onClose(context).then(() => null, (error) => error);
  const reopening = canvas.open(context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(openings, 1);
  assert.equal((await tools.tools[0].handler(input("view"), invocation("session"))).resultType, "failure");
  release();
  assert.match((await closing).message, /late SDK cleanup failure/);
  assert.equal((await reopening).url, "http://127.0.0.1/2");
  assert.equal(disposed, 2);
  await canvas.onClose(context);
  await tools.closeAll();
});

test("SDK tool captures nested input before an asynchronous binding lookup", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const received = [];
  const tools = createAilohaGithubTools({
    descriptors: [descriptor],
    async getBinding() { await gate; return { scope: scope("session", "view") }; },
    createDispatcher() {
      return {
        async handle(message) {
          received.push(message.params.arguments);
          return { result: { content: [{ type: "text", text: "ok" }] } };
        },
        async dispose() {},
      };
    },
  });
  tools.opened(scope("session", "view"));
  const request = {
    ...input("view"),
    paths: [{ relative: "original.txt", options: { overwrite: false } }],
  };
  const pending = tools.tools[0].handler(request, invocation("session"));
  request.paths[0].relative = "changed.txt";
  request.paths[0].options.overwrite = true;
  request.paths.push({ relative: "extra.txt" });
  release();
  assert.equal((await pending).resultType, "success");
  assert.deepEqual(received, [{
    deviceId: "target", paths: [{ relative: "original.txt", options: { overwrite: false } }],
  }]);
  await tools.closeAll();
});

test("failed binding initialization is retried only by a new call, without replaying failed tool operations", async () => {
  let bindings = 0;
  let calls = 0;
  const tools = createAilohaGithubTools({
    descriptors: [descriptor],
    async getBinding() {
      if (++bindings === 1) throw new Error("context_read_superseded");
      return { scope: scope("session", "view") };
    },
    createDispatcher() {
      return {
        async handle() {
          calls += 1;
          return { result: { isError: calls === 1, content: [{ type: "text", text: "operation result" }] } };
        },
        async dispose() {},
      };
    },
  });
  tools.opened(scope("session", "view"));
  const tool = tools.tools[0];
  assert.equal((await tool.handler(input("view"), invocation("session"))).resultType, "failure");
  assert.equal(bindings, 1);
  assert.equal(calls, 0);
  assert.equal((await tool.handler(input("view"), invocation("session"))).resultType, "failure");
  assert.equal(bindings, 2);
  assert.equal(calls, 1);
  assert.equal((await tool.handler(input("view"), invocation("session"))).resultType, "success");
  assert.equal(bindings, 2);
  assert.equal(calls, 2);
  await tools.closeAll();
});

test("canvas close during an opening request never exposes a late owner as active", async () => {
  let finishOpen;
  let opened;
  const opening = new Promise((resolve) => { finishOpen = resolve; });
  const registered = [];
  const canvas = withAilohaCanvas({
    inputSchema: { type: "object", properties: {} }, actions: [],
  }, {
    backend: "ailoha",
    createHost() {
      return {
        async openCanvas() { opened?.(); await opening; return { title: "Mobile", url: "http://127.0.0.1/" }; },
        async closeCanvas() {},
      };
    },
    onHostOpened: (selected) => registered.push(selected),
    onHostClosing: () => {},
  });
  const context = { sessionId: "session", instanceId: "view" };
  const entered = new Promise((resolve) => { opened = resolve; });
  const pending = canvas.open(context);
  await entered;
  const closing = canvas.onClose(context);
  finishOpen();
  await closing;
  await assert.rejects(pending, { code: "view_closed" });
  assert.deepEqual(registered, []);
});

test("queued canvas open keeps the original scope and nested options", async () => {
  const received = [];
  const registered = [];
  const canvas = withAilohaCanvas({
    inputSchema: { type: "object", properties: {} }, actions: [],
  }, {
    backend: "ailoha",
    createHost: () => ({
      async openCanvas(input) {
        received.push(input);
        return { title: "Mobile", url: "http://127.0.0.1/" };
      },
      async closeCanvas() {},
    }),
    onHostOpened: (scope) => registered.push(scope),
  });
  const context = {
    sessionId: "original-session", instanceId: "original-view",
    input: { deviceId: "original-device", options: { orientation: "portrait" } },
  };
  const pending = canvas.open(context);
  context.sessionId = "new-session";
  context.instanceId = "new-view";
  context.input.deviceId = "new-device";
  context.input.options.orientation = "landscape";
  await pending;
  assert.deepEqual(received, [{ deviceId: "original-device", options: { orientation: "portrait" } }]);
  assert.deepEqual(registered, [{ sessionId: "original-session", viewId: "original-view" }]);
  await canvas.onClose({ sessionId: "original-session", instanceId: "original-view" });
});

test("close during a pending same-instance host reopen retires its new lease before SDK admission", async () => {
  let releaseOpen;
  let enteredOpen;
  const gate = new Promise((resolve) => { releaseOpen = resolve; });
  const entered = new Promise((resolve) => { enteredOpen = resolve; });
  let opens = 0;
  let closes = 0;
  let leases = 0;
  let admissions = 0;
  const canvas = withAilohaCanvas({
    inputSchema: { type: "object", properties: {} }, actions: [],
  }, {
    backend: "ailoha",
    createHost: () => ({
      async openCanvas() {
        opens += 1;
        leases += 1;
        if (opens === 2) { enteredOpen(); await gate; }
        return { title: "Mobile", url: `http://127.0.0.1/${opens}` };
      },
      async closeCanvas() { closes += 1; leases = 0; },
    }),
    onHostOpened: () => { admissions += 1; },
    onHostClosing: () => {},
  });
  const context = { sessionId: "session", instanceId: "view" };
  await canvas.open(context);
  await canvas.onClose(context);
  const pending = canvas.open(context);
  await entered;
  const closing = canvas.onClose(context);
  let closed = false;
  void closing.then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(leases, 1);
  assert.equal(admissions, 1);
  releaseOpen();
  await assert.rejects(pending, { code: "view_closed" });
  await closing;
  assert.equal(opens, 2);
  assert.equal(closes, 2);
  assert.equal(leases, 0);
  assert.equal(admissions, 1);
  assert.equal((await canvas.open(context)).url, "http://127.0.0.1/3");
  await canvas.onClose(context);
  assert.equal(closes, 3);
});

test("canvas close serializes a same-instance reopen behind SDK lookup and retains its host", async () => {
  let releaseLookup;
  const lookup = new Promise((resolve) => { releaseLookup = resolve; });
  let releaseClose;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  const closed = [];
  let created = 0;
  let openings = 0;
  let reads = 0;
  const tools = createAilohaGithubTools({
    descriptors: [descriptor],
    async getBinding() {
      if (++reads === 1) await lookup;
      return { owner: reads };
    },
    createDispatcher({ binding }) {
      return {
        async handle() {
          return { result: { content: [{ type: "text", text: String(binding.owner) }] } };
        },
        async dispose() {},
      };
    },
  });
  const canvas = withAilohaCanvas({
    inputSchema: { type: "object", properties: {} }, actions: [],
  }, {
    backend: "ailoha",
    createHost() {
      const owner = ++created;
      return {
        async openCanvas() { return { title: "Mobile", url: `http://127.0.0.1/${owner}/${++openings}` }; },
        async closeCanvas() { await closeGate; closed.push(owner); },
      };
    },
    onHostOpened: (selected) => tools.opened(selected),
    onHostClosing: (selected) => tools.closing(selected),
  });
  const context = { sessionId: "session", instanceId: "view" };
  assert.equal((await canvas.open(context)).url, "http://127.0.0.1/1/1");
  const pending = tools.tools[0].handler(input("view"), invocation("session"));
  const closing = canvas.onClose(context);
  const reopening = canvas.open(context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created, 1);
  assert.equal(openings, 1);
  releaseLookup();
  assert.equal((await pending).resultType, "failure");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(openings, 1);
  releaseClose();
  await closing;
  assert.equal((await reopening).url, "http://127.0.0.1/1/2");
  assert.deepEqual(closed, [1]);
  const fresh = await tools.tools[0].handler(input("view"), invocation("session"));
  assert.equal(fresh.textResultForLlm, "2");
  assert.equal(fresh.resultType, "success");
  await canvas.onClose(context);
  assert.deepEqual(closed, [1, 1]);
  assert.equal(created, 1);
  await tools.closeAll();
});

test("idempotent SDK leases keep UI, MCP and peer views independent through suspend and receipt recovery", async (t) => {
  const { createRuntimeCanvasHost, createRuntimeMobileBackend } =
    await import(productModule("lib/ailoha/runtime-backend.mjs"));
  const { ailohaMcpCatalog, createAilohaMcpDispatcher } =
    await import(productModule("lib/ailoha/mcp-host.mjs"));
  mkdirSync(join(root, ".build"), { recursive: true });
  const directory = mkdtempSync(join(root, ".build/idempotent-owners-"));
  const previousContext = process.env.AILOHA_TEST_CONTEXT_STATE;
  process.env.AILOHA_TEST_CONTEXT_STATE = join(directory, "context.json");
  const scenario = sdkDouble.scenario;
  scenario.calls.length = 0;
  scenario.operations.clear();
  scenario.idempotentLeases = true;
  let failedLeaseId;
  let failLeaseOnce = false;
  const sdk = {
    ...sdkDouble,
    async releaseRuntimeLease(leaseId) {
      if (failLeaseOnce && leaseId === failedLeaseId) {
        failLeaseOnce = false;
        throw new Error("synthetic SDK lease cleanup failed");
      }
      return sdkDouble.releaseRuntimeLease(leaseId);
    },
  };
  const runtime = async () => ({ sdk, pin: { version: "synthetic-only", sourceSha: sdkDouble.sourceSha } });
  const scope = { sessionId: randomUUID(), viewId: "shared" };
  const peerScope = { sessionId: scope.sessionId, viewId: "external" };
  const runtimeHost = createRuntimeCanvasHost({ scope, runtime });
  let heldOpen;
  let releaseHeldOpen;
  const host = {
    ...runtimeHost,
    async openCanvas(input) {
      const result = await runtimeHost.openCanvas(input);
      if (heldOpen) {
        const hold = heldOpen;
        heldOpen = undefined;
        hold.enter();
        await hold.wait;
      }
      return result;
    },
  };
  const peer = createRuntimeCanvasHost({ scope: peerScope, runtime });
  let binding;
  const sdkTools = createAilohaGithubTools({
    descriptors: (await ailohaMcpCatalog()).filter(({ name }) =>
      ["mobile_device_list", "mobile_device_sms_send"].includes(name)),
    async getBinding(selected) {
      assert.deepEqual(selected, scope);
      return binding;
    },
    createDispatcher: ({ binding: selected, backendState }) => createAilohaMcpDispatcher({
      version: "synthetic-only", binding: selected, backendState,
      createBackend: (options) => createRuntimeMobileBackend({ ...options, runtime, allowContextReopen: false }),
    }),
  });
  const canvas = withAilohaCanvas({
    inputSchema: { type: "object", properties: {} }, actions: [],
  }, {
    backend: "ailoha", createHost: () => host,
    onHostOpened: (selected) => sdkTools.opened(selected),
    onHostClosing: (selected) => sdkTools.closing(selected),
  });
  const context = { sessionId: scope.sessionId, instanceId: scope.viewId, input: { deviceId: "opaque/target" } };
  t.after(async () => {
    scenario.beforeOperationRead = undefined;
    releaseHeldOpen?.();
    await canvas.onClose(context);
    await sdkTools.closeAll();
    await peer.closeCanvas();
    scenario.idempotentLeases = false;
    scenario.leaseKeys.clear();
    if (previousContext === undefined) delete process.env.AILOHA_TEST_CONTEXT_STATE;
    else process.env.AILOHA_TEST_CONTEXT_STATE = previousContext;
    rmSync(directory, { recursive: true });
    assert.equal(scenario.leases.size, 0);
  });
  const opened = await canvas.open(context);
  await peer.openCanvas();
  const selected = await host.invokeAction("get_selected_device", {});
  binding = { ...selected.contextBinding, scope };
  const call = (name, args = {}) => sdkTools.tools.find((entry) => entry.name === name)
    .handler({ instanceId: scope.viewId, ...args }, invocation(scope.sessionId));
  assert.equal((await call("mobile_device_list")).resultType, "success");
  const ensures = scenario.calls.filter((entry) => entry.ensure);
  assert.equal(ensures.length, 3);
  assert.equal(new Set(ensures.map(({ ensure }) => ensure.consumerId)).size, 3);
  assert.equal(new Set(scenario.leaseKeys.values()).size, 3);

  const url = new URL(opened.url);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const bootstrap = await fetch(new URL("/api/v1/auth/bootstrap", url), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: fragment.get("bootstrap"), sessionId: scope.sessionId, instanceId: scope.viewId,
    }),
  });
  assert.equal(bootstrap.status, 204);
  const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
  const panel = (action) => fetch(new URL(`/api/v1/canvas/${action}`, url), { method: "POST", headers: { Cookie: cookie } });
  assert.equal((await panel("suspend")).status, 204);
  assert.equal((await call("mobile_device_list")).resultType, "success");
  assert.ok((await peer.invokeAction("get_device_catalog", {})).runtimes);
  assert.equal((await panel("resume")).status, 204);

  const sms = { deviceId: "opaque/target", from: "+123", body: "lease recovery" };
  scenario.beforeOperationRead = async () => {
    scenario.beforeOperationRead = undefined;
    throw new Error("Synthetic accepted operation GET failed");
  };
  await assert.rejects(host.invokeAction("send_sms", sms));
  const posts = () => scenario.calls.filter((entry) =>
    entry.method === "POST" && entry.path === "/api/v1/targets/opaque%2Ftarget/telephony/sms");
  assert.equal(posts().length, 1);
  const closing = canvas.onClose(context);
  const reopening = canvas.open(context);
  await closing;
  assert.notEqual((await reopening).url, opened.url);
  assert.equal((await call("mobile_device_list")).resultType, "success");
  assert.equal((await host.invokeAction("send_sms", sms)).operation, "sms-send");
  assert.equal(posts().length, 1);

  const sdkSms = { ...sms, body: "SDK accepted recovery" };
  scenario.beforeOperationRead = async () => {
    scenario.beforeOperationRead = undefined;
    throw new Error("Synthetic SDK accepted operation GET failed");
  };
  assert.equal((await call("mobile_device_sms_send", sdkSms)).resultType, "failure");
  const originalId = [...scenario.operations.keys()].at(-1);
  assert.equal(posts().length, 2);
  const originalGets = () => scenario.calls.filter((entry) => entry.method === "GET"
    && entry.path === `/api/v1/operations/${encodeURIComponent(originalId)}`).length;
  const failedGets = originalGets();
  assert.ok(failedGets >= 1);
  failedLeaseId = [...scenario.leaseKeys].find(([key]) =>
    JSON.parse(key)[0].startsWith("mobile-canvas-mcp-"))?.[1];
  assert.ok(failedLeaseId);
  failLeaseOnce = true;
  await assert.rejects(canvas.onClose(context), /synthetic SDK lease cleanup failed/);
  assert.equal(scenario.leases.has(failedLeaseId), true);
  assert.equal((await call("mobile_device_sms_send", sdkSms)).resultType, "failure");
  assert.ok((await peer.invokeAction("get_device_catalog", {})).runtimes);
  await canvas.open(context);
  assert.equal(scenario.leases.has(failedLeaseId), false);
  const recovered = await call("mobile_device_sms_send", sdkSms);
  assert.equal(recovered.resultType, "success");
  assert.equal(posts().length, 2);
  assert.ok(originalGets() > failedGets);

  await canvas.onClose(context);
  let enterHeldOpen;
  const enteredHeldOpen = new Promise((resolve) => { enterHeldOpen = resolve; });
  const heldGate = new Promise((resolve) => { releaseHeldOpen = resolve; });
  heldOpen = { enter: enterHeldOpen, wait: heldGate };
  const pendingReopen = canvas.open(context);
  await enteredHeldOpen;
  const newLeaseId = [...scenario.leaseKeys].find(([key]) =>
    JSON.parse(key)[0].startsWith("mobile-canvas-canvas-") && JSON.parse(key)[1].viewId === scope.viewId)?.[1];
  assert.ok(newLeaseId && scenario.leases.has(newLeaseId));
  const pendingClose = canvas.onClose(context);
  assert.equal((await call("mobile_device_list")).resultType, "failure");
  releaseHeldOpen();
  await assert.rejects(pendingReopen, { code: "view_closed" });
  await pendingClose;
  assert.equal(scenario.leases.has(newLeaseId), false);
  assert.equal((await call("mobile_device_list")).resultType, "failure");
  assert.ok((await peer.invokeAction("get_device_catalog", {})).runtimes);
  await canvas.open(context);
  assert.equal((await call("mobile_device_list")).resultType, "success");
  assert.equal(posts().length, 2);

  const changedSms = { ...sms, body: "SDK incarnation refusal" };
  scenario.beforeOperationRead = async () => {
    scenario.beforeOperationRead = undefined;
    throw new Error("Synthetic SDK accepted operation GET failed again");
  };
  assert.equal((await call("mobile_device_sms_send", changedSms)).resultType, "failure");
  const changedId = [...scenario.operations.keys()].at(-1);
  assert.equal(posts().length, 3);
  await canvas.onClose(context);
  const originalRef = scenario.connectionRef;
  scenario.connectionRef = { ...originalRef, pid: originalRef.pid + 1 };
  try {
    await canvas.open(context);
    const refused = await call("mobile_device_sms_send", changedSms);
    assert.equal(refused.resultType, "failure");
    assert.match(refused.error, /runtime_incarnation_changed/);
    assert.equal(posts().length, 3);
    assert.equal([...scenario.operations.keys()].at(-1), changedId);
  } finally {
    scenario.connectionRef = originalRef;
  }
  await sdkTools.closing(scope);
  assert.ok((await host.invokeAction("get_device_catalog", {})).runtimes);
  assert.ok((await peer.invokeAction("get_device_catalog", {})).runtimes);
});

test("normal unmodified plugin MCP entry registers no unbound Ailoha tools", async () => {
  const child = spawn(process.execPath, [join(root, "scripts/mcp.mjs")], {
    cwd: root, env: { ...process.env, MOBILE_CANVAS_BACKEND: "ailoha" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const replies = [];
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    let newline;
    while ((newline = output.indexOf("\n")) !== -1) {
      replies.push(JSON.parse(output.slice(0, newline)));
      output = output.slice(newline + 1);
    }
  });
  try {
    for (const [id, method, params] of [
      [1, "initialize", { protocolVersion: "2025-06-18" }],
      [2, "tools/list", {}],
      [3, "tools/call", { name: descriptor.name, arguments: input("one") }],
    ]) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const deadline = Date.now() + 5000;
    while (replies.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(replies.length, 3);
    assert.match(replies[0].result.instructions, /SDK extension/);
    assert.deepEqual(replies[1].result.tools, []);
    assert.equal(replies[2].error.code, -32601);
  } finally {
    child.stdin.end();
    await once(child, "exit");
  }
  const partial = spawnSync(process.execPath, [join(root, "scripts/mcp.mjs"), "--session", "untrusted"], {
    cwd: root, env: { ...process.env, MOBILE_CANVAS_BACKEND: "ailoha" },
    encoding: "utf8",
  });
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /named_context_required/);
});
