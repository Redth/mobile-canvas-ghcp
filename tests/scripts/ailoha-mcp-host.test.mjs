import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
const { ailohaMcpCatalog, createAilohaMcpDispatcher } = await import(productModule("lib/ailoha/mcp-host.mjs"));

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
  for (const name of ["hardware_get", "clipboard_get", "settings_get", "settings_set",
    "location_clear", "sms_send", "biometric", "notification_push"]) {
    assert.equal(catalog.find((tool) => tool.name === `mobile_device_${name}`)
      .description.includes("capability evidence is required"), true);
  }
  for (const name of ["battery_set", "network_set", "location_set", "clipboard_set",
    "call", "calls", "permission_list", "permission_set"]) {
    assert.equal(catalog.find((tool) => tool.name === `mobile_device_${name}`)
      .description.includes("positively unsupported"), true);
  }
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
  for (const [tool, action, input] of [
    ["mobile_device_hardware_get", "get_hardware", { deviceId: "opaque-target" }],
    ["mobile_device_clipboard_get", "get_clipboard", { deviceId: "opaque-target" }],
    ["mobile_device_settings_get", "get_settings", { deviceId: "opaque-target" }],
    ["mobile_device_settings_set", "set_settings", { deviceId: "opaque-target", appearance: "dark" }],
    ["mobile_device_location_clear", "clear_location", { deviceId: "opaque-target" }],
    ["mobile_device_sms_send", "send_sms", { deviceId: "opaque-target", from: "+123", body: "text" }],
    ["mobile_device_biometric", "send_biometric", { deviceId: "opaque-target", action: "nomatch" }],
    ["mobile_device_notification_push", "push_notification",
      { deviceId: "opaque-target", bundleId: "com.example.native", payload: '{"aps":{}}' }],
  ]) {
    const response = await dispatcher.handle(call(tool, input));
    assert.equal(response.result.structuredContent.operation, action);
    assert.deepEqual(calls.at(-1), { name: action, input });
  }
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
    call("mobile_device_battery_set", { deviceId: "target", level: 80 }),
    call("mobile_device_permission_list", { deviceId: "target", bundleId: "com.example.app" }),
  ]) {
    const result = await dispatcher.handle(request);
    assert.equal(result.result.isError, true);
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
