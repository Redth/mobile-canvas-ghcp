import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import "../../tests/scripts/fixtures/ailoha-installed-hooks.mjs";
import { ownedTestDirectory } from "../../tests/scripts/fixtures/owned-test-directory.mjs";

const require = createRequire(import.meta.url);
const vscode = require("vscode");
const runtime = require("../out/runtime.js");

test("compiled Ailoha MCP discovery stays dormant before this view's first canonical context, then refreshes without swallowing post-open errors", async (t) => {
  const storage = await ownedTestDirectory(t, "mcp-first-view-");
  const previous = {
    backend: process.env.MOBILE_CANVAS_BACKEND,
    emitter: vscode.EventEmitter, lm: vscode.lm, command: vscode.commands.registerCommand,
    output: vscode.window.createOutputChannel, view: vscode.window.registerWebviewViewProvider,
    resolve: runtime.resolveAilohaContextBinding,
  };
  t.after(() => {
    if (previous.backend === undefined) delete process.env.MOBILE_CANVAS_BACKEND;
    else process.env.MOBILE_CANVAS_BACKEND = previous.backend;
    vscode.EventEmitter = previous.emitter;
    vscode.lm = previous.lm;
    vscode.commands.registerCommand = previous.command;
    vscode.window.createOutputChannel = previous.output;
    vscode.window.registerWebviewViewProvider = previous.view;
    runtime.resolveAilohaContextBinding = previous.resolve;
  });
  class Emitter {
    handlers = new Set();
    event = (handler) => { this.handlers.add(handler); return { dispose: () => this.handlers.delete(handler) }; };
    fire() { for (const handler of this.handlers) handler(); }
    dispose() { this.handlers.clear(); }
  }
  vscode.EventEmitter = Emitter;
  const disposable = () => ({ dispose() {} });
  let provider;
  let definitions;
  let changed = 0;
  let bindings = 0;
  vscode.window.createOutputChannel = () => ({ appendLine() {}, dispose() {} });
  vscode.window.registerWebviewViewProvider = (_id, value) => { provider = value; return disposable(); };
  vscode.commands.registerCommand = disposable;
  vscode.lm = {
    registerTool: disposable,
    registerMcpServerDefinitionProvider(_id, value) { definitions = value; value.onDidChangeMcpServerDefinitions(() => { changed += 1; }); return disposable(); },
  };
  const oldDefinition = vscode.McpStdioServerDefinition;
  vscode.McpStdioServerDefinition = class { constructor(...args) { this.args = args; } };
  t.after(() => { vscode.McpStdioServerDefinition = oldDefinition; });
  runtime.resolveAilohaContextBinding = async (_context, scope) => {
    bindings += 1;
    return { contextRef: "original-context", scopeEpoch: "epoch", scope, ownerProcessId: 123 };
  };
  process.env.MOBILE_CANVAS_BACKEND = "ailoha";
  const context = {
    subscriptions: [],
    globalStorageUri: { fsPath: storage },
    extension: { packageJSON: { version: "0.1.19" } },
    extensionUri: vscode.Uri.file("/synthetic-installed-extension"),
    asAbsolutePath: (path) => join("/synthetic-installed-extension", path),
  };
  const { activate } = require("../out/extension.js");
  activate(context);
  t.after(() => context.subscriptions.forEach((value) => value.dispose()));
  assert.deepEqual(await definitions.provideMcpServerDefinitions(), []);
  assert.equal(bindings, 0);
  provider.contextOpened.fire();
  assert.equal(changed, 1);
  const values = await definitions.provideMcpServerDefinitions();
  assert.equal(values.length, 1);
  assert.equal(bindings, 1);
  assert.ok(values[0].args[2].includes("original-context"));
  provider.dispose();
  runtime.resolveAilohaContextBinding = async () => { throw new Error("Original owner cleanup is pending"); };
  await assert.rejects(definitions.provideMcpServerDefinitions(), /Original owner cleanup is pending/);
});
