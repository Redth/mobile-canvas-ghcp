import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFile, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { WebSocketServer } from "ws";
import { CHAT_TOOL_NAMES } from "../../chatTools";
import { createMcpDefinition } from "../../extension";
import { HostBridge } from "../../hostBridge";
import type { ExtensionMessage } from "../../messages";
import { applyViewTitle, VIEW_INSTANCE_ID } from "../../viewProvider";

export async function run(): Promise<void> {
  await verifyActivation();
  await verifyHostBridge();
}

async function verifyActivation(): Promise<void> {
  const extension = vscode.extensions.getExtension("redth.mobile-canvas");
  assert.ok(extension, "Mobile Canvas should be discoverable");

  await extension.activate();
  assert.equal(extension.isActive, true);

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "mobileCanvas.open",
    "mobileCanvas.refresh",
    "mobileCanvas.deviceView.focus",
    "workbench.view.extension.mobileCanvas",
  ]) {
    assert.ok(commands.includes(command), `${command} should be registered`);
  }
  for (const name of Object.values(CHAT_TOOL_NAMES)) {
    assert.ok(
      vscode.lm.tools.some((tool) => tool.name === name),
      `${name} should be registered`,
    );
  }

  const definition = createMcpDefinition(
    extension.extensionUri,
    join(extension.extensionPath, "dist", "scripts", "mcp-vscode.mjs"),
    extension.packageJSON.version,
    "definition-session",
    join(extension.extensionPath, "refresh.signal"),
  );
  assert.equal(definition.label, "Mobile Canvas");
  assert.equal(definition.command, process.execPath);
  assert.deepEqual(definition.args?.slice(-4), [
    "--session",
    "definition-session",
    "--instance",
    VIEW_INSTANCE_ID,
  ]);
  assert.equal(definition.env?.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(
    definition.env?.MOBILE_CANVAS_VSCODE_REFRESH_SIGNAL,
    join(extension.extensionPath, "refresh.signal"),
  );
  assert.equal(definition.version, extension.packageJSON.version);
  assert.equal(definition.cwd?.toString(), extension.extensionUri.toString());

  const titleTarget: { title?: string; description?: string } = {};
  applyViewTitle(titleTarget, "  Pixel\n6  ", " Android 15  ·  booted ");
  assert.deepEqual(titleTarget, {
    title: "Pixel 6",
    description: "Android 15 · booted",
  });
  applyViewTitle(titleTarget, "\n\t");
  assert.deepEqual(titleTarget, { title: "Device", description: undefined });
}

async function verifyHostBridge(): Promise<void> {
  const bootstrapBodies: string[] = [];
  let apiCookie = "";
  let socketCookie = "";
  let selectionRestores = 0;
  const server = createServer((request, response) => {
    if (request.url === "/api/v1/auth/bootstrap") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        bootstrapBodies.push(body);
        const sessionId = JSON.parse(body).sessionId;
        response.setHeader(
          "Set-Cookie",
          `mobile_device_session=${sessionId === "test-session" ? "test-cookie" : "webview-cookie"}; HttpOnly; Path=/`,
        );
        response.statusCode = 204;
        response.end();
      });
      return;
    }
    if (request.url === "/api/v1/catalog") {
      apiCookie = request.headers.cookie ?? "";
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Set-Cookie", "mobile_device_session=must-not-leak");
      response.end('{"devices":[]}');
      return;
    }
    if (request.url === "/api/v1/selection") {
      response.setHeader("Content-Type", "application/json");
      if (
        request.headers.cookie === "mobile_device_session=test-cookie"
        || request.headers.cookie === "mobile_device_session=webview-cookie"
      ) {
        if (request.method === "POST") selectionRestores += 1;
        response.end(
          request.method === "POST"
            ? '{"id":"ios:phone"}'
            : '{"hasSelection":true,"device":{"id":"ios:phone","name":"Test iPhone","platform":"ios"}}',
        );
      } else {
        response.end('{"hasSelection":false}');
      }
      return;
    }
    if (request.url === "/api/v1/devices/ios%3Aphone/screenshot") {
      response.setHeader("Content-Type", "image/png");
      response.end(Buffer.from([137, 80, 78, 71]));
      return;
    }
    if (request.url === "/api/v1/devices/ios%3Aphone/ui") {
      response.setHeader("Content-Type", "application/json");
      response.end('{"root":{"role":"button","label":"Continue"}}');
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, request) => {
    socketCookie = request.headers.cookie ?? "";
    if (request.url?.startsWith("/ws/events")) {
      socket.send(JSON.stringify({
        kind: "text",
        deviceId: "ios:phone",
        detail: "must-not-leak",
      }));
      socket.send(JSON.stringify({
        kind: "tap",
        deviceId: "ios:phone",
        x: 10,
        y: 20,
        sessionId: "test-session",
        instanceId: "test-view",
      }));
    } else {
      socket.send(Buffer.from([1, 2, 3]));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const directory = await mkdtemp(join(tmpdir(), "mobile-canvas-vscode-test-"));
  const command = join(directory, "mobile-canvas");
  await writeFile(
    command,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
if (args[0] === "canvas" && args[1] === "open") {
  console.log(JSON.stringify({
    url: process.env.MOBILE_CANVAS_TEST_URL
      + "#bootstrap=test-secret&sessionId=" + encodeURIComponent(value("--session"))
      + "&instanceId=" + encodeURIComponent(value("--instance")),
    title: "Mobile Device"
  }));
} else if (args[0] === "canvas" && args[1] === "close") {
  console.log("{}");
} else {
  process.exit(2);
}
`,
    "utf8",
  );
  await chmod(command, 0o755);
  const refreshSignal = join(directory, "refresh.signal");
  await writeFile(
    refreshSignal,
    '{"type":"automation","nonce":"old","activity":'
      + '{"kind":"text","deviceId":"ios:phone","detail":"設定"}}\n',
    "utf8",
  );
  process.env.MOBILE_CANVAS_COMMAND = command;
  process.env.MOBILE_CANVAS_TEST_URL = `http://127.0.0.1:${address.port}/`;

  const messages: ExtensionMessage[] = [];
  const bridge = new HostBridge(
    command,
    "test-session",
    "test-view",
    {
      postMessage: async (message) => {
        messages.push(message);
        return true;
      },
    },
    { appendLine: () => {} },
    refreshSignal,
  );

  try {
    await bridge.handleMessage({ type: "ready" });
    assert.deepEqual(JSON.parse(bootstrapBodies[0]), {
      secret: "test-secret",
      sessionId: "test-session",
      instanceId: "test-view",
    });
    assert.deepEqual(messages.shift(), {
      type: "context",
      sessionId: "test-session",
      instanceId: "test-view",
    });

    const selectedContext = await bridge.getSelectedDeviceContext();
    assert.equal(selectedContext.deviceId, "ios:phone");
    assert.equal(selectedContext.deviceLabel, "Test iPhone");
    const screenshot = await bridge.getSelectedScreenshot();
    assert.deepEqual([...screenshot.bytes], [137, 80, 78, 71]);
    const uiTree = await bridge.getSelectedUiTree();
    assert.deepEqual(uiTree.tree, {
      root: { role: "button", label: "Continue" },
    });

    await appendFile(
      refreshSignal,
      '{"type":"refresh","nonce":"refresh-1"}\n',
      "utf8",
    );
    const refreshMessage = await waitForMessage(
      messages,
      (message) => message.type === "refresh",
    );
    assert.equal(refreshMessage.type, "refresh");

    await appendFile(
      refreshSignal,
      '{"type":"automation","nonce":"automation-1","activity":'
        + '{"kind":"tap","deviceId":"ios:phone","x":10,"y":20}}\n',
      "utf8",
    );
    const automationMessage = await waitForMessage(
      messages,
      (message) => message.type === "automation",
    );
    assert.equal(automationMessage.type, "automation");
    if (automationMessage.type === "automation") {
      assert.equal(automationMessage.activity.deviceId, "ios:phone");
      assert.equal(automationMessage.activity.kind, "tap");
    }

    await bridge.handleMessage({
      type: "api",
      id: "catalog",
      path: "/api/v1/catalog",
    });
    const apiResult = messages.shift();
    assert.equal(apiResult?.type, "api-result");
    assert.equal(apiCookie, "mobile_device_session=test-cookie");
    if (apiResult?.type === "api-result") {
      assert.equal(apiResult.headers["set-cookie"], undefined);
      assert.ok(apiResult.body);
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(apiResult.body)),
        { devices: [] },
      );
    }

    await bridge.handleMessage({
      type: "api",
      id: "escape",
      path: "/api/v1/../../outside",
    });
    const invalidPath = messages.shift();
    assert.equal(invalidPath?.type, "operation-error");

    await bridge.handleMessage({
      type: "socket-open",
      id: "video",
      channel: "video",
    });
    const frame = await waitForMessage(
      messages,
      (message) => message.type === "socket-message" && message.id === "video",
    );
    assert.equal(socketCookie, "mobile_device_session=test-cookie");
    assert.equal(frame.type, "socket-message");
    if (frame.type === "socket-message") {
      assert.deepEqual([...new Uint8Array(frame.data as ArrayBuffer)], [1, 2, 3]);
    }

    await bridge.handleMessage({
      type: "socket-open",
      id: "activities",
      channel: "events",
    });
    const activity = await waitForMessage(
      messages,
      (message) =>
        message.type === "socket-message" && message.id === "activities",
    );
    assert.equal(activity.type, "socket-message");
    if (activity.type === "socket-message") {
      assert.equal(typeof activity.data, "string");
      const payload = JSON.parse(activity.data as string);
      assert.equal(payload.kind, "tap");
      assert.equal(payload.detail, undefined);
    }

    await bridge.setVisible(false);
    assert.ok(messages.some(
      (message) => message.type === "visibility" && !message.visible,
    ));
    await bridge.restart();
    await bridge.handleMessage({ type: "ready" });
    assert.equal(selectionRestores, 1);

    await vscode.commands.executeCommand("mobileCanvas.open");
    await waitFor(() => bootstrapBodies.length >= 3);
    const viewBootstrap = JSON.parse(bootstrapBodies[2]);
    assert.equal(viewBootstrap.secret, "test-secret");
    assert.match(viewBootstrap.sessionId, /^[0-9a-f-]{36}$/);
    assert.notEqual(viewBootstrap.sessionId, vscode.env.sessionId);
    assert.equal(viewBootstrap.instanceId, VIEW_INSTANCE_ID);

    const selectedToolResult = await invokeTool(CHAT_TOOL_NAMES.selectedDevice);
    assert.deepEqual(readJsonPart(selectedToolResult.content[0]), {
      hasSelection: true,
      device: { id: "ios:phone", name: "Test iPhone", platform: "ios" },
    });

    const screenshotToolResult = await invokeTool(CHAT_TOOL_NAMES.screenshot);
    assert.match(readTextPart(screenshotToolResult.content[0]), /Test iPhone/);
    assert.equal(readDataPart(screenshotToolResult.content[1]).mimeType, "image/png");
    assert.deepEqual(
      [...readDataPart(screenshotToolResult.content[1]).data],
      [137, 80, 78, 71],
    );

    const uiToolResult = await invokeTool(CHAT_TOOL_NAMES.uiTree);
    assert.match(readTextPart(uiToolResult.content[0]), /Test iPhone/);
    assert.deepEqual(readJsonPart(uiToolResult.content[1]), {
      root: { role: "button", label: "Continue" },
    });
  } finally {
    bridge.dispose();
    delete process.env.MOBILE_CANVAS_COMMAND;
    delete process.env.MOBILE_CANVAS_TEST_URL;
    await rm(directory, { recursive: true, force: true });
    sockets.close();
    server.close();
  }

  function invokeTool(name: string): Thenable<vscode.LanguageModelToolResult> {
    return vscode.lm.invokeTool(name, {
      input: {},
      toolInvocationToken: undefined,
    });
  }

  function readTextPart(part: unknown): string {
    assert.ok(part instanceof vscode.LanguageModelTextPart);
    return part.value;
  }

  function readDataPart(part: unknown): vscode.LanguageModelDataPart {
    assert.ok(part instanceof vscode.LanguageModelDataPart);
    return part;
  }

  function readJsonPart(part: unknown): unknown {
    const data = readDataPart(part);
    assert.ok(
      data.mimeType === "application/json" || data.mimeType === "text/x-json",
      `unexpected JSON MIME type: ${data.mimeType}`,
    );
    return JSON.parse(new TextDecoder().decode(data.data));
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the Mobile Canvas view.");
}

async function waitForMessage(
  messages: ExtensionMessage[],
  predicate: (message: ExtensionMessage) => boolean,
): Promise<ExtensionMessage> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const index = messages.findIndex(predicate);
    if (index >= 0) {
      return messages.splice(index, 1)[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a host bridge message.");
}
