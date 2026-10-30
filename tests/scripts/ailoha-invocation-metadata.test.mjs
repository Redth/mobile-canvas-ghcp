import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { productModule } from "../ailoha-test-module.mjs";
import { createNativeBindingFixture, nativeAgent } from "./fixtures/ailoha-native-binding.mjs";
import { exchangeOutcome, nativeInvocationMetadata } from "./fixtures/ailoha-invocation-metadata.mjs";

const { createVerifiedAilohaCli } = await import(productModule("lib/ailoha/runtime-sdk.mjs"));
const { callSemanticTool } = await import(productModule("lib/ailoha/semantic-mcp.mjs"));
const { Client } = await import(productModule("node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"));
const { mobileErrorResult } = await import(productModule("lib/ailoha/mobile-backend.mjs"));
const { createAilohaMcpDispatcher } = await import(productModule("lib/ailoha/mcp-host.mjs"));
const root = fileURLToPath(new URL("../..", import.meta.url));
const pin = { version: "synthetic-only", sourceSha: "a".repeat(40) };
const payload = { error: "token=private-diagnostic /private/owner", type: "ApplicationOperationError", retryable: false };

async function fixture(t) {
  mkdirSync(join(root, ".build"), { recursive: true });
  const scratch = mkdtempSync(join(root, ".build/invocation-metadata-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const responsePath = join(scratch, "response.json");
  let launches = 0;
  const sdk = { async getVerifiedCliLaunch() {
    launches += 1;
    return { ...pin, file: process.execPath,
      args: [join(root, "tests/scripts/fixtures/semantic-mcp-server.mjs"), "--fixture-metadata", responsePath] };
  } };
  const model = createNativeBindingFixture({ registrations: [nativeAgent("native", "target", { registrationVersion: 3 })],
    semanticTool: (request) => callSemanticTool({ ...request, sdk, pin }) });
  const view = await model.createView();
  const initial = await view.controller.request("GET");
  assert.equal((await view.request({ operation: "bind", bindingToken: initial.binding.token,
    agentId: "agent-native", runtimeInstanceId: "native" })).appAvailable, true);
  const snapshot = await view.store.readSnapshot();
  const metadata = nativeInvocationMetadata(snapshot, view.scope);
  const respond = (meta = metadata, result = {}) => writeFileSync(responsePath, JSON.stringify({
    isError: true, content: [{ type: "text",
      text: "An error occurred invoking 'app_query': ApplicationOperationError: token=private-diagnostic" }],
    ...(meta === undefined ? {} : { _meta: meta }), ...result,
  }));
  const args = ["app", "query", "--context", snapshot.contextProjection.contextRef,
    "--context-epoch", snapshot.identity.scopeEpoch, "--context-revision", snapshot.identity.revision,
    "--route", "require-agent", "--json"];
  const cli = (stderr, exit = 1, stdout = "", script) => createVerifiedAilohaCli({ pin, sdk: {
    async getVerifiedCliLaunch() {
      launches += 1;
      return { ...pin, file: process.execPath, args: ["-e", script ??
        `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exitCode=${exit};`, "--"] };
    },
  } });
  return { ...model, view, snapshot, metadata, respond, sdk, args, cli, scratch,
    options: () => ({ metadataContext: { snapshot, scope: view.scope } }), launches: () => launches };
}

function checkReceipt(value, expected, code = "transport-failed") {
  assert.equal(value.code, code);
  assert.deepEqual(value._meta["ailoha.agentExchange"], expected["ailoha.agentExchange"]);
  const context = value._meta["ailoha.executionContext"];
  assert.equal(context.contextRef, expected["ailoha.executionContext"].contextRef);
  assert.deepEqual(context.selection, expected["ailoha.executionContext"].selection);
  assert.deepEqual(Object.keys(context).sort(), ["contextRef", "scope", "scopeEpoch", "revision", "selection"].sort());
  assert.doesNotMatch(JSON.stringify(value), /private-diagnostic|\/private\/owner|capturedAt|observed|provenance|connectionRef|endpointScope/);
}

function noticeObservedByParent(t, script, expected) {
  const spawn = ChildProcess.prototype.spawn;
  let timer;
  const observed = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("The owned parent did not receive the complete synthetic notice.")), 5000);
    t.mock.method(ChildProcess.prototype, "spawn", function (options) {
      const result = spawn.call(this, options);
      if (options.args.includes(script)) {
        let received = "";
        this.stderr.on("data", (chunk) => {
          received += chunk;
          if (received.length < expected.length) return;
          if (received !== expected) reject(new Error("The owned parent received unexpected synthetic stderr."));
          else resolve();
        });
      }
      return result;
    });
  });
  t.after(() => clearTimeout(timer));
  return observed.finally(() => clearTimeout(timer));
}

test("verified CLI preserves one combined original-context receipt after compact or pretty error JSON", async (t) => {
  const f = await fixture(t);
  for (const pretty of [undefined, 2]) {
    for (const exchange of [
      exchangeOutcome({ commitAttempted: false, admitted: false, effectMayBeUnknown: false, errorCode: "not-admitted" }),
      exchangeOutcome({ admitted: false }),
      exchangeOutcome(),
      exchangeOutcome({ completed: true, effectMayBeUnknown: false, errorCode: undefined }),
    ]) {
      const metadata = nativeInvocationMetadata(f.snapshot, f.view.scope, JSON.parse(JSON.stringify(exchange)));
      const stderr = `${JSON.stringify(payload, null, pretty)}\n${JSON.stringify({ _meta: metadata }, null, pretty)}\n`;
      const before = f.launches();
      await assert.rejects(f.cli(stderr)(f.args, f.options()), (error) => {
        checkReceipt(mobileErrorResult(error), metadata, exchange.errorCode ?? "semantic_operation_failed");
        assert(Object.isFrozen(error._meta));
        return true;
      });
      assert.equal(f.launches(), before + 1);
    }
  }
  const noExchange = nativeInvocationMetadata(f.snapshot, f.view.scope, null);
  const notAdmitted = nativeInvocationMetadata(f.snapshot, f.view.scope, exchangeOutcome({
    commitAttempted: false, admitted: false, effectMayBeUnknown: false, errorCode: "not-admitted",
  }));
  await assert.rejects(f.cli(`${JSON.stringify({ ...payload, type: "ContextRevisionConflict" })}\n${JSON.stringify({ _meta: notAdmitted })}`)(
    f.args, f.options()), (error) => {
    checkReceipt(mobileErrorResult(error), notAdmitted, "ContextRevisionConflict");
    return true;
  });
  await assert.rejects(f.cli(`${JSON.stringify({ ...payload, type: "AgentTransportUnsupported" })}\n${JSON.stringify({ _meta: noExchange })}`)(
    f.args, f.options()), (error) => {
    assert.equal(error.code, "AgentTransportUnsupported");
    assert.equal(error.status, 501);
    assert.equal(Object.hasOwn(error._meta, "ailoha.agentExchange"), false);
    return true;
  });
  const stdout = '{\n  "running": true\n}\n';
  const completed = nativeInvocationMetadata(f.snapshot, f.view.scope, exchangeOutcome({
    completed: true, effectMayBeUnknown: false, errorCode: undefined,
  }));
  assert.equal(await f.cli(`${JSON.stringify({ _meta: completed })}\n`, 0, stdout)(f.args, f.options()), stdout);
  await assert.rejects(f.cli(JSON.stringify(payload), 0, stdout)(f.args, f.options()), { code: "invocation_metadata_invalid" });
  await assert.rejects(f.cli(JSON.stringify({ _meta: f.metadata }), 0, stdout)(f.args, f.options()),
    (error) => { checkReceipt(mobileErrorResult(error), f.metadata); return true; });
  const bounded = structuredClone(f.snapshot);
  Object.assign(bounded.selection, { targetHostId: "h".repeat(256), targetId: "t".repeat(256),
    surfaceId: "s".repeat(256), runtimeInstanceId: "r".repeat(128), agentId: `agent-${"r".repeat(128)}` });
  const boundedMeta = nativeInvocationMetadata(bounded, f.view.scope);
  await assert.rejects(f.cli(`${JSON.stringify(payload)}\n${JSON.stringify({ _meta: boundedMeta })}`)(
    f.args, { metadataContext: { snapshot: bounded, scope: f.view.scope } }), (error) => {
    checkReceipt(mobileErrorResult(error), boundedMeta);
    return true;
  });
  bounded.selection.targetId += "t";
  const oversizedMeta = nativeInvocationMetadata(bounded, f.view.scope);
  await assert.rejects(f.cli(`${JSON.stringify(payload)}\n${JSON.stringify({ _meta: oversizedMeta })}`)(
    f.args, { metadataContext: { snapshot: bounded, scope: f.view.scope } }), { code: "invocation_metadata_invalid" });
});

test("CLI rejects ambiguous notices, raw duplicate aliases, private authority and wrong original context without replay", async (t) => {
  const f = await fixture(t);
  const base = JSON.stringify({ _meta: f.metadata });
  for (const notice of [
    `${base}\n${base}`, `${base}\n{"other":"diagnostic"}`, `arbitrary log\n${base}`,
    base.replace('"_meta":', '"_meta":{},"_meta":'),
    base.replace('"requestId":', '"requestId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","requestId":'),
    base.replace('"requestId":', '"requestId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","request\\u0049d":'),
    JSON.stringify({ _meta: { ...f.metadata, owner: {} } }),
    JSON.stringify({ _meta: { ...f.metadata, "ailoha.agentExchange": null } }),
    `${" ".repeat(128 * 1024)}${base}`,
    `{"_meta":${"[".repeat(9)}null${"]".repeat(9)}}`,
  ]) {
    await assert.rejects(f.cli(`${JSON.stringify(payload)}\n${notice}`)(f.args, f.options()), { code: "invocation_metadata_invalid" });
  }
  for (const mutate of [
    (m) => { m["ailoha.executionContext"].contextRef = "ctx-other"; },
    (m) => { m["ailoha.executionContext"].scopeEpoch = "other"; },
    (m) => { m["ailoha.executionContext"].revision = "99"; },
    (m) => { m["ailoha.executionContext"].scope.viewId = "peer"; },
    (m) => { m["ailoha.executionContext"].selection.targetId = "other"; },
    (m) => { m["ailoha.executionContext"].selection.runtimeInstanceId = "replacement"; },
    (m) => { m["ailoha.executionContext"].selection.connectionRef = {}; },
    (m) => { m["ailoha.executionContext"].observed.owner = {}; },
    (m) => { m["ailoha.agentExchange"].requestId = "A".repeat(32); },
    (m) => { m["ailoha.agentExchange"].commitAttempted = false; },
    (m) => { m["ailoha.agentExchange"].completed = true; },
    (m) => { m["ailoha.agentExchange"].effectMayBeUnknown = false; },
    (m) => { m["ailoha.agentExchange"].admitted = "true"; },
    (m) => { m["ailoha.agentExchange"].endpoint = "http://private.invalid"; },
  ]) {
    const metadata = structuredClone(f.metadata);
    mutate(metadata);
    const before = f.launches();
    await assert.rejects(f.cli(`${JSON.stringify(payload)}\n${JSON.stringify({ _meta: metadata })}`)(f.args, f.options()),
      { code: "invocation_metadata_invalid" });
    assert.equal(f.launches(), before + 1);
  }
  await assert.rejects(f.cli(`${JSON.stringify({ _meta: f.metadata })}\n${JSON.stringify(payload)}`)(f.args, f.options()),
    { code: "invocation_metadata_invalid" });
  await assert.rejects(f.cli(`${JSON.stringify(payload)}${base}`)(f.args, f.options()),
    { code: "invocation_metadata_invalid" });
  await assert.rejects(f.cli(`${JSON.stringify(payload)}\n${base}`)(f.args, { metadataContext: {
    snapshot: { ...f.snapshot, identity: { ...f.snapshot.identity, revision: "99" } }, scope: f.view.scope,
  } }), { code: "invocation_metadata_invalid" });
});

test("candidate failures remain one isolated v1 JSON and never consume app metadata notices", async (t) => {
  const f = await fixture(t);
  const candidate = { schema: "ailoha.agent.candidates/v1", ok: false, targetHostId: "host", targetId: "target",
    candidates: null, error: { code: "AgentCandidatesBrokerUnavailable", message: "Synthetic error" } };
  await assert.rejects(f.cli(`${JSON.stringify(candidate)}\n${JSON.stringify({ _meta: f.metadata })}`)(
    ["agent", "candidates", "--target-host", "host", "--target", "target", "--json"]), { code: "ailoha_cli_failed" });
});

test("real SDK stdio error metadata survives shared controller and named App MCP error conversion", async (t) => {
  const f = await fixture(t);
  f.respond();
  const read = await f.view.request({ lens: "app", operation: "query", text: "OK" });
  checkReceipt(read.error, f.metadata);
  const dispatcher = await createAilohaMcpDispatcher({
    binding: { scope: f.view.scope, contextRef: f.view.context.contextRef,
      scopeEpoch: f.view.context.scopeEpoch, ownerProcessId: process.pid },
    createSemanticInspection: () => f.view.createInspection(),
    createBackend() { throw new Error("Receipt reads cannot acquire a device backend or fallback."); },
  });
  t.after(() => dispatcher.dispose());
  for (const name of ["mobile_app_tree", "mobile_app_query", "mobile_app_status"]) {
    const before = f.launches();
    const reply = await dispatcher.handle({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: name === "mobile_app_query" ? { text: "OK" } : {} } });
    assert.equal(reply.result.isError, true);
    checkReceipt(JSON.parse(reply.result.content[0].text), f.metadata);
    assert.deepEqual(reply.result._meta, JSON.parse(reply.result.content[0].text)._meta);
    assert.equal(f.launches(), before + 1);
  }
});

test("SDK metadata is matched to the immutable original view, never a changed context or private projection", async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    (m) => { m["ailoha.executionContext"].scope.sessionId = "peer"; },
    (m) => { m["ailoha.executionContext"].selection.targetHostId = "other"; },
    (m) => { m["ailoha.executionContext"].provenance.agentId = "http://private.invalid"; },
    (m) => { m["ailoha.agentExchange"].requestId = "bad"; },
    (m) => { m["ailoha.agentExchange"].completed = true; },
    (m) => { m["ailoha.agentExchange"].owner = {}; },
  ]) {
    const metadata = structuredClone(f.metadata);
    mutate(metadata);
    f.respond(metadata);
    const read = await f.view.request({ lens: "app", operation: "query", text: "OK" });
    assert.equal(read.error.code, "invocation_metadata_invalid");
    assert.equal(Object.hasOwn(read.error, "_meta"), false);
    assert.equal(read.result, null);
  }
  f.respond(f.metadata, { isError: false, structuredContent: { running: true } });
  const falseSuccess = await f.view.request({ lens: "app", operation: "status" });
  checkReceipt(falseSuccess.error, f.metadata);
  assert.equal(falseSuccess.result, null);
});

test("completed original response metadata survives a later SDK cleanup failure without inventing unknown effects", async (t) => {
  const f = await fixture(t);
  const completed = nativeInvocationMetadata(f.snapshot, f.view.scope, exchangeOutcome({
    completed: true, effectMayBeUnknown: false, errorCode: undefined,
  }));
  f.respond(JSON.parse(JSON.stringify(completed)), { isError: false, structuredContent: { running: true } });
  const originalClose = Client.prototype.close;
  Client.prototype.close = async function () {
    await originalClose.call(this);
    throw new Error("token=private-cleanup");
  };
  try {
    const result = await f.view.request({ lens: "app", operation: "status" });
    checkReceipt(result.error, JSON.parse(JSON.stringify(completed)), "semantic_mcp_transport_failed");
    assert.equal(result.error._meta["ailoha.agentExchange"].effectMayBeUnknown, false);
  } finally { Client.prototype.close = originalClose; }
});

test("named MCP disposal returns the original admission receipt while keeping its retired view empty", async (t) => {
  const f = await fixture(t);
  f.respond();
  const dispatcher = await createAilohaMcpDispatcher({
    binding: { scope: f.view.scope, contextRef: f.view.context.contextRef,
      scopeEpoch: f.view.context.scopeEpoch, ownerProcessId: process.pid },
    createSemanticInspection: () => f.view.createInspection(),
    createBackend() { throw new Error("No fallback after an admitted App request."); },
  });
  let release;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const originalClose = Client.prototype.close;
  Client.prototype.close = async function () {
    await originalClose.call(this);
    entered();
    await new Promise((resolve) => { release = resolve; });
  };
  try {
    const pending = dispatcher.handle({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "mobile_app_status", arguments: {} } });
    await waiting;
    const closing = dispatcher.dispose();
    release();
    const response = await pending;
    checkReceipt(JSON.parse(response.result.content[0].text), f.metadata, "mcp_closed");
    assert.deepEqual(response.result._meta, JSON.parse(response.result.content[0].text)._meta);
    await closing;
  } finally {
    Client.prototype.close = originalClose;
    await dispatcher.dispose();
  }
});

test("SDK close failure and retired-view return preserve original receipts without repopulating the current view", async (t) => {
  const f = await fixture(t);
  f.respond();
  const originalClose = Client.prototype.close;
  let release;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  Client.prototype.close = async function () {
    await originalClose.call(this);
    entered();
    await new Promise((resolve) => { release = resolve; });
    throw new Error("token=private-cleanup");
  };
  try {
    const pending = f.view.request({ lens: "app", operation: "query", text: "OK" });
    await waiting;
    f.view.controller.setVisible(false);
    f.view.context.revision = "99";
    release();
    const retired = await pending;
    checkReceipt(retired.error, f.metadata);
    assert.equal(f.view.controller.snapshot().status, "suspended");
    assert.equal(f.view.controller.snapshot().error, null);
    assert.equal(retired.error._meta["ailoha.executionContext"].revision, "1");
  } finally {
    Client.prototype.close = originalClose;
  }
});

test("CLI cancellation after a complete notice retains original admission evidence and waits for owned close", async (t) => {
  const f = await fixture(t);
  const ready = join(f.scratch, "ready");
  const notice = JSON.stringify({ _meta: f.metadata });
  const script = `require("node:fs");process.stderr.write(${JSON.stringify(`${notice}\n`)},()=>require("node:fs").writeFileSync(${JSON.stringify(ready)},"ready"));setInterval(()=>{},1000);`;
  const observed = noticeObservedByParent(t, script, `${notice}\n`);
  const caller = new AbortController();
  const pending = f.cli("", 1, "", script)(f.args, { ...f.options(), signal: caller.signal });
  const rejected = assert.rejects(pending, (error) => {
    checkReceipt(mobileErrorResult(error), f.metadata, "ailoha_cli_cancelled");
    return true;
  });
  const deadline = Date.now() + 5000;
  while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert(existsSync(ready));
  await observed;
  caller.abort();
  await rejected;
  assert.equal(readFileSync(ready, "utf8"), "ready");
});

test("cancelled CLI rejects two conflicting complete notices instead of discarding original admission evidence", async (t) => {
  const f = await fixture(t);
  const ready = join(f.scratch, "conflicting-ready");
  const first = nativeInvocationMetadata(f.snapshot, f.view.scope, exchangeOutcome({
    commitAttempted: false, admitted: false, effectMayBeUnknown: false, errorCode: "not-admitted",
  }));
  const second = nativeInvocationMetadata(f.snapshot, f.view.scope, exchangeOutcome({ requestId: "b".repeat(32) }));
  const notices = `${JSON.stringify({ _meta: first })}\n${JSON.stringify({ _meta: second })}\n`;
  const script = `process.stderr.write(${JSON.stringify(notices)},()=>require("node:fs").writeFileSync(${JSON.stringify(ready)},"ready"));setInterval(()=>{},1000);`;
  const observed = noticeObservedByParent(t, script, notices);
  const caller = new AbortController();
  const before = f.launches();
  const pending = f.cli("", 1, "", script)(f.args, { ...f.options(), signal: caller.signal });
  const rejected = assert.rejects(pending, (error) => {
    assert.equal(error.code, "invocation_metadata_invalid");
    assert.equal(Object.hasOwn(mobileErrorResult(error), "_meta"), false);
    return true;
  });
  const deadline = Date.now() + 5000;
  while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert(existsSync(ready));
  await observed;
  caller.abort();
  await rejected;
  assert.equal(f.launches(), before + 1);
});

const closedMessage = "The captured named context is closed. No reopen, retry or fallback was attempted.";
const closedDiagnostic = "ContextClosed: The named view authority has been retired.";

test("verified CLI preserves ContextClosed before native capture without inventing a receipt or reopening", async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.view.context);
  const calls = structuredClone(f.calls);
  const before = f.launches();
  const stderr = `${JSON.stringify({ error: closedDiagnostic, type: "ContextClosed", retryable: false })}\n`;
  await assert.rejects(f.cli(stderr)(f.args, f.options()), (error) => {
    assert.deepEqual(mobileErrorResult(error), { code: "ContextClosed", message: closedMessage, status: 409 });
    assert.equal(Object.hasOwn(error, "_meta"), false);
    return true;
  });
  assert.equal(f.launches(), before + 1);
  assert.deepEqual(f.calls, calls);
  assert.deepEqual(f.view.context, original);
});

test("SDK stdio fixtures and shared App reads retain bare or wrapped ContextClosed without metadata or fallback", async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.view.context);
  const beforeCalls = f.calls.length;
  const beforeLaunches = f.launches();
  for (const text of [closedDiagnostic, `An error occurred invoking 'app_query': ${closedDiagnostic}`]) {
    f.respond(undefined, { _meta: undefined, content: [{ type: "text", text }] });
    const read = await f.view.request({ lens: "app", operation: "query", text: "OK" });
    assert.deepEqual(read.error, { code: "ContextClosed", message: closedMessage, status: 409 });
    assert.equal(read.result, null);
    assert.equal(read.appAvailable, false);
  }
  const dispatcher = await createAilohaMcpDispatcher({
    binding: { scope: f.view.scope, contextRef: f.view.context.contextRef,
      scopeEpoch: f.view.context.scopeEpoch, ownerProcessId: process.pid },
    createSemanticInspection: () => f.view.createInspection(),
    createBackend() { throw new Error("A closed context must not acquire a device backend or fallback."); },
  });
  t.after(() => dispatcher.dispose());
  f.respond(undefined, { _meta: undefined, content: [{ type: "text", text: closedDiagnostic }] });
  for (const name of ["mobile_app_tree", "mobile_app_query", "mobile_app_status"]) {
    const response = await dispatcher.handle({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: name === "mobile_app_query" ? { text: "OK" } : {} } });
    assert.equal(response.result.isError, true);
    assert.deepEqual(JSON.parse(response.result.content[0].text), { code: "ContextClosed", message: closedMessage, status: 409 });
    assert.equal(Object.hasOwn(response.result, "_meta"), false);
  }
  assert.equal(f.launches(), beforeLaunches + 5);
  assert.equal(f.view.toolCalls.length, 5);
  assert(f.view.toolCalls.every((request) => request.arguments.route === "require-agent"));
  assert(f.calls.slice(beforeCalls).every((args) => args[0] === "context" && args[1] === "get"));
  assert.deepEqual(f.view.context, original);
});

test("late ContextClosed without a native receipt cannot restore a retired semantic view", async (t) => {
  const f = await fixture(t);
  f.respond(undefined, { _meta: undefined, content: [{ type: "text", text: closedDiagnostic }] });
  const originalClose = Client.prototype.close;
  let entered;
  let release;
  const waiting = new Promise((resolve) => { entered = resolve; });
  Client.prototype.close = async function () {
    await originalClose.call(this);
    entered();
    await new Promise((resolve) => { release = resolve; });
    throw new Error("token=private-cleanup");
  };
  try {
    const before = f.launches();
    const pending = f.view.request({ lens: "app", operation: "query", text: "OK" });
    await waiting;
    f.view.controller.setVisible(false);
    Object.assign(f.view.context, { state: "closed", revision: "2", selection: null, observed: null });
    release();
    const retired = await pending;
    assert.equal(retired, f.view.controller.snapshot());
    assert.equal(retired.status, "suspended");
    assert.equal(retired.error, null);
    assert.equal(retired.result, null);
    assert.equal(retired.selection, null);
    assert.equal(retired.appAvailable, false);
    assert.equal(retired.binding.token, null);
    assert.equal(Object.hasOwn(retired, "_meta"), false);
    assert.equal(f.launches(), before + 1);
  } finally { Client.prototype.close = originalClose; }
});
