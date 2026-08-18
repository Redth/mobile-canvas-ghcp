import assert from "node:assert/strict";
import test from "node:test";
import { McpVsCodeContextProxy } from "../../lib/mcp-vscode-proxy.mjs";

test("injects the VS Code context into selection tools", async () => {
  const selected = [];
  const proxy = new McpVsCodeContextProxy({
    sessionId: "vscode-session",
    instanceId: "device-view",
    selectDevice: async (deviceId) => selected.push(deviceId),
  });
  const message = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "mobile_device_select",
      arguments: { deviceId: "ios:phone" },
    },
  };

  const result = await proxy.clientMessage(message);

  assert.equal(result.params.arguments.sessionId, "vscode-session");
  assert.equal(result.params.arguments.instanceId, "device-view");
  assert.deepEqual(selected, []);
});

test("replaces an explicit context with the current VS Code view", async () => {
  const proxy = new McpVsCodeContextProxy({
    sessionId: "current-session",
    instanceId: "current-view",
    selectDevice: async () => {},
  });
  const message = {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "mobile_device_get_selected",
      arguments: {
        sessionId: "stale-session",
        instanceId: "stale-view",
      },
    },
  };

  const result = await proxy.clientMessage(message);

  assert.equal(result.params.arguments.sessionId, "current-session");
  assert.equal(result.params.arguments.instanceId, "current-view");
});

test("selects a tool device before forwarding its call", async () => {
  const selected = [];
  const proxy = new McpVsCodeContextProxy({
    sessionId: "vscode-session",
    instanceId: "device-view",
    selectDevice: async (deviceId, options) => selected.push({ deviceId, ...options }),
  });
  const message = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "mobile_device_tap",
      arguments: { deviceId: "android:pixel", x: 1, y: 2 },
    },
  };

  await proxy.clientMessage(message);

  assert.deepEqual(selected, [{ deviceId: "android:pixel", force: false }]);
  assert.equal(message.params.arguments.sessionId, undefined);
});

test("makes canvas identity optional in the advertised tool schemas", async () => {
  const proxy = new McpVsCodeContextProxy({
    sessionId: "vscode-session",
    instanceId: "device-view",
    selectDevice: async () => {},
  });
  await proxy.clientMessage({ jsonrpc: "2.0", id: "list-1", method: "tools/list" });
  const response = {
    jsonrpc: "2.0",
    id: "list-1",
    result: {
      tools: [
        {
          name: "mobile_device_get_selected",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
              instanceId: { type: "string" },
            },
            required: ["sessionId", "instanceId"],
          },
        },
        {
          name: "mobile_device_tap",
          inputSchema: {
            type: "object",
            required: ["deviceId", "x", "y"],
          },
        },
      ],
    },
  };

  await proxy.serverMessage(response);

  assert.deepEqual(response.result.tools[0].inputSchema.required, []);
  assert.match(
    response.result.tools[0].inputSchema.properties.sessionId.description,
    /automatically/,
  );
  assert.deepEqual(
    response.result.tools[1].inputSchema.required,
    ["deviceId", "x", "y"],
  );
});

test("refreshes the followed device after a successful reveal call", async () => {
  const selected = [];
  let refreshes = 0;
  const proxy = new McpVsCodeContextProxy({
    sessionId: "vscode-session",
    instanceId: "device-view",
    selectDevice: async (deviceId, options) => selected.push({ deviceId, ...options }),
    refreshView: async () => { refreshes += 1; },
  });
  await proxy.clientMessage({
    jsonrpc: "2.0",
    id: "reveal-1",
    method: "tools/call",
    params: {
      name: "mobile_device_reveal",
      arguments: { deviceId: "ios:phone" },
    },
  });

  await proxy.serverMessage({
    jsonrpc: "2.0",
    id: "reveal-1",
    result: { content: [] },
  });

  assert.deepEqual(selected, [
    { deviceId: "ios:phone", force: false },
    { deviceId: "ios:phone", force: true },
  ]);
  assert.equal(refreshes, 1);
});

test("follows a device returned by a successful create call", async () => {
  const selected = [];
  let refreshes = 0;
  const proxy = new McpVsCodeContextProxy({
    sessionId: "vscode-session",
    instanceId: "device-view",
    selectDevice: async (deviceId, options) => selected.push({ deviceId, ...options }),
    refreshView: async () => { refreshes += 1; },
  });
  await proxy.clientMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "mobile_device_create",
      arguments: {
        platform: "ios",
        runtimeId: "runtime",
        deviceTypeId: "phone",
        name: "Created Phone",
      },
    },
  });

  await proxy.serverMessage({
    jsonrpc: "2.0",
    id: 4,
    result: {
      structuredContent: { id: "ios:created-phone" },
      content: [],
    },
  });

  assert.deepEqual(selected, [
    { deviceId: "ios:created-phone", force: true },
  ]);
  assert.equal(refreshes, 1);
});

test("refreshes without reselecting after a successful delete call", async () => {
  const selected = [];
  let refreshes = 0;
  const proxy = new McpVsCodeContextProxy({
    sessionId: "vscode-session",
    instanceId: "device-view",
    selectDevice: async (deviceId, options) => selected.push({ deviceId, ...options }),
    refreshView: async () => { refreshes += 1; },
  });
  await proxy.clientMessage({
    jsonrpc: "2.0",
    id: "delete-1",
    method: "tools/call",
    params: {
      name: "mobile_device_delete",
      arguments: { deviceId: "ios:obsolete", confirm: true },
    },
  });

  await proxy.serverMessage({
    jsonrpc: "2.0",
    id: "delete-1",
    result: { content: [] },
  });

  assert.deepEqual(selected, [
    { deviceId: "ios:obsolete", force: false },
  ]);
  assert.equal(refreshes, 1);
});

test("routes successful automation only to its VS Code view", async () => {
  const activities = [];
  const proxy = new McpVsCodeContextProxy({
    sessionId: "vscode-session",
    instanceId: "device-view",
    selectDevice: async () => {},
    showAutomation: async (activity) => activities.push(activity),
  });
  await proxy.clientMessage({
    jsonrpc: "2.0",
    id: "tap-1",
    method: "tools/call",
    params: {
      name: "mobile_device_tap",
      arguments: {
        deviceId: "ios:phone",
        x: 10,
        y: 20,
        duration: 0,
      },
    },
  });
  assert.deepEqual(activities, []);

  await proxy.serverMessage({
    jsonrpc: "2.0",
    id: "tap-1",
    result: { content: [] },
  });

  assert.deepEqual(activities, [{
    kind: "tap",
    deviceId: "ios:phone",
    x: 10,
    y: 20,
    duration: 0,
  }]);
});

test("refreshes rotation and recording mutations", async () => {
  const selected = [];
  let refreshes = 0;
  const proxy = new McpVsCodeContextProxy({
    sessionId: "vscode-session",
    instanceId: "device-view",
    selectDevice: async (deviceId, options) => selected.push({ deviceId, ...options }),
    refreshView: async () => { refreshes += 1; },
  });

  for (const [index, name] of [
    "mobile_device_rotate",
    "mobile_device_recording_start",
    "mobile_device_recording_stop",
  ].entries()) {
    await proxy.clientMessage({
      jsonrpc: "2.0",
      id: index,
      method: "tools/call",
      params: {
        name,
        arguments: { deviceId: "android:pixel" },
      },
    });
    await proxy.serverMessage({
      jsonrpc: "2.0",
      id: index,
      result: { content: [] },
    });
  }

  assert.equal(refreshes, 3);
  assert.deepEqual(
    selected.map(({ force }) => force),
    [false, true, false, true, false, true],
  );
});

test("injects the Windows view identity into windows_app_* tools", async () => {
  const selected = [];
  const proxy = new McpVsCodeContextProxy({
    sessionId: "vscode-session",
    instanceId: "device-view",
    windowsInstanceId: "windows-view",
    selectDevice: async (deviceId, options) => selected.push({ deviceId, ...options }),
  });
  const message = {
    jsonrpc: "2.0",
    id: "win-1",
    method: "tools/call",
    params: {
      name: "windows_app_screenshot",
      arguments: {
        sessionId: "stale-session",
        instanceId: "stale-view",
        // A stray deviceId must never drag a Windows tool into the Mobile selection follow-up.
        deviceId: "ios:phone",
      },
    },
  };

  const result = await proxy.clientMessage(message);

  assert.equal(result.params.arguments.sessionId, "vscode-session");
  assert.equal(result.params.arguments.instanceId, "windows-view");
  assert.deepEqual(selected, []);
});

test("short-circuits windows_app_* tools even without a Windows view", async () => {
  const selected = [];
  const proxy = new McpVsCodeContextProxy({
    sessionId: "vscode-session",
    instanceId: "device-view",
    selectDevice: async (deviceId, options) => selected.push({ deviceId, ...options }),
  });
  const message = {
    jsonrpc: "2.0",
    id: "win-2",
    method: "tools/call",
    params: {
      name: "windows_app_ui_tree",
      arguments: { deviceId: "android:pixel" },
    },
  };

  const result = await proxy.clientMessage(message);

  // No Windows instance to inject, but the call must still bypass the Mobile device logic entirely.
  assert.equal(result.params.arguments.sessionId, undefined);
  assert.equal(result.params.arguments.instanceId, undefined);
  assert.deepEqual(selected, []);
});

test("relabels windows_app_* schemas without touching mobile relabelling", async () => {
  const proxy = new McpVsCodeContextProxy({
    sessionId: "vscode-session",
    instanceId: "device-view",
    windowsInstanceId: "windows-view",
    selectDevice: async () => {},
  });
  await proxy.clientMessage({ jsonrpc: "2.0", id: "list-2", method: "tools/list" });
  const response = {
    jsonrpc: "2.0",
    id: "list-2",
    result: {
      tools: [
        {
          name: "windows_app_get_selected",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
              instanceId: { type: "string" },
            },
            required: ["sessionId", "instanceId"],
          },
        },
        {
          name: "mobile_device_get_selected",
          inputSchema: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
              instanceId: { type: "string" },
            },
            required: ["sessionId", "instanceId"],
          },
        },
      ],
    },
  };

  await proxy.serverMessage(response);

  assert.deepEqual(response.result.tools[0].inputSchema.required, []);
  assert.match(
    response.result.tools[0].inputSchema.properties.sessionId.description,
    /Windows App VS Code view/,
  );
  assert.deepEqual(response.result.tools[1].inputSchema.required, []);
  assert.match(
    response.result.tools[1].inputSchema.properties.instanceId.description,
    /Mobile Canvas VS Code extension/,
  );
});

test("leaves mobile_device_* tools unaffected when a Windows view exists", async () => {
  const selected = [];
  const proxy = new McpVsCodeContextProxy({
    sessionId: "vscode-session",
    instanceId: "device-view",
    windowsInstanceId: "windows-view",
    selectDevice: async (deviceId, options) => selected.push({ deviceId, ...options }),
  });

  const select = await proxy.clientMessage({
    jsonrpc: "2.0",
    id: "mobile-1",
    method: "tools/call",
    params: {
      name: "mobile_device_select",
      arguments: { deviceId: "ios:phone" },
    },
  });
  assert.equal(select.params.arguments.sessionId, "vscode-session");
  assert.equal(select.params.arguments.instanceId, "device-view");

  await proxy.clientMessage({
    jsonrpc: "2.0",
    id: "mobile-2",
    method: "tools/call",
    params: {
      name: "mobile_device_tap",
      arguments: { deviceId: "android:pixel", x: 1, y: 2 },
    },
  });
  assert.deepEqual(selected, [{ deviceId: "android:pixel", force: false }]);
});
