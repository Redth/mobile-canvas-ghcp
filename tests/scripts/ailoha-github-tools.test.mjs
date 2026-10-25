import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAilohaGithubTools } from "../../lib/ailoha/github-tools.mjs";
import { withAilohaCanvas } from "../../lib/ailoha/github-adapter.mjs";

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
  tools.opened(selected);
  release();
  assert.equal((await old).resultType, "failure");
  await closing;
  assert.equal((await tools.tools[0].handler(input("same"), invocation("session"))).resultType, "success");
  assert.deepEqual(dispatched, [2]);
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
  await canvas.onClose(context);
  finishOpen();
  await assert.rejects(pending, { code: "view_closed" });
  assert.deepEqual(registered, []);
});

test("canvas close retires its host before SDK lookup settles and a same-instance reopen owns a fresh host", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const closed = [];
  let created = 0;
  let reads = 0;
  const tools = createAilohaGithubTools({
    descriptors: [descriptor],
    async getBinding() {
      if (++reads === 1) await gate;
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
        async openCanvas() { return { title: "Mobile", url: `http://127.0.0.1/${owner}` }; },
        async closeCanvas() { closed.push(owner); },
      };
    },
    onHostOpened: (selected) => tools.opened(selected),
    onHostClosing: (selected) => tools.closing(selected),
  });
  const context = { sessionId: "session", instanceId: "view" };
  assert.equal((await canvas.open(context)).url, "http://127.0.0.1/1");
  const pending = tools.tools[0].handler(input("view"), invocation("session"));
  const closing = canvas.onClose(context);
  assert.equal((await canvas.open(context)).url, "http://127.0.0.1/2");
  release();
  assert.equal((await pending).resultType, "failure");
  await closing;
  assert.deepEqual(closed, [1]);
  const fresh = await tools.tools[0].handler(input("view"), invocation("session"));
  assert.equal(fresh.textResultForLlm, "2");
  assert.equal(fresh.resultType, "success");
  await canvas.onClose(context);
  assert.deepEqual(closed, [1, 2]);
  await tools.closeAll();
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
