import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scenario, sourceSha } from "./ailoha-sdk-double.mjs";
import { copilotUi } from "./copilot-sdk-double.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const product = resolve(process.argv[2]);
const kind = process.argv[3];
const extensionRoot = resolve(process.argv[4] ?? join(source, "vscode"));
const scratch = join(source, ".build", `ailoha-consent-${process.pid}-${randomUUID()}`);
mkdirSync(scratch, { recursive: true });
process.env.MOBILE_CANVAS_BACKEND = "ailoha";
process.env.AILOHA_TEST_SESSION_ID = `consent-session-${process.pid}`;
process.env.AILOHA_TEST_CONTEXT_STATE = join(scratch, "context.json");
const pin = join(product, "lib/ailoha/runtime-package.json");
const previousPin = existsSync(pin) ? readFileSync(pin) : undefined;
writeFileSync(pin, JSON.stringify({ schema: "mobile-canvas.ailoha-runtime/v1", version: "synthetic-only", sourceSha }));
const require = createRequire(import.meta.url);
const vscode = require("vscode");
const { getRuntimeContextBinding } = await import(pathToFileURL(join(product, "lib/ailoha/runtime-backend.mjs")).href);
let canvas;
if (kind === "github") {
  process.env.EXTENSION_PATH = join(scratch, "installed-plugins/mobile-canvas/extension.mjs");
  await import(pathToFileURL(join(product, "extensions/mobile-canvas/extension.mjs")).href);
  canvas = globalThis.ailohaTestCanvasRegistration.canvases[0];
  assert.equal(canvas.id, "mobile-device");
}
const evidence = { host: kind, synthetic: true, cases: [], realDeviceMutation: false };
let current;
const mutationCount = () => scenario.calls.filter((call) => call.method === "DELETE"
  || (call.method === "POST" && /\/actions\/reset$/.test(call.path ?? ""))).length;

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("The consumed host did not reach the expected consent state.");
}

async function open(name) {
  const scope = { sessionId: process.env.AILOHA_TEST_SESSION_ID, viewId: `${kind}-consent-${name}` };
  scenario.status = "running";
  scenario.deleted = false;
  scenario.providerId = "synthetic-provider";
  scenario.nativeId = "native-deployment-not-opaque-target";
  scenario.operationUnavailable = false;
  scenario.targets.clear();
  if (kind === "github") {
    const context = { sessionId: scope.sessionId, instanceId: scope.viewId };
    const opened = await canvas.open(context);
    const url = new URL(opened.url);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const bootstrap = await fetch(new URL("/api/v1/auth/bootstrap", url), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: fragment.get("bootstrap"), sessionId: scope.sessionId, instanceId: scope.viewId,
      }),
    });
    assert.equal(bootstrap.status, 204);
    const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
    return {
      scope, opened,
      action(name, input = {}) {
        const action = canvas.actions.find((entry) => entry.name === name);
        if (action) return action.handler({ ...context, input });
        const paths = {
          uninstall_app: [`/api/v1/devices/${encodeURIComponent(input.deviceId)}/apps/${encodeURIComponent(input.bundleId)}/uninstall?confirm=${input.confirm === true}`, "POST"],
          set_app_op: [`/api/v1/devices/${encodeURIComponent(input.deviceId)}/app-ops`, "POST"],
        };
        const route = paths[name];
        assert.ok(route, `Unknown canvas action: ${name}`);
        return fetch(new URL(route[0], url), {
          method: route[1], headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify(input),
        }).then(async (response) => {
          const value = await response.json();
          if (!response.ok) throw Object.assign(new Error(value.message), value);
          return value;
        });
      },
      close: () => canvas.onClose(context),
    };
  }
  const { resolveAilohaCanvasHost } = require(join(extensionRoot, "out/runtime.js"));
  const { HostBridge } = require(join(extensionRoot, "out/hostBridge.js"));
  const host = await resolveAilohaCanvasHost({
    asAbsolutePath: (path) => join(product, path.replace(/^dist\//, "")),
  }, scope, () => {});
  const messages = [];
  const bridge = new HostBridge(undefined, scope.sessionId, scope.viewId, {
    async postMessage(message) { messages.push(message); return true; },
  }, { appendLine() {} }, undefined, host);
  await bridge.handleMessage({ type: "ready" });
  return {
    scope, opened: await host.openCanvas(),
    async action(name, input = {}) {
      const id = randomUUID();
      const paths = {
        erase_device: [`/api/v1/devices/${encodeURIComponent(input.deviceId)}/erase`, "POST"],
        delete_device: [`/api/v1/devices/${encodeURIComponent(input.deviceId)}`, "DELETE"],
        select_device: ["/api/v1/selection", "POST"],
        uninstall_app: [`/api/v1/devices/${encodeURIComponent(input.deviceId)}/apps/${encodeURIComponent(input.bundleId)}/uninstall?confirm=${input.confirm === true}`, "POST"],
        set_app_op: [`/api/v1/devices/${encodeURIComponent(input.deviceId)}/app-ops`, "POST"],
      };
      const [path, method] = paths[name];
      await bridge.handleMessage({ type: "api", id, path, method, body: JSON.stringify(input) });
      const result = messages.find((message) => message.id === id);
      if (!result) throw new Error("The retired VS Code bridge did not return an API result.");
      assert.equal(result.type, "api-result");
      const value = JSON.parse(new TextDecoder().decode(result.body));
      if (result.status >= 400) throw Object.assign(new Error(value.message), value);
      return value;
    },
    async close() { bridge.dispose(); await bridge.closed(); },
  };
}

async function promptFor() {
  await waitFor(() => kind === "github" ? copilotUi.pending.size > 0
    : vscode.testUi.pickers.some((picker) => picker.visible));
  const prompt = kind === "github" ? copilotUi.prompts.findLast((prompt) => copilotUi.pending.has(prompt.requestId))
    : vscode.testUi.pickers.findLast((picker) => picker.visible);
  assert.ok(prompt);
  return {
    request: prompt,
    answer(decision) {
      if (kind === "github") return copilotUi.respond(prompt.requestId, decision === "approve"
        ? { action: "accept", content: { decision: "approve" } } : { action: decision === "deny" ? "decline" : "cancel" });
      if (decision === "cancel") { prompt.cancel(); return true; }
      return prompt.answer(decision === "approve");
    },
    retired() { return kind === "github" ? !copilotUi.pending.has(prompt.requestId) : prompt.disposed; },
  };
}

async function close() {
  if (current) { await current.close(); current = undefined; }
  await waitFor(() => scenario.leases.size === 0);
}

try {
  for (const [name, action, decision, code] of [
    ["deny", "delete_device", "deny", "consent_denied"],
    ["cancel", "erase_device", "cancel", "consent_cancelled"],
  ]) {
    current = await open(name);
    const before = mutationCount();
    const work = current.action(action, { deviceId: "opaque/target", confirm: true });
    const rejected = assert.rejects(work, { code });
    const prompt = await promptFor(work);
    assert.equal(mutationCount(), before);
    prompt.answer(decision);
    await rejected;
    assert.equal(mutationCount(), before);
    evidence.cases.push(name);
    await close();
  }
  for (const action of ["erase_device", "delete_device"]) {
    current = await open(action);
    const before = mutationCount();
    const work = current.action(action, { deviceId: "opaque/target", confirm: true });
    const prompt = await promptFor(work);
    assert.equal(mutationCount(), before);
    const description = kind === "github" ? prompt.request.message : prompt.request.items[1].detail;
    assert.match(description, /native-deployment-not-opaque-target/);
    assert.match(description, /ctx-/);
    assert.equal(description.includes("processStartedAt"), false);
    prompt.answer("approve");
    const result = await work;
    assert.equal(mutationCount(), before + 1);
    assert.equal(JSON.stringify(result).includes("connectionRef"), false);
    assert.equal(prompt.retired(), true);
    assert.equal(prompt.answer("approve"), false);
    evidence.cases.push(action);
    await close();
  }
  for (const change of ["selection", "retirement", "epoch", "native", "provider"]) {
    current = await open(change);
    const before = mutationCount();
    const work = current.action("erase_device", { deviceId: "opaque/target", confirm: true });
    const code = ["native", "provider"].includes(change) ? "consent_target_changed" : "context_snapshot_superseded";
    const rejected = assert.rejects(work, { code });
    const prompt = await promptFor(work);
    if (change === "selection") await current.action("select_device", { deviceId: "opaque/target" });
    else if (["retirement", "epoch"].includes(change)) {
      const contexts = JSON.parse(readFileSync(process.env.AILOHA_TEST_CONTEXT_STATE, "utf8"));
      const context = contexts.find((entry) => entry.scope.viewId === current.scope.viewId);
      if (change === "retirement") { context.state = "detached"; context.revision = "1"; }
      else { context.scopeEpoch = randomUUID(); context.revision = "0"; }
      writeFileSync(process.env.AILOHA_TEST_CONTEXT_STATE, JSON.stringify(contexts));
      await assert.rejects(getRuntimeContextBinding(current.scope));
    } else {
      if (change === "native") scenario.nativeId = "changed-native-target";
      else scenario.providerId = "changed-provider";
      prompt.answer("approve");
    }
    await rejected;
    assert.equal(mutationCount(), before);
    await waitFor(() => prompt.retired());
    evidence.cases.push(change);
    await close();
  }
  current = await open("replacement");
  {
    const before = mutationCount();
    const work = current.action("erase_device", { deviceId: "opaque/target", confirm: true });
    const rejected = assert.rejects(work);
    const prompt = await promptFor(work);
    await close();
    await rejected;
    scenario.connectionRef = { ...scenario.connectionRef, pid: scenario.connectionRef.pid + 1 };
    current = await open("replacement");
    assert.equal(prompt.answer("approve"), false);
    assert.equal(mutationCount(), before);
    const fresh = current.action("erase_device", { deviceId: "opaque/target", confirm: true });
    const newPrompt = await promptFor(fresh);
    assert.notEqual(newPrompt.request, prompt.request);
    newPrompt.answer("approve");
    await fresh;
    assert.equal(mutationCount(), before + 1);
    evidence.cases.push("replacement");
    await close();
  }
  current = await open("deadline");
  {
    const setTimeout = globalThis.setTimeout;
    let expire;
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay === 60_000) expire = () => callback(...args);
      return setTimeout(callback, delay, ...args);
    };
    try {
      const before = mutationCount();
      const work = current.action("erase_device", { deviceId: "opaque/target", confirm: true });
      const rejected = assert.rejects(work, { code: "consent_timeout" });
      const prompt = await promptFor(work);
      assert.equal(typeof expire, "function");
      expire();
      await rejected;
      await waitFor(() => prompt.retired());
      assert.equal(prompt.answer("approve"), false);
      assert.equal(mutationCount(), before);
      evidence.cases.push("deadline");
    } finally { globalThis.setTimeout = setTimeout; }
    await close();
  }
  current = await open("revalidation-deadline");
  {
    const timeout = globalThis.setTimeout;
    let expire;
    let release;
    let entered = false;
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay === 60_000) expire = () => callback(...args);
      return timeout(callback, delay, ...args);
    };
    try {
      const before = mutationCount();
      const work = current.action("erase_device", { deviceId: "opaque/target", confirm: true });
      const rejected = assert.rejects(work, { code: "consent_timeout" });
      const prompt = await promptFor();
      scenario.beforeTargetRead = async () => {
        entered = true;
        await new Promise((resolve) => { release = resolve; });
      };
      prompt.answer("approve");
      await waitFor(() => entered);
      expire();
      await rejected;
      release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(mutationCount(), before);
      evidence.cases.push("revalidation-deadline");
    } finally {
      scenario.beforeTargetRead = undefined;
      globalThis.setTimeout = timeout;
    }
    await close();
  }
  current = await open("external-during-probe");
  {
    const before = mutationCount();
    const work = current.action("erase_device", { deviceId: "opaque/target", confirm: true });
    const rejected = assert.rejects(work, { code: "context_snapshot_superseded" });
    const prompt = await promptFor();
    scenario.beforeTargetRead = async () => {
      const contexts = JSON.parse(readFileSync(process.env.AILOHA_TEST_CONTEXT_STATE, "utf8"));
      const context = contexts.find((entry) => entry.scope.viewId === current.scope.viewId);
      context.revision = String(BigInt(context.revision) + 1n);
      writeFileSync(process.env.AILOHA_TEST_CONTEXT_STATE, JSON.stringify(contexts));
      scenario.beforeTargetRead = undefined;
    };
    prompt.answer("approve");
    await rejected;
    assert.equal(mutationCount(), before);
    evidence.cases.push("external-during-probe");
    await close();
  }
  for (const cancellation of ["deadline", "owner", "caller"]) {
    current = await open(`queued-${cancellation}`);
    const timeout = globalThis.setTimeout;
    let expire;
    let release;
    let queuedSignal;
    const before = mutationCount();
    scenario.beforeMutationAdmission = async (_path, options) => {
      queuedSignal = options.signal;
      await new Promise((resolve) => { release = resolve; });
    };
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay === 60_000) expire = () => callback(...args);
      return timeout(callback, delay, ...args);
    };
    try {
      const caller = new AbortController();
      let work;
      if (cancellation === "caller") {
        const url = new URL(current.opened.url);
        const fragment = new URLSearchParams(url.hash.slice(1));
        const bootstrap = await fetch(new URL("/api/v1/auth/bootstrap", url), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: fragment.get("bootstrap"), sessionId: current.scope.sessionId, instanceId: current.scope.viewId,
          }),
        });
        assert.equal(bootstrap.status, 204);
        work = fetch(new URL("/api/v1/devices/opaque%2Ftarget/erase", url), {
          method: "POST", signal: caller.signal,
          headers: { "Content-Type": "application/json", Cookie: bootstrap.headers.get("set-cookie").split(";", 1)[0] },
          body: JSON.stringify({ confirm: true }),
        });
      } else work = current.action("erase_device", { deviceId: "opaque/target", confirm: true });
      const rejected = assert.rejects(work);
      const prompt = await promptFor();
      prompt.answer("approve");
      await waitFor(() => queuedSignal);
      if (cancellation === "deadline") expire();
      else if (cancellation === "owner") await close();
      else caller.abort();
      await waitFor(() => queuedSignal.aborted);
      release();
      await rejected;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(mutationCount(), before);
      assert.equal(prompt.answer("approve"), false);
      evidence.cases.push(`queued-${cancellation}`);
    } finally {
      scenario.beforeMutationAdmission = undefined;
      globalThis.setTimeout = timeout;
      await close();
    }
  }
  current = await open("unsupported-host");
  {
    const before = mutationCount();
    const original = vscode.window.createQuickPick;
    if (kind === "github") copilotUi.supported = false;
    else vscode.window.createQuickPick = undefined;
    try {
      await assert.rejects(current.action("erase_device", { deviceId: "opaque/target", confirm: true }),
        { code: "capability_not_supported" });
      assert.equal(mutationCount(), before);
      evidence.cases.push("unsupported-host");
    } finally {
      copilotUi.supported = true;
      vscode.window.createQuickPick = original;
    }
    await close();
  }
  current = await open("admission");
  {
    const before = mutationCount();
    scenario.operationUnavailable = true;
    for (let index = 0; index < 65; index += 1) {
      const id = `explicit-target-${index}`;
      scenario.targets.set(id, {
        targetId: id, providerId: "synthetic-provider", targetTypeId: "type", status: "running", surfaces: [],
        nativeIdentity: { platform: "ios", nativeId: `explicit-native-${index}` },
      });
    }
    for (let index = 0; index < 64; index += 1) {
      const work = current.action("erase_device", { deviceId: `explicit-target-${index}`, confirm: true });
      const rejected = assert.rejects(work, { status: 503 });
      const prompt = await promptFor(work);
      prompt.answer("approve");
      await rejected;
    }
    await assert.rejects(current.action("erase_device", { deviceId: "explicit-target-64", confirm: true }),
      { code: "operation_receipt_limit" });
    assert.equal(mutationCount(), before + 64);
    await assert.rejects(current.action("erase_device", { deviceId: "explicit-target-0", confirm: true }), { status: 503 });
    assert.equal(mutationCount(), before + 64);
    evidence.cases.push("admission-and-resume");
    await close();
  }
  scenario.appResponses = true;
  scenario.fencedAppResponses = true;
  scenario.platform = "ios";
  process.env.AILOHA_TEST_APP_PLATFORM = "ios";
  current = await open("fenced-uninstall-denial");
  {
    await current.action("select_device", { deviceId: "opaque/target" });
    const work = current.action("uninstall_app", {
      deviceId: "opaque/target", bundleId: "com.example.native", confirm: true,
    });
    const rejected = assert.rejects(work, { code: "consent_denied" });
    const prompt = await promptFor();
    const message = kind === "github" ? prompt.request.message : prompt.request.items[1].detail;
    assert.match(message, /Native package: com\.example\.native/);
    prompt.answer("deny");
    await rejected;
    assert.equal(existsSync(`${process.env.AILOHA_TEST_CONTEXT_STATE}.fenced`), false);
    evidence.cases.push("fenced-uninstall-denial");
    await close();
  }
  for (const interruption of ["deadline", "owner"]) {
    current = await open(`fenced-uninstall-${interruption}`);
    const timeout = globalThis.setTimeout;
    let expire;
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay === 60_000) expire = () => callback(...args);
      return timeout(callback, delay, ...args);
    };
    try {
      await current.action("select_device", { deviceId: "opaque/target" });
      const work = current.action("uninstall_app", {
        deviceId: "opaque/target", bundleId: "com.example.native", confirm: true,
      });
      const rejected = interruption === "deadline"
        ? assert.rejects(work, { code: "consent_timeout" }) : assert.rejects(work);
      const prompt = await promptFor();
      if (interruption === "deadline") { assert.ok(expire); expire(); }
      else await current.close();
      await rejected;
      assert.equal(prompt.answer("approve"), false);
      assert.equal(existsSync(`${process.env.AILOHA_TEST_CONTEXT_STATE}.fenced`), false);
      evidence.cases.push(`fenced-uninstall-${interruption}`);
    } finally {
      globalThis.setTimeout = timeout;
      await close();
    }
  }
  for (const interruption of ["deadline", "owner"]) {
    current = await open(`fenced-uninstall-queued-${interruption}`);
    const timeout = globalThis.setTimeout;
    let expire;
    let release;
    let launchBlocked = false;
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay === 60_000) expire = () => callback(...args);
      return timeout(callback, delay, ...args);
    };
    try {
      await current.action("select_device", { deviceId: "opaque/target" });
      const work = current.action("uninstall_app", {
        deviceId: "opaque/target", bundleId: "com.example.native", confirm: true,
      });
      const rejected = interruption === "deadline"
        ? assert.rejects(work, { code: "consent_timeout" }) : assert.rejects(work);
      const prompt = await promptFor();
      scenario.beforeCliLaunch = async () => {
        launchBlocked = true;
        await new Promise((resolve) => { release = resolve; });
      };
      prompt.answer("approve");
      await waitFor(() => launchBlocked);
      if (interruption === "deadline") { assert.ok(expire); expire(); }
      else await current.close();
      release();
      await rejected;
      assert.equal(existsSync(`${process.env.AILOHA_TEST_CONTEXT_STATE}.fenced`), false);
      evidence.cases.push(`fenced-uninstall-queued-${interruption}`);
    } finally {
      if (release) release();
      scenario.beforeCliLaunch = undefined;
      globalThis.setTimeout = timeout;
      await close();
    }
  }
  current = await open("fenced-uninstall-approved");
  {
    await current.action("select_device", { deviceId: "opaque/target" });
    const work = current.action("uninstall_app", {
      deviceId: "opaque/target", bundleId: "com.example.native", confirm: true,
    });
    const prompt = await promptFor();
    prompt.answer("approve");
    const result = await work;
    assert.equal(result.operation, "uninstall");
    assert.equal(result.bundleId, "com.example.native");
    assert.equal(JSON.stringify(result).includes("installationEvidence"), false);
    const native = JSON.parse(readFileSync(`${process.env.AILOHA_TEST_CONTEXT_STATE}.fenced`, "utf8"));
    assert.equal(native.length, 1);
    assert.equal(native[0].kind, "uninstallFencedTargetApp");
    assert.equal(scenario.calls.some((entry) => entry.method === "DELETE"
      && entry.path?.includes("/apps/")), false);
    evidence.cases.push("fenced-uninstall-approved");
    await close();
  }
  current = await open("fenced-uninstall-accepted-nonzero");
  {
    await current.action("select_device", { deviceId: "opaque/target" });
    process.env.AILOHA_TEST_FENCED_ACCEPTED_NONZERO = "1";
    try {
      const work = current.action("uninstall_app", {
        deviceId: "opaque/target", bundleId: "com.example.native", confirm: true,
      });
      const prompt = await promptFor();
      prompt.answer("approve");
      const result = await work;
      assert.equal(result.operation, "uninstall");
      const native = JSON.parse(readFileSync(`${process.env.AILOHA_TEST_CONTEXT_STATE}.fenced`, "utf8"));
      assert.equal(native.length, 2);
      assert.equal(new Set(native.map((entry) => entry.operationId)).size, 2);
      evidence.cases.push("fenced-uninstall-accepted-nonzero");
    } finally {
      delete process.env.AILOHA_TEST_FENCED_ACCEPTED_NONZERO;
      await close();
    }
  }
  scenario.platform = "android";
  process.env.AILOHA_TEST_APP_PLATFORM = "android";
  current = await open("fenced-android-app-op");
  {
    await current.action("select_device", { deviceId: "opaque/target" });
    const work = current.action("set_app_op", {
      deviceId: "opaque/target", bundleId: "com.example.native",
      operation: "SYSTEM_ALERT_WINDOW", mode: "ignore",
    });
    const prompt = await promptFor();
    const message = kind === "github" ? prompt.request.message : prompt.request.items[1].detail;
    assert.match(message, /whole UID scope/);
    assert.match(message, /Requested package mode: ignored/);
    prompt.answer("approve");
    const result = await work;
    assert.equal(result.mode, "ignore");
    assert.equal(result.operation, "SYSTEM_ALERT_WINDOW");
    const native = JSON.parse(readFileSync(`${process.env.AILOHA_TEST_CONTEXT_STATE}.fenced`, "utf8"));
    assert.equal(native.length, 3);
    assert.equal(native[2].result.uidScoped, true);
    assert.equal(scenario.calls.some((entry) => entry.method === "PUT"
      && entry.path?.includes("/app-ops/")), false);
    evidence.cases.push("fenced-android-app-op");
    await close();
  }
  current = await open("fenced-android-app-op-denial");
  {
    await current.action("select_device", { deviceId: "opaque/target" });
    const work = current.action("set_app_op", {
      deviceId: "opaque/target", bundleId: "com.example.native",
      operation: "SYSTEM_ALERT_WINDOW", mode: "ignore",
    });
    const rejected = assert.rejects(work, { code: "consent_denied" });
    const prompt = await promptFor();
    prompt.answer("deny");
    await rejected;
    assert.equal(JSON.parse(readFileSync(`${process.env.AILOHA_TEST_CONTEXT_STATE}.fenced`, "utf8")).length, 3);
    evidence.cases.push("fenced-android-app-op-denial");
    await close();
  }
  evidence.leaseCountAfterClose = scenario.leases.size;
  evidence.pendingHumanPrompts = kind === "github" ? copilotUi.pending.size
    : vscode.testUi.pickers.filter((picker) => !picker.disposed).length;
  assert.equal(evidence.pendingHumanPrompts, 0);
  process.stdout.write(JSON.stringify(evidence));
} finally {
  await close();
  if (previousPin) writeFileSync(pin, previousPin);
  else rmSync(pin, { force: true });
  rmSync(scratch, { recursive: true });
}
