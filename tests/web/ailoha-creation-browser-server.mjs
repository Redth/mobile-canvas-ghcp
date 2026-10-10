import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import "../scripts/fixtures/ailoha-installed-hooks.mjs";
import { enableCatalogCreation, scenario, sourceSha } from "../scripts/fixtures/ailoha-sdk-double.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const product = resolve(process.argv[2]);
const hostKind = process.argv[3];
const contextPath = resolve(process.argv[4]);
scenario.focusedText = process.argv.includes("--focused-text");
const combined = process.argv.includes("--combined");
const fixtureRoot = `${contextPath}.workspace`;
const secondRoot = `${contextPath}.workspace-second`;
const workspaceLog = `${contextPath}.workspace.jsonl`;
if (!["github", "vscode"].includes(hostKind)) throw new Error("Choose an owned github/vscode fixture.");
const pinPath = join(product, "lib/ailoha/runtime-package.json");
let previousPin;
try { previousPin = readFileSync(pinPath); }
catch (error) { if (error.code !== "ENOENT") throw error; }
writeFileSync(pinPath, JSON.stringify({ schema: "mobile-canvas.ailoha-runtime/v1", version: "synthetic-only", sourceSha }));
process.env.AILOHA_TEST_CONTEXT_STATE = contextPath;
if (combined) {
  scenario.combinedInspection = true;
  mkdirSync(fixtureRoot, { recursive: true });
  mkdirSync(secondRoot, { recursive: true });
  process.env.AILOHA_TEST_INSPECTION_LOG = workspaceLog;
  process.env.AILOHA_TEST_INSPECTION_MODE = "complete";
}
enableCatalogCreation();
const { createRuntimeCanvasHost } = await import(pathToFileURL(join(product, "lib/ailoha/runtime-backend.mjs")).href);
const scope = { sessionId: randomUUID(), viewId: `${hostKind}-creation-browser` };
const errors = [];
let workspaceChoice = "first";
let workspacePicks = 0;
let workspaceRoots;
if (combined && hostKind === "vscode") {
  const require = createRequire(import.meta.url);
  const vscode = require("vscode");
  const { createWorkspaceRootAdapter } = require(join(root, "vscode/out/workspaceRoots.js"));
  vscode.workspace.workspaceFolders = [fixtureRoot, secondRoot].map((path, index) => ({
    name: index ? "Owned second root" : "Owned first root", index, uri: vscode.Uri.file(path),
  }));
  vscode.window.showQuickPick = async (items) => {
    workspacePicks += 1;
    const chosen = workspaceChoice === "first" ? fixtureRoot : secondRoot;
    return items.find((item) => item.folderUri === vscode.Uri.file(chosen).toString());
  };
  workspaceRoots = createWorkspaceRootAdapter();
}
const host = createRuntimeCanvasHost({
  scope, onError: (error) => errors.push(error), validateWorkspaceRoot: workspaceRoots?.validate,
});
const opened = await host.openCanvas();
await host.invokeAction("select_device", { deviceId: "opaque/target" });
let bridge;
let html;
let origin;
const eventClients = new Set();
const queuedMessages = [];
const sharedAssets = new Set([
  "index.html", "device-canvas.css", "device-canvas.js", "canvas-state.js", "create-device-options.js",
  "ailoha-canvas-state.js", "ailoha-video-protocol.js", "ailoha-video-receiver.js", "ailoha-video-player.js",
  "ailoha-workspace-view.js", "ailoha-semantic-view.js",
]);
const hostAssets = new Set(["vscode-theme.css", "vscode-theme.js", "vscode-transport.js"]);
const shim = `
const ownedEvents = new EventSource("/test/events");
ownedEvents.onmessage = (event) => {
  const data = JSON.parse(event.data, (_key, value) =>
    value && Array.isArray(value.testArrayBuffer) ? new Uint8Array(value.testArrayBuffer).buffer : value);
  window.dispatchEvent(new MessageEvent("message", { data }));
};
window.acquireVsCodeApi = () => ({
  postMessage(message) {
    fetch("/test/message", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message, (_key, value) =>
        value instanceof ArrayBuffer ? { testArrayBuffer: [...new Uint8Array(value)] } : value),
    }).then((response) => {
      if (!response.ok) throw new Error("Owned synthetic IPC failed");
    }).catch((error) => {
      window.dispatchEvent(new MessageEvent("message", { data: {
        type: "operation-error", id: message.requestId ?? message.id, message: error.message,
      } }));
    });
  },
});
document.body.classList.add("vscode-dark");
`;

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("Owned test control exceeds its budget");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function sendMessage(message) {
  const text = JSON.stringify(message, (_key, value) =>
    value instanceof ArrayBuffer ? { testArrayBuffer: [...new Uint8Array(value)] } : value);
  if (eventClients.size === 0) {
    if (queuedMessages.length >= 256) throw new Error("Owned synthetic IPC queue is full");
    queuedMessages.push(text);
  } else for (const response of eventClients) response.write(`data: ${text}\n\n`);
  return true;
}
function logEntries(path) {
  try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
function updateSyntheticContext(nativeInstance) {
  const contexts = JSON.parse(readFileSync(contextPath, "utf8"));
  const context = contexts.find((entry) => entry.scope.sessionId === scope.sessionId && entry.scope.viewId === scope.viewId);
  if (!context || !context.selection) throw new Error("No complete owned synthetic target selection");
  context.selection = {
    ...context.selection, agentId: nativeInstance ? "owned-agent" : null,
    runtimeInstanceId: nativeInstance ? "owned-runtime" : null,
  };
  context.observed = nativeInstance ? { runtimeInstanceEvidence: "verified-native-instance" } : null;
  context.revision = String(BigInt(context.revision) + 1n);
  const temporary = `${contextPath}.binding-pending`;
  writeFileSync(temporary, JSON.stringify(contexts), { flag: "wx" });
  renameSync(temporary, contextPath);
  host.semanticInspection.invalidate();
}
const controls = createServer(async (request, response) => {
  const url = new URL(request.url, origin);
  response.setHeader("Cache-Control", "no-store");
  try {
    if (url.pathname === "/test/evidence") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        synthetic: true, host: hostKind, focusedText: scenario.focusedText, errors, calls: scenario.calls,
        leases: scenario.leases.size, videoResources: scenario.videos.size,
        created: [...scenario.createdTargets.values()], scope,
        combined, fixtureRoot, secondRoot, workspacePicks,
        ...(combined ? {
          workspace: host.workspaceInspection.snapshot(), semantic: host.semanticInspection.snapshot(),
          workspaceCalls: logEntries(workspaceLog), semanticCalls: logEntries(`${contextPath}.semantic.jsonl`),
          context: JSON.parse(readFileSync(contextPath, "utf8")),
        } : {}),
      }));
      return;
    }
    if (url.pathname === "/test/check") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(readFileSync(join(root, "tests/web/ailoha-creation-browser-check.mjs")));
      return;
    }
    if (request.method === "POST" && url.pathname === "/test/creation-hold") {
      if (scenario.creationGate) throw new Error("An owned creation hold already exists");
      let release;
      scenario.creationGate = { promise: new Promise((resolve) => { release = resolve; }), resolve: () => release() };
      response.writeHead(204).end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/test/creation-release") {
      scenario.creationGate?.resolve();
      scenario.creationGate = null;
      response.writeHead(204).end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/test/visibility") {
      const input = await readJson(request);
      if (!bridge || typeof input.visible !== "boolean") throw new Error("Owned VS Code visibility is required");
      await bridge.setVisible(input.visible);
      response.writeHead(204).end();
      return;
    }
    if (combined && request.method === "POST" && url.pathname === "/test/workspace-control") {
      const input = await readJson(request);
      if (input.root !== undefined) {
        if (!["first", "second"].includes(input.root)) throw new Error("Invalid owned workspace choice");
        if (hostKind === "github") host.workspaceInspection.bindRoot(input.root === "first" ? fixtureRoot : secondRoot, ["explicit-exclusion/**"]);
        else workspaceChoice = input.root;
      }
      if (input.mode !== undefined) {
        if (!["complete", "incomplete", "unknown-schema", "empty", "xss"].includes(input.mode)) throw new Error("Invalid owned workspace fixture mode");
        process.env.AILOHA_TEST_INSPECTION_MODE = input.mode;
      }
      const delay = input.delayMs ?? 0;
      if (!Number.isInteger(delay) || delay < 0 || delay > 5000) throw new Error("Invalid owned workspace delay");
      process.env.AILOHA_TEST_INSPECTION_DELAY_MS = String(delay);
      response.writeHead(204).end();
      return;
    }
    if (combined && request.method === "POST" && url.pathname === "/test/instance-control") {
      const input = await readJson(request);
      if (typeof input.nativeInstance !== "boolean") throw new Error("Explicit owned native-instance choice required");
      updateSyntheticContext(input.nativeInstance);
      response.writeHead(204).end();
      return;
    }
    if (hostKind !== "vscode") throw new Error("No owned fixture route");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html" }).end(html);
      return;
    }
    if (request.method === "GET" && url.pathname === "/test/ipc.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" }).end(shim);
      return;
    }
    if (request.method === "GET" && url.pathname === "/test/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      response.write(": owned synthetic IPC\n\n");
      eventClients.add(response);
      for (const text of queuedMessages.splice(0)) response.write(`data: ${text}\n\n`);
      request.once("close", () => eventClients.delete(response));
      return;
    }
    if (request.method === "POST" && url.pathname === "/test/message") {
      const message = await readJson(request);
      if (message.type !== "view-title") await bridge.handleMessage(message);
      response.writeHead(204).end();
      return;
    }
    const shared = /^\/assets\/dist\/web\/([^/]+)$/.exec(url.pathname);
    const hostAsset = /^\/assets\/media\/([^/]+)$/.exec(url.pathname);
    let asset;
    if (shared && sharedAssets.has(shared[1])) asset = join(product, "web", shared[1]);
    if (hostAsset && hostAssets.has(hostAsset[1])) asset = join(root, "vscode/media", hostAsset[1]);
    if (!asset) throw new Error("Unknown owned webview asset");
    response.writeHead(200, { "Content-Type": asset.endsWith(".css") ? "text/css" : "text/javascript" });
    response.end(readFileSync(asset));
  } catch (error) {
    errors.push({ fixtureError: error.message });
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: error.message }));
  }
});
await new Promise((resolve) => controls.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${controls.address().port}`;
if (hostKind === "vscode") {
  const require = createRequire(import.meta.url);
  const { HostBridge } = require(join(root, "vscode/out/hostBridge.js"));
  const { createWebviewHtml } = require(join(root, "vscode/out/webviewHtml.js"));
  bridge = new HostBridge(undefined, scope.sessionId, scope.viewId, { postMessage: async (message) => sendMessage(message) },
    { appendLine: (line) => errors.push({ bridgeError: line }) }, undefined, host, undefined, workspaceRoots);
  const extensionRoot = join(root, "vscode");
  html = createWebviewHtml({
    extensionUri: { fsPath: extensionRoot }, asAbsolutePath: (path) => join(extensionRoot, path),
  }, {
    cspSource: origin,
    asWebviewUri: (uri) => `${origin}/assets/${relative(extensionRoot, uri.fsPath).replaceAll("\\", "/")}`,
  });
  const nonce = /nonce="([^"]+)"/.exec(html)[1];
  // Only the browser's synthetic IPC shim needs HTTP/SSE; real VS Code supplies native postMessage.
  html = html.replace("default-src 'none'", "default-src 'none'; connect-src 'self'")
    .replace(`<script nonce="${nonce}"`, `<script nonce="${nonce}" src="/test/ipc.js"></script>\n  <script nonce="${nonce}"`);
}
console.log(JSON.stringify({
  synthetic: true, host: hostKind, focusedText: scenario.focusedText, url: hostKind === "github" ? opened.url : `${origin}/`,
  evidenceUrl: `${origin}/test/evidence`, controlOrigin: origin,
  combined, fixtureRoot, secondRoot,
}));
let closing;
async function close() {
  return closing ??= (async () => {
    scenario.creationGate?.resolve();
    if (bridge) { bridge.dispose(); await bridge.closed(); }
    else await host.closeCanvas();
    controls.closeAllConnections();
    await new Promise((resolve) => controls.close(resolve));
    if (previousPin) writeFileSync(pinPath, previousPin);
    else rmSync(pinPath, { force: true });
    rmSync(contextPath, { force: true });
    if (combined) {
      rmSync(workspaceLog, { force: true });
      rmSync(`${contextPath}.semantic.jsonl`, { force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  void close().catch((error) => {
    process.stderr.write(`Owned synthetic creation browser cleanup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
});
