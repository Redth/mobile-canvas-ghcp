import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import "../../tests/scripts/fixtures/ailoha-installed-hooks.mjs";
import { createSemanticInspectionController } from "../../lib/ailoha/semantic-inspection.mjs";
import { createAilohaCanvasHost } from "../../lib/ailoha/canvas-host.mjs";

const { HostBridge } = createRequire(import.meta.url)("../out/hostBridge.js");
const scope = { sessionId: "compiled-semantic-session", viewId: "compiled-semantic-view" };

test("compiled VS Code bridge forwards only the named semantic route and retires it on hide", async () => {
  const calls = [];
  const semanticInspection = createSemanticInspectionController({
    scope,
    async readSnapshot() {
      return {
        state: "open",
        selection: { targetHostId: "host", targetId: "target" },
        identity: { scopeEpoch: "epoch", revision: "1" },
        contextProjection: { contextRef: "ctx", ownerProcessId: process.pid, scopeEpoch: "epoch", revision: "1" },
      };
    },
    async callTool(request) {
      calls.push(request);
      return {
        elements: [], route: {
          owner: "target-host", targetHostId: "host", targetId: "target",
          executionContext: { contextRef: "ctx", scopeEpoch: "epoch", revision: "1", scope },
        },
      };
    },
  });
  const host = createAilohaCanvasHost({
    scope, semanticInspection,
    createBackend() { throw new Error("A forwarded semantic read must not connect the device backend."); },
  });
  const messages = [];
  const bridge = new HostBridge(undefined, scope.sessionId, scope.viewId,
    { async postMessage(message) { messages.push(message); return true; } },
    { appendLine() {} }, undefined, host);
  try {
    await bridge.handleMessage({
      type: "api", id: "read", path: "/api/v1/semantic/inspection", method: "POST",
      body: JSON.stringify({ lens: "system", operation: "tree" }),
    });
    const reply = messages.find((message) => message.id === "read");
    assert.equal(reply.status, 200);
    assert.equal(JSON.parse(new TextDecoder().decode(reply.body)).result.route.owner, "target-host");
    assert.deepEqual(calls[0].arguments.route, "target-host");
    assert.equal(calls[0].name, "app_tree");
    await bridge.setVisible(false);
    assert.equal(semanticInspection.snapshot().status, "suspended");
    assert.equal(semanticInspection.snapshot().result, null);
  } finally {
    bridge.dispose();
    await bridge.closed();
  }
});
