import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { productModule } from "../ailoha-test-module.mjs";
const { AilohaMobileBackend } = await import(productModule("lib/ailoha/mobile-backend.mjs"));
const { mobileCanvasBackend } = await import(productModule("lib/backend.mjs"));
const { createAilohaMediaAdapter } = await import(productModule("lib/ailoha/media-adapter.mjs"));
const { AilohaProtocolError } = await import(productModule("lib/ailoha/errors.mjs"));
const { publicSnapshot, MobileAilohaError } = await import(productModule("lib/ailoha/mobile-projection.mjs"));
const { createAilohaContextStore } = await import(productModule("lib/ailoha/context-adapter.mjs"));

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function fixture(options = {}) {
  const calls = [];
  const cleanups = new Set();
  let selection = null;
  let contextState = "open";
  let revision = 7;
  const surface = () => ({
    surfaceId: "surface/opaque", kind: "display",
    bounds: { x: -10, y: 20, width: 390, height: 844 },
    geometryRevision: revision, capabilities: [],
  });
  const targets = new Map(["one", "two"].map((id) => [id, {
    targetId: id, providerId: "provider", targetTypeId: "type", status: "running", surfaces: [surface()],
    nativeIdentity: { platform: "ios", nativeId: `real-native-${id}`, isVirtual: true },
  }]));
  const providers = [{ providerId: "provider", name: "Provider", version: "1", state: "ready", capabilities: [] }];
  const capabilities = [{ id: "target.lifecycle", version: 1, features: ["startTarget", "stopTarget", "rebootTarget", "resetTarget", "deleteTarget"] }];
  if (options.app) {
    capabilities.push({ id: "target.apps", version: 1,
      features: ["listTargetApps", "launchTargetApp", "terminateTargetApp",
        "uninstallTargetApp", "installStagedTargetApp"] });
    capabilities.push({ id: "target.app-ops", version: 1, features: ["listTargetAppOps", "updateTargetAppOp"] });
  }
  const client = {
    async getHostStatus() { return { hostId: "host", profile: "ailoha.target-host/v1", version: "test", state: "ready",
      capabilities: options.stagedApps ? [{ id: "host.artifacts", version: 1, features: ["createArtifact"] }] : [] }; },
    async listProviders() { return providers; },
    async listTargets() { return [...targets.values()]; },
    async getTarget(id) { calls.push(["get", id]); return { ...targets.get(id), surfaces: [surface()] }; },
    async getTargetCapabilities() { return capabilities; },
    async listTargetApps(id, query) {
      calls.push(["app-list", id, query.includeSystem]);
      return options.apps ?? [{
        appId: "opaque-app", packageId: "com.example.native", state: "installed",
        name: "Fixture", version: "1", buildNumber: "2",
      }];
    },
    async getTargetApp(id, appId) {
      calls.push(["app-get", id, appId]);
      return { appId, packageId: "com.example.native", state: "stopped" };
    },
    async launchTargetApp(id, appId, request) {
      calls.push(["app-launch", id, appId, request]); return { operationId: "app-launch" };
    },
    async terminateTargetApp(id, appId) { calls.push(["app-terminate", id, appId]); return { operationId: "app-terminate" }; },
    async uninstallTargetApp(id, appId, request) {
      calls.push(["app-uninstall", id, appId, request.confirmed]); return { operationId: "app-uninstall" };
    },
    async listTargetAppOps(id, appId) { calls.push(["app-op-list", id, appId]); return options.appOps ?? []; },
    async startTarget(id) { calls.push(["start", id]); return { operationId: `start-${id}` }; },
    async stopTarget(id) { calls.push(["stop", id]); return { operationId: `stop-${id}` }; },
    async rebootTarget(id) { calls.push(["reboot", id]); return { operationId: `reboot-${id}` }; },
    async resetTarget(id, options) { calls.push(["reset", id, options.confirmed]); return { operationId: `reset-${id}` }; },
    async deleteTarget(id, options) { calls.push(["delete", id, options.confirmed]); return { operationId: `delete-${id}` }; },
    async waitForOperation(id) {
      calls.push(["wait", id]);
      if (options.wait) await options.wait.promise;
      if (id.startsWith("start") || id.startsWith("reboot")) targets.get(id.split("-")[1]).status = "running";
      if (id.startsWith("stop")) targets.get(id.split("-")[1]).status = "stopped";
      return {
        operationId: id, kind: `${id.split("-")[0]}Target`, targetId: id.split("-")[1], providerId: "provider",
        status: "succeeded", destructive: id.startsWith("reset") || id.startsWith("delete"),
        createdAt: "2026-10-09T23:00:00Z", startedAt: "2026-10-09T23:00:01Z", completedAt: "2026-10-09T23:00:02Z",
      };
    },
    dispose() { calls.push(["client-dispose"]); },
    ...options.client,
  };
  const media = {
    supported() { return { screenshot: true, tap: true, longPress: true, swipe: true, liveStream: true }; },
    async screenshot(invocation) { calls.push(["screenshot", invocation.targetId]); return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]); },
    async tap(invocation, input) { calls.push(["tap", invocation, input]); },
    async swipe(invocation, input) { calls.push(["swipe", invocation, input]); },
    async createVideo(invocation) {
      calls.push(["video-create", invocation.targetId]);
      if (options.createWait) await options.createWait.promise;
      return { videoSessionId: "video", targetId: invocation.targetId, surfaceId: invocation.surfaceId };
    },
    async attachVideo(invocation, descriptor, callbacks) {
      calls.push(["video-attach", invocation.targetId]);
      return {
        protocol: "ailoha.video.v1",
        async send(text) { calls.push(["video-send", text]); return options.sendResult; },
        async close() { calls.push(["video-close"]); if (options.closeWait) await options.closeWait.promise; return options.closeResult; },
        callbacks,
      };
    },
    async deleteVideo(invocation) { calls.push(["video-delete", invocation.targetId]); },
    ...options.media,
  };
  const selectionStore = options.selectionStore ?? {
    get state() { return contextState; },
    async readSnapshot() {
      const projection = this.contextProjection;
      return publicSnapshot({
        selection, state: contextState,
        ...(projection ? {
          contextProjection: projection,
          identity: { scopeEpoch: projection.scopeEpoch, revision: projection.revision },
        } : {}),
      });
    },
    isCurrentSnapshot(snapshot) {
      const projection = this.contextProjection;
      return contextState === "open" && (!snapshot.contextProjection || (projection
        && snapshot.contextProjection.contextRef === projection.contextRef
        && snapshot.identity.scopeEpoch === projection.scopeEpoch && snapshot.identity.revision === projection.revision));
    },
    async set(value) { selection = value; },
    async clear() { selection = null; },
  };
  const owner = {
    hostId: "host",
    connectionRef: options.connectionRef ?? {
      schema: "ailoha.target-host.connection/v1", serviceId: "fixture-service", pid: 12345,
      startedAt: "2026-10-09T23:00:00Z", processStartedAt: "2026-10-09T22:59:59Z",
    },
    registerCleanup(callback) { cleanups.add(callback); return () => cleanups.delete(callback); },
    async release() {
      calls.push(["release-begin"]);
      for (const callback of [...cleanups].reverse()) await callback();
      calls.push(["release-end"]);
    },
  };
  const backend = new AilohaMobileBackend({
    scope: { sessionId: "unique-session", viewId: "unique-view" },
    client, media, owner, selectionStore,
    confirmDestructive: options.confirmDestructive,
    beginDestructiveApproval: options.beginDestructiveApproval,
    stagedApps: options.stagedApps,
    allowHostPackage: options.allowHostPackage,
    saveScreenshot: options.saveScreenshot,
    operationState: options.operationState,
    videoState: options.videoState,
  });
  return {
    backend, calls, targets, providers, client, media, cleanups, selectionStore, owner,
    retireContext() { contextState = "detached"; },
    geometryChanged() { revision += 1; },
    selectHost(hostId) { selection = { targetHostId: hostId, targetId: "one" }; },
  };
}

test("app compatibility uses native package mapping and waits for its exact accepted target operation", async (t) => {
  const state = fixture({ app: true });
  t.after(() => state.backend.dispose());
  state.client.waitForOperation = async (id) => ({
    operationId: id, kind: id === "app-launch" ? "launchTargetApp" : "terminateTargetApp",
    targetId: "one", providerId: "provider", status: "succeeded", destructive: false,
  });
  assert.equal((await state.backend.launchApp("one", "com.example.native")).bundleId, "com.example.native");
  assert.deepEqual(state.calls.find((call) => call[0] === "app-launch"), ["app-launch", "one", "opaque-app", {}]);
  assert.equal((await state.backend.launchApp("one", "com.example.native", true)).operation, "launch");
  const sequence = state.calls.filter(([name]) => name === "app-terminate" || name === "app-get" || name === "app-launch")
    .map(([name]) => name);
  assert.deepEqual(sequence.slice(-3), ["app-terminate", "app-get", "app-launch"]);
  const api = await state.backend.request("/api/v1/devices/one/apps/launch", {
    method: "POST", body: JSON.stringify({ bundleId: "com.example.native" }),
  });
  assert.equal(api.status, 200);
  assert.equal((await api.json()).bundleId, "com.example.native");
  const withArguments = await state.backend.request("/api/v1/devices/one/apps/launch", {
    method: "POST", body: JSON.stringify({ bundleId: "com.example.native", arguments: ["--safe", "two words"] }),
  });
  assert.equal(withArguments.status, 200);
  assert.deepEqual(state.calls.filter(([name]) => name === "app-launch").at(-1),
    ["app-launch", "one", "opaque-app", { arguments: ["--safe", "two words"] }]);
  assert.equal((await state.backend.request("/api/v1/devices/one/apps/launch", {
    method: "POST", body: JSON.stringify({ bundleId: "com.example.native", arguments: ["ok", 3] }),
  })).status, 400);
});

test("missing canonical inventory fields never become invented user/system, process or path metadata", async (t) => {
  const state = fixture({ app: true });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.listApps("one"), { code: "capability_not_supported" });
  await assert.rejects(state.backend.listApps("one", { includeSystem: true }), { code: "capability_not_supported" });
  const empty = fixture({ app: true, apps: [] });
  t.after(() => empty.backend.dispose());
  assert.deepEqual(await empty.backend.listApps("one"), {
    schemaVersion: "1.0", deviceId: "one", platform: "ios", total: 0, apps: [],
  });
  assert.equal((await state.backend.request("/api/v1/devices/one/apps?system=true")).status, 501);
  assert.deepEqual(state.calls.filter(([name]) => name === "app-launch"), []);
});

test("reviewed optional native metadata projects exact legacy inventory and system filtering", async (t) => {
  const state = fixture({ app: true, apps: [
    { appId: "system-app", packageId: "com.example.system", name: "Alpha system",
      version: "", buildNumber: "", state: "running", kind: "system", processId: 48 },
    { appId: "opaque-app", packageId: "com.example.native", name: "Zed",
      version: "2.0", buildNumber: "7", state: "running", kind: "user", processId: 4321,
      path: "/apps/example.app", dataContainer: "/containers/example" },
    { appId: "other-app", packageId: "com.example.other", name: "",
      version: "", buildNumber: "", state: "installed", kind: "user" },
  ] });
  t.after(() => state.backend.dispose());
  assert.deepEqual(await state.backend.listApps("one", { limit: 1 }), {
    schemaVersion: "1.0", deviceId: "one", platform: "ios", total: 2,
    apps: [{
      bundleId: "com.example.other", name: null, version: null, build: null,
      kind: "user", running: false, processId: null, path: null, dataContainer: null,
    }],
  });
  assert.deepEqual(await state.backend.listApps("one", { includeSystem: true, text: "example", limit: 10 }), {
    schemaVersion: "1.0", deviceId: "one", platform: "ios", total: 3,
    apps: [
      { bundleId: "com.example.other", name: null, version: null, build: null,
        kind: "user", running: false, processId: null, path: null, dataContainer: null },
      { bundleId: "com.example.native", name: "Zed", version: "2.0", build: "7",
        kind: "user", running: true, processId: 4321,
        path: "/apps/example.app", dataContainer: "/containers/example" },
      { bundleId: "com.example.system", name: "Alpha system", version: null, build: null,
        kind: "system", running: true, processId: 48, path: null, dataContainer: null },
    ],
  });
  assert.deepEqual(state.calls.filter(([name]) => name === "app-list")
    .map(([, , includeSystem]) => includeSystem), [false, true]);
  const unclassified = fixture({ app: true, apps: [
    { appId: "generic", packageId: "com.example.unknown", name: "Unknown",
      version: "1", buildNumber: "1", state: "installed" },
  ] });
  t.after(() => unclassified.backend.dispose());
  await assert.rejects(unclassified.backend.listApps("one", { includeSystem: true }), { code: "capability_not_supported" });
  const installing = fixture({ app: true, apps: [
    { appId: "installing", packageId: "com.example.pending", name: "Pending",
      version: "1", buildNumber: "1", state: "installing", kind: "user" },
  ] });
  t.after(() => installing.backend.dispose());
  await assert.rejects(installing.backend.listApps("one"), { code: "capability_not_supported" });
});

test("app mutation and app-op capabilities require the canonical inventory used for native ID lookup", async (t) => {
  const state = fixture({ app: true });
  t.after(() => state.backend.dispose());
  state.client.getTargetCapabilities = async () => [
    { id: "target.apps", version: 1, features: ["launchTargetApp", "terminateTargetApp", "uninstallTargetApp"] },
    { id: "target.app-ops", version: 1, features: ["listTargetAppOps"] },
  ];
  for (const target of state.targets.values()) target.nativeIdentity.platform = "android";
  const { capabilities } = await state.backend.getDevice("one");
  assert.equal(capabilities.appList, false);
  assert.equal(capabilities.appLaunch, false);
  assert.equal(capabilities.appTerminate, false);
  assert.equal(capabilities.appOpList, false);
  await assert.rejects(state.backend.launchApp("one", "com.example.native"), { code: "capability_not_supported" });
  await assert.rejects(state.backend.listAppOps("one", "com.example.native"), { code: "capability_not_supported" });
  assert.equal(state.calls.some(([name]) => name === "app-launch" || name === "app-op-list"), false);
  const otherPlatform = fixture({ app: true });
  t.after(() => otherPlatform.backend.dispose());
  otherPlatform.targets.get("one").nativeIdentity.platform = "browser";
  const projected = await otherPlatform.backend.getDevice("one");
  assert.equal(projected.capabilities.appList, false);
  assert.equal(projected.capabilities.appLaunch, false);
  assert.equal(projected.capabilities.appOpList, false);
});

test("stale named app authority before dispatch and failed terminate prevent the next mutation", async (t) => {
  const state = canonicalFixture({ app: true });
  t.after(() => state.backend.dispose());
  const waiting = deferred();
  const proceed = deferred();
  state.client.listTargetApps = async () => {
    waiting.resolve();
    await proceed.promise;
    return [{ appId: "opaque-app", packageId: "com.example.native", state: "installed" }];
  };
  const pending = assert.rejects(state.backend.launchApp("one", "com.example.native"), { code: "context_snapshot_superseded" });
  await waiting.promise;
  await state.advanceSelection();
  proceed.resolve();
  await pending;
  assert.equal(state.calls.some(([name]) => name === "app-launch"), false);
  const failed = fixture({ app: true });
  t.after(() => failed.backend.dispose());
  failed.client.waitForOperation = async (id) => {
    throw new AilohaProtocolError("operation_failed", {
      operationId: id,
      operation: { operationId: id, kind: "terminateTargetApp", targetId: "one", providerId: "provider", status: "failed" },
    });
  };
  await assert.rejects(failed.backend.launchApp("one", "com.example.native", true), { code: "operation_failed" });
  assert.equal(failed.calls.some(([name]) => name === "app-launch"), false);
});

test("target replacement before dispatch and after acceptance cannot inherit app ownership", async (t) => {
  const replaced = fixture({ app: true });
  t.after(() => replaced.backend.dispose());
  const listApps = replaced.client.listTargetApps;
  replaced.client.listTargetApps = async (...args) => {
    const apps = await listApps(...args);
    replaced.targets.get("one").nativeIdentity.nativeId = "another-native-target";
    return apps;
  };
  await assert.rejects(replaced.backend.launchApp("one", "com.example.native"), { code: "app_target_replaced" });
  assert.equal(replaced.calls.some(([name]) => name === "app-launch"), false);

  const accepted = fixture({ app: true });
  t.after(() => accepted.backend.dispose());
  let submissions = 0;
  accepted.client.launchTargetApp = async () => {
    submissions += 1;
    return { operationId: "accepted-native-app" };
  };
  accepted.client.waitForOperation = async () => {
    throw new AilohaProtocolError("timeout", { operationId: "accepted-native-app" });
  };
  await assert.rejects(accepted.backend.launchApp("one", "com.example.native"), { code: "timeout" });
  accepted.targets.get("one").nativeIdentity.nativeId = "replacement-after-acceptance";
  await assert.rejects(accepted.backend.launchApp("one", "com.example.native"), { code: "operation_owner_mismatch" });
  assert.equal(submissions, 1);
});

test("lost app acceptance retains original operation and native app across a selected-target change", async (t) => {
  const state = fixture({ app: true });
  t.after(() => state.backend.dispose());
  let submissions = 0;
  const accepted = deferred();
  const complete = deferred();
  state.client.launchTargetApp = async () => {
    submissions += 1;
    throw new AilohaProtocolError("transport_error", { status: 202, operationId: "accepted-app-launch" });
  };
  state.client.waitForOperation = async (id) => {
    assert.equal(id, "accepted-app-launch");
    accepted.resolve();
    await complete.promise;
    return {
      operationId: id, targetId: "one", providerId: "provider",
      kind: "launchTargetApp", status: "succeeded", destructive: false,
    };
  };
  const pending = state.backend.launchApp("one", "com.example.native");
  await accepted.promise;
  await state.backend.select("two");
  complete.resolve();
  assert.equal((await pending).success, true);
  assert.equal(submissions, 1);
});

test("accepted app receipts retain private incarnation ownership across host recovery", async (t) => {
  const operationState = new Map();
  const connectionRef = {
    schema: "ailoha.target-host.connection/v1", serviceId: "fixture-service", pid: 12345,
    startedAt: "2026-10-09T23:00:00Z", processStartedAt: "2026-10-09T22:59:59Z",
  };
  let submissions = 0;
  const client = {
    async launchTargetApp() { submissions += 1; return { operationId: "accepted-app-launch" }; },
    async waitForOperation() { throw new AilohaProtocolError("timeout", { operationId: "accepted-app-launch" }); },
  };
  const initial = fixture({ app: true, operationState, connectionRef, client });
  t.after(() => initial.backend.dispose());
  await assert.rejects(initial.backend.launchApp("one", "com.example.native"), { code: "timeout" });
  const [receipt] = operationState.values();
  assert.deepEqual(receipt.connectionRef, connectionRef);
  assert.equal(Object.keys(receipt).includes("connectionRef"), false);
  assert.equal(JSON.stringify(receipt).includes("processStartedAt"), false);

  const replacements = {
    serviceId: "replacement-service", pid: 99999,
    startedAt: "2026-10-09T23:00:01Z", processStartedAt: "2026-10-09T22:59:58Z",
  };
  for (const field of ["serviceId", "pid", "startedAt", "processStartedAt"]) {
    const replaced = fixture({
      app: true, operationState, connectionRef: { ...connectionRef, [field]: replacements[field] },
      client,
    });
    t.after(() => replaced.backend.dispose());
    await assert.rejects(replaced.backend.launchApp("one", "com.example.native"),
      { code: "runtime_incarnation_changed" });
    assert.equal(replaced.calls.some(([name]) => name === "app-list"
      || name === "app-launch" || name === "app-get"), false);
  }
  const resumed = fixture({ app: true, operationState, connectionRef: { ...connectionRef },
    client: { ...client, async waitForOperation(id) {
      return { operationId: id, kind: "launchTargetApp", targetId: "one",
        providerId: "provider", status: "succeeded", destructive: false };
    } } });
  t.after(() => resumed.backend.dispose());
  assert.equal((await resumed.backend.launchApp("one", "com.example.native")).success, true);
  assert.equal(submissions, 1);
});

test("unknown app acceptance cannot submit twice and cold relaunch never repeats a successful stop", async (t) => {
  const uncertain = fixture({ app: true });
  t.after(() => uncertain.backend.dispose());
  let posts = 0;
  uncertain.client.launchTargetApp = async () => {
    posts += 1;
    throw new AilohaProtocolError("transport_error");
  };
  await assert.rejects(uncertain.backend.launchApp("one", "com.example.native"), { code: "transport_error" });
  await assert.rejects(uncertain.backend.launchApp("one", "com.example.native"), { code: "app_outcome_uncertain" });
  assert.equal(posts, 1);

  const cold = fixture({ app: true });
  t.after(() => cold.backend.dispose());
  let stops = 0;
  let starts = 0;
  cold.client.terminateTargetApp = async () => { stops += 1; return { operationId: "app-terminate" }; };
  cold.client.launchTargetApp = async () => { starts += 1; throw new AilohaProtocolError("transport_error"); };
  cold.client.waitForOperation = async () => ({
    operationId: "app-terminate", targetId: "one", providerId: "provider",
    kind: "terminateTargetApp", status: "succeeded", destructive: false,
  });
  await assert.rejects(cold.backend.launchApp("one", "com.example.native", true), { code: "transport_error" });
  await assert.rejects(cold.backend.launchApp("one", "com.example.native", true), { code: "app_outcome_uncertain" });
  assert.equal(stops, 1);
  assert.equal(starts, 1);
});

test("completed terminate is not resubmitted when cold relaunch readback fails", async (t) => {
  for (const outcome of ["transport", "running"]) {
    const state = fixture({ app: true });
    t.after(() => state.backend.dispose());
    let stops = 0;
    let reads = 0;
    state.client.terminateTargetApp = async () => {
      stops += 1;
      return { operationId: "app-terminate" };
    };
    state.client.waitForOperation = async (id) => ({
      operationId: id, kind: id === "app-terminate" ? "terminateTargetApp" : "launchTargetApp",
      targetId: "one", providerId: "provider", status: "succeeded", destructive: false,
    });
    state.client.getTargetApp = async () => {
      reads += 1;
      if (reads === 1 && outcome === "transport") throw new AilohaProtocolError("transport_error");
      return { appId: "opaque-app", packageId: "com.example.native",
        state: reads === 1 && outcome === "running" ? "running" : "stopped" };
    };
    await assert.rejects(state.backend.launchApp("one", "com.example.native", true),
      { code: outcome === "transport" ? "transport_error" : "app_stop_unconfirmed" });
    assert.equal(stops, 1);
    assert.equal(state.calls.filter(([name]) => name === "app-launch").length, 0);
    assert.equal((await state.backend.launchApp("one", "com.example.native", true)).success, true);
    assert.equal(stops, 1);
    assert.equal(reads, 2);
    assert.equal(state.calls.filter(([name]) => name === "app-launch").length, 1);
  }
});

test("completed terminate readback cannot launch on a replaced target or replay an unknown stop", async (t) => {
  const replaced = fixture({ app: true });
  t.after(() => replaced.backend.dispose());
  let stops = 0;
  replaced.client.terminateTargetApp = async () => {
    stops += 1;
    return { operationId: "app-terminate" };
  };
  replaced.client.waitForOperation = async (id) => ({
    operationId: id, kind: "terminateTargetApp",
    targetId: "one", providerId: "provider", status: "succeeded", destructive: false,
  });
  replaced.client.getTargetApp = async () => { throw new AilohaProtocolError("transport_error"); };
  await assert.rejects(replaced.backend.launchApp("one", "com.example.native", true), { code: "transport_error" });
  replaced.targets.get("one").nativeIdentity.nativeId = "replacement-after-stop";
  await assert.rejects(replaced.backend.launchApp("one", "com.example.native", true), { code: "operation_owner_mismatch" });
  assert.equal(stops, 1);
  assert.equal(replaced.calls.filter(([name]) => name === "app-launch").length, 0);

  const unknown = fixture({ app: true });
  t.after(() => unknown.backend.dispose());
  let unknownStops = 0;
  unknown.client.terminateTargetApp = async () => {
    unknownStops += 1;
    throw new AilohaProtocolError("transport_error");
  };
  await assert.rejects(unknown.backend.launchApp("one", "com.example.native", true), { code: "transport_error" });
  await assert.rejects(unknown.backend.launchApp("one", "com.example.native", true), { code: "app_outcome_uncertain" });
  assert.equal(unknownStops, 1);
  assert.equal(unknown.calls.filter(([name]) => name === "app-launch").length, 0);
});

test("completed terminate is not resubmitted after failed readback and view reopening", async (t) => {
  const operationState = new Map();
  let stops = 0;
  const original = fixture({ app: true, operationState });
  t.after(() => original.backend.dispose());
  original.client.terminateTargetApp = async () => {
    stops += 1;
    return { operationId: "app-terminate" };
  };
  original.client.waitForOperation = async (id) => ({
    operationId: id, kind: "terminateTargetApp", targetId: "one",
    providerId: "provider", status: "succeeded", destructive: false,
  });
  original.client.getTargetApp = async () => { throw new AilohaProtocolError("transport_error"); };
  await assert.rejects(original.backend.launchApp("one", "com.example.native", true), { code: "transport_error" });
  await original.backend.dispose();

  const reopened = fixture({ app: true, operationState });
  t.after(() => reopened.backend.dispose());
  reopened.client.terminateTargetApp = async () => {
    stops += 1;
    return { operationId: "unwanted-second-stop" };
  };
  reopened.client.waitForOperation = async (id) => ({
    operationId: id, kind: "launchTargetApp", targetId: "one",
    providerId: "provider", status: "succeeded", destructive: false,
  });
  assert.equal((await reopened.backend.launchApp("one", "com.example.native", true)).success, true);
  assert.equal(stops, 1);
  assert.equal(reopened.calls.filter(([name]) => name === "app-get").length, 1);
  assert.equal(reopened.calls.filter(([name]) => name === "app-launch").length, 1);
});

test("cold relaunch cannot borrow a later named revision after confirmed termination", async (t) => {
  const state = canonicalFixture({ app: true });
  t.after(() => state.backend.dispose());
  let stops = 0;
  state.client.terminateTargetApp = async () => {
    stops += 1;
    return { operationId: "app-terminate" };
  };
  state.client.waitForOperation = async (id) => ({
    operationId: id, kind: "terminateTargetApp", targetId: "one",
    providerId: "provider", status: "succeeded", destructive: false,
  });
  state.client.getTargetApp = async () => {
    await state.advanceSelection();
    return { appId: "opaque-app", packageId: "com.example.native", state: "stopped" };
  };
  await assert.rejects(state.backend.launchApp("one", "com.example.native", true),
    { code: "context_snapshot_superseded" });
  await state.store.set({ targetHostId: "host", targetId: "one", surfaceId: "surface/opaque" });
  await assert.rejects(state.backend.launchApp("one", "com.example.native", true),
    { code: "context_snapshot_superseded" });
  assert.equal(stops, 1);
  assert.equal(state.calls.filter(([name]) => name === "app-launch").length, 0);
});

test("cold relaunch recovery rejects another incarnation without replaying the original stop", async (t) => {
  const operationState = new Map();
  const connectionRef = {
    schema: "ailoha.target-host.connection/v1", serviceId: "fixture-service", pid: 12345,
    startedAt: "2026-10-09T23:00:00Z", processStartedAt: "2026-10-09T22:59:59Z",
  };
  let stops = 0;
  let reads = 0;
  let starts = 0;
  const client = {
    async terminateTargetApp() { stops += 1; return { operationId: "app-terminate" }; },
    async launchTargetApp() { starts += 1; return { operationId: "app-launch" }; },
    async waitForOperation(id) {
      return { operationId: id, kind: id === "app-terminate" ? "terminateTargetApp" : "launchTargetApp",
        targetId: "one", providerId: "provider", status: "succeeded", destructive: false };
    },
    async getTargetApp(_id, appId) {
      reads += 1;
      if (reads === 1) throw new AilohaProtocolError("transport_error");
      return { appId, packageId: "com.example.native", state: "stopped" };
    },
  };
  const initial = fixture({ app: true, operationState, connectionRef, client });
  t.after(() => initial.backend.dispose());
  await assert.rejects(initial.backend.launchApp("one", "com.example.native", true),
    { code: "transport_error" });
  const [progress] = [...operationState.values()].filter((value) => value.terminationSucceeded);
  assert.deepEqual(progress.connectionRef, connectionRef);
  assert.equal(Object.keys(progress).includes("connectionRef"), false);
  assert.equal(JSON.stringify(progress).includes("processStartedAt"), false);
  const replaced = fixture({
    app: true, operationState, connectionRef: { ...connectionRef, processStartedAt: "2026-10-09T22:59:58Z" }, client,
  });
  t.after(() => replaced.backend.dispose());
  await assert.rejects(replaced.backend.launchApp("one", "com.example.native", true),
    { code: "runtime_incarnation_changed" });
  assert.equal(reads, 1);
  assert.equal(stops, 1);
  assert.equal(starts, 0);
  const resumed = fixture({ app: true, operationState, connectionRef: { ...connectionRef }, client });
  t.after(() => resumed.backend.dispose());
  assert.equal((await resumed.backend.launchApp("one", "com.example.native", true)).success, true);
  assert.equal(reads, 2);
  assert.equal(stops, 1);
  assert.equal(starts, 1);
});

test("concurrent cold relaunch calls share the original stop and launch", async (t) => {
  const state = fixture({ app: true });
  t.after(() => state.backend.dispose());
  const stopEntered = deferred();
  const finishStop = deferred();
  state.client.terminateTargetApp = async () => {
    state.calls.push(["app-terminate"]);
    stopEntered.resolve();
    await finishStop.promise;
    return { operationId: "app-terminate" };
  };
  state.client.waitForOperation = async (id) => ({
    operationId: id, kind: id === "app-terminate" ? "terminateTargetApp" : "launchTargetApp",
    targetId: "one", providerId: "provider", status: "succeeded", destructive: false,
  });
  const first = state.backend.launchApp("one", "com.example.native", true);
  await stopEntered.promise;
  const second = state.backend.launchApp("one", "com.example.native", true);
  finishStop.resolve();
  assert.equal((await first).success, true);
  assert.equal((await second).success, true);
  assert.equal(state.calls.filter(([name]) => name === "app-terminate").length, 1);
  assert.equal(state.calls.filter(([name]) => name === "app-launch").length, 1);
});

test("app failures carry only captured ownership and operation receipt, not provider paths", async (t) => {
  const state = canonicalFixture({ app: true });
  t.after(() => state.backend.dispose());
  state.client.launchTargetApp = async () => ({ operationId: "app-secret-error" });
  state.client.waitForOperation = async () => {
    throw new AilohaProtocolError("operation_failed", {
      operationId: "app-secret-error",
      operation: {
        operationId: "app-secret-error", kind: "launchTargetApp", targetId: "one",
        providerId: "provider", status: "failed",
        result: { privatePath: "/private/native/path", credential: "sensitive" },
      },
    });
  };
  const response = await state.backend.request("/api/v1/devices/one/apps/launch", {
    method: "POST", body: JSON.stringify({ bundleId: "com.example.native" }),
  });
  assert.equal(response.status, 502);
  const error = await response.json();
  assert.equal(error.code, "operation_failed");
  assert.equal(error.operationId, "app-secret-error");
  assert.equal(error.operation.targetId, "one");
  assert.equal(error.operation.appId, "opaque-app");
  assert.equal(error.contextIdentity.scopeEpoch, "original-epoch");
  assert.equal(JSON.stringify(error).includes("/private/native/path"), false);
  assert.equal(JSON.stringify(error).includes("sensitive"), false);
});

test("completed native launch metadata is projected only when typed and reported", async (t) => {
  const reported = fixture({ app: true });
  t.after(() => reported.backend.dispose());
  reported.client.waitForOperation = async (id) => ({
    operationId: id, kind: "launchTargetApp", targetId: "one", providerId: "provider",
    status: "succeeded", destructive: false, result: { processId: 4321, detail: "com.example.native/.Main" },
  });
  assert.deepEqual(await reported.backend.launchApp("one", "com.example.native"), {
    schemaVersion: "1.0", success: true, deviceId: "one", bundleId: "com.example.native",
    operation: "launch", processId: 4321, detail: "com.example.native/.Main",
  });
  const malformed = fixture({ app: true });
  t.after(() => malformed.backend.dispose());
  let starts = 0;
  malformed.client.launchTargetApp = async () => {
    starts += 1;
    return { operationId: "app-launch" };
  };
  malformed.client.waitForOperation = async (id) => ({
    operationId: id, kind: "launchTargetApp", targetId: "one", providerId: "provider",
    status: "succeeded", destructive: false, result: { processId: "not-a-PID" },
  });
  await assert.rejects(malformed.backend.launchApp("one", "com.example.native"), { code: "invalid_response" });
  await assert.rejects(malformed.backend.launchApp("one", "com.example.native"), { code: "invalid_response" });
  assert.equal(starts, 1);
});

test("failed native inventory before submission retains captured target and sanitizes diagnostics", async (t) => {
  const state = canonicalFixture({ app: true });
  t.after(() => state.backend.dispose());
  state.client.listTargetApps = async () => { throw new Error("private host path /secret/device.apk"); };
  const response = await state.backend.request("/api/v1/devices/one/apps/launch", {
    method: "POST", body: JSON.stringify({ bundleId: "com.example.native" }),
  });
  assert.equal(response.status, 502);
  const error = await response.json();
  assert.equal(error.operation.targetId, "one");
  assert.equal(error.operation.targetHostId, "host");
  assert.equal(error.contextIdentity.scopeEpoch, "original-epoch");
  assert.equal(JSON.stringify(error).includes("/secret/"), false);
  assert.equal(state.calls.some(([name]) => name === "app-launch"), false);
});

test("install, destructive uninstall and Android app-op mutation remain explicitly gated", async (t) => {
  const state = fixture({ app: true });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.installApp("one", "/synthetic/fixture.apk"), { code: "capability_not_supported" });
  await assert.rejects(state.backend.uninstallApp("one", "com.example.native", false), { code: "confirmation_required" });
  await assert.rejects(state.backend.uninstallApp("one", "com.example.native", true), { code: "capability_not_supported" });
  await assert.rejects(state.backend.listAppOps("one", "com.example.native"), { code: "capability_not_supported" });
  assert.equal(state.calls.some(([name]) => name === "app-uninstall" || name === "app-op-list"), false);
  for (const target of state.targets.values()) target.nativeIdentity.platform = "android";
  await assert.rejects(state.backend.setAppOp("one", "com.example.native", "SYSTEM_ALERT_WINDOW"), { code: "capability_not_supported" });
  assert.deepEqual(await state.backend.listAppOps("one", "com.example.native"), {
    schemaVersion: "1.0", deviceId: "one", platform: "android", bundleId: "com.example.native", operations: [], total: 0,
  });
  assert.deepEqual(state.calls.filter(([name]) => name === "app-op-list").at(-1), ["app-op-list", "one", "opaque-app"]);
  state.client.listTargetAppOps = async () => [{ appOpId: "SYSTEM_ALERT_WINDOW", appId: "com.example.native", mode: "allow" }];
  await assert.rejects(state.backend.listAppOps("one", "com.example.native"), { code: "capability_not_supported" });
  state.client.listTargetAppOps = async () => [
    { appOpId: "SYSTEM_ALERT_WINDOW", appId: "opaque-app", mode: "ignored", uidScoped: true },
    { appOpId: "WRITE_SETTINGS", appId: "opaque-app", mode: "allow", uidScoped: false },
  ];
  assert.deepEqual(await state.backend.listAppOps("one", "com.example.native"), {
    schemaVersion: "1.0", deviceId: "one", platform: "android", bundleId: "com.example.native",
    operations: [
      { name: "SYSTEM_ALERT_WINDOW", mode: "ignore", uidScoped: true },
      { name: "WRITE_SETTINGS", mode: "allow", uidScoped: false },
    ], total: 2,
  });
  state.client.listTargetAppOps = async () => [
    { appOpId: "SYSTEM_ALERT_WINDOW", appId: "opaque-app", mode: "foreground", uidScoped: true },
  ];
  await assert.rejects(state.backend.listAppOps("one", "com.example.native"), { code: "capability_not_supported" });
});

async function stagedFixture(t, overrides = {}) {
  const { stagedApps: stagedOverrides, ...fixtureOverrides } = overrides;
  const directory = await mkdtemp(join(process.cwd(), ".mobile-stage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "local app.apk");
  await writeFile(sourcePath, "controlled fixture");
  const steps = [];
  const stagedApps = {
    async stage(invocation, path) {
      steps.push(["stage", path, invocation.executionContext?.revision]);
      return { artifactId: "private-artifact", proof: { packageName: "local app.apk", receiptHash: "private-hash" } };
    },
    async install(invocation) {
      steps.push(["install", invocation.executionContext?.revision]);
      return { operationId: "install-operation" };
    },
    async cleanup(invocation) {
      steps.push(["cleanup", invocation.executionContext?.revision]);
      return { operationId: "cleanup-operation" };
    },
    ...stagedOverrides,
  };
  const state = canonicalFixture({
    app: true, stagedApps, allowHostPackage: () => true,
    beginDestructiveApproval(action, invocation, { stagedArtifact: proof }) {
      assert.equal(action, "install");
      assert.equal(JSON.stringify(invocation).includes("connectionRef"), false);
      steps.push(["approval", action, proof.artifactId, invocation.executionContext.revision]);
      return {
        async run(work) { return work(); },
        requireCurrent() {},
        consume(owned, receipt) {
          assert.equal(owned, invocation);
          assert.equal(receipt, proof);
          steps.push(["consumed", proof.artifactId]);
        },
        dispose() {},
      };
    },
    ...fixtureOverrides,
  });
  state.client.waitForOperation = async (id) => {
    steps.push(["wait", id]);
    return { operationId: id, targetId: "one", providerId: "provider",
      kind: id === "install-operation" ? "installTargetApp" : "deleteArtifact",
      status: "succeeded", destructive: true };
  };
  t.after(() => state.backend.dispose());
  return { ...state, sourcePath, steps };
}

test("source-conditional install stages on host, waits for accepted install and owned deletion, never exposes path", async (t) => {
  const state = await stagedFixture(t);
  const result = await state.backend.installApp("one", state.sourcePath);
  assert.deepEqual(result, {
    schemaVersion: "1.0", success: true, deviceId: "one",
    bundleId: null, operation: "install", processId: null, detail: null,
  });
  assert.deepEqual(state.steps.map(([name]) => name),
    ["stage", "approval", "consumed", "install", "wait", "cleanup", "wait"]);
  assert.equal(JSON.stringify(result).includes(state.sourcePath), false);
});

test("a timed-out accepted staged install resumes only the original operation read", async (t) => {
  const state = await stagedFixture(t);
  let reads = 0;
  const wait = state.client.waitForOperation;
  state.client.waitForOperation = async (id) => {
    if (id === "install-operation" && reads++ === 0) throw new MobileAilohaError("operation_timeout", "Read timed out.", 504);
    return wait(id);
  };
  await assert.rejects(state.backend.installApp("one", state.sourcePath), { code: "operation_timeout" });
  await rm(state.sourcePath);
  await state.advanceSelection();
  state.client.getTargetCapabilities = async () => { throw new Error("A new capability read must not replace an accepted owner."); };
  assert.equal((await state.backend.installApp("one", state.sourcePath)).success, true);
  assert.deepEqual(state.steps.map(([name]) => name),
    ["stage", "approval", "consumed", "install", "wait", "cleanup", "wait"]);
});

test("view revision changed during staged upload blocks install but permits owned artifact cleanup", async (t) => {
  let state;
  state = await stagedFixture(t, { stagedApps: {
    async stage(invocation, path) {
      state.steps.push(["stage", path]);
      await state.advanceSelection();
      return { artifactId: "private-artifact", proof: { packageName: "local app.apk", receiptHash: "private-hash" } };
    },
  } });
  await assert.rejects(state.backend.installApp("one", state.sourcePath), { code: "context_snapshot_superseded" });
  assert.deepEqual(state.steps.map(([name]) => name), ["stage", "cleanup", "wait"]);
  await state.store.set({ targetHostId: "host", targetId: "one", surfaceId: "surface/opaque" });
  await assert.rejects(state.backend.installApp("one", state.sourcePath), { code: "context_snapshot_superseded" });
  assert.deepEqual(state.steps.map(([name]) => name), ["stage", "cleanup", "wait"]);
});

test("host-rejected staged install and denied approval never submit a second install", async (t) => {
  const rejected = await stagedFixture(t, { stagedApps: {
    async install() {
      rejected.steps.push(["install"]);
      throw new MobileAilohaError("install_rejected", "Host incarnation changed.", 409);
    },
  } });
  await assert.rejects(rejected.backend.installApp("one", rejected.sourcePath), { code: "install_rejected" });
  await assert.rejects(rejected.backend.installApp("one", rejected.sourcePath), { code: "install_rejected" });
  assert.deepEqual(rejected.steps.map(([name]) => name),
    ["stage", "approval", "consumed", "install", "cleanup", "wait"]);
  const denied = await stagedFixture(t, { beginDestructiveApproval() {
    return { async run() { throw new MobileAilohaError("consent_denied", "Approval declined.", 403); },
      requireCurrent() {}, consume() { throw Error("must not consume"); }, dispose() {} };
  } });
  await assert.rejects(denied.backend.installApp("one", denied.sourcePath), { code: "consent_denied" });
  assert.deepEqual(denied.steps.map(([name]) => name), ["stage", "cleanup", "wait"]);
  const booleanOnly = await stagedFixture(t, { beginDestructiveApproval() { return true; } });
  await assert.rejects(booleanOnly.backend.installApp("one", booleanOnly.sourcePath), { code: "capability_not_supported" });
  assert.deepEqual(booleanOnly.steps.map(([name]) => name), ["stage", "cleanup", "wait"]);
});

test("stage uncertainty and accepted install errors cannot replay on retry or replacement incarnation", async (t) => {
  const unknown = await stagedFixture(t, { stagedApps: {
    async stage() { unknown.steps.push(["stage"]); throw new Error("private package /hidden/app.apk"); },
  } });
  await assert.rejects(unknown.backend.installApp("one", unknown.sourcePath), { code: "ailoha_operation_failed" });
  await assert.rejects(unknown.backend.installApp("one", unknown.sourcePath), { code: "stage_outcome_uncertain" });
  assert.deepEqual(unknown.steps.map(([name]) => name), ["stage"]);

  const shared = new Map();
  const original = await stagedFixture(t, { operationState: shared });
  original.client.waitForOperation = async () => { throw new MobileAilohaError("operation_timeout", "Pending.", 504); };
  await assert.rejects(original.backend.installApp("one", original.sourcePath), { code: "operation_timeout" });
  const replacement = await stagedFixture(t, {
    operationState: shared,
    connectionRef: { ...original.backend.connectionRef, processStartedAt: "2026-10-10T00:01:00Z" },
  });
  await assert.rejects(replacement.backend.installApp("one", original.sourcePath), { code: "runtime_incarnation_changed" });
  assert.equal(replacement.steps.length, 0);
});

test("cleanup failure reports the secondary error without erasing the successful install receipt", async (t) => {
  const state = await stagedFixture(t, { stagedApps: {
    async cleanup() {
      state.steps.push(["cleanup"]);
      throw new MobileAilohaError("cleanup_rejected", "Owned deletion rejected.", 409);
    },
  } });
  const response = await state.backend.request("/api/v1/devices/one/apps/install", {
    method: "POST", body: JSON.stringify({ path: state.sourcePath }),
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.cleanupProblem.code, "cleanup_rejected");
  assert.equal(body.operationId, "install-operation");
  assert.equal(JSON.stringify(body).includes(state.sourcePath), false);
  assert.deepEqual(state.steps.map(([name]) => name),
    ["stage", "approval", "consumed", "install", "wait", "cleanup"]);
});

test("missing scoped consent, host topology or source capability cannot stage a package", async (t) => {
  for (const options of [
    { beginDestructiveApproval: undefined },
    { allowHostPackage: () => false },
    { client: { async getHostStatus() {
      return { hostId: "host", profile: "ailoha.target-host/v1", state: "ready", version: "test", capabilities: [] };
    } } },
  ]) {
    const state = await stagedFixture(t, options);
    await assert.rejects(state.backend.installApp("one", state.sourcePath), { code: "capability_not_supported" });
    assert.equal(state.steps.length, 0);
  }
});

function canonicalFixture(options = {}) {
  const scope = { sessionId: "unique-session", viewId: "unique-view" };
  const contextCalls = [];
  let canonical = {
    schema: "ailoha.execution-context/v1", version: 1,
    contextRef: "ctx-canonical-snapshot", scope, scopeEpoch: "original-epoch", revision: "1", state: "open",
    owner: { processId: 1234, processStartedAt: "2026-10-10T00:00:00Z" },
    selection: { targetHostId: "host", targetId: "one", surfaceId: "surface/opaque" },
    observed: null,
  };
  const store = createAilohaContextStore({
    scope, ownerProcessId: 1234, contextRef: canonical.contextRef, scopeEpoch: canonical.scopeEpoch,
    async runCli(args) {
      contextCalls.push(args);
      const requestIndex = args.indexOf("--request-json");
      const input = requestIndex < 0 ? null : JSON.parse(args[requestIndex + 1]);
      if (args[1] === "open") {
        assert.equal(canonical.state, "detached");
        assert.deepEqual(input.expected, { scopeEpoch: canonical.scopeEpoch, revision: canonical.revision });
        canonical = { ...canonical, state: "open", scopeEpoch: "reopened-epoch", revision: "0", selection: null };
      } else if (args[1] === "select") {
        assert.deepEqual(input.expected, { scopeEpoch: canonical.scopeEpoch, revision: canonical.revision });
        canonical = { ...canonical, revision: String(BigInt(canonical.revision) + 1n), selection: input.selection };
      }
      return JSON.stringify({ ok: true, context: canonical, error: null });
    },
  });
  return {
    ...fixture({ ...options, selectionStore: store }),
    store, contextCalls,
    async advanceSelection() {
      canonical = { ...canonical, revision: String(BigInt(canonical.revision) + 1n),
        selection: { targetHostId: "host", targetId: "two", surfaceId: "surface/opaque" } };
      return store.read();
    },
    async retireAuthority({ observe = true } = {}) {
      canonical = { ...canonical, state: "detached", revision: String(BigInt(canonical.revision) + 1n), selection: null };
      if (observe) return store.readSnapshot();
    },
    async reopenAuthority() {
      await store.binding();
      await store.set({ targetHostId: "host", targetId: "two", surfaceId: "surface/opaque" });
    },
  };
}

test("legacy remains the default and invalid opt-in never becomes a fallback", () => {
  assert.equal(mobileCanvasBackend(), "legacy");
  assert.equal(mobileCanvasBackend("legacy"), "legacy");
  assert.equal(mobileCanvasBackend("ailoha"), "ailoha");
  for (const value of ["", "Ailoha", "unknown"]) assert.throws(() => mobileCanvasBackend(value), /never falls back/);
});

test("trusted backend captures the original full lease evidence without serializing it", async (t) => {
  const state = fixture();
  t.after(() => state.backend.dispose());
  const captured = state.backend.connectionRef;
  assert.equal(Object.isFrozen(captured), true);
  state.owner.connectionRef.pid = 1;
  state.owner.hostId = "another-host";
  await state.backend.ready();
  const screenshot = await state.backend.screenshot("one");
  assert.equal(screenshot.invocation.connectionRef, captured);
  assert.equal(captured.pid, 12345);
  assert.equal(screenshot.invocation.targetHostId, "host");
  assert.equal(JSON.stringify(screenshot.invocation).includes("processStartedAt"), false);
  await state.backend.display("one");
  const input = await state.backend.input("tap", "one", { x: 10, y: 30 });
  const dispatched = state.calls.find(([kind]) => kind === "tap")[1];
  assert.equal(dispatched.connectionRef, captured);
  assert.equal(Object.hasOwn(input.context, "connectionRef"), false);
  assert.equal(Object.hasOwn((await state.backend.catalog()), "connectionRef"), false);
});

test("real compatibility action paths project inventory/selection/native identity and positive unsupported", async (t) => {
  const state = fixture();
  t.after(() => state.backend.dispose());
  const devices = await state.backend.invokeAction("list_devices");
  assert.equal(devices[0].id, "one");
  assert.equal(devices[0].udid, "real-native-one");
  assert.deepEqual(await state.backend.invokeAction("get_selected_device"), { hasSelection: false });
  await state.backend.invokeAction("select_device", { deviceId: "one" });
  assert.equal((await state.backend.invokeAction("get_selected_device")).device.id, "one");
  const catalog = await state.backend.catalog();
  assert.equal(catalog.catalogCompleteness, "inventory-only");
  assert.equal(catalog.devices[0].capabilities.recording, false);
  await assert.rejects(state.backend.invokeAction("start_recording", { deviceId: "one" }), { status: 501, code: "capability_not_supported" });
  const unsupported = await state.backend.request("/api/v1/devices/one/ui");
  assert.equal(unsupported.status, 501);
  assert.equal((await unsupported.json()).code, "capability_not_supported");
});

test("an open empty canonical view projects its verified binding without inferring a target", async (t) => {
  const state = fixture();
  t.after(() => state.backend.dispose());
  const binding = {
    contextRef: "ctx-returned-empty", scopeEpoch: "returned-empty-epoch", revision: "0", ownerProcessId: 1234,
  };
  Object.defineProperty(state.selectionStore, "contextProjection", { get: () => binding });
  const selected = await state.backend.invokeAction("get_selected_device");
  assert.deepEqual(selected, {
    hasSelection: false,
    scope: { sessionId: "unique-session", viewId: "unique-view" },
    contextBinding: binding,
  });
  assert.equal(Object.hasOwn(selected, "device"), false);
  assert.equal(state.calls.length, 0);
  binding.revision = "1";
  assert.equal(selected.contextBinding.revision, "0");
  await state.backend.select("one");
  const populated = await state.backend.getSelected();
  assert.equal(populated.contextBinding.revision, "1");
  assert.equal(populated.device.nativeId, "real-native-one");
});

test("selection reads that observe retirement cannot project an empty or populated binding", async (t) => {
  for (const selection of [null, { targetHostId: "host", targetId: "one" }]) {
    const state = fixture();
    t.after(() => state.backend.dispose());
    const reading = deferred();
    const result = deferred();
    Object.defineProperty(state.selectionStore, "contextProjection", {
      value: { contextRef: "ctx-old", scopeEpoch: "old-epoch", revision: "0", ownerProcessId: 1234 },
    });
    state.selectionStore.readSnapshot = async () => {
      reading.resolve();
      await result.promise;
      return publicSnapshot({
        selection, state: "open", contextProjection: state.selectionStore.contextProjection,
        identity: { scopeEpoch: "old-epoch", revision: "0" },
      });
    };
    const pending = state.backend.getSelected();
    const rejected = assert.rejects(pending, { code: "view_closed" });
    await reading.promise;
    state.retireContext();
    result.resolve();
    await rejected;
    assert.equal(state.calls.length, 0);
  }
});

test("retirement during selected target confirmation cannot return a stale usable binding", async (t) => {
  const state = fixture();
  t.after(() => state.backend.dispose());
  await state.backend.select("one");
  const reading = deferred();
  const result = deferred();
  const get = state.client.getTarget;
  state.client.getTarget = async (...args) => {
    reading.resolve();
    await result.promise;
    return get(...args);
  };
  const pending = state.backend.getSelected();
  const rejected = assert.rejects(pending, { code: "view_closed" });
  await reading.promise;
  state.retireContext();
  result.resolve();
  await rejected;
});

for (const action of ["lifecycle", "getSelected", "getDevice", "display", "input", "select", "inventory"]) {
  test(`canonical revision advance during ${action} rejects the old snapshot without relabeling or dispatch`, async (t) => {
    const state = canonicalFixture();
    t.after(() => state.backend.dispose());
    if (action === "input") await state.backend.display("one");
    const entered = deferred();
    const release = deferred();
    const get = action === "inventory" ? state.client.listTargets : state.client.getTarget;
    const method = action === "inventory" ? "listTargets" : "getTarget";
    state.client[method] = async (...args) => {
      entered.resolve();
      await release.promise;
      return get(...args);
    };
    const work = action === "lifecycle" ? state.backend.lifecycle("restart", "one")
      : action === "getSelected" ? state.backend.getSelected()
      : action === "getDevice" ? state.backend.getDevice("one")
      : action === "display" ? state.backend.display("one")
      : action === "select" ? state.backend.select("one")
      : action === "inventory" ? state.backend.listDevices()
      : state.backend.input("tap", "one", { x: 10, y: 30 });
    const rejected = assert.rejects(work, { code: "context_snapshot_superseded" });
    await entered.promise;
    assert.equal((await state.advanceSelection()).targetId, "two");
    assert.equal(state.store.contextProjection.revision, "2");
    release.resolve();
    await rejected;
    assert.equal(state.calls.some(([kind]) => ["reboot", "tap"].includes(kind)), false);
    assert.equal(state.contextCalls.some((args) => args[1] === "select"), false);
  });
}

test("direct target reads observe canonical retirement before any target host request", async (t) => {
  const state = canonicalFixture();
  t.after(() => state.backend.dispose());
  await state.store.binding({ allowCreate: false, allowReopen: false });
  await state.retireAuthority({ observe: false });
  assert.equal(state.store.state, "open");
  await assert.rejects(state.backend.getDevice("one"), { code: "view_closed" });
  assert.equal(state.calls.length, 0);
  assert.equal(state.contextCalls.some((args) => ["open", "select", "detach"].includes(args[1])), false);
});

test("direct reads retain explicit target semantics without changing the selected target", async (t) => {
  const state = canonicalFixture();
  t.after(() => state.backend.dispose());
  const device = await state.backend.getDevice("two");
  assert.equal(device.id, "two");
  assert.equal(device.nativeId, "real-native-two");
  assert.equal((await state.store.readSnapshot()).selection.targetId, "one");
  assert.equal(state.contextCalls.some((args) => args[1] === "select"), false);
});

for (const reopen of [false, true]) {
  test(`canonical ${reopen ? "epoch replacement" : "retirement"} during input cannot reuse the captured authority`, async (t) => {
    const state = canonicalFixture();
    t.after(() => state.backend.dispose());
    await state.backend.display("one");
    const entered = deferred();
    const release = deferred();
    const get = state.client.getTarget;
    state.client.getTarget = async (...args) => {
      entered.resolve();
      await release.promise;
      return get(...args);
    };
    const work = state.backend.input("tap", "one", { x: 10, y: 30 });
    const rejected = assert.rejects(work, { code: reopen ? "context_snapshot_superseded" : "view_closed" });
    await entered.promise;
    await state.retireAuthority();
    if (reopen) await state.reopenAuthority();
    release.resolve();
    await rejected;
    assert.equal(state.calls.some(([kind]) => kind === "tap"), false);
  });
}

for (const reopen of [false, true]) {
  test(`accepted lifecycle retains original canonical revision and epoch across ${reopen ? "authority reopen" : "a newer read"}`, async (t) => {
    const completion = deferred();
    const entered = deferred();
    const state = canonicalFixture({ wait: completion });
    t.after(() => state.backend.dispose());
    const wait = state.client.waitForOperation;
    state.client.waitForOperation = async (...args) => {
      entered.resolve();
      return wait(...args);
    };
    const work = state.backend.lifecycle("restart", "one");
    await entered.promise;
    assert.deepEqual(state.calls.filter(([kind]) => kind === "reboot"), [["reboot", "one"]]);
    if (reopen) {
      await state.retireAuthority();
      await state.reopenAuthority();
    } else await state.advanceSelection();
    completion.resolve();
    const result = await work;
    assert.equal(result.invocation.targetId, "one");
    assert.equal(result.invocation.executionContext.revision, "1");
    assert.equal(result.invocation.executionContext.scopeEpoch, "original-epoch");
    assert.equal(result.invocation.executionContext.contextRef, "ctx-canonical-snapshot");
    assert.equal((await state.backend.getSelected()).device.id, "two");
    assert.equal(state.calls.filter(([kind]) => kind === "reboot").length, 1);
  });
}

test("display observations keep the original canonical identity instead of borrowing a later read", async (t) => {
  const state = canonicalFixture();
  t.after(() => state.backend.dispose());
  await state.backend.display("one");
  await state.advanceSelection();
  await assert.rejects(state.backend.input("tap", "one", { x: 10, y: 30 }), { code: "stale_selection" });
  assert.equal(state.calls.some(([kind]) => kind === "tap"), false);
});

test("lifecycle awaits authoritative completion and selection cannot retarget accepted work", async (t) => {
  const wait = deferred();
  const state = fixture({ wait });
  t.after(() => state.backend.dispose());
  await state.backend.select("one");
  const stopping = state.backend.lifecycle("shutdown", "one");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.calls.filter(([kind]) => kind === "stop"), [["stop", "one"]]);
  await state.backend.select("two");
  wait.resolve();
  const stopped = await stopping;
  assert.equal(stopped.id, "one");
  assert.equal(stopped.state, "shutdown");
  assert.equal(stopped.invocation.targetId, "one");
  assert.equal((await state.backend.getSelected()).device.id, "two");
});

test("missing real scoped destructive consent is unsupported even when confirm is true", async (t) => {
  const state = fixture();
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.lifecycle("erase", "one", { confirm: true }), { status: 501 });
  for (const input of [{}, { confirm: false }, Object.create({ confirm: true }), { get confirm() { return true; } }]) {
    await assert.rejects(state.backend.lifecycle("delete", "one", input), { code: "confirmation_required" });
  }
  assert.equal(state.calls.length, 0);
});

test("real consent is captured to the original target and is separate from the literal gate", async (t) => {
  const consent = deferred();
  let captured;
  const state = fixture({ confirmDestructive: (context) => { captured = context; return consent.promise; } });
  t.after(() => state.backend.dispose());
  await state.backend.select("one");
  const resetting = state.backend.lifecycle("erase", "one", { confirm: true });
  await new Promise((resolve) => setImmediate(resolve));
  await state.backend.select("two");
  assert.equal(captured.invocation.targetId, "one");
  consent.resolve(false);
  await assert.rejects(resetting, { code: "consent_denied" });
  assert.equal(state.calls.some(([kind]) => kind === "reset"), false);
});

test("geometry-observed input uses logical bounds and rejects later revisions before dispatch", async (t) => {
  const state = fixture();
  t.after(() => state.backend.dispose());
  await state.backend.select("one");
  await assert.rejects(state.backend.input("tap", "one", { x: 0, y: 30 }), { code: "stale_geometry" });
  const display = await state.backend.display("one");
  await state.backend.input("tap", "one", { x: 0, y: 30, duration: 0.6 });
  const tap = state.calls.find(([kind]) => kind === "tap");
  assert.equal(tap[1].geometry.geometryRevision, display.geometryRevision);
  assert.equal(tap[1].scope.viewId, "unique-view");
  assert.equal(tap[2].duration, 0.6);
  state.geometryChanged();
  await assert.rejects(state.backend.input("tap", "one", { x: 0, y: 30 }), { code: "stale_geometry" });
  assert.equal(state.calls.filter(([kind]) => kind === "tap").length, 1);
});

test("owned video closes its socket, deletes captured session, then releases without stopping a host/device", async () => {
  const state = fixture();
  await state.backend.select("one");
  const video = await state.backend.openVideo("one", () => {}, () => {});
  assert.deepEqual(Object.keys(video.context).sort(), ["ownerId", "videoSessionId"]);
  assert.equal(state.cleanups.size, 1);
  await state.backend.dispose();
  const order = state.calls.map(([kind]) => kind);
  assert.ok(order.indexOf("video-close") < order.indexOf("video-delete"));
  assert.ok(order.indexOf("video-delete") < order.indexOf("release-end"));
  assert.equal(order.includes("stop"), false);
  assert.equal(order.includes("delete"), false);
});

test("known canonical replacement during accepted video creation cleans the original snapshot resource", async (t) => {
  const createWait = deferred();
  const state = canonicalFixture({ createWait });
  t.after(() => state.backend.dispose());
  const opening = state.backend.openVideo("one", () => {}, () => {});
  const rejected = assert.rejects(opening, { code: "context_snapshot_superseded" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.calls.filter(([kind]) => kind === "video-create"), [["video-create", "one"]]);
  await state.advanceSelection();
  createWait.resolve();
  await rejected;
  assert.equal(state.calls.some(([kind]) => kind === "video-attach"), false);
  assert.deepEqual(state.calls.filter(([kind]) => kind === "video-delete"), [["video-delete", "one"]]);
});

test("live video allows same-binding reads and retires callbacks without relabeling owned cleanup", async (t) => {
  const state = canonicalFixture();
  t.after(() => state.backend.dispose());
  const delivered = [];
  const errors = [];
  let callbacks;
  let cleanupInvocation;
  const attach = state.media.attachVideo;
  state.media.attachVideo = async (invocation, descriptor, captured) => {
    callbacks = captured;
    return attach(invocation, descriptor, captured);
  };
  const remove = state.media.deleteVideo;
  state.media.deleteVideo = async (invocation, descriptor) => {
    cleanupInvocation = invocation;
    return remove(invocation, descriptor);
  };
  const video = await state.backend.openVideo("one", (value) => delivered.push(value), (error) => errors.push(error));
  callbacks.onMessage("original");
  await state.store.readSnapshot();
  callbacks.onMessage("same-binding");
  await state.advanceSelection();
  callbacks.onMessage("retired");
  callbacks.onError(new Error("retired protected channel"));
  await video.close();
  assert.deepEqual(delivered, ["original", "same-binding"]);
  assert.deepEqual(errors, []);
  assert.equal(cleanupInvocation.targetId, "one");
  assert.equal(cleanupInvocation.executionContext.revision, "1");
  assert.equal(cleanupInvocation.executionContext.scopeEpoch, "original-epoch");
  assert.equal(state.calls.filter(([kind]) => kind === "video-create").length, 1);
  assert.equal(state.calls.filter(([kind]) => kind === "video-delete").length, 1);
});

test("selection/close while creation is pending cannot attach the old video to a new view", async (t) => {
  const createWait = deferred();
  const state = fixture({ createWait });
  t.after(() => state.backend.dispose());
  await state.backend.select("one");
  const opening = state.backend.openVideo("one", () => {}, () => {});
  const rejected = assert.rejects(opening, { code: "video_owner_retired" });
  await new Promise((resolve) => setImmediate(resolve));
  const selecting = state.backend.select("two");
  await new Promise((resolve) => setImmediate(resolve));
  createWait.resolve();
  await rejected;
  await selecting;
  assert.equal(state.calls.some(([kind]) => kind === "video-attach"), false);
  assert.deepEqual(state.calls.filter(([kind]) => kind === "video-delete"), [["video-delete", "one"]]);
});

test("send/close false are real failures, never successful retirement or release", async () => {
  const state = fixture({ sendResult: false, closeResult: false });
  await state.backend.select("one");
  const video = await state.backend.openVideo("one", () => {}, () => {});
  await assert.rejects(video.send("hello"), { code: "video_send_failed" });
  await assert.rejects(state.backend.dispose(), { code: "video_cleanup_failed" });
  assert.equal(state.calls.some(([kind]) => kind === "release-end"), false);
  assert.equal(state.cleanups.size, 1);
});

test("lost create result remains explicit and cannot trigger a second create or legacy retry", async (t) => {
  const state = fixture({ media: { async createVideo() { state.calls.push(["video-create"]); throw new Error("private transport error"); } } });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.openVideo("one", () => {}, () => {}));
  await assert.rejects(state.backend.openVideo("one", () => {}, () => {}), { code: "video_create_uncertain" });
  assert.equal(state.calls.filter(([kind]) => kind === "video-create").length, 1);
  const response = await state.backend.request("/api/v1/devices/one/input/rotate", { method: "POST" });
  assert.equal(response.status, 501);
});

test("unknown SDK failures are explicitly reported without serializing private diagnostic data", async (t) => {
  const state = fixture({ client: { async listTargets() { throw new Error("Bearer private-secret http://private-origin"); } } });
  t.after(() => state.backend.dispose());
  const response = await state.backend.request("/api/v1/devices");
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes("private"), false);
});

test("named contexts from another host fail rather than selecting a same-named target", async (t) => {
  const state = fixture();
  t.after(() => state.backend.dispose());
  state.selectHost("other-host");
  await assert.rejects(state.backend.getSelected(), { code: "host_selection_mismatch" });
});

test("release failure then retry polls the original accepted video cleanup with exactly one DELETE", async () => {
  let deletes = 0;
  let polls = 0;
  const operation = {
    operationId: "captured/video-stop", kind: "stopLiveVideoSession", targetId: "one",
    status: "succeeded", destructive: false, createdAt: "2026-10-09T23:00:00Z", startedAt: "2026-10-09T23:00:01Z",
  };
  const media = createAilohaMediaAdapter({
    transport: {
      async response() {
        deletes += 1;
        const error = new Error("synthetic truncated accepted DELETE");
        error.name = "TargetHostTransportError";
        error.response = { status: 202, location: `/api/v1/operations/${encodeURIComponent(operation.operationId)}` };
        throw error;
      },
    },
    client: {
      async waitForOperation(id) {
        assert.equal(id, operation.operationId);
        if (++polls === 1) throw new Error("synthetic temporary GET failure");
        return operation;
      },
    },
  });
  const state = fixture({ media: {
    async createVideo() {
      return {
        videoSessionId: "video", targetId: "one", surfaceId: "surface/opaque",
        resourcePath: "/api/v1/targets/one/surfaces/surface%2Fopaque/video/sessions/video",
      };
    },
    deleteVideo: media.deleteVideo,
  } });
  await state.backend.select("one");
  await state.backend.openVideo("one", () => {}, () => {});
  await assert.rejects(state.backend.dispose(), { code: "video_cleanup_failed" });
  assert.equal(state.cleanups.size, 1);
  assert.equal(state.calls.some(([name]) => name === "release-end"), false);
  await state.backend.dispose();
  assert.equal(deletes, 1);
  assert.equal(polls, 2);
  assert.equal(state.cleanups.size, 0);
  assert.equal(state.calls.filter(([name]) => name === "video-close").length, 1);
  assert.equal(state.calls.some(([name]) => ["start", "stop", "delete", "reset"].includes(name)), false);
});

test("provider diagnostics distinguish control connection from unavailable/degraded native tooling", async (t) => {
  const state = fixture();
  t.after(() => state.backend.dispose());
  state.providers.push({
    providerId: "unavailable-provider", name: "Missing platform tooling", version: "1", state: "unavailable",
    description: "Synthetic Xcode/Android SDK dependency is unavailable.", capabilities: [],
  });

  const mixed = await state.backend.catalog();
  assert.equal(mixed.providers.length, 2);
  assert.equal(mixed.devices[0].isAvailable, true);
  const unavailable = mixed.diagnostics.find((diagnostic) => diagnostic.providerId === "unavailable-provider");
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.checks[0].message, state.providers[1].description);
  assert.deepEqual(unavailable.checks[0].actions, []);
  assert.equal(mixed.diagnostics.at(-1).ready, false);
  state.providers[0].state = "degraded";
  assert.equal((await state.backend.catalog()).devices[0].isAvailable, true);
  state.providers[0].state = "unavailable";
  state.targets.clear();
  const none = await state.backend.catalog();
  assert.equal(none.devices.length, 0);
  assert.equal(none.diagnostics.every((diagnostic) => diagnostic.available === false && diagnostic.ready === false), true);
  assert.equal(none.catalogCompleteness, "inventory-only");
});

test("external named-authority retirement blocks new host operations instead of reusing explicit target IDs", async (t) => {
  const state = fixture();
  t.after(() => state.backend.dispose());
  await state.backend.select("one");
  await state.backend.display("one");
  state.retireContext();
  const before = state.calls.length;
  await assert.rejects(state.backend.lifecycle("boot", "one"), { code: "view_closed" });
  await assert.rejects(state.backend.input("tap", "one", { x: 1, y: 30 }), { code: "view_closed" });
  await assert.rejects(state.backend.listDevices(), { code: "view_closed" });
  await assert.rejects(state.backend.openVideo("one", () => {}, () => {}), { code: "view_closed" });
  assert.equal(state.calls.length, before);
});

test("lost202 lifecycle acceptance polls the retained operation without submitting another mutation", async (t) => {
  let submissions = 0;
  const state = fixture({ client: {
    async startTarget() {
      submissions += 1;
      throw new AilohaProtocolError("transport_error", { status: 202, operationId: "start-one" });
    },
  } });
  t.after(() => state.backend.dispose());
  const result = await state.backend.lifecycle("boot", "one");
  assert.equal(result.id, "one");
  assert.equal(submissions, 1);
  assert.equal(state.calls.some(([name, id]) => name === "wait" && id === "start-one"), true);
});

test("timed-out lifecycle wait and view reopening recover the captured receipt with exactly one POST", async (t) => {
  const operationState = new Map();
  let submissions = 0;
  let waits = 0;
  const client = {
    async startTarget() { submissions += 1; return { operationId: "captured-start" }; },
    async waitForOperation() {
      if (++waits === 1) throw new AilohaProtocolError("timeout", { operationId: "captured-start" });
      return {
        operationId: "captured-start", kind: "startTarget", targetId: "one", providerId: "provider",
        status: "succeeded", destructive: false, createdAt: "2026-10-09T23:00:00Z",
      };
    },
  };
  const first = fixture({ operationState, client });
  await assert.rejects(first.backend.lifecycle("boot", "one"), { code: "timeout" });
  await first.backend.dispose();
  const second = fixture({ operationState, client });
  t.after(() => second.backend.dispose());
  const result = await second.backend.lifecycle("boot", "one");
  assert.equal(result.invocation.scope.viewId, "unique-view");
  assert.equal(submissions, 1);
  assert.equal(waits, 2);
  assert.equal(operationState.size, 0);
});

for (const changed of [
  { serviceId: "replacement-service" },
  { pid: 12346 },
  { startedAt: "2026-10-09T23:00:01Z" },
  { processStartedAt: "2026-10-09T23:00:00Z" },
]) {
  test(`a changed ${Object.keys(changed)[0]} cannot resume or replay another incarnation's lifecycle receipt`, async (t) => {
    const operationState = new Map();
    const first = fixture({ operationState, client: {
      async waitForOperation(id) { throw new AilohaProtocolError("timeout", { operationId: id }); },
    } });
    await assert.rejects(first.backend.lifecycle("restart", "one"), { code: "timeout" });
    const receipt = [...operationState.values()][0];
    assert.equal(receipt.invocation.connectionRef, first.backend.connectionRef);
    await first.backend.dispose();
    const second = fixture({
      operationState, connectionRef: { ...first.backend.connectionRef, ...changed },
    });
    t.after(() => second.backend.dispose());
    await assert.rejects(second.backend.lifecycle("restart", "one"), { code: "runtime_incarnation_changed" });
    assert.equal(second.calls.length, 0);
    assert.equal([...operationState.values()][0], receipt);
    assert.equal(first.calls.filter(([kind]) => kind === "reboot").length, 1);
    await second.backend.lifecycle("shutdown", "two");
    assert.equal(second.calls.filter(([kind]) => kind === "stop").length, 1);
    assert.equal([...operationState.values()][0], receipt);
  });
}

test("completed lifecycle confirmation cannot use a replacement incarnation with the same host ID", async (t) => {
  const operationState = new Map();
  let completed = false;
  const first = fixture({ operationState });
  const wait = first.client.waitForOperation;
  first.client.waitForOperation = async (...args) => { completed = true; return wait(...args); };
  const get = first.client.getTarget;
  first.client.getTarget = async (...args) => {
    if (completed) throw new AilohaProtocolError("timeout");
    return get(...args);
  };
  await assert.rejects(first.backend.lifecycle("restart", "one"), { code: "timeout" });
  const receipt = [...operationState.values()][0];
  assert.equal(receipt.completed.status, "succeeded");
  await first.backend.dispose();
  const second = fixture({ operationState, connectionRef: {
    ...first.backend.connectionRef, processStartedAt: "2026-10-09T23:00:00Z",
  } });
  t.after(() => second.backend.dispose());
  await assert.rejects(second.backend.lifecycle("restart", "one"), { code: "runtime_incarnation_changed" });
  assert.equal(second.calls.length, 0);
  assert.equal([...operationState.values()][0], receipt);
});

test("accepted work and video cleanup stay on the original captured transport and incarnation", async (t) => {
  const operationState = new Map();
  const wait = deferred();
  const first = fixture({ operationState, wait });
  t.after(() => first.backend.dispose());
  const lifecycle = first.backend.lifecycle("restart", "one");
  await new Promise((resolve) => setImmediate(resolve));
  const receipt = [...operationState.values()][0];
  const original = first.backend.connectionRef;
  first.owner.connectionRef = { ...original, pid: 12346 };
  const second = fixture({ operationState, connectionRef: first.owner.connectionRef });
  t.after(() => second.backend.dispose());
  await assert.rejects(second.backend.lifecycle("restart", "one"), { code: "runtime_incarnation_changed" });
  assert.equal(second.calls.length, 0);
  wait.resolve();
  assert.equal((await lifecycle).invocation.targetId, "one");
  assert.equal(receipt.invocation.connectionRef, original);
  let cleanupInvocation;
  first.media.deleteVideo = async (invocation) => { cleanupInvocation = invocation; };
  const video = await first.backend.openVideo("one", () => {}, () => {});
  await video.close();
  assert.equal(cleanupInvocation.connectionRef, original);
  assert.equal(first.backend.connectionRef, original);
});

test("unknown video creation is not replayed after a changed incarnation", async (t) => {
  const videoState = {};
  const first = fixture({ videoState, media: {
    async createVideo() { throw new Error("synthetic unknown acceptance"); },
  } });
  t.after(() => first.backend.dispose());
  await assert.rejects(first.backend.openVideo("one", () => {}, () => {}));
  assert.equal(videoState.invocation.connectionRef, first.backend.connectionRef);
  const second = fixture({ videoState, connectionRef: {
    ...first.backend.connectionRef, pid: 12346,
  } });
  t.after(() => second.backend.dispose());
  await assert.rejects(second.backend.openVideo("one", () => {}, () => {}), { code: "runtime_incarnation_changed" });
  assert.equal(second.calls.length, 0);
});

test("unknown lifecycle outcomes cannot be replayed and mismatched completion never retargets", async (t) => {
  let submissions = 0;
  const unknown = fixture({ client: {
    async startTarget() { submissions += 1; throw new AilohaProtocolError("transport_error"); },
  } });
  t.after(() => unknown.backend.dispose());
  await assert.rejects(unknown.backend.lifecycle("boot", "one"), { code: "transport_error" });
  await assert.rejects(unknown.backend.lifecycle("boot", "one"), { code: "lifecycle_outcome_uncertain" });
  assert.equal(submissions, 1);

  const mismatch = fixture({ client: {
    async waitForOperation() { return { kind: "startTarget", status: "succeeded", targetId: "two" }; },
  } });
  t.after(() => mismatch.backend.dispose());
  await assert.rejects(mismatch.backend.lifecycle("boot", "one"), { code: "operation_owner_mismatch" });
});

test("succeeded reboot receipt survives target-read failure and selection/reopen without another POST", async (t) => {
  const operationState = new Map();
  let posts = 0;
  let polls = 0;
  let completed = false;
  let rejectRead = true;
  const first = fixture({ operationState });
  const getTarget = first.client.getTarget;
  first.client.rebootTarget = async (id) => { posts += 1; return { operationId: `reboot-${id}` }; };
  first.client.waitForOperation = async (id) => {
    polls += 1;
    completed = true;
    return {
      operationId: id, kind: "rebootTarget", targetId: "one", providerId: "provider",
      status: "succeeded", destructive: false, createdAt: "2026-10-09T23:00:00Z",
    };
  };
  first.client.getTarget = async (id, options) => {
    if (completed && id === "one" && rejectRead) {
      rejectRead = false;
      throw new AilohaProtocolError("timeout");
    }
    return getTarget(id, options);
  };
  await first.backend.select("one");
  await assert.rejects(first.backend.lifecycle("restart", "one"), { code: "timeout" });
  await first.backend.select("two");
  await first.backend.dispose();
  const second = fixture({ operationState, client: {
    async rebootTarget() { posts += 1; return { operationId: "do-not-submit" }; },
    async waitForOperation() { polls += 1; throw new Error("Completed receipt should only re-read target output."); },
  } });
  t.after(() => second.backend.dispose());
  await second.backend.select("two");
  const result = await second.backend.lifecycle("restart", "one");
  assert.equal(result.id, "one");
  assert.equal(result.invocation.targetId, "one");
  assert.equal((await second.backend.getSelected()).device.id, "two");
  assert.equal(posts, 1);
  assert.equal(polls, 1);
  assert.equal(operationState.size, 0);
});

test("succeeded lifecycle receipt survives a state mismatch while unrelated explicit action remains usable", async (t) => {
  const state = fixture();
  t.after(() => state.backend.dispose());
  const reboot = state.client.rebootTarget;
  let reboots = 0;
  state.client.rebootTarget = async (id, options) => { reboots += 1; return reboot(id, options); };
  const wait = state.client.waitForOperation;
  state.client.waitForOperation = async (id, options) => {
    const result = await wait(id, options);
    if (id === "reboot-one") state.targets.get("one").status = "starting";
    return result;
  };
  await assert.rejects(state.backend.lifecycle("restart", "one"), { code: "operation_state_mismatch" });
  await state.backend.lifecycle("shutdown", "two");
  state.targets.get("one").status = "running";
  const result = await state.backend.lifecycle("restart", "one");
  assert.equal(result.id, "one");
  assert.equal(reboots, 1);
  assert.equal(state.calls.filter(([name, id]) => name === "wait" && id === "reboot-one").length, 1);
});

test("receipt admission remains exactly64 after concurrent asynchronous destructive approvals", async (t) => {
  const approval = deferred();
  const operationState = new Map();
  let approvals = 0;
  const state = fixture({
    operationState,
    async confirmDestructive() { approvals += 1; await approval.promise; return true; },
    client: {
      async waitForOperation(id) { throw new AilohaProtocolError("timeout", { operationId: id }); },
    },
  });
  t.after(() => state.backend.dispose());
  for (let index = 0; index < 65; index += 1) {
    const id = `target-${index}`;
    state.targets.set(id, { ...structuredClone(state.targets.get("one")), targetId: id });
  }
  const work = Array.from({ length: 65 }, (_, index) =>
    state.backend.lifecycle("erase", `target-${index}`, { confirm: true }));
  const results = Promise.allSettled(work);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(approvals, 65);
  assert.equal(operationState.size, 0);
  approval.resolve();
  const completed = await results;
  assert.equal(completed.filter((result) => result.status === "rejected" && result.reason.code === "operation_receipt_limit").length, 1);
  assert.equal(completed.filter((result) => result.status === "rejected" && result.reason.code === "timeout").length, 64);
  assert.equal(operationState.size, 64);
  assert.equal(state.calls.filter(([name]) => name === "reset").length, 64);
  const before = state.calls.filter(([name]) => name === "reset").length;
  await assert.rejects(state.backend.lifecycle("erase", "target-0", { confirm: true }), { code: "timeout" });
  assert.equal(state.calls.filter(([name]) => name === "reset").length, before);
});

test("an old delayed output cannot evict a newly submitted same-key lifecycle receipt", async (t) => {
  const delayedRead = deferred();
  const readStarted = deferred();
  const secondReceiptWait = deferred();
  const operationState = new Map();
  let posts = 0;
  let oldFinalReads = 0;
  let returnedWaits = 0;
  const state = fixture({ operationState });
  t.after(() => state.backend.dispose());
  state.client.rebootTarget = async () => ({ operationId: `reboot-${++posts}` });
  state.client.waitForOperation = async (operationId) => {
    if (operationId === "reboot-2") await secondReceiptWait.promise;
    if (operationId === "reboot-1") returnedWaits += 1;
    return {
      operationId, kind: "rebootTarget", targetId: "one", providerId: "provider",
      status: "succeeded", destructive: false, createdAt: "2026-10-09T23:00:00Z",
    };
  };
  const get = state.client.getTarget;
  state.client.getTarget = async (id, options) => {
    if (returnedWaits > 0 && posts === 1 && ++oldFinalReads === 2) {
      readStarted.resolve();
      await delayedRead.promise;
    }
    return get(id, options);
  };
  const oldA = state.backend.lifecycle("restart", "one");
  const oldB = state.backend.lifecycle("restart", "one");
  await readStarted.promise;
  await oldA;
  assert.equal(operationState.size, 0);
  const newA = state.backend.lifecycle("restart", "one");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts, 2);
  delayedRead.resolve();
  await oldB;
  assert.equal(operationState.size, 1);
  const newB = state.backend.lifecycle("restart", "one");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts, 2);
  secondReceiptWait.resolve();
  await Promise.all([newA, newB]);
  assert.equal(operationState.size, 0);
});

test("an old terminal failure cannot remove a new same-key pending lifecycle receipt", async (t) => {
  const oldFailure = deferred();
  const newCompletion = deferred();
  const operationState = new Map();
  let posts = 0;
  let oldPolls = 0;
  const state = fixture({ operationState });
  t.after(() => state.backend.dispose());
  state.client.rebootTarget = async () => ({ operationId: `reboot-${++posts}` });
  state.client.waitForOperation = async (operationId) => {
    if (operationId === "reboot-1" && ++oldPolls === 2) {
      await oldFailure.promise;
      throw new AilohaProtocolError("operation_failed", {
        operationId, operation: { operationId, status: "failed" },
      });
    }
    if (operationId === "reboot-2") await newCompletion.promise;
    return {
      operationId, kind: "rebootTarget", targetId: "one", providerId: "provider",
      status: "succeeded", destructive: false, createdAt: "2026-10-09T23:00:00Z",
    };
  };
  const oldA = state.backend.lifecycle("restart", "one");
  const oldB = state.backend.lifecycle("restart", "one");
  const oldRejected = assert.rejects(oldB, { code: "operation_failed" });
  await oldA;
  const newA = state.backend.lifecycle("restart", "one");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts, 2);
  oldFailure.resolve();
  await oldRejected;
  assert.equal(operationState.size, 1);
  const newB = state.backend.lifecycle("restart", "one");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts, 2);
  newCompletion.resolve();
  await Promise.all([newA, newB]);
});
