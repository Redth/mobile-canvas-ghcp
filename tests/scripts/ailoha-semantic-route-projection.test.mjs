import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { productModule } from "../ailoha-test-module.mjs";
import { createNativeBindingFixture, nativeAgent } from "./fixtures/ailoha-native-binding.mjs";
import { nativeSemanticOutput, privateRouteMarker, withPrivateRouteBlobs } from "./fixtures/native-semantic-route.mjs";
import { exchangeOutcome, nativeInvocationMetadata } from "./fixtures/ailoha-invocation-metadata.mjs";

const { createAilohaMcpDispatcher } = await import(productModule("lib/ailoha/mcp-host.mjs"));
const { createAilohaCanvasHost } = await import(productModule("lib/ailoha/canvas-host.mjs"));
const { callSemanticTool } = await import(productModule("lib/ailoha/semantic-mcp.mjs"));
const contextKeys = ["contextRef", "scope", "scopeEpoch", "revision", "selection"];
const routeKeys = ["owner", "operation", "reason", "description", "targetHostId", "targetId", "surfaceId",
  "agentId", "runtimeInstanceId", "legacyAgentId", "agentRegistrationVersion", "correlation", "executionContext"];

async function fixture(semanticTool) {
  const model = createNativeBindingFixture({ registrations: [nativeAgent("native", "target", { registrationVersion: 3 })], semanticTool });
  const view = await model.createView();
  const initial = await view.controller.request("GET");
  assert.equal((await view.request({ operation: "bind", bindingToken: initial.binding.token,
    agentId: "agent-native", runtimeInstanceId: "native" })).appAvailable, true);
  model.model.mutateTool = (output, request) => nativeSemanticOutput(output, request);
  return { ...model, view };
}

function checkPublicRoute(route, context, app) {
  assert.deepEqual(Object.keys(route).sort(), [...routeKeys].sort());
  assert.deepEqual(Object.keys(route.executionContext).sort(), [...contextKeys].sort());
  assert.deepEqual(route.executionContext.scope, context.scope);
  assert.equal(route.executionContext.contextRef, context.contextRef);
  assert.equal(route.executionContext.scopeEpoch, context.scopeEpoch);
  assert.equal(route.executionContext.revision, context.revision);
  assert.deepEqual(route.executionContext.selection, { workspaceId: null, applicationId: null,
    targetHostId: "host", targetId: "target", surfaceId: "surface",
    agentId: app ? "agent-native" : null, runtimeInstanceId: app ? "native" : null });
  assert.equal(route.owner, app ? "agent" : "target-host");
  assert.equal(route.reason, "explicit-preference");
  assert.equal(route.description, app ? "The caller required the app agent." : "The caller required the Target Host.");
  assert.equal(route.correlation, app ? "matched" : "not-requested");
  assert.equal(route.agentRegistrationVersion, app ? 3 : null);
  assert.equal(route.legacyAgentId, app ? "legacy-native" : null);
  assert.equal(JSON.stringify(route).includes(privateRouteMarker), false);
}

test("native-shaped App/System success routes publish only minimal contexts without inventing metadata", async () => {
  const f = await fixture();
  for (const lens of ["app", "system"]) {
    let raw;
    f.model.mutateTool = (output, request) => { raw = nativeSemanticOutput(output, request); return raw; };
    const state = await f.view.request({ lens, operation: "query", text: "native" });
    assert.equal(state.status, "complete");
    assert.deepEqual(Object.keys(raw.route.executionContext).sort(),
      ["contextRef", "scope", "scopeEpoch", "revision", "capturedAt", "selection", "observed", "provenance"].sort());
    checkPublicRoute(state.result.route, f.view.context, lens === "app");
    assert.equal(state.result.route.operation, "query-elements");
    assert.equal(Object.hasOwn(state.result, "_meta"), false);
    assert.equal(Object.hasOwn(state, "_meta"), false);
    assert.deepEqual(Object.keys(state.result.provenance).sort(),
      ["ownerProcessId", "processStartedAt", "runtimeInstanceEvidence"].sort());
  }
});

test("unknown native route/context/scope/selection blobs do not cross the public success projection", async () => {
  const f = await fixture();
  f.model.mutateTool = (output, request) => withPrivateRouteBlobs(nativeSemanticOutput(output, request));
  for (const lens of ["app", "system"]) {
    const state = await f.view.request({ lens, operation: "tree" });
    assert.equal(state.status, "complete");
    checkPublicRoute(state.result.route, f.view.context, lens === "app");
    assert.equal(JSON.stringify(state).includes(privateRouteMarker), false);
    assert.equal(Object.hasOwn(state.result, "_meta"), false);
  }
});

test("private native evidence and present selection are checked before publishing a sanitized success", async () => {
  const f = await fixture();
  for (const mutate of [
    (r) => { r.executionContext.observed.runtimeInstanceEvidence = "unsupported"; },
    (r) => { r.runtimeInstanceId = "replacement"; },
    (r) => { r.executionContext.scope.viewId = "peer"; },
    (r) => { r.executionContext.selection.targetId = "other"; },
    (r) => { r.executionContext.selection.agentId = "agent-replacement"; },
    (r) => { r.executionContext.selection = null; },
  ]) {
    f.model.mutateTool = (output, request) => {
      const result = withPrivateRouteBlobs(nativeSemanticOutput(output, request));
      mutate(result.route);
      return result;
    };
    const state = await f.view.request({ lens: "app", operation: "tree" });
    assert.equal(state.error.code, "semantic_route_mismatch");
    assert.equal(state.result, null);
    assert.equal(state.appAvailable, false);
    assert.equal(JSON.stringify(state).includes(privateRouteMarker), false);
  }
  f.model.mutateTool = (output, request) => {
    const result = nativeSemanticOutput(output, request);
    result.route.executionContext.selection.agentId = "agent-native";
    result.route.executionContext.selection.runtimeInstanceId = "native";
    return result;
  };
  assert.equal((await f.view.request({ lens: "system", operation: "tree" })).error.code, "semantic_route_mismatch");
});

test("public route scalar bounds preserve legitimate fields and reject malformed or future values", async () => {
  const f = await fixture();
  f.model.mutateTool = (output, request) => {
    const result = nativeSemanticOutput(output, request);
    result.route.description = "d".repeat(2048);
    result.route.reason = "r".repeat(128);
    return result;
  };
  const bounded = await f.view.request({ lens: "app", operation: "status" });
  assert.equal(bounded.status, "complete");
  assert.equal(bounded.result.route.description.length, 2048);
  assert.equal(bounded.result.route.reason.length, 128);
  for (const changes of [{ description: "d".repeat(2049) }, { operation: {} },
    { correlation: "c".repeat(129) }, { legacyAgentId: "x".repeat(257) }, { agentRegistrationVersion: 4 }]) {
    f.model.mutateTool = (output, request) => {
      const result = nativeSemanticOutput(output, request);
      Object.assign(result.route, changes);
      return result;
    };
    assert.equal((await f.view.request({ lens: "app", operation: "status" })).error.code, "semantic_invalid_response");
  }
});

test("all shared App MCP reads expose projected native routes and no unreceived metadata", async (t) => {
  const f = await fixture();
  f.model.mutateTool = (output, request) => withPrivateRouteBlobs(nativeSemanticOutput(output, request));
  const dispatcher = await createAilohaMcpDispatcher({
    binding: { scope: f.view.scope, contextRef: f.view.context.contextRef,
      scopeEpoch: f.view.context.scopeEpoch, ownerProcessId: process.pid },
    createSemanticInspection: () => f.view.createInspection(),
    createBackend() { throw new Error("App route projection cannot acquire a device backend."); },
  });
  t.after(() => dispatcher.dispose());
  for (const name of ["mobile_app_tree", "mobile_app_query", "mobile_app_status"]) {
    const response = await dispatcher.handle({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: name === "mobile_app_query" ? { text: "native" } : {} } });
    assert.notEqual(response.result.isError, true);
    checkPublicRoute(response.result.structuredContent.result.route, f.view.context, true);
    assert.equal(JSON.stringify(response).includes(privateRouteMarker), false);
    assert.equal(Object.hasOwn(response.result, "_meta"), false);
    assert.equal(Object.hasOwn(response.result.structuredContent.result, "_meta"), false);
  }
});

test("real SDK stdio success keeps received sanitized metadata while separately projecting the raw native route", async (t) => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  mkdirSync(join(root, ".build"), { recursive: true });
  const scratch = mkdtempSync(join(root, ".build/native-route-stdio-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const responsePath = join(scratch, "response.json");
  const pin = { version: "synthetic-only", sourceSha: "a".repeat(40) };
  const sdk = { async getVerifiedCliLaunch() {
    return { ...pin, file: process.execPath,
      args: [join(root, "tests/scripts/fixtures/semantic-mcp-server.mjs"), "--fixture-metadata", responsePath] };
  } };
  const f = await fixture((request) => callSemanticTool({ ...request, sdk, pin }));
  const snapshot = await f.view.store.readSnapshot();
  const meta = nativeInvocationMetadata(snapshot, f.view.scope, exchangeOutcome({
    completed: true, effectMayBeUnknown: false, errorCode: undefined,
  }));
  const body = withPrivateRouteBlobs(nativeSemanticOutput({ elements: [], route: { owner: "agent",
    ...snapshot.selection, executionContext: meta["ailoha.executionContext"] } }, { name: "app_query" }));
  writeFileSync(responsePath, JSON.stringify({ isError: false, content: [{ type: "text", text: "Native-shaped fixture result" }],
    structuredContent: body, _meta: meta }));
  const dispatcher = await createAilohaMcpDispatcher({
    binding: { scope: f.view.scope, contextRef: f.view.context.contextRef,
      scopeEpoch: f.view.context.scopeEpoch, ownerProcessId: process.pid },
    createSemanticInspection: () => f.view.createInspection(),
    createBackend() { throw new Error("App query cannot acquire a device backend."); },
  });
  t.after(() => dispatcher.dispose());
  const response = await dispatcher.handle({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "mobile_app_query", arguments: { text: "native" } } });
  assert.notEqual(response.result.isError, true);
  checkPublicRoute(response.result.structuredContent.result.route, f.view.context, true);
  assert.deepEqual(Object.keys(response.result._meta["ailoha.executionContext"]).sort(), [...contextKeys].sort());
  assert.equal(response.result._meta["ailoha.agentExchange"].completed, true);
  assert.equal(response.result._meta["ailoha.agentExchange"].effectMayBeUnknown, false);
  assert.equal(JSON.stringify(response).includes(privateRouteMarker), false);
});

test("owned GitHub HTTP panel serves the same native App/System projection", async (t) => {
  const f = await fixture();
  f.model.mutateTool = (output, request) => withPrivateRouteBlobs(nativeSemanticOutput(output, request));
  const host = createAilohaCanvasHost({
    scope: f.view.scope, semanticInspection: f.view.controller,
    createBackend() {
      return { closed: false, async ready() {}, async dispose() {}, async closeVideos() {},
        request() { throw new Error("Semantic reads must not call a device backend route."); } };
    },
  });
  t.after(() => host.closeCanvas());
  const opened = new URL((await host.openCanvas()).url);
  const secret = new URLSearchParams(opened.hash.slice(1)).get("bootstrap");
  const grant = await fetch(new URL("/api/v1/auth/bootstrap", opened), {
    method: "POST", body: JSON.stringify({ secret, sessionId: f.view.scope.sessionId, instanceId: f.view.scope.viewId }),
  });
  const cookie = grant.headers.get("set-cookie").split(";", 1)[0];
  for (const lens of ["app", "system"]) {
    const response = await fetch(new URL("/api/v1/semantic/inspection", opened), {
      method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ lens, operation: "tree" }),
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    checkPublicRoute(state.result.route, f.view.context, lens === "app");
    assert.equal(JSON.stringify(state).includes(privateRouteMarker), false);
    assert.equal(Object.hasOwn(state.result, "_meta"), false);
  }
});

test("a late native-shaped success cannot restore a retired view or publish private route evidence", async () => {
  const f = await fixture();
  let entered;
  let release;
  const waiting = new Promise((resolve) => { entered = resolve; });
  f.model.beforeTool = () => new Promise((resolve) => { release = resolve; entered(); });
  f.model.mutateTool = (output, request) => withPrivateRouteBlobs(nativeSemanticOutput(output, request));
  const pending = f.view.request({ lens: "app", operation: "tree" });
  await waiting;
  f.view.controller.setVisible(false);
  release();
  const state = await pending;
  assert.equal(state, f.view.controller.snapshot());
  assert.equal(state.status, "suspended");
  assert.equal(state.result, null);
  assert.equal(state.selection, null);
  assert.equal(state.appAvailable, false);
  assert.equal(JSON.stringify(state).includes(privateRouteMarker), false);
});
