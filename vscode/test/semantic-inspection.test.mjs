import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import "../../tests/scripts/fixtures/ailoha-installed-hooks.mjs";
import { createSemanticInspectionController } from "../../lib/ailoha/semantic-inspection.mjs";
import { createAilohaCanvasHost } from "../../lib/ailoha/canvas-host.mjs";
import { createNativeBindingFixture, nativeAgent } from "../../tests/scripts/fixtures/ailoha-native-binding.mjs";
import { nativeInvocationMetadata } from "../../tests/scripts/fixtures/ailoha-invocation-metadata.mjs";
import { canonicalAppFailure, captureMetadataContext, validateInvocationMetadata } from "../../lib/ailoha/invocation-metadata.mjs";

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

for (const registrationVersion of [2, 3]) test(`compiled VS Code bridge shares explicit native v${registrationVersion} candidate/bind/clear with the canonical MCP context`, async () => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("first"),
    nativeAgent("chosen", "target", { registrationVersion })] });
  const view = await fixture.createView("compiled-native-binding");
  const host = createAilohaCanvasHost({
    scope: view.scope, semanticInspection: view.controller,
    createBackend() { throw new Error("Semantic binding must not acquire or mutate a device backend."); },
  });
  const messages = [];
  const bridge = new HostBridge(undefined, view.scope.sessionId, view.scope.viewId,
    { async postMessage(message) { messages.push(message); return true; } }, { appendLine() {} }, undefined, host);
  let counter = 0;
  const request = async (method, input, status = 200) => {
    const id = `native-binding-${++counter}`;
    await bridge.handleMessage({ type: "api", id, path: "/api/v1/semantic/inspection", method,
      ...(input ? { body: JSON.stringify(input) } : {}) });
    const response = messages.find((message) => message.id === id);
    assert.equal(response.status, status);
    return JSON.parse(new TextDecoder().decode(response.body));
  };
  try {
    const initial = await request("GET");
    const evidence = await request("POST", { operation: "candidates", bindingToken: initial.binding.token });
    assert.equal(evidence.binding.candidates.length, 2);
    assert.deepEqual(evidence.binding.candidates.map((candidate) => candidate.registrationVersion), [2, registrationVersion]);
    assert.equal(evidence.appAvailable, false);
    const selected = await request("POST", { operation: "bind", bindingToken: evidence.binding.token,
      candidateToken: evidence.binding.candidates[1].token });
    assert.equal(selected.selection.runtimeInstanceId, "chosen");
    assert.equal((await view.mcpStore().readSnapshot()).selection.runtimeInstanceId, "chosen");
    let app;
    for (const operation of ["tree", "query", "status"]) {
      app = await request("POST", { lens: "app", operation, ...(operation === "query" ? { text: "OK" } : {}) });
      assert.equal(app.result.route.owner, "agent");
      assert.equal(app.result.route.runtimeInstanceId, "chosen");
    }
    if (registrationVersion === 3) {
      fixture.model.beforeTool = async () => {
        const snapshot = await view.store.readSnapshot();
        const metadata = validateInvocationMetadata(nativeInvocationMetadata(snapshot, view.scope),
          captureMetadataContext({ snapshot, scope: view.scope, route: "require-agent" }));
        throw canonicalAppFailure("ApplicationOperationError", metadata);
      };
      const failed = await request("POST", { lens: "app", operation: "status" }, 502);
      assert.equal(failed.error.code, "transport-failed");
      assert.equal(failed.error._meta["ailoha.executionContext"].selection.runtimeInstanceId, "chosen");
      assert.equal(failed.error._meta["ailoha.agentExchange"].effectMayBeUnknown, true);
      assert.equal(Object.hasOwn(failed.error._meta["ailoha.executionContext"], "observed"), false);
      fixture.model.beforeTool = null;
    }
    fixture.model.registrations[1].transportError = "AgentTransportUnsupported";
    const unsupported = await request("POST", { lens: "app", operation: "status" }, 501);
    assert.equal(unsupported.error.code, "AgentTransportUnsupported");
    assert.equal(unsupported.error.status, 501);
    assert.equal(unsupported.appAvailable, false);
    assert.equal(unsupported.result, null);
    assert.equal(view.toolCalls.every((call) => call.arguments.route === "require-agent"), true);
    const system = await request("POST", { lens: "system", operation: "tree" });
    assert.equal(system.result.route.owner, "target-host");
    const cleared = await request("POST", { operation: "unbind", bindingToken: system.binding.token });
    assert.equal(cleared.appAvailable, false);
    assert.equal(cleared.selection.targetId, "target");
    const latest = await request("POST", { operation: "candidates", bindingToken: cleared.binding.token });
    await bridge.setVisible(false);
    const hidden = await view.request({ operation: "bind", bindingToken: latest.binding.token,
      candidateToken: latest.binding.candidates[0].token });
    assert.equal(hidden.error.code, "semantic_view_suspended");
    assert.equal(view.context.selection.runtimeInstanceId, null);
    assert.equal(messages.some((message) => message.type === "semantic-inspection"
      && message.state.selection?.runtimeInstanceId === "chosen"), true);
  } finally {
    bridge.dispose();
    await bridge.closed();
  }
});
