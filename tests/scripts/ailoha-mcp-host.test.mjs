import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
const { ailohaMcpCatalog, createAilohaMcpDispatcher } = await import(productModule("lib/ailoha/mcp-host.mjs"));
const { ARTIFACT_FEATURE_GATES } = await import(productModule("lib/ailoha/artifact-features.mjs"));

const binding = {
  contextRef: "ctx-opaque", scopeEpoch: "captured-epoch", ownerProcessId: 1234,
  scope: { sessionId: "unique-live-session", viewId: "unique-view" },
};
const message = (method, params) => ({ jsonrpc: "2.0", id: 1, method, params });
const call = (name, args) => message("tools/call", { name, arguments: args });

test("MCP preserves all61 installed identities and advertises broader opt-in limitations", async () => {
  const catalog = await ailohaMcpCatalog({ boundScope: binding.scope });
  const baseline = JSON.parse(readFileSync(new URL("./ailoha-compatibility-baseline.json", import.meta.url), "utf8"));
  assert.deepEqual(catalog.map((tool) => tool.name).sort(), baseline.mcpTools);
  assert.equal(catalog.length, 61);
  assert.equal(catalog.find((tool) => tool.name === "mobile_device_app_launch").description.includes("positively unsupported"), true);
  assert.equal(catalog.every((tool) => tool.execution.taskSupport === "forbidden"), true);
  assert.equal(catalog.find((tool) => tool.name === "mobile_device_tap").inputSchema.properties.geometryRevision.maximum, 0xffffffff);
  const selected = catalog.find((tool) => tool.name === "mobile_device_get_selected");
  assert.deepEqual(selected.outputSchema.properties.contextBinding.required, ["contextRef", "scopeEpoch", "revision", "ownerProcessId"]);
  assert.deepEqual(selected.outputSchema.properties.scope.required, ["sessionId", "viewId"]);
});

test("static plugin opt-in cannot invent a named context or choose the first view", async () => {
  await assert.rejects(createAilohaMcpDispatcher({ version: "test" }), { code: "named_context_required" });
});

test("actual dispatch uses the bound context with original tool meanings and captured input", async (t) => {
  const calls = [];
  const dispatcher = await createAilohaMcpDispatcher({
    binding, version: "0.1.18",
    createBackend: async (options) => {
      assert.equal(options.contextRef, binding.contextRef);
      assert.deepEqual(options.scope, binding.scope);
      assert.equal(options.ownerProcessId, binding.ownerProcessId);
      return {
        async invokeAction(name, input) {
          calls.push({ name, input });
          return { success: true, operation: name, deviceId: input.deviceId };
        },
        async screenshot(deviceId) {
          return { bytes: new Uint8Array([137, 80, 78, 71]), invocation: { targetId: deviceId } };
        },
        async dispose() { calls.push({ disposed: true }); },
      };
    },
  });
  t.after(() => dispatcher.dispose());
  const initial = await dispatcher.handle(message("initialize", { protocolVersion: "2025-03-26" }));
  assert.equal(initial.result.serverInfo.name, "mobile-canvas");
  assert.equal(initial.result.serverInfo.version, "0.1.18");
  const tapped = await dispatcher.handle(call("mobile_device_tap", {
    deviceId: "opaque-target", x: 10, y: 20, geometryRevision: 13, coordinate: "window", surfaceId: "opaque-surface",
  }));
  assert.equal(tapped.result.structuredContent.operation, "tap_device");
  assert.equal(calls[0].input.geometryRevision, 13);
  const screenshot = await dispatcher.handle(call("mobile_device_screenshot", { deviceId: "opaque-target" }));
  assert.equal(screenshot.result.content[1].type, "image");
  assert.equal(screenshot.result.content[1].mimeType, "image/png");
});

test("unsupported/invalid/cross-scope calls are positive failures before any runtime resolution", async (t) => {
  let backendCalls = 0;
  const dispatcher = await createAilohaMcpDispatcher({
    binding, version: "test", createBackend() { backendCalls += 1; throw new Error("do not reach"); },
  });
  t.after(() => dispatcher.dispose());
  for (const request of [
    call("mobile_device_app_launch", { deviceId: "target", bundleId: "app" }),
    call("mobile_device_tap", { deviceId: "target", x: "bad", y: 1 }),
    call("mobile_device_select", { deviceId: "target", sessionId: "other" }),
  ]) {
    const result = await dispatcher.handle(request);
    assert.equal(result.result.isError, true);
  }
  assert.equal(backendCalls, 0);
});

test("all nine installed file, media and diagnostics identities retain schemas but fail before native dispatch", async (t) => {
  let backendCalls = 0;
  const dispatcher = await createAilohaMcpDispatcher({
    binding, version: "test", createBackend() { backendCalls += 1; throw new Error("do not reach"); },
  });
  t.after(() => dispatcher.dispose());
  const tools = (await dispatcher.handle(message("tools/list"))).result.tools;
  const original = JSON.parse(readFileSync(new URL("../../lib/ailoha/mcp-catalog.json", import.meta.url), "utf8")).tools;
  const inputs = {
    mobile_device_file_list: { deviceId: "target", bundleId: "com.example.app", path: "Documents" },
    mobile_device_file_pull: { deviceId: "target", path: "empty.txt", output: "/owned/output" },
    mobile_device_file_push: { deviceId: "target", input: "/owned/empty.txt", path: "empty.txt" },
    mobile_device_file_delete: { deviceId: "target", path: "/directory", recursive: false },
    mobile_device_file_mkdir: { deviceId: "target", path: "Documents", bundleId: "com.example.app" },
    mobile_device_media_add: { deviceId: "target", paths: ["/owned/photo.png"] },
    mobile_device_log: { deviceId: "target", text: "fault", seconds: 300, limit: 10 },
    mobile_device_crashes: { deviceId: "target", text: "example", limit: 10 },
    mobile_device_crash_report: { deviceId: "target", crashId: "report-id" },
  };
  for (const [name, input] of Object.entries(inputs)) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool);
    assert.equal(tool.description.includes(ARTIFACT_FEATURE_GATES[name]), true);
    assert.deepEqual(tool.inputSchema, original.find((entry) => entry.name === name).inputSchema);
    assert.deepEqual(tool.outputSchema, original.find((entry) => entry.name === name).outputSchema);
    const result = await dispatcher.handle(call(name, input));
    assert.equal(result.result.isError, true, name);
    assert.deepEqual(JSON.parse(result.result.content[0].text), {
      code: "artifact_contract_unavailable", message: ARTIFACT_FEATURE_GATES[name], status: 501,
    });
  }
  for (const [name, input] of [
    ["mobile_device_media_add", { deviceId: "target", paths: ["/owned/photo.png", null] }],
    ["mobile_device_file_pull", { deviceId: "target", path: "file" }],
    ["mobile_device_log", { deviceId: "target", limit: "100" }],
  ]) {
    const result = await dispatcher.handle(call(name, input));
    assert.equal(result.result.isError, true);
    assert.equal(JSON.parse(result.result.content[0].text).code, "invalid_request");
  }
  assert.equal(backendCalls, 0);
});

test("bound empty-context inventory retains the installed MCP list output envelope", async (t) => {
  const devices = [{ id: "opaque/target", nativeId: "real-native-id" }];
  const dispatcher = await createAilohaMcpDispatcher({
    binding, version: "test",
    async createBackend(options) {
      assert.deepEqual(options.scope, binding.scope);
      return {
        async invokeAction(action) {
          assert.equal(action, "list_devices");
          return devices;
        },
        async dispose() {},
      };
    },
  });
  t.after(() => dispatcher.dispose());
  const catalog = await dispatcher.handle(message("tools/list"));
  const schema = catalog.result.tools.find((tool) => tool.name === "mobile_device_list").outputSchema;
  assert.deepEqual(schema.required, ["result"]);
  const result = await dispatcher.handle(call("mobile_device_list", {}));
  assert.notEqual(result.result.isError, true);
  assert.deepEqual(result.result.structuredContent, { result: devices });
  assert.deepEqual(JSON.parse(result.result.content[0].text), result.result.structuredContent);
});

test("operational failure is sanitized and never triggers a legacy or second-owner invocation", async (t) => {
  let calls = 0;
  const dispatcher = await createAilohaMcpDispatcher({
    binding, version: "test",
    async createBackend() {
      return { async invokeAction() { calls += 1; throw new Error("private bearer secret"); }, async dispose() {} };
    },
  });
  t.after(() => dispatcher.dispose());
  const result = await dispatcher.handle(call("mobile_device_boot", { deviceId: "target" }));
  assert.equal(result.result.isError, true);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(calls, 1);
});
