import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { productModule } from "../ailoha-test-module.mjs";
import { workspaceInspectionFixture } from "./fixtures/workspace-inspection-fixture.mjs";

const {
  createWorkspaceInspectionController, projectWorkspaceInspection, WORKSPACE_INSPECTION_MAX_BYTES,
} = await import(productModule("lib/ailoha/workspace-inspection.mjs"));
const { createVerifiedAilohaCli } = await import(productModule("lib/ailoha/runtime-sdk.mjs"));
const { createRuntimeCanvasHost } = await import(productModule("lib/ailoha/runtime-backend.mjs"));
const { createAilohaCanvasHost } = await import(productModule("lib/ailoha/canvas-host.mjs"));
const { withAilohaCanvas } = await import(productModule("lib/ailoha/github-adapter.mjs"));
const root = "/workspace-inspection-fixture";
const scope = { sessionId: "inspection-session", viewId: "inspection-view" };
const output = (path = root, mode) => JSON.stringify(workspaceInspectionFixture(path, mode));
const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
};

test("canonical populated output preserves MAUI/Expo evidence, wrappers and distinct native app identities", () => {
  const result = projectWorkspaceInspection(output(), root);
  assert.equal(result.applications.length, 8);
  const maui = result.applications.find((app) => app.framework === "maui");
  assert.equal(maui.instrumentation.dependency.state, "declared");
  assert.equal(maui.instrumentation.startup.state, "observed");
  assert.equal(maui.instrumentation.debugGuard.state, "observed");
  const expo = result.applications.find((app) => app.variant === "expo");
  assert.equal(expo.nativeWrappers.length, 2);
  assert.equal(expo.nativeWrappers[0].nativeTarget, null);
  assert.equal(expo.nativeWrappers[1].nativeTarget.name, "ExpoWrapper");
  assert.notEqual(expo.nativeWrappers[1].applicationId, expo.applicationId);
  const native = result.applications.filter((app) => app.primaryManifest === "native/Consumer.xcodeproj/project.pbxproj");
  assert.equal(new Set(native.map((app) => app.applicationId)).size, 3);
  assert.equal(new Set(native.map((app) => app.nativeTarget.bundleId)).size, 1);
  assert.equal(native[2].role, "library");
  assert.equal(result.applications.find((app) => app.variant === "swiftpm").role, "unknown");
  assert.equal(result.applications.find((app) => app.variant === "bare").instrumentation.dependency.state, "not-observed");
  for (const app of result.applications) {
    assert.equal(app.instrumentation.liveConnection.state, "not-evaluated");
    assert.equal(app.instrumentation.correlation.state, "not-evaluated");
    assert.equal(app.liveCapabilityEvidence, null);
    assert.equal(Object.isFrozen(app), true);
  }
  assert.equal(JSON.stringify(result).includes("MUST_NOT"), false);
});

test("incomplete canonical output keeps diagnostics and unknown projects instead of empty successful onboarding", () => {
  const result = projectWorkspaceInspection(output(root, "incomplete"), root);
  assert.equal(result.scan.complete, false);
  assert.equal(result.applications[0].framework, "unknown");
  assert.equal(result.applications[0].instrumentation.startup.state, "unknown");
  assert.equal(result.diagnostics[0].code, "malformed-json");
  assert.equal(result.diagnostics[0].path, "broken/package.json");
});

for (const [name, mutate, code] of [
  ["unknown schema", (value) => { value.schema = "ailoha.workspace.inspection/v2"; }, "workspace_inspection_schema_unsupported"],
  ["another root", (value) => { value.workspace.root = "/another-workspace"; }, "workspace_inspection_root_mismatch"],
  ["missing scan counter", (value) => { delete value.scan.bytesRead; }, "workspace_inspection_invalid"],
  ["negative limit", (value) => { value.scan.limits.maxDepth = -1; }, "workspace_inspection_invalid"],
  ["duplicate application identity", (value) => { value.applications[1].applicationId = value.applications[0].applicationId; }, "workspace_inspection_invalid"],
  ["absolute evidence path", (value) => { value.applications[0].evidence[0].path = "/outside/root"; }, "workspace_inspection_invalid"],
  ["relative escape", (value) => { value.applications[0].primaryManifest = "../outside/package.json"; }, "workspace_inspection_invalid"],
  ["missing declarations", (value) => { delete value.applications[0].instrumentation.dependency.declarations; }, "workspace_inspection_invalid"],
  ["running startup claim", (value) => { value.applications[0].instrumentation.startup.state = "running"; }, "workspace_inspection_invalid"],
  ["evaluated live connection", (value) => { value.applications[0].instrumentation.liveConnection.state = "connected"; }, "workspace_inspection_invalid"],
  ["evaluated correlation", (value) => { value.applications[0].instrumentation.correlation.state = "matched"; }, "workspace_inspection_invalid"],
  ["capabilities list instead of explicit null", (value) => { value.applications[0].liveCapabilityEvidence = []; }, "workspace_inspection_invalid"],
  ["too many diagnostics", (value) => { value.diagnostics = Array(201).fill(value.diagnostics[0]); }, "workspace_inspection_invalid"],
]) {
  test(`projection rejects ${name} before adopting an application card`, () => {
    const value = workspaceInspectionFixture(root);
    mutate(value);
    assert.throws(() => projectWorkspaceInspection(JSON.stringify(value), root), { code });
  });
}

test("projection drops unrecognized private fields and supports additive nullable native metadata in older v1", () => {
  const value = workspaceInspectionFixture(root);
  value.privateHandle = "PRIVATE_FIELD_SENTINEL";
  value.applications[0].privateCredential = "PRIVATE_FIELD_SENTINEL";
  for (const app of value.applications) {
    delete app.nativeTarget;
    for (const wrapper of app.nativeWrappers) {
      delete wrapper.applicationId;
      delete wrapper.nativeTarget;
    }
  }
  const result = projectWorkspaceInspection(JSON.stringify(value), root);
  assert.equal(result.applications[0].nativeTarget, null);
  assert.equal(JSON.stringify(result).includes("PRIVATE_FIELD_SENTINEL"), false);
});

test("exact 2 MiB output bound, malformed JSON, empty scan and invalid-root scan are explicit", () => {
  const text = output();
  const bounded = text + " ".repeat(WORKSPACE_INSPECTION_MAX_BYTES - Buffer.byteLength(text));
  assert.equal(projectWorkspaceInspection(bounded, root).applications.length, 8);
  assert.throws(() => projectWorkspaceInspection(bounded + " ", root), { code: "workspace_inspection_output_limit" });
  assert.throws(() => projectWorkspaceInspection("{", root), { code: "workspace_inspection_invalid" });
  assert.equal(projectWorkspaceInspection(output(root, "empty"), root).applications.length, 0);
  const value = workspaceInspectionFixture(root, "empty");
  value.scan.complete = false;
  value.workspace.root = null;
  value.workspace.workspaceId = null;
  assert.equal(projectWorkspaceInspection(JSON.stringify(value), root).scan.complete, false);
});

function controller(runCli, options = {}) {
  return createWorkspaceInspectionController({ scope, runCli: runCli ?? (async () => output()), ...options });
}

test("no ambient root, folder inference, runtime or process is used by a not-selected view", async () => {
  let calls = 0;
  const view = controller(async () => { calls += 1; return output(); });
  assert.equal(view.snapshot().status, "not-selected");
  await assert.rejects(view.inspect(), { code: "workspace_root_required" });
  for (const path of [undefined, ".", "relative/root", "/bad\u0000root"]) {
    assert.throws(() => view.bindRoot(path), { code: "workspace_root_required" });
  }
  assert.throws(() => view.bindRoot(root, [""]), { code: "workspace_exclusions_invalid" });
  assert.throws(() => view.bindRoot(root, Array(65).fill("ignored/**")), { code: "workspace_exclusions_invalid" });
  assert.equal(calls, 0);
});

test("one captured explicit root/exclusion request is coalesced, read-only and immutable", async () => {
  const pending = deferred();
  const calls = [];
  const view = controller(async (args, options) => { calls.push({ args, options }); return pending.promise; });
  const exclusions = ["ignored/**", "experiments/*"];
  view.bindRoot(root, exclusions);
  exclusions.push("not-captured/**");
  const first = view.inspect();
  const second = view.inspect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["workspace", "inspect", "--path", root, "--json", "--exclude", "ignored/**", "--exclude", "experiments/*"]);
  assert.equal(calls[0].options.signal.aborted, false);
  pending.resolve(output());
  assert.equal((await first).status, "complete");
  assert.equal((await second).generation, view.snapshot().generation);
  assert.deepEqual(view.snapshot().scope, scope);
  assert.equal(Object.isFrozen(view.snapshot().inspection), true);
});

test("a late old-root scan cannot paint new cards, and process concurrency stays at one", async () => {
  const first = deferred();
  const second = deferred();
  const calls = [];
  const view = controller((args, options) => {
    calls.push({ args, signal: options.signal });
    return calls.length === 1 ? first.promise : second.promise;
  });
  view.bindRoot(root);
  const old = view.inspect();
  await new Promise((resolve) => setImmediate(resolve));
  view.bindRoot("/new-root");
  assert.equal(calls[0].signal.aborted, true);
  const next = view.inspect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(view.snapshot().inspection, null);
  first.resolve(output());
  await old;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args[3], "/new-root");
  second.resolve(output("/new-root"));
  assert.equal((await next).root, "/new-root");
  assert.equal(view.snapshot().inspection.workspace.root, "/new-root");
});

for (const action of ["cancel", "invalidate", "clearRoot", "hide"]) {
  test(`${action} retires a captured read even when its obsolete completion ignores cancellation`, async () => {
    const pending = deferred();
    let signal;
    const view = controller((_args, options) => { signal = options.signal; return pending.promise; });
    view.bindRoot(root);
    const result = view.inspect();
    await new Promise((resolve) => setImmediate(resolve));
    if (action === "hide") view.setVisible(false);
    else view[action]();
    assert.equal(signal.aborted, true);
    pending.resolve(output());
    await result;
    assert.equal(view.snapshot().inspection, null);
    if (action === "hide") {
      await assert.rejects(view.inspect(), { code: "workspace_view_retired" });
      assert.throws(() => view.bindRoot("/new-root"), { code: "workspace_view_retired" });
      view.setVisible(true);
      assert.equal(view.snapshot().status, "ready");
    }
  });
}

test("trust is revalidated immediately before invocation and deadline/errors are recoverable", async () => {
  let trusted = true;
  let calls = 0;
  const errors = [];
  const view = controller(async () => { calls += 1; return output(); }, {
    onError: (error) => errors.push(error),
    validateRoot: () => trusted ? undefined : { code: "workspace_untrusted", message: "Workspace trust is required." },
  });
  view.bindRoot(root);
  trusted = false;
  assert.equal((await view.inspect()).error.code, "workspace_untrusted");
  assert.equal(calls, 0);
  trusted = true;
  assert.equal((await view.inspect()).status, "complete");
  assert.equal(errors.length, 1);
  const timed = controller(() => new Promise(() => {}), { timeoutMs: 15 });
  timed.bindRoot(root);
  assert.equal((await timed.inspect()).error.code, "workspace_inspection_timeout");
  assert.equal(timed.snapshot().inspection, null);
});

test("renderer invocation captures a displayed generation and cannot race a newer explicit root", async () => {
  let calls = 0;
  const view = controller(async (args) => { calls += 1; return output(args[3]); });
  const first = view.bindRoot(root);
  view.bindRoot("/new-root");
  await assert.rejects(view.request("POST", JSON.stringify({ generation: first.generation })), { code: "workspace_view_changed" });
  await assert.rejects(view.request("DELETE", JSON.stringify({ generation: first.generation })), { code: "workspace_view_changed" });
  await assert.rejects(view.request("POST", JSON.stringify({ path: "/" })), { code: "workspace_root_authority_required" });
  await assert.rejects(view.request("POST", "{}"), { code: "workspace_generation_required" });
  assert.equal(calls, 0);
  const result = await view.request("POST", JSON.stringify({ generation: view.snapshot().generation }));
  assert.equal(result.root, "/new-root");
  assert.equal(calls, 1);
});

test("trust lost during a scan rejects late evidence even without a workspace event", async () => {
  let trusted = true;
  const pending = deferred();
  const view = controller(() => pending.promise, {
    validateRoot: () => trusted ? undefined : { code: "workspace_untrusted", message: "Workspace trust is required." },
  });
  view.bindRoot(root);
  const scan = view.inspect();
  await new Promise((resolve) => setImmediate(resolve));
  trusted = false;
  pending.resolve(output());
  assert.equal((await scan).error.code, "workspace_untrusted");
  assert.equal(view.snapshot().inspection, null);
  assert.equal(view.clearRoot({ code: "workspace_untrusted", message: "Workspace trust is required." }).error.status, 403);
});

test("actual missing public SDK gate is an error without starting a Target Host or changing context", async () => {
  const errors = [];
  const host = createRuntimeCanvasHost({ scope, onError: (error) => errors.push(error) });
  const result = await host.invokeAction("workspace_inspect", { path: root });
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "ailoha_runtime_unavailable");
  assert.equal(result.inspection, null);
  assert.equal(errors.length, 1);
  await host.closeCanvas();
});

test("actual canvas retires inspection at selection intent and backend context-error boundaries", async (t) => {
  const scans = [];
  const view = controller((_args, options) => {
    const pending = deferred();
    scans.push({ pending, signal: options.signal });
    return pending.promise;
  });
  let backendError;
  let backendCalls = 0;
  const host = createAilohaCanvasHost({
    scope, workspaceInspection: view,
    async createBackend(options) {
      backendError = options.onError;
      return {
        async ready() {},
        async invokeAction() { backendCalls += 1; },
        async request() { backendCalls += 1; return new Response("{}"); },
        async dispose() {},
      };
    },
  });
  t.after(() => host.closeCanvas());
  const opened = await host.openCanvas({ workspaceRoot: root });
  const url = new URL(opened.url);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const grant = await fetch(new URL("/api/v1/auth/bootstrap", url), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: fragment.get("bootstrap"), sessionId: scope.sessionId, instanceId: scope.viewId }),
  });
  const cookie = grant.headers.get("set-cookie").split(";", 1)[0];
  for (const action of ["provider-selection", "http-selection", "context-error"]) {
    const pending = view.inspect();
    await new Promise((resolve) => setImmediate(resolve));
    const scan = scans.at(-1);
    if (action === "provider-selection") await host.invokeAction("select_device", { deviceId: "new-target" });
    if (action === "http-selection") {
      await fetch(new URL("/api/v1/selection", url), {
        method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: "new-target" }),
      });
    }
    if (action === "context-error") backendError({
      code: "context_retired", message: "The view context changed.", status: 409,
      contextIdentity: { scopeEpoch: "retired-epoch", revision: "2", state: "detached" },
    });
    assert.equal(scan.signal.aborted, true);
    scan.pending.resolve(output());
    await pending;
    assert.equal(view.snapshot().inspection, null);
  }
  assert.equal(backendCalls, 2);
});

test("GitHub adapter keeps legacy unchanged, ignores SDK working-directory hints and adds only the opt-in action", async () => {
  const base = { inputSchema: { type: "object", properties: {} }, actions: Array.from({ length: 24 }, (_, index) => ({ name: `legacy-${index}` })) };
  assert.equal(withAilohaCanvas(base, { backend: "legacy" }), base);
  const views = [];
  const wrapped = withAilohaCanvas(base, {
    backend: "ailoha",
    createHost({ scope }) {
      const inspection = createWorkspaceInspectionController({ scope, runCli: async (args) => output(args[3]) });
      const host = createAilohaCanvasHost({ scope, workspaceInspection: inspection, createBackend() { throw new Error("A scan must not open a device backend."); } });
      views.push(host);
      return host;
    },
  });
  assert.equal(wrapped.actions.length, 25);
  const context = { sessionId: scope.sessionId, instanceId: scope.viewId, session: { workingDirectory: "/ambient-sdk-hint" } };
  const action = wrapped.actions.find((entry) => entry.name === "workspace_inspect");
  await assert.rejects(action.handler(context), { code: "workspace_root_required" });
  assert.equal(views[0].workspaceInspection.snapshot().root, null);
  const result = await action.handler({ ...context, input: { path: root, sessionId: "untrusted-other-view" } });
  assert.deepEqual(result.scope, scope);
  assert.equal(result.root, root);
  await wrapped.onClose(context);
  await assert.rejects(action.handler({ ...context, input: { path: root } }), { code: "workspace_view_retired" });
});

test("verified one-shot process accepts only structured exit-2 scans and preserves cancellation/output/error bounds", async (t) => {
  const source = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const scratch = join(source, ".build", `workspace-cli-${process.pid}-${randomUUID()}`);
  mkdirSync(scratch, { recursive: true });
  const variables = ["AILOHA_TEST_CONTEXT_STATE", "AILOHA_TEST_INSPECTION_MODE", "AILOHA_TEST_INSPECTION_DELAY_MS", "AILOHA_TEST_INSPECTION_LOG"];
  const previous = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of variables) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    rmSync(scratch, { recursive: true, force: true });
  });
  process.env.AILOHA_TEST_CONTEXT_STATE = join(scratch, "unused-context.json");
  process.env.AILOHA_TEST_INSPECTION_LOG = join(scratch, "scan-processes.jsonl");
  const pin = { version: "original-consumer-fixture", sourceSha: "0".repeat(40) };
  let launches = 0;
  const runCli = createVerifiedAilohaCli({
    pin,
    sdk: { async getVerifiedCliLaunch({ expectedVersion }) {
      launches += 1;
      assert.equal(expectedVersion, pin.version);
      return { file: process.execPath, args: [join(source, "tests/scripts/fixtures/ailoha-context-double.mjs")], ...pin };
    } },
  });
  const args = ["workspace", "inspect", "--path", root, "--json"];
  process.env.AILOHA_TEST_INSPECTION_MODE = "incomplete";
  assert.equal(projectWorkspaceInspection(await runCli(args), root).scan.complete, false);
  process.env.AILOHA_TEST_INSPECTION_MODE = "failure";
  await assert.rejects(runCli(args), (error) => error.code === "ailoha_cli_failed" && !error.message.includes("PRIVATE"));
  process.env.AILOHA_TEST_INSPECTION_MODE = "oversized";
  await assert.rejects(runCli(args), { code: "ailoha_cli_output_limit" });
  const before = launches;
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(runCli(args, { signal: cancelled.signal }), { code: "ailoha_cli_cancelled" });
  assert.equal(launches, before);
  process.env.AILOHA_TEST_INSPECTION_MODE = "complete";
  process.env.AILOHA_TEST_INSPECTION_DELAY_MS = "1000";
  const controller = new AbortController();
  const previousCalls = readFileSync(process.env.AILOHA_TEST_INSPECTION_LOG, "utf8").trim().split("\n").length;
  const pending = runCli(args, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: "ailoha_cli_cancelled" });
  let pid;
  const deadline = Date.now() + 5000;
  while (!pid && Date.now() < deadline) {
    const calls = readFileSync(process.env.AILOHA_TEST_INSPECTION_LOG, "utf8").trim().split("\n");
    if (calls.length > previousCalls) pid = JSON.parse(calls.at(-1)).pid;
    else await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(typeof pid, "number");
  controller.abort();
  await rejected;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.throws(() => readFileSync(process.env.AILOHA_TEST_CONTEXT_STATE), { code: "ENOENT" });
});

test("verified inspection launch preserves the total SDK budget and cannot dispatch after timeout or cancellation", async () => {
  const pin = { version: "original-consumer-fixture", sourceSha: "0".repeat(40) };
  const args = ["workspace", "inspect", "--path", root, "--json"];
  for (const cancelled of [false, true]) {
    const pending = deferred();
    let launchArgumentsRead = false;
    const runCli = createVerifiedAilohaCli({
      pin, sdk: { getVerifiedCliLaunch: () => pending.promise },
    });
    const caller = new AbortController();
    const result = runCli(args, { signal: caller.signal, timeoutMs: cancelled ? 1000 : 15 });
    const rejected = assert.rejects(result, { code: cancelled ? "ailoha_cli_cancelled" : "ailoha_cli_timeout" });
    await Promise.resolve();
    if (cancelled) caller.abort();
    await rejected;
    pending.resolve({
      ...pin, file: process.execPath,
      get args() { launchArgumentsRead = true; throw new Error("Retired launch must not dispatch a process."); },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(launchArgumentsRead, false);
  }
});
