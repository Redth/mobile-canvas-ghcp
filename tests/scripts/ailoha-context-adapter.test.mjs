import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
const { createAilohaContextStore, getAilohaContextStore } = await import(productModule("lib/ailoha/context-adapter.mjs"));

const scope = { sessionId: "synthetic-live-window", viewId: "synthetic-canvas" };
const document = {
  schema: "ailoha.execution-context/v1", version: 1,
  contextRef: "ctx-104b2b8d422eae1ac5d36b66ea59f122eddbbb6370393cc7d688b1872de0335c",
  scope, scopeEpoch: "0435219057734efaaef0470511230fb0", revision: "0", state: "open",
  owner: { processId: 81027, processStartedAt: "2026-10-10T00:36:44.610198+00:00" },
  selection: null, observed: null,
};
function fixture(options = {}) {
  const calls = [];
  let current = structuredClone(document);
  const runCli = async (args) => {
    calls.push(args);
    if (options.reply) return JSON.stringify(options.reply);
    const requestIndex = args.indexOf("--request-json");
    const input = requestIndex >= 0 ? JSON.parse(args[requestIndex + 1]) : null;
    switch (args[1]) {
      case "open":
        if (calls.length > 1 && current.state === "open") {
          return JSON.stringify({ ok: false, context: null, error: {
            code: "ContextAlreadyOpen", message: "Retire the current authority before reopening it.",
            current: { contextRef: current.contextRef, scopeEpoch: current.scopeEpoch, revision: current.revision, state: "open" },
          } });
        }
        if (current.state !== "open") {
          assert.equal(input.expected.scopeEpoch, current.scopeEpoch);
          assert.equal(input.expected.revision, current.revision);
          current.state = "open";
          current.scopeEpoch = "new-epoch";
          current.revision = "0";
        }
        break;
      case "select":
        if (input.expected.revision !== current.revision) {
          return JSON.stringify({ ok: false, context: null, error: {
            code: "ContextRevisionConflict", message: "Stale intent was not retried.",
            current: { contextRef: current.contextRef, scopeEpoch: current.scopeEpoch, revision: current.revision, state: "open" },
          } });
        }
        current.selection = input.selection;
        current.revision = String(BigInt(current.revision) + 1n);
        break;
      case "detach":
        current.state = "detached";
        current.selection = null;
        current.observed = null;
        current.revision = String(BigInt(current.revision) + 1n);
        break;
    }
    return JSON.stringify({ ok: true, context: current, error: null });
  };
  const store = createAilohaContextStore({ scope, ownerProcessId: 81027, runCli, ...options });
  return {
    store, calls,
    concurrentChange() { current.revision = "9"; },
    externalSelection(targetId) {
      current = { ...current, revision: String(BigInt(current.revision) + 1n),
        selection: { targetHostId: "host", targetId, surfaceId: "surface" } };
    },
    applicationSelection() { current.selection = { applicationId: "app:src/App.csproj" }; },
    nativeSelection() {
      current = { ...current, revision: String(BigInt(current.revision) + 1n),
        selection: { applicationId: null, targetHostId: "host", targetId: "native-target",
          surfaceId: "surface", agentId: "agent-1", runtimeInstanceId: "runtime-1" },
        observed: { runtimeInstanceEvidence: "verified-native-instance" } };
    },
    externalRetirement() {
      current = { ...current, state: "detached", revision: String(BigInt(current.revision) + 1n), selection: null, observed: null };
    },
  };
}

test("exact native-instance context is adopted with its owner process and verified evidence", async () => {
  const { store, nativeSelection } = fixture();
  await store.binding();
  nativeSelection();
  const captured = await store.readSnapshot();
  assert.equal(captured.selection.runtimeInstanceId, "runtime-1");
  assert.equal(captured.selection.agentId, "agent-1");
  assert.equal(captured.contextProjection.processStartedAt, document.owner.processStartedAt);
  assert.equal(captured.contextProjection.runtimeInstanceEvidence, "verified-native-instance");
});

test("real serialized open/get shape is cached as one named trusted view authority", async () => {
  const { store, calls } = fixture();
  const binding = await store.binding();
  assert.equal(binding.contextRef, document.contextRef);
  assert.equal(binding.scopeEpoch, document.scopeEpoch);
  assert.equal(binding.ownerProcessId, 81027);
  assert.deepEqual(store.contextProjection, {
    contextRef: document.contextRef, scopeEpoch: document.scopeEpoch, revision: "0", ownerProcessId: 81027,
    processStartedAt: document.owner.processStartedAt, runtimeInstanceEvidence: "unsupported",
  });
  assert.equal(await store.read(), null);
  assert.equal(calls.filter((args) => args[1] === "open").length, 1);
  assert.equal(calls[1][1], "get");
  assert.equal(calls[1].includes(document.contextRef), true);
});

test("one immutable read snapshot binds selection, canonical projection, identity and state", async () => {
  const state = fixture();
  await state.store.binding();
  await state.store.set({ targetHostId: "host", targetId: "one", surfaceId: "surface" });
  const first = await state.store.readSnapshot();
  assert.deepEqual(first.selection, { targetHostId: "host", targetId: "one", surfaceId: "surface" });
  assert.deepEqual(first.identity, { scopeEpoch: document.scopeEpoch, revision: "1" });
  assert.equal(first.contextProjection.revision, "1");
  assert.equal(first.state, "open");
  for (const value of [first, first.selection, first.identity, first.contextProjection]) assert.equal(Object.isFrozen(value), true);
  assert.equal(state.store.isCurrentSnapshot(first), true);
  state.externalSelection("two");
  assert.equal((await state.store.read()).targetId, "two");
  assert.equal(state.store.isCurrentSnapshot(first), false);
  assert.equal(first.selection.targetId, "one");
  assert.equal(first.contextProjection.revision, "1");
  state.externalRetirement();
  const retired = await state.store.readSnapshot();
  assert.equal(retired.state, "detached");
  assert.equal(retired.selection, null);
  assert.equal(retired.contextProjection, undefined);
  assert.equal(state.store.isCurrentSnapshot(retired), false);
  await state.store.binding();
  const reopened = await state.store.readSnapshot();
  assert.equal(reopened.identity.scopeEpoch, "new-epoch");
  assert.equal(state.store.isCurrentSnapshot(first), false);
  assert.equal(state.store.isCurrentSnapshot(reopened), true);
});

test("selection is complete-tuple CAS with string revisions and no stale intent retries", async () => {
  const state = fixture();
  await state.store.binding();
  const identity = state.store.identity;
  await state.store.set({ targetHostId: "host", targetId: "target", surfaceId: "surface" }, identity);
  const call = state.calls.find((args) => args[1] === "select");
  const request = JSON.parse(call[call.indexOf("--request-json") + 1]);
  assert.deepEqual(request.expected, { scopeEpoch: document.scopeEpoch, revision: "0" });
  assert.deepEqual(request.selection, {
    workspaceId: null, applicationId: null, targetHostId: "host", targetId: "target", surfaceId: "surface",
    agentId: null, runtimeInstanceId: null,
  });
  state.concurrentChange();
  await assert.rejects(state.store.set({ targetHostId: "host", targetId: "other" }, state.store.identity), (error) => {
    assert.equal(error.code, "ContextRevisionConflict");
    assert.equal(error.contextIdentity.revision, "9");
    return true;
  });
  assert.equal(state.calls.filter((args) => args[1] === "select").length, 2);
});

test("a delayed accepted selection result cannot roll back a newer observed canonical snapshot", async () => {
  let releaseWrite;
  let writeStarted;
  const entered = new Promise((resolve) => { writeStarted = resolve; });
  let current = structuredClone(document);
  const calls = [];
  const store = createAilohaContextStore({
    scope, ownerProcessId: 81027,
    async runCli(args) {
      calls.push(args);
      if (args[1] === "select") {
        const input = JSON.parse(args[args.indexOf("--request-json") + 1]);
        current = { ...current, revision: "1", selection: input.selection };
        const accepted = JSON.stringify({ ok: true, context: current, error: null });
        writeStarted();
        await new Promise((resolve) => { releaseWrite = resolve; });
        return accepted;
      }
      return JSON.stringify({ ok: true, context: current, error: null });
    },
  });
  await store.binding();
  const pending = store.set({ targetHostId: "host", targetId: "one" }, store.identity);
  const rejected = assert.rejects(pending, { code: "context_write_superseded" });
  await entered;
  current = { ...current, revision: "2", selection: { targetHostId: "host", targetId: "two" } };
  const latest = await store.readSnapshot();
  releaseWrite();
  await rejected;
  assert.equal(store.isCurrentSnapshot(latest), true);
  assert.equal(store.contextProjection.revision, "2");
  assert.equal((await store.read()).targetId, "two");
  assert.equal(calls.filter((args) => args[1] === "select").length, 1);
});

test("explicit detach tombstones selection; reopen uses exact prior identity and a new epoch", async () => {
  const { store, calls } = fixture();
  await store.binding();
  await store.set({ targetHostId: "host", targetId: "target" });
  await store.clear();
  assert.equal(await store.read(), null);
  assert.equal(calls.filter((args) => args[1] === "open").length, 1);
  await store.binding();
  const reopening = calls.filter((args) => args[1] === "open")[1];
  const request = JSON.parse(reopening[reopening.indexOf("--request-json") + 1]);
  assert.deepEqual(request.expected, { scopeEpoch: document.scopeEpoch, revision: "2" });
  assert.equal((await store.binding()).scopeEpoch, "new-epoch");
});

test("unbound reads and repeated detach never open or resurrect authority", async () => {
  const state = fixture();
  await assert.rejects(state.store.read(), { code: "context_not_bound" });
  assert.equal(state.calls.length, 0);
  await state.store.binding();
  await state.store.clear();
  await state.store.clear();
  assert.equal(await state.store.read(), null);
  await assert.rejects(state.store.binding({ allowReopen: false }), { code: "context_retired" });
  assert.equal(state.calls.filter((args) => args[1] === "open").length, 1);
  assert.equal(state.calls.filter((args) => args[1] === "detach").length, 1);
});

test("read-only binding discovery cannot create authority before a trusted view opens", async () => {
  const state = fixture();
  await assert.rejects(state.store.binding({ allowCreate: false, allowReopen: false }), { code: "context_not_bound" });
  assert.equal(state.calls.length, 0);
  const opened = await state.store.binding();
  assert.deepEqual(await state.store.binding({ allowCreate: false, allowReopen: false }), opened);
  assert.equal(state.calls.filter((args) => args[1] === "open").length, 1);
  assert.equal(state.calls.at(-1)[1], "get");
  await state.store.clear();
  await assert.rejects(state.store.binding({ allowCreate: false, allowReopen: false }), { code: "context_retired" });
  assert.equal(state.calls.filter((args) => args[1] === "open").length, 1);
  assert.equal(state.calls.filter((args) => args[1] === "detach").length, 1);
});

test("an externally retired empty authority no longer projects an open context binding", async () => {
  const state = fixture();
  await state.store.binding();
  assert.equal(state.store.contextProjection.contextRef, document.contextRef);
  state.externalRetirement();
  assert.equal(await state.store.read(), null);
  assert.equal(state.store.state, "detached");
  assert.equal(state.store.contextProjection, undefined);
  assert.equal(state.calls.filter((args) => args[1] === "open").length, 1);
  assert.equal(state.calls.some((args) => ["select", "detach"].includes(args[1])), false);
});

test("a pending GET cannot restore an old open document after detach", async () => {
  let releaseGet;
  let reading = false;
  let current = structuredClone(document);
  const calls = [];
  const store = createAilohaContextStore({
    scope, ownerProcessId: 81027,
    async runCli(args) {
      calls.push(args);
      if (args[1] === "get" && reading) {
        const captured = structuredClone(current);
        await new Promise((resolve) => { releaseGet = resolve; });
        return JSON.stringify({ ok: true, context: captured, error: null });
      }
      if (args[1] === "detach") current = { ...current, state: "detached", revision: "1", selection: null, observed: null };
      return JSON.stringify({ ok: true, context: current, error: null });
    },
  });
  await store.binding();
  reading = true;
  const pending = store.read();
  const rejected = assert.rejects(pending, { code: "context_read_superseded" });
  await new Promise((resolve) => setImmediate(resolve));
  await store.clear();
  releaseGet();
  await rejected;
  reading = false;
  assert.equal(await store.read(), null);
  assert.equal(calls.filter((args) => args[1] === "open").length, 1);
});

test("a bound MCP process reads the explicit opaque ref/epoch instead of opening or guessing another view", async () => {
  const { store, calls } = fixture({ contextRef: document.contextRef, scopeEpoch: document.scopeEpoch });
  await store.binding();
  assert.equal(calls[0][1], "get");
  assert.equal(calls[0].includes("--scope-epoch"), true);
  assert.equal(calls.some((args) => args[1] === "open"), false);
});

test("different owner/scope and unsupported app/instance context are errors, never null selection", async () => {
  for (const change of [
    { state: "active" },
    { owner: { ...document.owner, processId: 1 } },
    { scope: { ...scope, viewId: "other" } },
  ]) {
    const { store } = fixture({ reply: { ok: true, context: { ...document, ...change }, error: null } });
    await assert.rejects(store.binding(), { code: "context_identity_mismatch" });
  }
  const state = fixture();
  await state.store.binding();
  state.applicationSelection();
  await assert.rejects(state.store.read(), { code: "semantic_context_unsupported" });
});

test("an already-open authority is an explicit conflict, not an idempotent reopen", async () => {
  const { store } = fixture({ reply: { ok: false, context: null, error: {
    code: "ContextAlreadyOpen", message: "Retire the current authority before reopening it.",
    current: { contextRef: document.contextRef, scopeEpoch: document.scopeEpoch, revision: "1", state: "open" },
  } } });
  await assert.rejects(store.binding(), { code: "ContextAlreadyOpen" });
});

test("cached scopes reject conflicting explicit ref/epoch without new CLI or host selection IO", async () => {
  const calls = [];
  const testScope = { sessionId: "cache-isolation-session", viewId: "cache-isolation-view" };
  const record = { ...document, scope: testScope };
  const options = {
    scope: testScope, ownerProcessId: 81027,
    async runCli(args) { calls.push(args); return JSON.stringify({ ok: true, context: record, error: null }); },
  };
  const store = getAilohaContextStore(options);
  await store.binding();
  const count = calls.length;
  assert.equal(getAilohaContextStore({
    ...options, contextRef: record.contextRef, scopeEpoch: record.scopeEpoch,
  }), store);
  for (const changed of [{ contextRef: "ctx-other" }, { scopeEpoch: "another-epoch" }]) {
    assert.throws(() => getAilohaContextStore({
      ...options, contextRef: record.contextRef, scopeEpoch: record.scopeEpoch, ...changed,
    }), { code: "context_binding_mismatch" });
  }
  assert.equal(calls.length, count);
  assert.equal(calls.some((args) => args[1] === "select"), false);
});
