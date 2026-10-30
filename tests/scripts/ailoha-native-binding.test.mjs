import assert from "node:assert/strict";
import test from "node:test";
import { createNativeBindingFixture, nativeAgent } from "./fixtures/ailoha-native-binding.mjs";
import { productModule } from "../ailoha-test-module.mjs";

const { createVerifiedAilohaCli } = await import(productModule("lib/ailoha/runtime-sdk.mjs"));
const { createAilohaCanvasHost } = await import(productModule("lib/ailoha/canvas-host.mjs"));
const { readNativeAgentCandidates } = await import(productModule("lib/ailoha/semantic-mcp.mjs"));

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

test("v1 legacy2 and v2 native3/mixed candidates bind exact identities without projecting transport authority", async () => {
  for (const versions of [[2], [3], [2, 3]]) {
    const fixture = createNativeBindingFixture({ registrations: versions.map((version) =>
      nativeAgent(`runtime-${version}`, "target", { registrationVersion: version,
        endpointScope: "target-guest", port: 54321, connectionRef: { token: "must-not-project" } })) });
    const view = await fixture.createView();
    const evidence = await discover(view);
    assert.equal(evidence.error, null);
    assert.deepEqual(evidence.binding.candidates.map((candidate) => candidate.registrationVersion), versions);
    assert.equal(evidence.appAvailable, false);
    assert.match(evidence.binding.message, /advertisements only/i);
    assert.doesNotMatch(JSON.stringify(evidence), /"(?:endpointScope|port|connectionRef)"|must-not-project/);
    const selected = await bind(view, evidence, versions.length - 1);
    assert.equal(selected.selection.agentId, `agent-runtime-${versions.at(-1)}`);
    assert.equal(selected.appAvailable, true);
    const write = fixture.calls.find((args) => args[1] === "select");
    const intent = JSON.parse(write[write.indexOf("--request-json") + 1]);
    assert.deepEqual(intent.selection, { workspaceId: null, applicationId: null,
      targetHostId: "host", targetId: "target", surfaceId: "surface",
      agentId: selected.selection.agentId, runtimeInstanceId: selected.selection.runtimeInstanceId });
    assert.equal(Object.hasOwn(intent.selection, "registrationVersion"), false);
  }
});

test("another target's v3 inventory does not change iOS/v2 or genuine empty selected-pair discovery", async () => {
  const fixture = createNativeBindingFixture({ registrations: [
    nativeAgent("ios", "ios"), nativeAgent("rn-android", "android", { registrationVersion: 3 }),
  ] });
  for (const [target, versions] of [["ios", [2]], ["android", [3]], ["empty", []]]) {
    const view = await fixture.createView(target, target);
    const result = await discover(view);
    assert.equal(result.error, null);
    assert.deepEqual(result.binding.candidates.map((candidate) => candidate.registrationVersion), versions);
    assert.equal(result.appAvailable, false);
  }
  fixture.model.registrations.push(nativeAgent("rn-android", "another", { registrationVersion: 3 }));
  const ios = await fixture.createView("ios-duplicate", "ios");
  assert.equal((await discover(ios)).error.code, "AgentCandidatesAmbiguous");
  fixture.model.registrations = [nativeAgent("future", "another", { registrationVersion: 4 })];
  assert.equal((await discover(ios)).error.code, "AgentCandidatesInventoryInvalid");
});

test("candidate schemas reject future versions, mismatched envelopes, missing fields and private authority", async () => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("native", "target", { registrationVersion: 3 })] });
  const view = await fixture.createView();
  for (const mutate of [
    (value) => ({ ...value, schema: "ailoha.agent.candidates/v1" }),
    (value) => ({ ...value, schema: "ailoha.agent.candidates/v3" }),
    (value) => ({ ...value, candidates: [] }),
    (value) => ({ ...value, candidates: [{ ...value.candidates[0], registrationVersion: 2 }] }),
    (value) => ({ ...value, candidates: [{ ...value.candidates[0], registrationVersion: 4 }] }),
    (value) => ({ ...value, candidates: [{ ...value.candidates[0], registrationVersion: "3" }] }),
    (value) => ({ ...value, candidates: [{ ...value.candidates[0], targetHostId: "other" }] }),
    (value) => ({ ...value, candidates: [{ ...value.candidates[0], targetId: "other" }] }),
    (value) => ({ ...value, candidates: [{ ...value.candidates[0], agentId: "agent-another" }] }),
    (value) => ({ ...value, candidates: [{ ...value.candidates[0], runtimeInstanceId: "x".repeat(129) }] }),
    (value) => ({ ...value, candidates: [null] }),
    (value) => ({ ...value, candidates: [value.candidates[0], value.candidates[0]] }),
    (value) => ({ ...value, candidates: Array(257).fill(value.candidates[0]) }),
    (value) => ({ ...value, error: undefined }),
    ...["port", "currentPort", "endpointScope", "endpoint", "owner", "connectionRef", "serial", "transport"].map((key) =>
      (value) => ({ ...value, candidates: [{ ...value.candidates[0], [key]: "must-not-project" }] })),
    (value) => ({ ...value, owner: "must-not-project" }),
  ]) {
    fixture.model.mutateInventory = mutate;
    const failed = await discover(view);
    assert.equal(failed.error.code, "semantic_candidates_invalid");
    assert.equal(failed.binding.candidates, null);
    assert.equal(failed.appAvailable, false);
    assert.doesNotMatch(JSON.stringify(failed), /must-not-project/);
  }
  assert.equal(fixture.calls.some((args) => args[1] === "select"), false);
});

test("raw duplicate and escaped-alias candidate/error properties cannot overwrite target, identity or version", async () => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("native", "target", { registrationVersion: 3 })] });
  const view = await fixture.createView();
  for (const [key, alias, first, last] of [
    ["schema", "sche\\u006da", "ailoha.agent.candidates/v1", "ailoha.agent.candidates/v2"],
    ["targetId", "target\\u0049d", "other", "target"],
    ["runtimeInstanceId", "runtimeInstance\\u0049d", "other", "native"],
    ["registrationVersion", "registration\\u0056ersion", 4, 3],
  ]) {
    for (const wireKey of [key, alias]) {
      fixture.model.mutateInventoryText = (raw) => raw.replace(
        `${JSON.stringify(key)}:${JSON.stringify(last)}`,
        `${JSON.stringify(key)}:${JSON.stringify(first)},"${wireKey}":${JSON.stringify(last)}`);
      const failed = await discover(view);
      assert.equal(failed.error.code, "semantic_candidates_invalid", wireKey);
      assert.equal(failed.binding.candidates, null);
    }
  }
  fixture.model.inventoryError = "AgentCandidatesBrokerUnavailable";
  for (const wireKey of ["code", "co\\u0064e"]) {
    fixture.model.mutateInventoryText = (raw) => raw.replace('"code":"AgentCandidatesBrokerUnavailable"',
      `"code":"AgentCandidatesInventoryInvalid","${wireKey}":"AgentCandidatesBrokerUnavailable"`);
    assert.equal((await discover(view)).error.code, "semantic_candidates_invalid");
  }
  fixture.model.inventoryError = null;
  fixture.model.mutateInventoryText = (raw) => raw.replace('"error":null', '"error":{"a":{"b":{"c":null}}}');
  assert.equal((await discover(view)).error.code, "semantic_candidates_invalid");
  fixture.model.mutateInventoryText = (raw) => raw.replace('"error":null',
    `"error":${"[".repeat(1024)}null${"]".repeat(1024)}`);
  assert.equal((await discover(view)).error.code, "semantic_candidates_invalid");
  fixture.model.mutateInventoryText = null;
  assert.equal((await discover(view)).binding.candidates[0].registrationVersion, 3);
  for (const number of ["3.0", "3e0"]) {
    fixture.model.mutateInventoryText = (raw) => raw.replace('"registrationVersion":3', `"registrationVersion":${number}`);
    assert.equal((await discover(view)).binding.candidates[0].registrationVersion, 3);
  }
  fixture.model.mutateInventoryText = null;
  fixture.model.inventoryError = "AgentCandidatesBrokerUnavailable";
  fixture.model.mutateInventory = (value) => ({ ...value, error: { ...value.error,
    message: 'Literal {"code":1,"code":2}, escaped quote " and slash \\ are text, not property tokens.' } });
  assert.equal((await discover(view)).error.code, "AgentCandidatesBrokerUnavailable");
  assert.equal(fixture.calls.some((args) => args[1] === "select"), false);
  assert.deepEqual(view.toolCalls, []);
});

test("candidate target/count/byte bounds are exact at the shared adapter boundary", async () => {
  const targetHostId = "h".repeat(128);
  const targetId = "t".repeat(128);
  const result = { schema: "ailoha.agent.candidates/v2", ok: true, targetHostId, targetId, error: null,
    candidates: Array.from({ length: 256 }, (_, i) => ({
      agentId: `agent-${String(i).padStart(128, "r")}`, runtimeInstanceId: String(i).padStart(128, "r"),
      registrationVersion: i === 255 ? 3 : 2, targetHostId, targetId,
    })) };
  let raw = JSON.stringify(result);
  const read = (selection = { targetHostId, targetId }) => readNativeAgentCandidates({
    snapshot: { selection }, runCli: async (args) => args[0] === "commands"
      ? JSON.stringify([{ command: "agent candidates", description: "Synthetic", mutating: false }]) : raw,
  });
  assert.equal((await read()).candidates.length, 256);
  const bounded = raw;
  raw = bounded.padEnd(512 * 1024, " ");
  assert.equal((await read()).candidates.length, 256);
  raw += " ";
  await assert.rejects(read(), { code: "semantic_candidates_invalid" });
  for (const invalidId of ["", ".", "..", " ", "h".repeat(129), "bad\u0000host", "bad\u0085host", "\ud800"]) {
    raw = JSON.stringify({ ...result, schema: "ailoha.agent.candidates/v1", targetHostId: invalidId, candidates: [] });
    await assert.rejects(read({ targetHostId: invalidId, targetId }), { code: "semantic_candidates_invalid" });
  }
  raw = `${bounded}${" ".repeat(512 * 1024)}`;
  await assert.rejects(read(), { code: "semantic_candidates_invalid" });
  raw = "{";
  await assert.rejects(read(), { code: "semantic_candidates_invalid" });
});

test("both candidate success schemas keep failures v1 and never turn malformed errors into empty discovery", async () => {
  for (const registrationVersion of [2, 3]) {
    const fixture = createNativeBindingFixture({ registrations: [nativeAgent("native", "target", { registrationVersion })] });
    const view = await fixture.createView();
    fixture.model.inventoryError = "AgentCandidatesBrokerUnavailable";
    assert.equal((await discover(view)).error.code, "AgentCandidatesBrokerUnavailable");
    fixture.model.mutateInventory = (value) => ({ ...value, targetHostId: null, targetId: null,
      error: { code: "AgentCandidatesRequestInvalid", message: "Invalid selectors" } });
    assert.equal((await discover(view)).error.code, "AgentCandidatesRequestInvalid");
    for (const mutate of [
      (value) => ({ ...value, schema: "ailoha.agent.candidates/v2" }),
      (value) => ({ ...value, candidates: [] }),
      (value) => ({ ...value, candidates: undefined }),
      (value) => ({ ...value, error: { code: "AgentCandidatesBrokerUnavailable" } }),
      (value) => ({ ...value, error: { ...value.error, owner: "must-not-project" } }),
      (value) => ({ ...value, error: { code: "FutureFailure", message: "Unknown" } }),
      (value) => ({ ...value, error: { ...value.error, message: "x".repeat(2049) } }),
      (value) => ({ ...value, targetHostId: null, targetId: null }),
      (value) => ({ ...value, targetId: "wrong" }),
      (value) => ({ ...value, targetHostId: undefined }),
    ]) {
      fixture.model.mutateInventory = mutate;
      const failed = await discover(view);
      assert.equal(failed.error.code, "semantic_candidates_invalid");
      assert.equal(failed.binding.discovery, "error");
      assert.equal(failed.binding.candidates, null);
    }
  }
});

test("native3 canonical binding refuses unsupported, stale and unverified evidence without replay or fallback", async () => {
  for (const [code, status] of [["AgentTransportUnsupported", 501], ["unsupported-capability", 501],
    ["AgentTransportStale", 409], ["AgentInstanceUnverified", 409]]) {
    const fixture = createNativeBindingFixture({ registrations: [
      nativeAgent("native", "target", { registrationVersion: 3, transportError: code }),
    ] });
    const view = await fixture.createView();
    const failed = await bind(view, await discover(view));
    assert.equal(failed.error.code, code);
    assert.equal(failed.error.status, status);
    assert.equal(failed.appAvailable, false);
    assert.equal(view.context.selection.runtimeInstanceId, null);
    assert.equal(fixture.calls.filter((args) => args[1] === "select").length, 1);
    assert.doesNotMatch(JSON.stringify(failed), /must-not-project/);
    assert.equal((await view.request({ lens: "system", operation: "tree" })).result.route.owner, "target-host");
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

test("verified CLI preserves only strict v1 candidate failure stderr on exit 1, including selected v3 failures", async () => {
  const pin = { version: "synthetic-only", sourceSha: "a".repeat(40) };
  const failure = { schema: "ailoha.agent.candidates/v1", ok: false, targetHostId: "host", targetId: "target",
    candidates: null, error: { code: "AgentCandidatesBrokerUnavailable", message: "Synthetic failure" } };
  const failureText = JSON.stringify(failure);
  const successText = JSON.stringify({ ...failure, schema: "ailoha.agent.candidates/v2", ok: true, error: null,
    candidates: [{ agentId: "agent-native", runtimeInstanceId: "native", registrationVersion: 3,
      targetHostId: "host", targetId: "target" }] });
  for (const [code, shape, accepted] of [
    [1, failure, true],
    [1, { ...failure, targetHostId: null, targetId: null,
      error: { code: "AgentCandidatesRequestInvalid", message: "Invalid selectors" } }, true],
    [2, failure, false],
    [1, { ...failure, schema: "ailoha.agent.candidates/v2" }, "invalid"],
    [1, { ...failure, schema: "ailoha.agent.candidates/v3" }, "invalid"],
    [1, { ...failure, candidates: [] }, "invalid"],
    [1, { ...failure, targetId: "other" }, "invalid"],
    [1, { ...failure, connectionRef: {} }, "invalid"],
    [1, { ...failure, error: { code: failure.error.code } }, "invalid"],
    [1, { ...failure, ok: true, error: null, candidates: [] }, false],
    [1, { ...failure, schema: "ailoha.agent.candidates/v2", ok: true, error: null,
      candidates: [{ agentId: "agent-native", runtimeInstanceId: "native",
        registrationVersion: 3, targetHostId: "host", targetId: "target" }] }, false],
    ...[
      failureText.replace('"schema":', '"schema":"ailoha.agent.candidates/v2","schema":'),
      failureText.replace('"schema":', '"schema":"ailoha.agent.candidates/v2","sche\\u006da":'),
      failureText.replace('"targetId":', '"targetId":"other","targetId":'),
      failureText.replace('"targetId":', '"targetId":"other","target\\u0049d":'),
      failureText.replace('"code":', '"code":"AgentCandidatesInventoryInvalid","code":'),
      failureText.replace('"code":', '"code":"AgentCandidatesInventoryInvalid","co\\u0064e":'),
      successText.replace('"runtimeInstanceId":', '"runtimeInstanceId":"other","runtimeInstanceId":'),
      successText.replace('"runtimeInstanceId":', '"runtimeInstanceId":"other","runtimeInstance\\u0049d":'),
      successText.replace('"registrationVersion":3', '"registrationVersion":4,"registrationVersion":3'),
      successText.replace('"registrationVersion":3', '"registrationVersion":4,"registration\\u0056ersion":3'),
    ].map((raw) => [1, raw, "invalid"]),
    [1, { ok: false, error: { code: "private" } }, false],
  ]) {
    const cli = createVerifiedAilohaCli({ pin, sdk: {
      async getVerifiedCliLaunch() {
        return { ...pin, file: process.execPath, args: ["-e",
          `process.stderr.write(${JSON.stringify(typeof shape === "string" ? shape : JSON.stringify(shape))});process.exit(${code})`, "--"] };
      },
    } });
    const work = cli(["agent", "candidates", "--target-host", "host", "--target", "target", "--json"]);
    if (accepted === true) assert.deepEqual(JSON.parse(await work), shape);
    else await assert.rejects(work, { code: accepted === "invalid" ? "semantic_candidates_invalid" : "ailoha_cli_failed" });
  }
});

for (const registrationVersion of [2, 3]) test(`GitHub owned HTTP panel binds and clears native v${registrationVersion} in the canonical view, not a device or another panel`, async (t) => {
  const fixture = createNativeBindingFixture({ registrations: [nativeAgent("one"), nativeAgent("two", "target", { registrationVersion })] });
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
  assert.deepEqual(evidence.binding.candidates.map((candidate) => candidate.registrationVersion), [2, registrationVersion]);
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

test("tampered successful binding replies are rejected before document adoption or listener emission", async () => {
  for (const tamper of [
    (reply) => { reply.selection.targetHostId = "invalid-host"; },
    (reply) => { reply.selection.targetId = "invalid-target"; },
    (reply) => { reply.selection.surfaceId = "invalid-surface"; },
    (reply) => { reply.selection.agentId = "agent-invalid"; },
    (reply) => { reply.selection.runtimeInstanceId = "invalid-runtime"; },
    (reply) => { reply.owner.processStartedAt = "invalid-owner-birth"; },
    (reply) => { reply.observed.hostInstanceId = "invalid-host-incarnation"; },
    (reply) => { reply.observed.runtimeInstanceEvidence = "unsupported"; },
    (reply) => { reply.observed.applicationEvidence = "invalid-application-evidence"; },
  ]) {
    const fixture = createNativeBindingFixture({ registrations: [nativeAgent("exact")] });
    const view = await fixture.createView();
    const evidence = await discover(view);
    const original = await view.store.readSnapshot();
    const observations = [];
    const states = [];
    const unsubscribe = view.store.onChange(() => observations.push(view.store.contextProjection));
    const unsubscribeState = view.controller.subscribe((state) => states.push(state));
    fixture.model.tamperSelectReply = (reply) => { tamper(reply); return reply; };
    const rejected = await bind(view, evidence);
    assert.equal(rejected.error.code, "semantic_binding_mismatch");
    assert.deepEqual(observations, []);
    assert.deepEqual(view.store.contextProjection, original.contextProjection);
    assert.equal(view.store.isCurrentSnapshot(original), true);
    assert.equal(states.some((state) => JSON.stringify(state.selection).includes("invalid-")), false);
    assert.equal(view.context.selection.targetId, "target");
    assert.equal(view.context.selection.runtimeInstanceId, "exact");
    assert.equal(fixture.calls.filter((call) => call[1] === "select").length, 1);
    fixture.model.tamperSelectReply = null;
    const recovered = await view.controller.request("GET");
    assert.equal(recovered.selection.runtimeInstanceId, "exact");
    assert.equal(recovered.selection.targetId, "target");
    assert.equal(recovered.appAvailable, false);
    assert.equal(fixture.calls.filter((call) => call[1] === "select").length, 1);
    unsubscribe();
    unsubscribeState();
  }
});
