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

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("a closed MCP owner cannot dispatch when shared backend acquisition completes", async () => {
  const entered = deferred();
  const release = deferred();
  let dispatched = 0;
  let disposed = 0;
  const dispatcher = await createAilohaMcpDispatcher({
    binding, version: "test",
    async createBackend() {
      entered.resolve();
      await release.promise;
      return {
        async invokeAction() { dispatched += 1; return { success: true }; },
        async dispose() { disposed += 1; },
      };
    },
  });
  const pending = dispatcher.handle(call("mobile_device_boot", { deviceId: "original-target" }));
  await entered.promise;
  const closing = dispatcher.dispose();
  release.resolve();
  const [response] = await Promise.all([pending, closing]);
  assert.equal(dispatched, 0);
  assert.equal(disposed, 1);
  assert.equal(response.id, 1);
  assert.equal(response.result.isError, true);
  assert.equal(JSON.parse(response.result.content[0].text).code, "mcp_closed");
});

test("a previously cancelled MCP caller does not acquire the shared backend", async () => {
  const caller = new AbortController();
  caller.abort();
  let acquired = 0;
  const dispatcher = await createAilohaMcpDispatcher({
    binding, version: "test",
    async createBackend() {
      acquired += 1;
      return { async invokeAction() { return { success: true }; }, async dispose() {} };
    },
  });
  try {
    const response = await dispatcher.handle(call("mobile_device_boot", { deviceId: "original-target" }),
      { signal: caller.signal });
    assert.equal(acquired, 0);
    assert.equal(response.result.isError, true);
    assert.equal(JSON.parse(response.result.content[0].text).code, "cancelled");
  } finally {
    await dispatcher.dispose();
  }
});

for (const [name, original, replace] of [
  ["mobile_device_boot", { deviceId: "original-target" },
    (input) => { input.deviceId = "replacement-target"; }],
  ["mobile_device_file_mkdir", { deviceId: "original-target", path: "/original" },
    (input) => { input.deviceId = "replacement-target"; input.path = "/replacement"; }],
  ["mobile_device_media_add", { deviceId: "original-target", paths: ["/owned/original.png"] },
    (input) => { input.deviceId = "replacement-target"; input.paths[0] = "/owned/replacement.png"; }],
]) {
  test(`parent: ${name} keeps the original JSON arguments across backend acquisition`, async (t) => {
    const entered = deferred();
    const release = deferred();
    const input = structuredClone(original);
    let received;
    const invoke = async (_name, args) => {
      received = structuredClone(args);
      return { success: true, deviceId: args.deviceId };
    };
    const dispatcher = await createAilohaMcpDispatcher({
      binding, version: "test",
      async createBackend() {
        entered.resolve();
        await release.promise;
        return { invokeAction: invoke, guardedFile: invoke, stageArtifact: invoke, async dispose() {} };
      },
    });
    t.after(() => dispatcher.dispose());
    const pending = dispatcher.handle(call(name, input));
    await entered.promise;
    replace(input);
    release.resolve();

    const result = await pending;

    assert.notEqual(result.result.isError, true);
    assert.deepEqual(received, original);
  });
}

test("parent: MCP response keeps its original request ID across backend acquisition", async (t) => {
  const entered = deferred();
  const release = deferred();
  const dispatcher = await createAilohaMcpDispatcher({
    binding, version: "test",
    async createBackend() {
      entered.resolve();
      await release.promise;
      return { async invokeAction() { return { success: true }; }, async dispose() {} };
    },
  });
  t.after(() => dispatcher.dispose());
  const request = call("mobile_device_boot", { deviceId: "original-target" });
  const pending = dispatcher.handle(request);
  await entered.promise;
  request.id = 99;
  release.resolve();

  assert.equal((await pending).id, 1);
});

test("parent: MCP trusted named binding is captured before a caller can replace it", async (t) => {
  const supplied = structuredClone(binding);
  let received;
  const dispatcher = await createAilohaMcpDispatcher({
    binding: supplied, version: "test",
    async createBackend(options) {
      received = {
        contextRef: options.contextRef, scopeEpoch: options.scopeEpoch,
        ownerProcessId: options.ownerProcessId, scope: structuredClone(options.scope),
      };
      return { async invokeAction() { return { success: true }; }, async dispose() {} };
    },
  });
  t.after(() => dispatcher.dispose());
  supplied.contextRef = "replacement-context";
  supplied.scope.viewId = "replacement-view";

  await dispatcher.handle(call("mobile_device_boot", { deviceId: "original-target" }));

  assert.deepEqual(received, binding);
});

test("parent: cancelled MCP caller cannot dispatch after shared backend acquisition completes", async (t) => {
  const entered = deferred();
  const release = deferred();
  const caller = new AbortController();
  let dispatched = 0;
  const dispatcher = await createAilohaMcpDispatcher({
    binding, version: "test",
    async createBackend() {
      entered.resolve();
      await release.promise;
      return {
        async invokeAction() { dispatched++; return { success: true }; },
        async dispose() {},
      };
    },
  });
  t.after(() => dispatcher.dispose());
  const pending = dispatcher.handle(call("mobile_device_boot", { deviceId: "original-target" }),
    { signal: caller.signal });
  await entered.promise;
  caller.abort();
  release.resolve();

  const result = await pending;

  assert.equal(dispatched, 0);
  assert.equal(result.result.isError, true);
});

test("a cancelled MCP caller does not abort a live peer sharing backend acquisition", async (t) => {
  const entered = deferred();
  const release = deferred();
  const caller = new AbortController();
  const dispatched = [];
  const dispatcher = await createAilohaMcpDispatcher({
    binding, version: "test",
    async createBackend() {
      entered.resolve();
      await release.promise;
      return {
        async invokeAction(_name, args) {
          dispatched.push(args.deviceId);
          return { success: true, deviceId: args.deviceId };
        },
        async dispose() {},
      };
    },
  });
  t.after(() => dispatcher.dispose());
  const cancelled = dispatcher.handle(call("mobile_device_boot", { deviceId: "cancelled-target" }),
    { signal: caller.signal });
  await entered.promise;
  const live = dispatcher.handle(call("mobile_device_boot", { deviceId: "live-target" }));
  caller.abort();
  release.resolve();

  assert.equal((await cancelled).result.isError, true);
  assert.equal(JSON.parse((await cancelled).result.content[0].text).code, "cancelled");
  assert.equal((await live).result.structuredContent.deviceId, "live-target");
  assert.deepEqual(dispatched, ["live-target"]);
});

test("MCP preserves all61 installed identities and advertises broader opt-in limitations", async () => {
  const catalog = await ailohaMcpCatalog({ boundScope: binding.scope });
  const baseline = JSON.parse(readFileSync(new URL("./ailoha-compatibility-baseline.json", import.meta.url), "utf8"));
  assert.deepEqual(catalog.map((tool) => tool.name).sort(), baseline.mcpTools);
  assert.equal(catalog.length, 61);
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
  assert.match(catalog.find((tool) => tool.name === "mobile_device_reveal").description, /capability evidence is required/);
  for (const name of ["mobile_device_ui_dump", "mobile_device_ui_find", "mobile_device_ui_tap"]) {
    assert.match(catalog.find((tool) => tool.name === name).description, /compatible published runtime/);
  }
  assert.equal(catalog.find((tool) => tool.name === "mobile_device_app_launch").description.includes("bound view/Target Host"), true);
  assert.equal(catalog.find((tool) => tool.name === "mobile_device_app_install").description.includes("explicitly unsupported"), true);
  assert.equal(catalog.find((tool) => tool.name === "mobile_device_recording_start").description.includes("positively unsupported"), false);
  assert.equal(catalog.find((tool) => tool.name === "mobile_device_recording_status").description.includes("positively unsupported"), false);
  assert.equal(catalog.find((tool) => tool.name === "mobile_device_recording_stop").description.includes("positively unsupported"), false);
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
        async reveal(deviceId, options) {
          calls.push({ name: "reveal", deviceId, options });
          return { id: deviceId, platform: "ios", nativeId: "owned-native-id" };
        },
        async invokeAction(name, input, options) {
          calls.push({ name, input, options });
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
    assert.deepEqual(calls.at(-1).name, action);
    assert.deepEqual(calls.at(-1).input, input);
  }
  for (const [tool, input, expected] of [
    ["mobile_device_press_key", { deviceId: "opaque-target", keyCode: 40 }, "press_key"],
    ["mobile_device_press_button", { deviceId: "opaque-target", button: "home" }, "press_button"],
    ["mobile_device_type_text", { deviceId: "opaque-target", text: "literal \u2603" }, "type_text"],
    ["mobile_device_rotate", { deviceId: "opaque-target", orientation: "portrait" }, "rotate_device"],
    ["mobile_device_presentation_get", { deviceId: "opaque-target" }, "presentation_get"],
    ["mobile_device_presentation_set", { deviceId: "opaque-target", enabled: true }, "presentation_set"],
  ]) {
    const result = await dispatcher.handle(call(tool, input));
    assert.equal(result.result.structuredContent.operation, expected);
    assert.deepEqual(calls.at(-1), { name: expected, input, options: { signal: undefined } });
  }
  const screenshot = await dispatcher.handle(call("mobile_device_screenshot", { deviceId: "opaque-target" }));
  assert.equal(screenshot.result.content[1].type, "image");
  assert.equal(screenshot.result.content[1].mimeType, "image/png");
  const revealed = await dispatcher.handle(call("mobile_device_reveal", { deviceId: "opaque-target" }));
  assert.equal(revealed.result.structuredContent.id, "opaque-target");
  assert.equal(calls.at(-1).name, "reveal");
  assert.deepEqual(calls.at(-1).options, { selectRevealed: false });
  const launched = await dispatcher.handle(call("mobile_device_app_launch", {
    deviceId: "opaque-target", bundleId: "com.example.fixture", relaunch: true,
  }));
  assert.equal(launched.result.structuredContent.operation, "launch_app");
  assert.deepEqual(calls.at(-1).input, {
    deviceId: "opaque-target", bundleId: "com.example.fixture", relaunch: true,
  });
  const caller = new AbortController();
  const uninstall = await dispatcher.handle(call("mobile_device_app_uninstall", {
    deviceId: "opaque-target", bundleId: "com.example.fixture", confirm: true,
  }), { signal: caller.signal });
  assert.equal(uninstall.result.structuredContent.operation, "uninstall_app");
  assert.deepEqual(calls.at(-1).input, {
    deviceId: "opaque-target", bundleId: "com.example.fixture", confirm: true,
  });
  assert.equal(calls.at(-1).options.signal, caller.signal);
  const setter = await dispatcher.handle(call("mobile_device_app_op_set", {
    deviceId: "opaque-target", bundleId: "com.example.fixture",
    operation: "SYSTEM_ALERT_WINDOW", mode: "ignore",
  }), { signal: caller.signal });
  assert.equal(setter.result.structuredContent.operation, "set_app_op");
  assert.deepEqual(calls.at(-1).input, {
    deviceId: "opaque-target", bundleId: "com.example.fixture",
    operation: "SYSTEM_ALERT_WINDOW", mode: "ignore",
  });
  assert.equal(calls.at(-1).options.signal, caller.signal);
  for (const [tool, action] of [
    ["mobile_device_recording_start", "start_recording"],
    ["mobile_device_recording_status", "get_recording_status"],
    ["mobile_device_recording_stop", "stop_recording"],
  ]) {
    const result = await dispatcher.handle(call(tool, { deviceId: "opaque-target" }));
    assert.equal(result.result.structuredContent.operation, action);
  }
});

test("recording MCP arguments retain the original selector and options while backend initialization waits", async (t) => {
  let ready;
  const pending = new Promise((resolve) => { ready = resolve; });
  let submitted;
  const dispatcher = await createAilohaMcpDispatcher({
    binding, version: "test",
    createBackend: () => pending,
  });
  t.after(() => dispatcher.dispose());
  const input = { deviceId: "original-target", timeoutSeconds: 180, outputPath: "/owned/original.mp4" };
  const response = dispatcher.handle(call("mobile_device_recording_start", input));
  input.deviceId = "replacement-target";
  input.timeoutSeconds = 1;
  input.outputPath = "/owned/replacement.mp4";
  ready({
    async invokeAction(action, args) {
      assert.equal(action, "start_recording");
      submitted = args;
      return { deviceId: args.deviceId, isRecording: true, outputPath: args.outputPath, timeoutSeconds: args.timeoutSeconds };
    },
    async dispose() {},
  });
  const result = await response;
  assert.equal(result.result.isError, undefined);
  assert.deepEqual(submitted, {
    deviceId: "original-target", timeoutSeconds: 180, outputPath: "/owned/original.mp4",
  });
});

test("unsupported/invalid/cross-scope calls are positive failures before any runtime resolution", async (t) => {
  let backendCalls = 0;
  const dispatcher = await createAilohaMcpDispatcher({
    binding, version: "test", createBackend() { backendCalls += 1; throw new Error("do not reach"); },
  });
  t.after(() => dispatcher.dispose());
  for (const request of [
    call("mobile_device_app_launch", { deviceId: "target" }),
    call("mobile_device_tap", { deviceId: "target", x: "bad", y: 1 }),
    call("mobile_device_select", { deviceId: "target", sessionId: "other" }),
    call("mobile_device_battery_set", { deviceId: "target", level: 80 }),
    call("mobile_device_network_set", { deviceId: "target", profile: "lte" }),
    call("mobile_device_location_set", { deviceId: "target", latitude: 1, longitude: 2 }),
    call("mobile_device_clipboard_set", { deviceId: "target", text: "hello" }),
    call("mobile_device_permission_list", { deviceId: "target", bundleId: "com.example.app" }),
    call("mobile_device_recording_start", { deviceId: "target", timeoutSeconds: 0 }),
    call("mobile_device_recording_start", { deviceId: "target", outputPath: "relative.mp4" }),
  ]) {
    const result = await dispatcher.handle(request);
    assert.equal(result.result.isError, true);
  }
  assert.equal(backendCalls, 0);
});

test("actual bound MCP dispatch preserves all three native System UI identities and legacy outputs", async (t) => {
  const calls = [];
  const dispatcher = await createAilohaMcpDispatcher({
    binding, version: "test",
    async createBackend() {
      return {
        async invokeAction(name, input) {
          calls.push([name, input]);
          if (name === "ui_dump") return { schemaVersion: "1.0", deviceId: input.deviceId,
            platform: "ios", root: null, elementCount: 0, raw: "native" };
          if (name === "ui_find") return { schemaVersion: "1.0", deviceId: input.deviceId,
            matches: [], total: 0 };
          return { schemaVersion: "1.0", deviceId: input.deviceId, success: true, match: null, total: 1 };
        },
        async dispose() {},
      };
    },
  });
  t.after(() => dispatcher.dispose());
  const dump = await dispatcher.handle(call("mobile_device_ui_dump", { deviceId: "target", includeRaw: true }));
  const find = await dispatcher.handle(call("mobile_device_ui_find", { deviceId: "target", text: "Save", limit: 2 }));
  const tap = await dispatcher.handle(call("mobile_device_ui_tap", { deviceId: "target", text: "Save" }));
  assert.equal(dump.result.structuredContent.raw, "native");
  assert.equal(find.result.structuredContent.total, 0);
  assert.equal(tap.result.structuredContent.success, true);
  assert.deepEqual(calls.map(([name]) => name), ["ui_dump", "ui_find", "ui_tap"]);
});

test("VS Code's bound MCP reveal follows the selected target while raw GitHub MCP does not", async (t) => {
  const calls = [];
  const dispatcher = await createAilohaMcpDispatcher({
    binding, version: "test", selectCreated: true,
    createBackend: async () => ({
      async reveal(deviceId, options) {
        calls.push([deviceId, options]);
        return { id: deviceId, platform: "ios", nativeId: "native" };
      },
      async dispose() {},
    }),
  });
  t.after(() => dispatcher.dispose());
  const reply = await dispatcher.handle(call("mobile_device_reveal", { deviceId: "opaque-target" }));
  assert.equal(reply.result.structuredContent.id, "opaque-target");
  assert.deepEqual(calls, [["opaque-target", { selectRevealed: true }]]);
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
  const recordingStatus = catalog.result.tools.find((tool) => tool.name === "mobile_device_recording_status");
  assert.equal(recordingStatus.annotations.readOnlyHint, false);
  assert.equal(recordingStatus.annotations.destructiveHint, false);
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

for (const params of [
  { protocolVersion: "2025-03-26", capabilities: { elicitation: {} } },
  { protocolVersion: "2025-11-25", capabilities: {} },
  { protocolVersion: "2025-11-25", capabilities: { elicitation: { url: {} } } },
]) {
  test(`MCP cannot treat confirm=true as consent without supported form elicitation: ${JSON.stringify(params)}`, async (t) => {
    let runtimeCalls = 0;
    const dispatcher = await createAilohaMcpDispatcher({
      binding, version: "test",
      createBackend() { runtimeCalls += 1; throw new Error("No runtime should be acquired."); },
      requestElicitation() { throw new Error("No unsupported host prompt should be requested."); },
    });
    t.after(() => dispatcher.dispose());
    await dispatcher.handle(message("initialize", params));
    const result = await dispatcher.handle(call("mobile_device_delete", { deviceId: "opaque", confirm: true }));
    assert.equal(result.result.isError, true);
    assert.equal(JSON.parse(result.result.content[0].text).code, "consent_not_supported");
    assert.equal(runtimeCalls, 0);
  });
}

test("guarded pull, mkdir and delete retain installed MCP schemas and scoped consent", async (t) => {
  let backendCalls = 0;
  const dispatcher = await createAilohaMcpDispatcher({
    binding, version: "test", createBackend() {
      backendCalls += 1;
      return {
        async readArtifact(name, input) {
          return { schemaVersion: "1.0", deviceId: input.deviceId, operation: name };
        },
        async stageArtifact(name, input) {
          return { schemaVersion: "1.0", deviceId: input.deviceId, operation: name };
        },
        async guardedFile(name, input) {
          return { schemaVersion: "1.0", deviceId: input.deviceId, operation: name };
        },
        async dispose() {},
      };
    },
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
    const readable = ["mobile_device_file_list", "mobile_device_log", "mobile_device_crashes",
      "mobile_device_crash_report", "mobile_device_media_add", "mobile_device_file_mkdir"].includes(name);
    const gated = false;
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool);
    assert.equal(tool.description.includes(ARTIFACT_FEATURE_GATES[name]), gated);
    assert.deepEqual(tool.inputSchema, original.find((entry) => entry.name === name).inputSchema);
    assert.deepEqual(tool.outputSchema, original.find((entry) => entry.name === name).outputSchema);
    if (name === "mobile_device_file_pull") assert.equal(tool.annotations.destructiveHint, true);
    const result = await dispatcher.handle(call(name, input));
    assert.equal(result.result.isError === true, !readable, name);
    assert.deepEqual(JSON.parse(result.result.content[0].text), readable
      ? { schemaVersion: "1.0", deviceId: input.deviceId, operation: name }
      : ["mobile_device_file_push", "mobile_device_file_pull", "mobile_device_file_delete"].includes(name)
        ? {
          code: "consent_not_supported",
          message: "This MCP client cannot request genuine captured form approval; confirm=true is not authorization.",
          status: 501,
        }
        : { code: "artifact_contract_unavailable", message: ARTIFACT_FEATURE_GATES[name], status: 501 });
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
  assert.equal(backendCalls, 1);
});
