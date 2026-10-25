import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
import { createNativeBindingFixture, nativeAgent } from "./fixtures/ailoha-native-binding.mjs";

const { createAilohaMcpDispatcher, ailohaMcpCatalog, ailohaAppMcpCatalog } = await import(productModule("lib/ailoha/mcp-host.mjs"));
const appNames = ["mobile_app_tree", "mobile_app_query", "mobile_app_status"];
const call = (name, args = {}, extra = {}) => ({
  jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, ...extra },
});
const errorCode = (response) => {
  assert.equal(response.result.isError, true);
  return JSON.parse(response.result.content[0].text).code;
};
async function bind(view, runtimeInstanceId) {
  const current = await view.controller.request("GET");
  const selected = await view.request({ operation: "bind", bindingToken: current.binding.token,
    agentId: `agent-${runtimeInstanceId}`, runtimeInstanceId });
  assert.equal(selected.error, null);
}
async function dispatcherFor(t, view) {
  const deviceCalls = [];
  const factories = [];
  const binding = { scope: view.scope, contextRef: view.context.contextRef,
    scopeEpoch: view.context.scopeEpoch, ownerProcessId: view.context.owner.processId };
  const dispatcher = await createAilohaMcpDispatcher({
    binding, version: "synthetic-only",
    createSemanticInspection(options) {
      assert.deepEqual(options, binding);
      factories.push(options);
      return view.createInspection();
    },
    async createBackend() {
      deviceCalls.push("acquire");
      return {
        async invokeAction(name) { deviceCalls.push(name); return { hasSelection: true }; },
        async dispose() {},
      };
    },
    onEvent() { throw new Error("Read-only App tools must not emit device automation."); },
  });
  t.after(() => dispatcher.dispose());
  return { dispatcher, deviceCalls, factories, binding };
}

test("App descriptors are pure bootstrap data and need no view authority or runtime", () => {
  const first = ailohaAppMcpCatalog();
  assert.deepEqual(first.map((tool) => tool.name), appNames);
  first[0].inputSchema.properties.route = { type: "string" };
  assert.equal(Object.hasOwn(ailohaAppMcpCatalog()[0].inputSchema.properties, "route"), false);
  assert.equal(first.every((tool) => tool.execution.taskSupport === "forbidden"), true);
});

test("named Ailoha MCP appends three readonly tools without changing the legacy61 catalog or baseline", async (t) => {
  const fixture = createNativeBindingFixture();
  const view = await fixture.createView();
  const { dispatcher } = await dispatcherFor(t, view);
  const baseline = JSON.parse(readFileSync(new URL("./ailoha-compatibility-baseline.json", import.meta.url), "utf8"));
  const base = await ailohaMcpCatalog({ boundScope: view.scope });
  assert.deepEqual(ailohaAppMcpCatalog().map((tool) => tool.name), appNames);
  assert.equal(base.length, 61);
  assert.deepEqual(base.map((tool) => tool.name).sort(), baseline.mcpTools);
  const listed = await dispatcher.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(listed.result.tools.length, 64);
  assert.deepEqual(listed.result.tools.slice(0, 61), base);
  assert.deepEqual(listed.result.tools.slice(61).map((tool) => tool.name), appNames);
  assert.deepEqual(listed.result.tools.slice(61), ailohaAppMcpCatalog());
  for (const tool of listed.result.tools.slice(61)) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.execution.taskSupport, "forbidden");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema.additionalProperties, false);
  }
  const initialized = await dispatcher.handle({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} });
  assert.match(initialized.result.instructions, /61 mobile_device_/);
  assert.match(initialized.result.instructions, /mobile_app_tree.*require-agent/);
  assert.match(initialized.result.instructions, /never fall back/);
  assert.equal(errorCode(await dispatcher.handle(call("mobile_app_bind", {}))), "unknown_tool");
});

test("absent App binding fails all reads without acquiring a device backend; device61 remain callable", async (t) => {
  const fixture = createNativeBindingFixture();
  const view = await fixture.createView();
  const { dispatcher, deviceCalls } = await dispatcherFor(t, view);
  for (const name of appNames) {
    assert.equal(errorCode(await dispatcher.handle(call(name, name === "mobile_app_query" ? { text: "OK" } : {}))),
      "semantic_app_unavailable");
  }
  assert.deepEqual(deviceCalls, []);
  assert.deepEqual(view.toolCalls, []);
  assert.equal((await dispatcher.handle(call("mobile_device_get_selected"))).result.structuredContent.hasSelection, true);
  assert.deepEqual(deviceCalls, ["acquire", "get_selected_device"]);
});

test("App MCP reads use exactly the UI-selected native instance and canonical require-agent provenance", async (t) => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("first"), nativeAgent("chosen")] });
  const view = await fixture.createView();
  const { dispatcher, deviceCalls } = await dispatcherFor(t, view);
  await bind(view, "chosen");
  const before = structuredClone(view.context);
  for (const [name, args, operation] of [
    ["mobile_app_tree", { maxDepth: 4 }, "tree"],
    ["mobile_app_query", { text: "OK", automationId: "submit", type: "Button" }, "query"],
    ["mobile_app_status", {}, "status"],
  ]) {
    const response = await dispatcher.handle(call(name, args));
    assert.notEqual(response.result.isError, true);
    const output = response.result.structuredContent;
    assert.equal(output.schema, "mobile-canvas.app-inspection/v1");
    assert.equal(output.operation, operation);
    assert.deepEqual(output.scope, view.scope);
    assert.equal(output.selection.runtimeInstanceId, "chosen");
    assert.equal(output.result.route.runtimeInstanceId, "chosen");
    assert.equal(output.result.route.agentId, "agent-chosen");
    assert.equal(output.result.route.owner, "agent");
    assert.equal(output.result.route.executionContext.contextRef, view.context.contextRef);
    assert.equal(output.result.provenance.runtimeInstanceEvidence, "verified-native-instance");
    assert.deepEqual(JSON.parse(response.result.content[0].text), output);
    assert.equal(Object.hasOwn(output, "binding"), false);
  }
  assert.deepEqual(view.toolCalls.map((request) => request.arguments.route), ["require-agent", "require-agent", "require-agent"]);
  assert.deepEqual(view.context, before);
  assert.deepEqual(deviceCalls, []);
});

test("App read arguments cannot replace scope, context, owner, target, agent, route or endpoints", async (t) => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("chosen")] });
  const view = await fixture.createView();
  const { dispatcher, factories, deviceCalls } = await dispatcherFor(t, view);
  for (const name of appNames) {
    for (const key of ["sessionId", "instanceId", "viewId", "scope", "contextRef", "scopeEpoch", "ownerProcessId",
      "targetHostId", "targetId", "deviceId", "surfaceId", "agentId", "runtimeInstanceId", "applicationId",
      "agentPort", "port", "endpoint", "route", "lens", "operation"]) {
      const args = { ...(name === "mobile_app_query" ? { text: "OK" } : {}), [key]: "cannot-inject" };
      assert.equal(errorCode(await dispatcher.handle(call(name, args))), "invalid_request");
    }
    assert.equal(errorCode(await dispatcher.handle(call(name, {}, { task: { ttl: 1000 } }))), "mcp_tasks_unsupported");
  }
  assert.deepEqual(factories, []);
  assert.deepEqual(deviceCalls, []);
});

test("App reads retain view isolation and reject stale/disconnected instances without System fallback", async (t) => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("one", "one"), nativeAgent("two", "two")] });
  const one = await fixture.createView("one", "one");
  const two = await fixture.createView("two", "two");
  const first = await dispatcherFor(t, one);
  const second = await dispatcherFor(t, two);
  await bind(one, "one");
  assert.equal(errorCode(await second.dispatcher.handle(call("mobile_app_status"))), "semantic_app_unavailable");
  await bind(two, "two");
  assert.equal((await first.dispatcher.handle(call("mobile_app_status"))).result.structuredContent.selection.runtimeInstanceId, "one");
  assert.equal((await second.dispatcher.handle(call("mobile_app_status"))).result.structuredContent.selection.runtimeInstanceId, "two");
  fixture.model.registrations = [nativeAgent("replacement", "one"), nativeAgent("two", "two")];
  assert.equal(errorCode(await first.dispatcher.handle(call("mobile_app_tree"))), "AgentNotFound");
  assert.equal((await second.dispatcher.handle(call("mobile_app_status"))).result.structuredContent.selection.runtimeInstanceId, "two");
  fixture.model.beforeTool = () => { two.context.revision = String(BigInt(two.context.revision) + 1n); };
  assert.equal(errorCode(await second.dispatcher.handle(call("mobile_app_tree"))), "semantic_context_superseded");
  assert.equal(one.toolCalls.every((request) => request.arguments.route === "require-agent"), true);
  assert.equal(two.toolCalls.every((request) => request.arguments.route === "require-agent"), true);
  assert.deepEqual(first.deviceCalls, []);
  assert.deepEqual(second.deviceCalls, []);
});

test("the shared semantic validator bounds App MCP output and rejects wrong-owner results", async (t) => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("chosen")] });
  const view = await fixture.createView();
  const { dispatcher, deviceCalls } = await dispatcherFor(t, view);
  await bind(view, "chosen");
  for (const args of [{ maxDepth: 0 }, { maxDepth: 17 }, { maxDepth: 1.5 }]) {
    assert.equal(errorCode(await dispatcher.handle(call("mobile_app_tree", args))), "invalid_request");
  }
  assert.equal(errorCode(await dispatcher.handle(call("mobile_app_query", { text: "x".repeat(129) }))), "semantic_invalid_request");
  assert.equal(errorCode(await dispatcher.handle(call("mobile_app_query"))), "semantic_invalid_request");
  fixture.model.mutateTool = (output) => ({ ...output, capabilities: "x".repeat(1024 * 1024) });
  assert.equal(errorCode(await dispatcher.handle(call("mobile_app_status"))), "semantic_invalid_response");
  fixture.model.mutateTool = (output) => ({ ...output, route: { ...output.route, runtimeInstanceId: "different" } });
  assert.equal(errorCode(await dispatcher.handle(call("mobile_app_tree"))), "semantic_route_mismatch");
  fixture.model.mutateTool = (output) => ({ ...output, elements: Array.from({ length: 301 }, (_, index) => ({
    id: String(index), type: "Button", text: "x".repeat(1000),
  })) });
  const bounded = (await dispatcher.handle(call("mobile_app_tree"))).result.structuredContent.result;
  assert.equal(bounded.elements.length, 300);
  assert.equal(bounded.elements[0].text.length, 512);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(deviceCalls, []);
});

test("cancellation and MCP disposal retire App reads without affecting a live peer", async (t) => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("chosen")] });
  const view = await fixture.createView();
  const { dispatcher, deviceCalls } = await dispatcherFor(t, view);
  await bind(view, "chosen");
  let started;
  let entered = new Promise((resolve) => { started = resolve; });
  fixture.model.beforeTool = (request) => request.arguments.text === "wait"
    ? new Promise((resolve) => { started(); request.signal.addEventListener("abort", resolve, { once: true }); }) : undefined;
  const caller = new AbortController();
  const pending = dispatcher.handle(call("mobile_app_query", { text: "wait" }), { signal: caller.signal });
  await entered;
  assert.notEqual((await dispatcher.handle(call("mobile_app_status"))).result.isError, true);
  caller.abort();
  assert.equal(errorCode(await pending), "cancelled");
  entered = new Promise((resolve) => { started = resolve; });
  const retiring = dispatcher.handle(call("mobile_app_query", { text: "wait" }));
  await entered;
  await dispatcher.dispose();
  assert.equal(errorCode(await retiring), "mcp_closed");
  assert.deepEqual(deviceCalls, []);
});
