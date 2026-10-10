import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { productModule } from "../ailoha-test-module.mjs";

const { createSemanticInspectionController } = await import(productModule("lib/ailoha/semantic-inspection.mjs"));
const { callSemanticTool } = await import(productModule("lib/ailoha/semantic-mcp.mjs"));
const { createAilohaCanvasHost } = await import(productModule("lib/ailoha/canvas-host.mjs"));
const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures/semantic-mcp-server.mjs");
const scope = { sessionId: "test-session", viewId: "test-view" };
const selection = { targetHostId: "host-1", targetId: "target-1", surfaceId: "surface-1" };
let revision = "1";
let current = selection;
const snapshot = () => ({
  state: "open", selection: current,
  identity: { scopeEpoch: "epoch-1", revision },
  contextProjection: { contextRef: "ctx-1", scopeEpoch: "epoch-1", revision,
    ownerProcessId: process.pid, processStartedAt: "2026-10-09T00:00:00Z",
    runtimeInstanceEvidence: current.runtimeInstanceId ? "verified-native-instance" : "unsupported" },
});
const sdk = {
  async getVerifiedCliLaunch() {
    return { file: process.execPath, args: [fixture], version: "1", sourceSha: "a".repeat(40) };
  },
};
const pin = { version: "1", sourceSha: "a".repeat(40) };

function controller() {
  return createSemanticInspectionController({
    scope, readSnapshot: async () => snapshot(),
    callTool: (request) => callSemanticTool({ ...request, sdk, pin }),
  });
}

test("real stdio MCP initializes, lists, calls and returns bounded Target Host provenance", async () => {
  current = selection;
  revision = "1";
  const result = await controller().request("POST", JSON.stringify({ lens: "system", operation: "tree", maxDepth: 3 }));
  assert.equal(result.status, "complete");
  assert.equal(result.result.route.owner, "target-host");
  assert.equal(result.result.route.executionContext.revision, "1");
  assert.equal(result.result.elements[0].children[0].id, "button");
});

test("App requires a selected native instance and never falls back after a canonical error", async () => {
  current = selection;
  const unavailable = await controller().request("POST", JSON.stringify({ lens: "app", operation: "tree" }));
  assert.equal(unavailable.error.code, "semantic_app_unavailable");
  current = { ...selection, agentId: "agent-1", runtimeInstanceId: "runtime-1" };
  const view = controller();
  const status = await view.request("POST", JSON.stringify({ lens: "app", operation: "status" }));
  assert.equal(status.status, "complete");
  assert.equal(status.result.route.runtimeInstanceId, "runtime-1");
  const pid = Number(status.result.status.agentName);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const failure = await view.request("POST", JSON.stringify({ lens: "app", operation: "query", text: "error" }));
  assert.equal(failure.status, "error");
  assert.equal(failure.result, null);
  assert.equal(failure.error.code, "CanonicalCapabilityUnsupported");
  assert.match(failure.error.message, /CanonicalCapabilityUnsupported/);
});

test("canonical query uses literal bounded filters and keeps element IDs in their owning lens", async () => {
  current = selection;
  revision = "1";
  const result = await controller().request("POST", JSON.stringify({
    lens: "system", operation: "query", type: "Button", automationId: "submit", text: "OK",
  }));
  assert.equal(result.status, "complete");
  assert.equal(result.result.route.owner, "target-host");
  assert.equal(result.result.elements[0].id, "root");
  await assert.rejects(controller().request("POST", JSON.stringify({ lens: "system", operation: "query" })),
    { code: "semantic_invalid_request" });
});

test("context revision, cancellation and mismatched owner retire read results", async () => {
  current = { ...selection, runtimeInstanceId: "runtime-1" };
  revision = "1";
  const view = controller();
  const waiting = view.request("POST", JSON.stringify({ lens: "app", operation: "query", text: "wait" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  view.invalidate();
  const retired = await waiting;
  assert.equal(retired.result, null);
  const read = view.request("POST", JSON.stringify({ lens: "system", operation: "tree" }));
  revision = "2";
  const changed = await read;
  assert.equal(changed.error.code, "semantic_context_superseded");
  current = selection;
  revision = "1";
  const bad = await createSemanticInspectionController({
    scope, readSnapshot: async () => snapshot(),
    callTool: async () => ({
      elements: [], route: { owner: "agent", targetHostId: "host-1", targetId: "target-1" },
    }),
  }).request("POST", JSON.stringify({ lens: "system", operation: "tree" }));
  assert.equal(bad.error.code, "semantic_route_mismatch");
});

test("an old pending GET cannot repopulate a newly selected or suspended view", async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const view = createSemanticInspectionController({
    scope, readSnapshot: () => waiting, callTool() { throw new Error("GET must not invoke MCP."); },
  });
  const read = view.request("GET");
  view.invalidate();
  release(snapshot());
  assert.equal((await read).selection, null);
  assert.equal(view.snapshot().result, null);
  view.setVisible(false);
  assert.equal(view.snapshot().status, "suspended");
});

test("bounded input and no read methods can invoke mutation tools", async () => {
  const view = controller();
  await assert.rejects(view.request("POST", JSON.stringify({ lens: "system", operation: "tap" })),
    { code: "semantic_invalid_request" });
  await assert.rejects(callSemanticTool({ sdk, pin, context: {}, name: "app_tap" }), { code: "semantic_tool_unsupported" });
});

test("GitHub App owned panel serves the same semantic read route and invalidates selection", async (t) => {
  current = selection;
  revision = "1";
  const semanticInspection = controller();
  let announce;
  const host = createAilohaCanvasHost({
    scope, semanticInspection,
    async createBackend({ onEvent }) {
      announce = onEvent;
      return {
        closed: false, async ready() {}, async dispose() {}, async closeVideos() {},
        async request() { return new Response("{}"); },
      };
    },
  });
  t.after(() => host.closeCanvas());
  const opened = await host.openCanvas();
  const url = new URL(opened.url);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const grant = await fetch(new URL("/api/v1/auth/bootstrap", url), {
    method: "POST", body: JSON.stringify({
      secret: fragment.get("bootstrap"), sessionId: scope.sessionId, instanceId: scope.viewId,
    }),
  });
  const cookie = grant.headers.get("set-cookie").split(";", 1)[0];
  const request = (method, body) => fetch(new URL("/api/v1/semantic/inspection", url), {
    method, headers: { Cookie: cookie }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const response = await request("POST", { lens: "system", operation: "tree" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.route.owner, "target-host");
  announce({ kind: "selection", deviceId: "other" });
  assert.equal(semanticInspection.snapshot().result, null);
  const unsupported = await fetch(new URL("/api/v1/semantic/not-a-route", url), { headers: { Cookie: cookie } });
  assert.equal(unsupported.status, 400);
});
