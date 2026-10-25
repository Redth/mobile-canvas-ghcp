import assert from "node:assert/strict";
import test from "node:test";
import { createNativeBindingFixture, nativeAgent } from "./fixtures/ailoha-native-binding.mjs";
import { productModule } from "../ailoha-test-module.mjs";

const { createVerifiedAilohaCli } = await import(productModule("lib/ailoha/runtime-sdk.mjs"));
const { createAilohaCanvasHost } = await import(productModule("lib/ailoha/canvas-host.mjs"));

async function discover(view) {
  const state = await view.controller.request("GET");
  return view.request({ operation: "candidates", bindingToken: state.binding.token });
}
async function bind(view, state, index = 0) {
  return view.request({ operation: "bind", bindingToken: state.binding.token,
    candidateToken: state.binding.candidates[index].token });
}

test("synthetic absent, one and multiple registrations never auto-bind; explicit choice is exact", async () => {
  for (const count of [0, 1, 2]) {
    const fixture = createNativeBindingFixture({
      registrations: Array.from({ length: count }, (_, i) => nativeAgent(`runtime-${i}`)),
    });
    const view = await fixture.createView();
    const result = await discover(view);
    assert.equal(result.binding.discovery, "complete");
    assert.equal(result.binding.candidates.length, count);
    assert.equal(result.appAvailable, false);
    assert.equal(fixture.calls.some((call) => call[1] === "select"), false);
    if (!count) continue;
    const selected = await bind(view, result, count - 1);
    assert.equal(selected.appAvailable, true);
    assert.equal(selected.selection.runtimeInstanceId, `runtime-${count - 1}`);
    const write = fixture.calls.find((call) => call[1] === "select");
    const input = JSON.parse(write[write.indexOf("--request-json") + 1]);
    assert.deepEqual(input.expected, { scopeEpoch: "epoch-view", revision: "0" });
    assert.deepEqual(input.selection, { workspaceId: null, applicationId: null,
      targetHostId: "host", targetId: "target", surfaceId: "surface",
      agentId: `agent-runtime-${count - 1}`, runtimeInstanceId: `runtime-${count - 1}` });
    const mcp = await view.mcpStore().readSnapshot();
    assert.deepEqual(mcp.selection, selected.selection);
    assert.equal(mcp.contextProjection.runtimeInstanceEvidence, "verified-native-instance");
    const app = await view.request({ lens: "app", operation: "status" });
    assert.equal(app.result.route.owner, "agent");
    assert.equal(view.toolCalls[0].arguments.route, "require-agent");
    const cleared = await view.request({ operation: "unbind", bindingToken: app.binding.token });
    assert.equal(cleared.selection.runtimeInstanceId, undefined);
    assert.equal(cleared.selection.targetId, "target");
    const system = await view.request({ lens: "system", operation: "tree" });
    assert.equal(system.result.route.owner, "target-host");
  }
});

test("old preview lacks candidates, never falls back to unsafe enumeration, but exact manual binding works", async () => {
  const fixture = createNativeBindingFixture({ advertised: false, registrations: [nativeAgent("manual")] });
  const view = await fixture.createView();
  const result = await discover(view);
  assert.equal(result.binding.discovery, "unavailable");
  assert.equal(result.binding.candidates, null);
  assert.equal(fixture.calls.some((call) => call[0] === "agent" || call[0] === "broker"), false);
  const selected = await view.request({ operation: "bind", bindingToken: result.binding.token,
    agentId: "agent-manual", runtimeInstanceId: "manual" });
  assert.equal(selected.appAvailable, true);
});

test("wrong target and legacy candidates are omitted; exact IDs still require canonical live verification", async () => {
  const fixture = createNativeBindingFixture({ registrations: [
    nativeAgent("wrong", "other"), nativeAgent("wrong-host", "target", { targetHostId: "other" }),
    nativeAgent("legacy", "target", { registrationVersion: 1 }), nativeAgent("valid"),
  ] });
  const view = await fixture.createView();
  const result = await discover(view);
  assert.deepEqual(result.binding.candidates.map((candidate) => candidate.runtimeInstanceId), ["valid"]);
  for (const [runtime, code] of [["wrong", "AgentTargetCorrelationMismatch"], ["legacy", "AgentInstanceUnverified"],
    ["absent", "AgentNotFound"]]) {
    const current = await view.controller.request("GET");
    const failed = await view.request({ operation: "bind", bindingToken: current.binding.token,
      agentId: `agent-${runtime}`, runtimeInstanceId: runtime });
    assert.equal(failed.error.code, code);
    assert.equal(failed.appAvailable, false);
    assert.doesNotMatch(JSON.stringify(failed), /must-not-project/);
  }
  assert.equal(view.context.selection.runtimeInstanceId, null);
});

test("global duplicate runtime and failed inventory are errors, never successful empty candidates", async () => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("duplicate"), nativeAgent("duplicate", "other")] });
  const view = await fixture.createView();
  const ambiguous = await discover(view);
  assert.equal(ambiguous.error.code, "AgentCandidatesAmbiguous");
  assert.equal(ambiguous.binding.candidates, null);
  assert.equal(ambiguous.binding.discovery, "error");
  fixture.model.registrations = [];
  fixture.model.inventoryError = "AgentCandidatesBrokerUnavailable";
  const failed = await discover(view);
  assert.equal(failed.error.code, "AgentCandidatesBrokerUnavailable");
  assert.equal(failed.binding.candidates, null);
  assert.doesNotMatch(JSON.stringify(failed), /private\/registration|must-not-project/);
});

test("malformed, wrong-pair, duplicate, oversized or private candidate projections fail closed", async () => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("valid")] });
  const view = await fixture.createView();
  for (const mutate of [
    (value) => ({ ...value, targetId: "another-target" }),
    (value) => ({ ...value, candidates: [{ ...value.candidates[0], registrationVersion: 1 }] }),
    (value) => ({ ...value, candidates: [{ ...value.candidates[0], agentId: "legacy-id" }] }),
    (value) => ({ ...value, candidates: [{ ...value.candidates[0], runtimeInstanceId: "invalid.runtime" }] }),
    (value) => ({ ...value, candidates: [{ ...value.candidates[0], port: 1234 }] }),
    (value) => ({ ...value, candidates: [value.candidates[0], value.candidates[0]] }),
    (value) => ({ ...value, candidates: Array(257).fill(value.candidates[0]) }),
    (value) => ({ ...value, error: {} }),
  ]) {
    fixture.model.mutateInventory = mutate;
    const failed = await discover(view);
    assert.equal(failed.error.code, "semantic_candidates_invalid");
    assert.equal(failed.binding.candidates, null);
    assert.equal(fixture.calls.some((call) => call[1] === "select"), false);
  }
});

test("stale advertisement and process restart revoke App without selecting a replacement or falling back", async () => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("original")] });
  const view = await fixture.createView();
  const evidence = await discover(view);
  fixture.model.registrations = [nativeAgent("restarted")];
  const failed = await bind(view, evidence);
  assert.equal(failed.error.code, "AgentNotFound");
  assert.equal(failed.appAvailable, false);
  const newEvidence = await discover(view);
  const selected = await bind(view, newEvidence);
  assert.equal(selected.selection.runtimeInstanceId, "restarted");
  fixture.model.registrations[0].liveRuntimeInstanceId = "another-process";
  const stale = await view.request({ lens: "app", operation: "status" });
  assert.equal(stale.error.code, "AgentInstanceMismatch");
  assert.equal(stale.result, null);
  assert.equal(stale.appAvailable, false);
  assert.equal((await view.controller.request("GET")).appAvailable, false);
  assert.deepEqual(view.toolCalls.map((call) => call.arguments.route), ["require-agent"]);
  const system = await view.request({ lens: "system", operation: "tree" });
  assert.equal(system.result.route.owner, "target-host");
});

test("two named views and the same app on two targets keep evidence, tokens and bindings isolated", async () => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("one", "one"), nativeAgent("two", "two")] });
  const one = await fixture.createView("one", "one");
  const two = await fixture.createView("two", "two");
  const first = await discover(one);
  const second = await discover(two);
  assert.deepEqual(first.binding.candidates.map((candidate) => candidate.runtimeInstanceId), ["one"]);
  assert.deepEqual(second.binding.candidates.map((candidate) => candidate.runtimeInstanceId), ["two"]);
  const crossView = await two.request({ operation: "bind", bindingToken: second.binding.token,
    candidateToken: first.binding.candidates[0].token });
  assert.equal(crossView.error.code, "semantic_binding_superseded");
  assert.equal(fixture.calls.some((call) => call[1] === "select"), false);
  await bind(one, first);
  await bind(two, await discover(two));
  assert.equal(one.context.selection.runtimeInstanceId, "one");
  assert.equal(two.context.selection.runtimeInstanceId, "two");
  await one.store.clear();
  one.controller.invalidate();
  assert.equal((await one.controller.request("GET")).selection, null);
  assert.equal((await two.controller.request("GET")).appAvailable, true);
});

test("target/host/process/revision changes retire undispatched tokens and accepted mismatched evidence", async () => {
  for (const change of [
    (context) => { context.selection.targetId = "new"; },
    (context) => { context.selection.targetHostId = "new-host"; },
    (context) => { context.owner.processStartedAt = "2026-10-25T00:00:01Z"; },
    (context) => { context.observed.hostInstanceId = "new-host-incarnation"; },
    (context) => { context.revision = "9"; },
  ]) {
    const fixture = createNativeBindingFixture({ registrations: [nativeAgent("valid")] });
    const view = await fixture.createView();
    const evidence = await discover(view);
    change(view.context);
    const stale = await bind(view, evidence);
    assert.equal(stale.error.code, "semantic_binding_superseded");
    assert.equal(fixture.calls.some((call) => call[1] === "select"), false);
  }
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("valid")] });
  const view = await fixture.createView();
  const evidence = await discover(view);
  fixture.model.afterSelect = (context) => { context.observed.runtimeInstanceEvidence = "unsupported"; };
  const mismatch = await bind(view, evidence);
  assert.equal(mismatch.error.code, "semantic_binding_mismatch");
  assert.equal((await view.controller.request("GET")).appAvailable, false);
});

test("cancellation, hide and disconnect retire candidate evidence and never replay binding writes", async () => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("valid")] });
  const view = await fixture.createView();
  let release;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  fixture.model.beforeCandidates = async () => {
    started();
    await new Promise((resolve) => { release = resolve; });
  };
  const reading = discover(view);
  await entered;
  view.controller.setVisible(false);
  release();
  const retired = await reading;
  assert.equal(retired.status, "suspended");
  assert.equal(retired.binding.candidates, null);
  view.controller.setVisible(true);
  fixture.model.beforeCandidates = null;
  const evidence = await discover(view);
  fixture.model.disconnected = true;
  const failure = await bind(view, evidence);
  assert.equal(failure.error.code, "ContextOwnerUnavailable");
  assert.equal(failure.appAvailable, false);
  assert.equal(fixture.calls.filter((call) => call[1] === "select").length, 0);
  const disconnected = await view.controller.request("GET");
  assert.equal(disconnected.selection, null);
  assert.equal(disconnected.binding.token, null);
  assert.equal(disconnected.error.code, "ContextOwnerUnavailable");
});

test("verified CLI preserves only the agreed candidate stderr envelope on exit 1", async () => {
  const pin = { version: "synthetic-only", sourceSha: "a".repeat(40) };
  for (const [code, shape, accepted] of [
    [1, { schema: "ailoha.agent.candidates/v1", ok: false, candidates: null, error: { code: "AgentCandidatesBrokerUnavailable" } }, true],
    [2, { schema: "ailoha.agent.candidates/v1", ok: false, candidates: null, error: { code: "AgentCandidatesBrokerUnavailable" } }, false],
    [1, { ok: false, error: { code: "private" } }, false],
  ]) {
    const cli = createVerifiedAilohaCli({ pin, sdk: {
      async getVerifiedCliLaunch() {
        return { ...pin, file: process.execPath, args: ["-e",
          `process.stderr.write(${JSON.stringify(JSON.stringify(shape))});process.exit(${code})`, "--"] };
      },
    } });
    const work = cli(["agent", "candidates", "--target-host", "host", "--target", "target", "--json"]);
    if (accepted) assert.deepEqual(JSON.parse(await work), shape);
    else await assert.rejects(work, { code: "ailoha_cli_failed" });
  }
});

test("GitHub owned HTTP panel binds and clears the canonical view, not a device or another panel", async (t) => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("one"), nativeAgent("two")] });
  const view = await fixture.createView();
  const host = createAilohaCanvasHost({
    scope: view.scope, semanticInspection: view.controller,
    async createBackend() {
      return { closed: false, async ready() {}, async dispose() {}, async closeVideos() {},
        request() { throw new Error("Native binding must not call a device mutation route."); } };
    },
  });
  t.after(() => host.closeCanvas());
  const { url } = await host.openCanvas();
  const base = new URL(url);
  const bootstrap = new URLSearchParams(base.hash.slice(1)).get("bootstrap");
  const grant = await fetch(new URL("/api/v1/auth/bootstrap", base), {
    method: "POST", body: JSON.stringify({ secret: bootstrap, sessionId: view.scope.sessionId, instanceId: view.scope.viewId }),
  });
  const cookie = grant.headers.get("set-cookie").split(";", 1)[0];
  const request = async (method, input) => {
    const response = await fetch(new URL("/api/v1/semantic/inspection", base), {
      method, headers: { Cookie: cookie }, ...(input ? { body: JSON.stringify(input) } : {}),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const initial = await request("GET");
  const evidence = await request("POST", { operation: "candidates", bindingToken: initial.binding.token });
  assert.equal(evidence.binding.candidates.length, 2);
  assert.equal(evidence.appAvailable, false);
  const chosen = await request("POST", { operation: "bind", bindingToken: evidence.binding.token,
    candidateToken: evidence.binding.candidates[1].token });
  assert.equal(chosen.selection.runtimeInstanceId, "two");
  assert.equal((await view.mcpStore().readSnapshot()).selection.runtimeInstanceId, "two");
  const clear = await request("POST", { operation: "unbind", bindingToken: chosen.binding.token });
  assert.equal(clear.selection.targetId, "target");
  assert.equal(clear.appAvailable, false);
  const unauthenticated = await fetch(new URL("/api/v1/semantic/inspection", base), {
    method: "POST", body: JSON.stringify({ operation: "bind", bindingToken: chosen.binding.token,
      agentId: "agent-one", runtimeInstanceId: "one" }),
  });
  assert.equal(unauthenticated.status, 401);
});

test("canonical CAS conflict or uncertain accepted binding is never retried or replaced", async () => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("exact")] });
  const view = await fixture.createView();
  const evidence = await discover(view);
  fixture.model.beforeSelect = () => { view.context.revision = "9"; };
  const conflict = await bind(view, evidence);
  assert.equal(conflict.error.code, "ContextRevisionConflict");
  assert.equal(fixture.calls.filter((call) => call[1] === "select").length, 1);
  fixture.model.beforeSelect = null;
  fixture.model.afterSelect = () => { fixture.model.disconnected = true; };
  const retryEvidence = await discover(view);
  const uncertain = await bind(view, retryEvidence);
  assert.equal(uncertain.error.code, "ContextOwnerUnavailable");
  assert.equal(fixture.calls.filter((call) => call[1] === "select").length, 2);
  fixture.model.disconnected = false;
  const current = await view.controller.request("GET");
  assert.equal(current.selection.runtimeInstanceId, "exact");
  assert.equal(current.appAvailable, false);
  const reverified = await view.request({ lens: "app", operation: "status" });
  assert.equal(reverified.appAvailable, true);
  assert.equal(reverified.result.route.runtimeInstanceId, "exact");
  assert.equal(fixture.calls.filter((call) => call[1] === "select").length, 2);
});

test("cancelling a pending native bind retires its captured intent and reports uncertain delivery", async () => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("exact")] });
  const view = await fixture.createView();
  const evidence = await discover(view);
  let release;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  fixture.model.beforeSelect = async () => {
    started();
    await new Promise((resolve) => { release = resolve; });
  };
  const pending = bind(view, evidence);
  await entered;
  const cancelled = await view.controller.request("DELETE");
  assert.equal(cancelled.error.code, "semantic_binding_cancelled");
  assert.equal(cancelled.appAvailable, false);
  assert.equal(cancelled.binding.token, null);
  release();
  assert.equal((await pending).error.code, "semantic_binding_cancelled");
  assert.equal(view.context.selection.runtimeInstanceId, null);
  assert.equal(fixture.calls.filter((call) => call[1] === "select").length, 1);
});

test("binding needs host-incarnation evidence and never accepts workspace mappings or mixed selectors", async () => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("exact")] });
  const view = await fixture.createView();
  delete view.context.observed.hostInstanceId;
  const read = await view.controller.request("GET");
  const unavailable = await view.request({ operation: "bind", bindingToken: read.binding.token,
    agentId: "agent-exact", runtimeInstanceId: "exact" });
  assert.equal(unavailable.error.code, "semantic_binding_unavailable");
  assert.equal(fixture.calls.some((call) => call[1] === "select"), false);
  for (const extra of [{ applicationId: "workspace-app" }, { targetId: "other" },
    { candidateToken: "another-choice" }, { runtimeInstanceId: "invalid.runtime" }]) {
    await assert.rejects(view.request({ operation: "bind", bindingToken: read.binding.token,
      agentId: "agent-exact", runtimeInstanceId: "exact", ...extra }), { code: "semantic_binding_invalid" });
  }
});
