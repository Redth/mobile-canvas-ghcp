import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { productModule } from "../ailoha-test-module.mjs";
import { ownedTestDirectory } from "./fixtures/owned-test-directory.mjs";
const { AilohaMobileBackend } = await import(productModule("lib/ailoha/mobile-backend.mjs"));
const { mobileCanvasBackend } = await import(productModule("lib/backend.mjs"));
const { createAilohaMediaAdapter } = await import(productModule("lib/ailoha/media-adapter.mjs"));
const { createAilohaDeviceFeatures } = await import(productModule("lib/ailoha/device-features.mjs"));
const { createAilohaRevealAdapter } = await import(productModule("lib/ailoha/reveal-adapter.mjs"));
const { createAilohaSystemUiAdapter } = await import(productModule("lib/ailoha/system-ui-adapter.mjs"));
const { AilohaProtocolError } = await import(productModule("lib/ailoha/errors.mjs"));
const { publicSnapshot, MobileAilohaError } = await import(productModule("lib/ailoha/mobile-projection.mjs"));
const { createAilohaContextStore } = await import(productModule("lib/ailoha/context-adapter.mjs"));
const { createAilohaMcpDispatcher } = await import(productModule("lib/ailoha/mcp-host.mjs"));
const { ARTIFACT_FEATURE_GATES } = await import(productModule("lib/ailoha/artifact-features.mjs"));
const { createVerifiedAilohaCli } = await import(productModule("lib/ailoha/runtime-sdk.mjs"));

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
    geometryRevision: revision, capabilities: options.systemUi
      ? [{ id: "surface.ui", version: 1, features: ["getSystemUiSnapshot", "querySystemUi", "tapSystemUiMatch"] }]
      : [],
  });
  const targets = new Map(["one", "two"].map((id) => [id, {
    targetId: id, providerId: "provider", targetTypeId: "type", status: "running", surfaces: [surface()],
    nativeIdentity: { platform: "ios", nativeId: `real-native-${id}`, isVirtual: true },
  }]));
  const featureCapabilities = options.featureCapabilities ?? [];
  const systemUiCapabilities = options.systemUi
    ? [{ id: "surface.ui", version: 1, features: ["getSystemUiSnapshot", "querySystemUi", "tapSystemUiMatch"] }] : [];
  const providers = [{ providerId: "provider", name: "Provider", version: "1", state: "ready",
    capabilities: [...featureCapabilities, ...systemUiCapabilities] }];
  const capabilities = [{ id: "target.lifecycle", version: 1, features: [
    "startTarget", "stopTarget", "rebootTarget", "resetTarget", "deleteTarget",
    ...(options.reveal ? ["revealTarget"] : []),
  ] }, ...featureCapabilities, ...systemUiCapabilities];
  if (options.app) {
    capabilities.push({ id: "target.apps", version: 1,
      features: ["listTargetApps", "launchTargetApp", "terminateTargetApp",
        "uninstallTargetApp", "installStagedTargetApp",
        ...(options.fencedCapabilities ? ["captureFencedTargetAppAction", "uninstallFencedTargetApp"] : [])] });
    capabilities.push({ id: "target.app-ops", version: 1,
      features: ["listTargetAppOps", "updateTargetAppOp",
        ...(options.fencedCapabilities ? ["updateFencedTargetAppOp"] : [])] });
    providers[0].capabilities.push(...capabilities.slice(-2));
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
    async listTargetAppReferences(id, query) {
      return this.listTargetApps(id, { ...query, includeSystem: true });
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
    client, media, owner, selectionStore, features: options.features, featureState: options.featureState,
    reveal: options.reveal, revealState: options.revealState,
    systemUi: options.systemUi, systemUiState: options.systemUiState,
    controls: options.controls,
    confirmDestructive: options.confirmDestructive,
    stagedApps: options.stagedApps,
    fencedApps: options.fencedApps,
    allowHostPackage: options.allowHostPackage,
    saveScreenshot: options.saveScreenshot,
    operationState: options.operationState,
    videoState: options.videoState,
    artifactState: options.artifactState,
    runCli: options.runCli,
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

test("ordinary app mutations or fenced feature claims without a trusted CLI never advertise destructive parity", async (t) => {
  for (const options of [
    { app: true, fencedApps: {} },
    { app: true, fencedCapabilities: true, confirmDestructive: async () => true },
    { app: true, fencedCapabilities: true, fencedApps: {}, confirmDestructive: async () => true },
  ]) {
    const state = fixture(options);
    t.after(() => state.backend.dispose());
    for (const target of state.targets.values()) target.nativeIdentity.platform = "android";
    const device = await state.backend.getDevice("one");
    assert.equal(device.capabilities.appUninstall, false);
    assert.equal(device.capabilities.appOpSet, false);
    await assert.rejects(state.backend.uninstallApp("one", "com.example.native", true),
      { code: "capability_not_supported" });
    await assert.rejects(state.backend.setAppOp("one", "com.example.native", "SYSTEM_ALERT_WINDOW"),
      { code: "capability_not_supported" });
    assert.equal(state.calls.some(([name]) => ["app-uninstall", "app-op-set"].includes(name)), false);
  }
});

function fencedFixture(t, { answer = async () => true, capture, submit, readback, wait, operationState } = {}) {
  const events = [];
  const fencedApps = {
    async capture(invocation, request) {
      events.push(["capture", invocation, request]);
      return capture?.(invocation, request) ?? {
        appId: request.appId, packageId: request.packageId,
        ...(request.operation ? {
          operation: request.operation, currentMode: "default",
          requestedMode: request.mode, uidScoped: false,
        } : {}),
        receipt: { schema: "synthetic-fenced-action/v1", token: "captured-native-installation" },
      };
    },
    async uninstall(invocation, receipt, options) {
      events.push(["uninstall", invocation, receipt, options]);
      return submit?.(invocation, receipt, options) ?? { operationId: "fenced-uninstall" };
    },
    async setAppOp(invocation, receipt, options) {
      events.push(["set-app-op", invocation, receipt, options]);
      return submit?.(invocation, receipt, options) ?? { operationId: "fenced-app-op" };
    },
    readback(operation, proof) {
      return readback?.(operation, proof) ?? {
        appId: proof.appId, appOpId: proof.operation, mode: proof.requestedMode, uidScoped: false,
      };
    },
  };
  const state = canonicalFixture({
    app: true, fencedCapabilities: true, fencedApps, operationState,
    confirmDestructive: async (request) => {
      events.push(["prompt", request]);
      return answer(request);
    },
    client: {
      async waitForOperation(operationId) {
        events.push(["wait", operationId]);
        if (wait) return wait(operationId);
        return {
          operationId, kind: operationId === "fenced-uninstall" ? "uninstallFencedTargetApp" : "updateFencedTargetAppOp",
          targetId: "one", providerId: "provider", status: "succeeded",
          destructive: operationId === "fenced-uninstall",
          createdAt: "2026-10-09T23:00:00Z", completedAt: "2026-10-09T23:00:02Z",
        };
      },
    },
  });
  t.after(() => state.backend.dispose());
  return { ...state, events };
}

async function waitForFencedEvent(events, kind) {
  for (let attempt = 0; attempt < 100 && !events.some(([event]) => event === kind); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(events.some(([event]) => event === kind), true, `Expected captured ${kind} event.`);
}

test("parent: cancelling an accepted app-action waiter cannot poison its live peer", async (t) => {
  const entered = deferred();
  const finished = deferred();
  const caller = new AbortController();
  const state = fencedFixture(t);
  state.client.waitForOperation = async (operationId, options = {}) => {
    state.events.push(["wait", operationId]);
    entered.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new AilohaProtocolError("cancelled", { operationId }));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      finished.promise.then(() => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve({
          operationId, kind: "uninstallFencedTargetApp", targetId: "one",
          providerId: "provider", status: "succeeded", destructive: true,
          createdAt: "2026-10-09T23:00:00Z", completedAt: "2026-10-09T23:00:02Z",
        });
      });
    });
  };
  const cancelled = state.backend.uninstallApp("one", "com.example.native", true, { signal: caller.signal });
  const cancelledResult = assert.rejects(cancelled, { code: "cancelled" });
  await entered.promise;
  const peer = state.backend.uninstallApp("one", "com.example.native", true);
  const peerResult = peer.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  caller.abort();
  finished.resolve();
  await cancelledResult;
  const result = await peerResult;
  assert.equal(result.ok, true, "The live peer must not inherit another caller's cancellation.");
  assert.equal(result.value.success, true);
  assert.equal(state.events.filter(([event]) => event === "uninstall").length, 1);
  assert.equal(state.events.filter(([event]) => event === "prompt").length, 1);
});

test("accepted app-op confirmation stays receipt-owned when its first caller cancels", async (t) => {
  const entered = deferred();
  const finished = deferred();
  const caller = new AbortController();
  const state = fencedFixture(t);
  state.targets.get("one").nativeIdentity.platform = "android";
  state.client.waitForOperation = async (operationId, options = {}) => {
    state.events.push(["wait", operationId]);
    entered.resolve();
    await finished.promise;
    assert.notEqual(options.signal, caller.signal);
    assert.equal(options.signal?.aborted, false);
    return {
      operationId, kind: "updateFencedTargetAppOp", targetId: "one",
      providerId: "provider", status: "succeeded", destructive: false,
      createdAt: "2026-10-09T23:00:00Z", completedAt: "2026-10-09T23:00:02Z",
    };
  };
  const input = ["one", "com.example.native", "camera", "allow"];
  const cancelled = state.backend.setAppOp(...input, { signal: caller.signal });
  const cancelledResult = assert.rejects(cancelled, { code: "cancelled" });
  await entered.promise;
  const peer = state.backend.setAppOp(...input);
  caller.abort();
  await cancelledResult;
  finished.resolve();
  assert.deepEqual(await peer, {
    schemaVersion: "1.0", success: true, deviceId: "one",
    bundleId: "com.example.native", operation: "CAMERA", mode: "allow",
  });
  assert.equal(state.events.filter(([event]) => event === "set-app-op").length, 1);
  assert.equal(state.events.filter(([event]) => event === "prompt").length, 1);
  assert.deepEqual(state.events.filter(([event]) => event === "wait").length, 1);
});

test("parent: accepted feature cancellation stays local and cannot return late success", async (t) => {
  const entered = deferred();
  const finished = deferred();
  const caller = new AbortController();
  const state = featureFixture();
  t.after(() => state.backend.dispose());
  state.client.waitForOperation = async (operationId) => {
    entered.resolve();
    await finished.promise;
    return {
      operationId, kind: "simulateTargetSms", targetId: "one", providerId: "provider",
      status: "succeeded", destructive: false,
      createdAt: "2026-10-09T23:00:00Z", completedAt: "2026-10-09T23:00:02Z",
    };
  };
  const input = { from: "+123", body: "original message" };
  const cancelled = state.backend.deviceFeature("sms_send", "one", input, { signal: caller.signal });
  const cancelledResult = assert.rejects(cancelled, { code: "cancelled" });
  await entered.promise;
  const peer = state.backend.deviceFeature("sms_send", "one", input);
  caller.abort();
  finished.resolve();
  await cancelledResult;
  assert.equal((await peer).success, true);
  assert.equal(state.wire.filter((request) => request.method === "POST").length, 1);
});

test("parent: a sole cancelled app caller retains the original completed receipt for later retry", async (t) => {
  const entered = deferred();
  const finished = deferred();
  const operationState = new Map();
  const caller = new AbortController();
  const state = fencedFixture(t, {
    operationState,
    async wait(operationId) {
      entered.resolve();
      await finished.promise;
      return {
        operationId, kind: "uninstallFencedTargetApp", targetId: "one", providerId: "provider",
        status: "succeeded", destructive: true,
        createdAt: "2026-10-09T23:00:00Z", completedAt: "2026-10-09T23:00:02Z",
      };
    },
  });
  const cancelled = state.backend.uninstallApp("one", "com.example.native", true, { signal: caller.signal });
  const cancelledResult = assert.rejects(cancelled, { code: "cancelled" });
  await entered.promise;
  const progress = [...operationState.values()].find((value) => value.confirming);
  assert.ok(progress);
  const ownerCompletion = progress.confirming;
  caller.abort();
  await cancelledResult;
  finished.resolve();
  await ownerCompletion;

  const result = await state.backend.uninstallApp("one", "com.example.native", true);

  assert.equal(result.success, true);
  for (const event of ["capture", "prompt", "uninstall"]) {
    assert.equal(state.events.filter(([kind]) => kind === event).length, 1);
  }
});

test("parent: a sole cancelled feature caller retains the original completion without another POST", async (t) => {
  const entered = deferred();
  const finished = deferred();
  const featureState = new Map();
  const caller = new AbortController();
  const state = featureFixture({ featureState });
  t.after(() => state.backend.dispose());
  state.client.waitForOperation = async (operationId) => {
    entered.resolve();
    await finished.promise;
    return {
      operationId, kind: "simulateTargetSms", targetId: "one", providerId: "provider",
      status: "succeeded", destructive: false,
      createdAt: "2026-10-09T23:00:00Z", completedAt: "2026-10-09T23:00:02Z",
    };
  };
  const input = { from: "+123", body: "original message" };
  const cancelled = state.backend.deviceFeature("sms_send", "one", input, { signal: caller.signal });
  const cancelledResult = assert.rejects(cancelled, { code: "cancelled" });
  await entered.promise;
  const receipt = [...featureState.values()][0];
  assert.ok(receipt.confirming);
  const ownerCompletion = receipt.confirming;
  caller.abort();
  await cancelledResult;
  finished.resolve();
  await ownerCompletion;

  const result = await state.backend.deviceFeature("sms_send", "one", input);

  assert.equal(result.success, true);
  assert.equal(state.wire.filter((request) => request.method === "POST").length, 1);
});

test("acknowledged app and feature successes permit a new explicit same-key action", async (t) => {
  const app = fencedFixture(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await app.backend.uninstallApp("one", "com.example.native", true)).success, true);
  }
  assert.equal(app.events.filter(([event]) => event === "capture").length, 2);
  assert.equal(app.events.filter(([event]) => event === "prompt").length, 2);
  assert.equal(app.events.filter(([event]) => event === "uninstall").length, 2);

  const feature = featureFixture();
  t.after(() => feature.backend.dispose());
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await feature.backend.deviceFeature("sms_send", "one", { from: "+123", body: "hello" })).success, true);
  }
  assert.equal(feature.wire.filter((request) => request.method === "POST").length, 2);
});

test("fenced uninstall captures a private native receipt before the genuine prompt and never uses ordinary DELETE", async (t) => {
  const decision = deferred();
  const state = fencedFixture(t, { answer: () => decision.promise });
  const work = state.backend.uninstallApp("one", "com.example.native", true);
  await waitForFencedEvent(state.events, "prompt");
  const prompt = state.events.find(([event]) => event === "prompt")[1];
  assert.equal(state.events[0][0], "capture");
  assert.match(prompt.message, /Native package: com\.example\.native/);
  assert.equal(prompt.appAction.receipt.token, "captured-native-installation");
  assert.equal(JSON.stringify(prompt).includes("captured-native-installation"), false);
  assert.equal(state.events.some(([event]) => event === "uninstall"), false);
  decision.resolve(true);
  assert.deepEqual(await work, {
    schemaVersion: "1.0", success: true, deviceId: "one", bundleId: "com.example.native",
    operation: "uninstall", processId: null, detail: null,
  });
  assert.equal(state.events.filter(([event]) => event === "uninstall").length, 1);
  assert.equal(state.calls.some(([event]) => event === "app-uninstall"), false);
});

test("fenced Android setter returns the effective legacy ignore mode only after complete native readback", async (t) => {
  const state = fencedFixture(t);
  for (const target of state.targets.values()) target.nativeIdentity.platform = "android";
  assert.deepEqual(await state.backend.setAppOp("one", "com.example.native", "system_alert_window", "ignore"), {
    schemaVersion: "1.0", success: true, deviceId: "one", bundleId: "com.example.native",
    operation: "SYSTEM_ALERT_WINDOW", mode: "ignore",
  });
  const capture = state.events.find(([event]) => event === "capture")[2];
  assert.equal(capture.mode, "ignored");
  assert.equal(state.events.filter(([event]) => event === "set-app-op").length, 1);
});

test("accepted fenced app-op recovers after view retirement without recapture", async (t) => {
  let waits = 0;
  const state = fencedFixture(t, {
    wait(operationId) {
      waits += 1;
      if (waits === 1) throw new AilohaProtocolError("transport_error", { operationId });
      return {
        operationId, kind: "updateFencedTargetAppOp", targetId: "one", providerId: "provider",
        status: "succeeded", destructive: false,
        createdAt: "2026-10-09T23:00:00Z", completedAt: "2026-10-09T23:00:02Z",
      };
    },
  });
  state.targets.get("one").nativeIdentity.platform = "android";
  await assert.rejects(state.backend.setAppOp("one", "com.example.native", "camera", "allow"),
    { code: "transport_error" });
  await state.retireAuthority({ observe: false });
  const reads = state.calls.length;
  const resumed = await state.backend.setAppOp("one", "com.example.native", "camera", "allow");
  assert.equal(resumed.success, true);
  assert.equal(waits, 2);
  assert.equal(state.calls.length, reads);
  assert.equal(state.events.filter(([event]) => event === "capture").length, 1);
  assert.equal(state.events.filter(([event]) => event === "prompt").length, 1);
  assert.equal(state.events.filter(([event]) => event === "set-app-op").length, 1);
});

test("native accepted mismatch stays typed until explicit same-key GET recovery", async (t) => {
  const operationId = "café";
  const state = fencedFixture(t, {
    submit() {
      const error = new MobileAilohaError("app_action_accepted_mismatch",
        "The accepted action did not match its captured attempt.", 409);
      error.operationId = operationId;
      throw error;
    },
    wait(id) {
      return {
        operationId: id, kind: "updateFencedTargetAppOp", targetId: "one", providerId: "provider",
        status: "succeeded", destructive: false,
        createdAt: "2026-10-09T23:00:00Z", completedAt: "2026-10-09T23:00:02Z",
      };
    },
  });
  state.targets.get("one").nativeIdentity.platform = "android";
  await assert.rejects(state.backend.setAppOp("one", "com.example.native", "camera", "allow"), (error) => {
    assert.equal(error.code, "app_action_accepted_mismatch");
    assert.equal(error.operationId, operationId);
    return true;
  });
  assert.equal(state.events.some(([event]) => event === "wait"), false);
  await state.retireAuthority({ observe: false });
  const reads = state.calls.length;
  const result = await state.backend.setAppOp("one", "com.example.native", "camera", "allow");
  assert.equal(result.success, true);
  assert.equal(state.calls.length, reads);
  assert.deepEqual(state.events.filter(([event]) => event === "wait").map(([, id]) => id), [operationId]);
  for (const event of ["capture", "prompt", "set-app-op"]) {
    assert.equal(state.events.filter(([kind]) => kind === event).length, 1);
  }
});

test("accepted mismatch with a foreign terminal target retains the ID without success or replay", async (t) => {
  const operationId = "a".repeat(700);
  const state = fencedFixture(t, {
    submit() {
      const error = new MobileAilohaError("app_action_accepted_mismatch",
        "The accepted action did not match its captured attempt.", 409);
      error.operationId = operationId;
      throw error;
    },
    wait(id) {
      return {
        operationId: id, kind: "uninstallFencedTargetApp", targetId: "foreign-target",
        providerId: "provider", status: "succeeded", destructive: true,
        createdAt: "2026-10-09T23:00:00Z", completedAt: "2026-10-09T23:00:02Z",
      };
    },
  });
  await assert.rejects(state.backend.uninstallApp("one", "com.example.native", true),
    { code: "app_action_accepted_mismatch", operationId });
  await assert.rejects(state.backend.uninstallApp("one", "com.example.native", true),
    { code: "operation_owner_mismatch", operationId });
  assert.equal(state.events.filter(([event]) => event === "uninstall").length, 1);
  assert.equal(state.events.filter(([event]) => event === "prompt").length, 1);
});

test("a setter cannot report success from a destructively marked terminal operation", async (t) => {
  const state = fencedFixture(t, {
    wait(operationId) {
      return {
        operationId, kind: "updateFencedTargetAppOp", targetId: "one", providerId: "provider",
        status: "succeeded", destructive: true,
        createdAt: "2026-10-09T23:00:00Z", completedAt: "2026-10-09T23:00:02Z",
      };
    },
  });
  state.targets.get("one").nativeIdentity.platform = "android";
  await assert.rejects(state.backend.setAppOp("one", "com.example.native", "camera", "allow"),
    { code: "operation_owner_mismatch" });
  await assert.rejects(state.backend.setAppOp("one", "com.example.native", "camera", "allow"),
    { code: "operation_owner_mismatch" });
  assert.equal(state.events.filter(([event]) => event === "set-app-op").length, 1);
  assert.equal(state.events.filter(([event]) => event === "prompt").length, 1);
});

test("fenced app-op mutation names UID effects and requires authoritative matching effective readback", async (t) => {
  const state = fencedFixture(t, {
    capture: (_invocation, request) => ({
      appId: request.appId, packageId: request.packageId, operation: request.operation,
      currentMode: "deny", requestedMode: request.mode, uidScoped: true,
      receipt: { schema: "synthetic-fenced-action/v1", token: "captured-uid-state" },
    }),
    readback: (_completed, proof) => ({
      appId: proof.appId, appOpId: proof.operation, mode: "deny", uidScoped: true,
    }),
  });
  for (const target of state.targets.values()) target.nativeIdentity.platform = "android";
  await assert.rejects(state.backend.setAppOp("one", "com.example.native", "system_alert_window", "allow"),
    { code: "app_action_readback_mismatch" });
  const prompt = state.events.find(([event]) => event === "prompt")[1];
  assert.match(prompt.message, /SYSTEM_ALERT_WINDOW/);
  assert.match(prompt.message, /deny \(whole UID scope\)/);
  assert.match(prompt.message, /Requested package mode: allow/);
  assert.equal(state.events.filter(([event]) => event === "set-app-op").length, 1);
  assert.equal(state.calls.some(([event]) => event === "app-uninstall"), false);
});

test("fenced denial, definitive rejection and uncertain delivery never turn into implicit approval or replay", async (t) => {
  const denied = fencedFixture(t, { answer: () => false });
  await assert.rejects(denied.backend.uninstallApp("one", "com.example.native", true), { code: "consent_denied" });
  assert.equal(denied.events.some(([event]) => event === "uninstall"), false);

  let rejection = 403;
  const state = fencedFixture(t, {
    submit: () => { throw new AilohaProtocolError("http_error", { status: rejection }); },
  });

  test("native typed app rejection evicts only its receipt while delivery unknown retains it", async (t) => {
    let code = "app_action_rejected";
    const state = fencedFixture(t, {
      submit: () => { throw new MobileAilohaError(code, "Sanitized native action outcome.", code === "app_action_rejected" ? 409 : 502); },
    });
    await assert.rejects(state.backend.uninstallApp("one", "com.example.native", true),
      { code: "app_action_rejected" });
    code = "app_action_delivery_unknown";
    await assert.rejects(state.backend.uninstallApp("one", "com.example.native", true),
      { code: "app_action_delivery_unknown" });
    await assert.rejects(state.backend.uninstallApp("one", "com.example.native", true),
      { code: "app_action_outcome_uncertain" });
    assert.equal(state.events.filter(([event]) => event === "uninstall").length, 2);
    assert.equal(state.events.filter(([event]) => event === "prompt").length, 2);
  });
  await assert.rejects(state.backend.uninstallApp("one", "com.example.native", true), { code: "http_error" });
  rejection = 408;
  await assert.rejects(state.backend.uninstallApp("one", "com.example.native", true), { code: "http_error" });
  await assert.rejects(state.backend.uninstallApp("one", "com.example.native", true), {
    code: "app_action_outcome_uncertain",
  });
  assert.equal(state.events.filter(([event]) => event === "uninstall").length, 2);
  assert.equal(state.events.filter(([event]) => event === "prompt").length, 2);
});

test("caller cancellation retires an app approval without dispatch and cannot be revived by a late answer", async (t) => {
  const decision = deferred();
  const state = fencedFixture(t, { answer: () => decision.promise });
  const caller = new AbortController();
  const work = state.backend.uninstallApp("one", "com.example.native", true, { signal: caller.signal });
  const rejection = assert.rejects(work, { code: "consent_cancelled" });
  await waitForFencedEvent(state.events, "prompt");
  caller.abort();
  await rejection;
  decision.resolve(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.events.some(([event]) => event === "uninstall"), false);
});

for (const interruption of ["expiry", "caller abort"]) {
  test(`queued fenced app revalidation ${interruption} performs zero native submissions`, async (t) => {
    let clock = 0;
    if (interruption === "expiry") t.mock.method(performance, "now", () => clock);
    const answer = deferred();
    const state = fencedFixture(t, { answer: () => answer.promise });
    const caller = new AbortController();
    const work = state.backend.uninstallApp("one", "com.example.native", true, { signal: caller.signal });
    const rejection = assert.rejects(work, {
      code: interruption === "expiry" ? "consent_timeout" : "consent_cancelled",
    });
    await waitForFencedEvent(state.events, "prompt");
    const queued = deferred();
    const release = deferred();
    state.client.getTarget = async () => {
      queued.resolve();
      await release.promise;
      return state.targets.get("one");
    };
    answer.resolve(true);
    await queued.promise;
    if (interruption === "expiry") clock = 60_001;
    else caller.abort();
    release.resolve();
    await rejection;
    assert.equal(state.events.some(([event]) => event === "uninstall"), false);
  });
}

test("a late accepted fenced operation retains its original ID for GET-only recovery after approval expiry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const delivery = deferred();
  const state = fencedFixture(t, { submit: () => delivery.promise });
  const work = state.backend.uninstallApp("one", "com.example.native", true);
  const rejection = assert.rejects(work, { code: "submission_outcome_unknown" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.events.filter(([event]) => event === "uninstall").length, 1);
  t.mock.timers.tick(60_000);
  await rejection;
  delivery.resolve({ operationId: "fenced-uninstall" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await state.backend.uninstallApp("one", "com.example.native", true)).success, true);
  assert.equal(state.events.filter(([event]) => event === "uninstall").length, 1);
  assert.deepEqual(state.events.filter(([event]) => event === "wait"), [["wait", "fenced-uninstall"]]);
});

async function stagedFixture(t, overrides = {}) {
  const { stagedApps: stagedOverrides, beginDestructiveApproval, ...fixtureOverrides } = overrides;
  const directory = await ownedTestDirectory(t, "mobile-stage-");
  const sourcePath = join(directory, "local app.apk");
  await writeFile(sourcePath, "controlled fixture");
  const steps = [];
  let stageSignal;
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const stagedApps = {
    async stage(invocation, path, options) {
      assert.equal(options.timeoutMs, 11 * 60_000);
      assert.ok(options.signal instanceof AbortSignal);
      stageSignal = options.signal;
      steps.push(["stage", path, invocation.executionContext?.revision]);
      const receipt = "a".repeat(64);
      return {
        artifactId: "private-artifact", sourcePath: path, receipt, size: 18, sha256: "b".repeat(64),
        proof: {
          targetHostId: invocation.targetHostId, targetId: invocation.targetId,
          providerId: invocation.providerId, nativeTargetId: invocation.nativeIdentity.nativeId,
          nativeTargetPlatform: invocation.nativeIdentity.platform,
          contextRef: invocation.executionContext.contextRef, scopeEpoch: invocation.executionContext.scopeEpoch,
          revision: invocation.executionContext.revision, hostInstanceId: "staged-host-incarnation",
          ownerProcessId: invocation.contextOwner.processId,
          ownerStartedAt: invocation.contextOwner.processStartedAt,
          sourcePathHash: hash(path), packageName: "local app.apk", receiptHash: hash(receipt),
        },
      };
    },
    async install(invocation, staged, options) {
      assert.ok(options.signal instanceof AbortSignal);
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 30_000);
      steps.push(["install", invocation.executionContext?.revision]);
      return { operationId: "install-operation" };
    },
    async cleanup(invocation, staged, options) {
      assert.ok(options.signal instanceof AbortSignal);
      if (stageSignal?.aborted) assert.equal(options.signal.aborted, false);
      assert.equal(options.timeoutMs, 30_000);
      steps.push(["cleanup", invocation.executionContext?.revision]);
      return { operationId: "cleanup-operation" };
    },
    ...stagedOverrides,
  };
  const state = canonicalFixture({
    app: true, stagedApps, allowHostPackage: () => true,
    confirmDestructive(request) {
      assert.equal(request.action, "install");
      assert.equal(JSON.stringify(request.invocation).includes("connectionRef"), false);
      steps.push(["approval", request.action, request.stagedArtifact.artifactId,
        request.invocation.executionContext.revision]);
      return true;
    },
    ...fixtureOverrides,
  });
  if (beginDestructiveApproval) state.backend.beginDestructiveApproval = beginDestructiveApproval;
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
    ["stage", "approval", "install", "wait", "cleanup", "wait"]);
  assert.equal(JSON.stringify(result).includes(state.sourcePath), false);
});

test("install cannot submit while a genuine scoped approval decision is pending or rejected", async (t) => {
  const requested = deferred();
  const decision = deferred();
  let state;
  state = await stagedFixture(t, { confirmDestructive(request) {
    assert.equal(request.action, "install");
    assert.equal(request.stagedArtifact.artifactId, "private-artifact");
    state.steps.push(["approval"]);
    requested.resolve();
    return decision.promise;
  } });
  const pending = state.backend.installApp("one", state.sourcePath);
  await requested.promise;
  assert.deepEqual(state.steps.map(([name]) => name), ["stage", "approval"]);
  decision.resolve(true);
  assert.equal((await pending).success, true);
  assert.deepEqual(state.steps.map(([name]) => name),
    ["stage", "approval", "install", "wait", "cleanup", "wait"]);

  const denied = await stagedFixture(t, { confirmDestructive: async () => false });
  await assert.rejects(denied.backend.installApp("one", denied.sourcePath), { code: "consent_denied" });
  assert.deepEqual(denied.steps.map(([name]) => name), ["stage", "cleanup", "wait"]);
});

for (const cancellation of ["caller", "owner", "deadline"]) {
  test(`staged install ${cancellation} cancellation while genuine approval is pending cleans only its original artifact`, async (t) => {
    const waiting = deferred();
    const decision = deferred();
    const caller = new AbortController();
    const state = await stagedFixture(t, { confirmDestructive(request) {
      assert.equal(request.action, "install");
      waiting.resolve();
      return decision.promise;
    } });
    const originalTimer = globalThis.setTimeout;
    let expire;
    if (cancellation === "deadline") {
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay === 60_000) expire = () => callback(...args);
        return originalTimer(callback, delay, ...args);
      };
    }
    try {
      const work = state.backend.invokeAction("install_app", { deviceId: "one", path: state.sourcePath },
        { signal: caller.signal });
      const rejected = assert.rejects(work, {
        code: cancellation === "deadline" ? "consent_timeout" : "consent_cancelled",
      });
      await waiting.promise;
      assert.deepEqual(state.steps.map(([name]) => name), ["stage"]);
      if (cancellation === "caller") caller.abort();
      else if (cancellation === "owner") state.backend.cancelPendingApprovals();
      else expire();
      decision.resolve(true);
      await rejected;
      assert.deepEqual(state.steps.map(([name]) => name), ["stage", "cleanup", "wait"]);
    } finally {
      globalThis.setTimeout = originalTimer;
    }
  });
}

test("canvas API forwards its original request abort through staged install without cancelling owned cleanup", async (t) => {
  const waiting = deferred();
  const decision = deferred();
  const caller = new AbortController();
  const state = await stagedFixture(t, { confirmDestructive() {
    waiting.resolve();
    return decision.promise;
  } });
  const request = state.backend.request("/api/v1/devices/one/apps/install", {
    method: "POST", body: JSON.stringify({ path: state.sourcePath }), signal: caller.signal,
  });
  await waiting.promise;
  caller.abort();
  decision.resolve(true);
  const response = await request;
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "consent_cancelled");
  assert.equal(JSON.stringify(body).includes(state.sourcePath), false);
  assert.deepEqual(state.steps.map(([name]) => name), ["stage", "cleanup", "wait"]);
});

test("cancelled original install authority during verified CLI acquisition cannot start a native child", async (t) => {
  const entered = deferred();
  const release = deferred();
  const caller = new AbortController();
  const pin = { version: "synthetic-only", sourceSha: "a".repeat(40) };
  const directory = await ownedTestDirectory(t, "mobile-native-");
  const marker = join(directory, "native-post");
  let launches = 0;
  const runCli = createVerifiedAilohaCli({ pin, sdk: {
    async getVerifiedCliLaunch() {
      launches += 1;
      entered.resolve();
      await release.promise;
      return { ...pin, file: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'POST')`] };
    },
  } });
  const state = await stagedFixture(t, { stagedApps: {
    async install(invocation, staged, options) {
      state.steps.push(["install-start"]);
      await runCli(["target", "app", "install-staged", "--json"], options);
      return { operationId: "must-not-submit" };
    },
  } });
  const work = state.backend.invokeAction("install_app", { deviceId: "one", path: state.sourcePath },
    { signal: caller.signal });
  const rejected = assert.rejects(work, (error) => {
    assert.equal(error.code, "consent_cancelled");
    return true;
  });
  await entered.promise;
  caller.abort();
  release.resolve();
  await rejected;
  assert.equal(launches, 1);
  await assert.rejects(access(marker), { code: "ENOENT" });
  assert.deepEqual(state.steps.map(([name]) => name),
    ["stage", "approval", "install-start"]);
  assert.equal(state.calls.some(([name]) => name === "app-install"), false);
  await assert.rejects(state.backend.installApp("one", state.sourcePath), {
    code: "app_install_outcome_uncertain",
  });
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
    ["stage", "approval", "install", "wait", "cleanup", "wait"]);
});

test("accepted HTTP 202 staged install resumes GET on the original operation without another prompt or POST", async (t) => {
  let state;
  state = await stagedFixture(t, { stagedApps: {
    async install() {
      state.steps.push(["install"]);
      throw new AilohaProtocolError("transport_error", { status: 202, operationId: "install-operation" });
    },
  } });
  let reads = 0;
  const wait = state.client.waitForOperation;
  state.client.waitForOperation = async (id) => {
    if (id === "install-operation" && reads++ === 0) {
      state.steps.push(["wait", id]);
      throw new MobileAilohaError("operation_timeout", "The accepted operation is still running.", 504);
    }
    return wait(id);
  };
  await assert.rejects(state.backend.installApp("one", state.sourcePath), { code: "operation_timeout" });
  await rm(state.sourcePath);
  await state.advanceSelection();
  assert.equal((await state.backend.installApp("one", state.sourcePath)).success, true);
  assert.equal(reads, 2);
  assert.deepEqual(state.steps.map(([name]) => name),
    ["stage", "approval", "install", "wait", "wait", "cleanup", "wait"]);
});

for (const [code, status] of [["http_error", 408], ["http_error", 499], ["client_disposed", undefined]]) {
  test(`uncertain staged install ${code}/${status ?? "no-status"} retains the original receipt and cannot POST again`, async (t) => {
    let state;
    const operationState = new Map();
    state = await stagedFixture(t, { operationState, stagedApps: {
      async install() {
        state.steps.push(["install"]);
        throw new AilohaProtocolError(code, { status });
      },
    } });
    await assert.rejects(state.backend.installApp("one", state.sourcePath), { code });
    const [progress] = operationState.values();
    assert.equal(progress.invocation.contextOwner.processStartedAt, "2026-10-10T00:00:00Z");
    await assert.rejects(state.backend.installApp("one", state.sourcePath), { code: "app_install_outcome_uncertain" });
    assert.equal(operationState.get(JSON.stringify(["host", "one", "staged-install", state.sourcePath])), progress);
    assert.deepEqual(state.steps.map(([name]) => name), ["stage", "approval", "install"]);
  });
}

test("approval expiry after an accepted install keeps the original operation ID for GET-only recovery", async (t) => {
  let state;
  state = await stagedFixture(t, {
    beginDestructiveApproval(action, invocation, { stagedArtifact }) {
      state.steps.push(["approval"]);
      return {
        approved: Promise.resolve(), signal: new AbortController().signal,
        remainingTimeoutMs(ceiling) { return ceiling; },
        async run(work) {
          await work();
          throw new MobileAilohaError("consent_expired", "Original approval deadline elapsed.", 409);
        },
        requireCurrent() {},
        consume(owned, staged) {
          assert.equal(owned, invocation);
          assert.equal(staged, stagedArtifact);
          state.steps.push(["consumed"]);
        },
        dispose() {},
      };
    },
  });
  await assert.rejects(state.backend.installApp("one", state.sourcePath), (error) => {
    assert.equal(error.code, "consent_expired");
    assert.equal(error.operationId, "install-operation");
    return true;
  });
  assert.deepEqual(state.steps.map(([name]) => name), ["stage", "approval", "consumed", "install"]);
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
    ["stage", "approval", "install", "cleanup", "wait"]);
  const denied = await stagedFixture(t, { confirmDestructive: async () => false });
  await assert.rejects(denied.backend.installApp("one", denied.sourcePath), { code: "consent_denied" });
  assert.deepEqual(denied.steps.map(([name]) => name), ["stage", "cleanup", "wait"]);
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

test("cancelled approval before admission cannot dispatch install and cleans the staged artifact", async (t) => {
  const caller = new AbortController();
  let state;
  state = await stagedFixture(t, {
    beginDestructiveApproval(action, invocation, { stagedArtifact }) {
      return {
        approved: Promise.resolve(),
        signal: caller.signal,
        remainingTimeoutMs(ceiling) { return ceiling; },
        async run(work) { return work(); },
        requireCurrent() {},
        consume(owned, staged) {
          assert.equal(owned, invocation);
          assert.equal(staged, stagedArtifact);
          caller.abort();
          state.steps.push(["consumed"]);
        },
        dispose() {},
      };
    },
    stagedApps: {
      async install(invocation, staged, options) {
        assert.equal(options.signal, caller.signal);
        options.signal.throwIfAborted();
        state.steps.push(["install"]);
      },
    },
  });
  await assert.rejects(state.backend.installApp("one", state.sourcePath), { code: "ailoha_operation_failed" });
  await assert.rejects(state.backend.installApp("one", state.sourcePath), { code: "ailoha_operation_failed" });
  assert.deepEqual(state.steps.map(([name]) => name), ["stage", "consumed", "cleanup", "wait"]);
});

test("spent submission budget blocks pre-wire install and cleans the original staged artifact", async (t) => {
  let state;
  state = await stagedFixture(t, {
    beginDestructiveApproval(action, invocation, { stagedArtifact }) {
      return {
        approved: Promise.resolve(), signal: new AbortController().signal,
        async run(work) { return work(); },
        requireCurrent() {},
        consume(owned, staged) {
          assert.equal(owned, invocation);
          assert.equal(staged, stagedArtifact);
          state.steps.push(["consumed"]);
        },
        remainingTimeoutMs(ceiling) {
          assert.equal(ceiling, 30_000);
          throw new MobileAilohaError("consent_expired", "Original attempt budget expired.", 409);
        },
        dispose() {},
      };
    },
  });
  await assert.rejects(state.backend.installApp("one", state.sourcePath), { code: "consent_expired" });
  await assert.rejects(state.backend.installApp("one", state.sourcePath), { code: "consent_expired" });
  assert.deepEqual(state.steps.map(([name]) => name), ["stage", "consumed", "cleanup", "wait"]);
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
    ["stage", "approval", "install", "wait", "cleanup"]);
  const unknown = await stagedFixture(t, { stagedApps: {
    async cleanup() {
      unknown.steps.push(["cleanup"]);
      throw new Error("private cleanup source /secret/app.apk");
    },
  } });
  await assert.rejects(unknown.backend.installApp("one", unknown.sourcePath), { code: "ailoha_operation_failed" });
  await assert.rejects(unknown.backend.installApp("one", unknown.sourcePath), {
    code: "app_stage_cleanup_outcome_uncertain",
  });
  assert.equal(unknown.steps.filter(([name]) => name === "cleanup").length, 1);
});

test("missing scoped consent, host topology or source capability cannot stage a package", async (t) => {
  for (const options of [
    { confirmDestructive: undefined },
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

function guardedFixture(kind, path, owner, options = {}) {
  const date = "2026-10-10T00:00:00Z";
  const ticks = (value) => (BigInt(Date.parse(value)) + 62135596800000n) * 10000n;
  const connection = owner.connectionRef;
  return {
    kind, path, targetHostId: "host", attemptId: "0123456789abcdef0123456789abcdef",
    owner: {
      hostInstanceId: `host-${stageHash(`${connection.serviceId}\0${connection.pid}\0${ticks(connection.startedAt)}\0${ticks(connection.processStartedAt)}`)}`,
      targetId: "one", providerId: "provider",
      registrationEpoch: "01234567-89ab-cdef-0123-456789abcdef",
      nativeIdentity: { platform: "ios", nativeId: "real-native-one", isVirtual: true },
    },
    contextRef: "ctx-canonical-snapshot", scopeEpoch: "original-epoch", revision: "1",
    ownerProcessId: 1234, ownerStartedAt: date,
    appId: null, recursive: kind === "delete" ? options.recursive ?? false : false,
    destinationPath: kind === "export" ? options.destinationPath : null,
    overwrite: kind === "export", maximumBytes: 512 * 1024 * 1024,
  };
}

function guardedOperation(kind, receipt, status = "queued") {
  return {
    operationId: "guarded-operation", requestId: receipt.attemptId,
    targetId: "one", providerId: "provider",
    kind: { export: "exportTargetFile", delete: "deleteTargetFileWithOptions",
      mkdir: "createTargetDirectory" }[kind],
    status, destructive: kind === "delete", createdAt: "2026-10-10T00:00:00Z",
  };
}

test("local guarded delete uses original scoped consent and backend-confirmed mutation path", async (t) => {
  let prompts = 0;
  let receipt;
  const actions = [];
  const state = canonicalFixture({
    confirmDestructive: async (request) => {
      prompts += 1;
      assert.equal(request.action, "file_delete");
      assert.match(request.message, /app:\/\/com.example.app\/Documents\/fixture/);
      return true;
    },
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["deleteTargetFileWithOptions"] },
          { id: "target.apps", version: 1, features: ["listTargetApps"] }];
      },
      async listTargetApps() {
        return [{ appId: "com.example.app", packageId: "com.example.app",
          "x-ailoha-target-host": { targetId: "one", providerId: "provider" } }];
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-file") + 1];
      actions.push(action);
      if (action === "prepare") {
        assert.equal(args[args.indexOf("--path") + 1], "app://com.example.app/Documents/fixture");
        assert.ok(args.includes("--recursive"));
        receipt = guardedFixture("delete", "app://com.example.app/Documents/fixture", state.owner,
          { recursive: true });
        return JSON.stringify({ status: "prepared", receipt });
      }
      assert.equal(args[args.indexOf("--guarded") + 1], JSON.stringify(receipt));
      const operation = guardedOperation("delete", receipt, action === "continue" ? "queued" : "succeeded");
      if (action === "recover") operation.result = { path: "Documents/fixture" };
      return JSON.stringify({ status: action === "continue" ? "accepted" : "succeeded",
        receipt, operationId: operation.operationId, operation,
        ...(action === "recover" ? { mutation: { path: "Documents/fixture" } } : {}) });
    },
  });
  t.after(() => state.backend.dispose());
  const result = await state.backend.guardedFile("mobile_device_file_delete",
    { deviceId: "one", path: "Documents/fixture", bundleId: "com.example.app", recursive: true });
  assert.equal(result.path, "Documents/fixture");
  assert.equal(result.operation, "delete");
  assert.equal(prompts, 1);
  assert.deepEqual(actions, ["prepare", "continue", "recover"]);
});

test("local guarded mkdir retains accepted original receipt after failed GET and recovers without a second submission", async (t) => {
  let receipt;
  let recovery = 0;
  const actions = [];
  const state = canonicalFixture({
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["createTargetDirectory"] }];
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-file") + 1];
      actions.push(action);
      if (action === "prepare") {
        receipt = guardedFixture("mkdir", "/Documents/new", state.owner);
        return JSON.stringify({ status: "prepared", receipt });
      }
      const operation = guardedOperation("mkdir", receipt, action === "continue" ? "queued" : "succeeded");
      if (action === "recover" && ++recovery === 1) {
        throw Object.assign(new Error("Original GET was unavailable"), { code: "owned_get_failed" });
      }
      if (action === "recover") operation.result = { path: "/Documents/new" };
      return JSON.stringify({ status: action === "continue" ? "accepted" : "succeeded",
        receipt, operationId: operation.operationId, operation,
        ...(action === "recover" ? { mutation: { path: "/Documents/new" } } : {}) });
    },
  });
  t.after(() => state.backend.dispose());
  const input = { deviceId: "one", path: "/Documents/new" };
  await assert.rejects(state.backend.guardedFile("mobile_device_file_mkdir", input), { code: "owned_get_failed" });
  const result = await state.backend.guardedFile("mobile_device_file_mkdir", input);
  assert.equal(result.path, "/Documents/new");
  assert.equal(result.operation, "mkdir");
  assert.deepEqual(actions, ["prepare", "continue", "recover", "recover"]);
});

test("guarded readback rejects another operation ID, retaining the original GET-only recovery", async (t) => {
  let receipt;
  let wrongReadback = true;
  const actions = [];
  const state = canonicalFixture({
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["createTargetDirectory"] }];
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-file") + 1];
      actions.push(action);
      if (action === "prepare") {
        receipt = guardedFixture("mkdir", "/Documents/owned", state.owner);
        return JSON.stringify({ status: "prepared", receipt });
      }
      const operation = guardedOperation("mkdir", receipt, action === "continue" ? "queued" : "succeeded");
      if (action === "recover" && wrongReadback) operation.operationId = "another-operation";
      if (action === "recover") operation.result = { path: "/Documents/owned" };
      return JSON.stringify({ status: action === "continue" ? "accepted" : "succeeded",
        receipt, operationId: operation.operationId, operation,
        ...(action === "recover" ? { mutation: { path: "/Documents/owned" } } : {}) });
    },
  });
  t.after(() => state.backend.dispose());
  const input = { deviceId: "one", path: "/Documents/owned" };
  await assert.rejects(state.backend.guardedFile("mobile_device_file_mkdir", input),
    { code: "guarded_file_operation_mismatch" });
  wrongReadback = false;
  assert.equal((await state.backend.guardedFile("mobile_device_file_mkdir", input)).path, input.path);
  assert.deepEqual(actions, ["prepare", "continue", "recover", "recover"]);
});

test("guarded input and original revision are captured before asynchronous capability lookup", async (t) => {
  const input = { deviceId: "one", path: "/Documents/original" };
  let prepared = false;
  const state = canonicalFixture({
    client: {
      async getTargetCapabilities() {
        input.path = "/Documents/replacement";
        return [{ id: "target.files", version: 1, features: ["createTargetDirectory"] }];
      },
    },
    async runCli(args) {
      prepared = true;
      assert.equal(args[args.indexOf("--path") + 1], "/Documents/original");
      assert.equal(args[args.indexOf("--context-revision") + 1], "1");
      throw Object.assign(new Error("Owned probe stops before admission."), { code: "probe_stopped" });
    },
  });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.guardedFile("mobile_device_file_mkdir", input), { code: "probe_stopped" });
  assert.equal(prepared, true);
  await assert.rejects(state.backend.guardedFile("mobile_device_file_mkdir",
    { deviceId: "one", path: "/Documents/original" }), { code: "guarded_file_prepare_unknown" });
});

test("guarded prepare stops when its original view revision changes before device admission", async (t) => {
  let prepared = false;
  let state;
  state = canonicalFixture({
    client: {
      async getTargetCapabilities() {
        await state.advanceSelection();
        return [{ id: "target.files", version: 1, features: ["createTargetDirectory"] }];
      },
    },
    async runCli() { prepared = true; throw new Error("stale view admitted device IO"); },
  });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.guardedFile("mobile_device_file_mkdir",
    { deviceId: "one", path: "/Documents/original" }), { code: "context_snapshot_superseded" });
  assert.equal(prepared, false);
});

test("guarded delete requires scoped approval and never admits a denied mutation", async (t) => {
  let receipt;
  const actions = [];
  const state = canonicalFixture({
    confirmDestructive: async (request) => {
      assert.equal(request.action, "file_delete");
      assert.match(request.message, /Documents\/owned/);
      return false;
    },
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["deleteTargetFileWithOptions"] }];
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-file") + 1];
      actions.push(action);
      assert.equal(action, "prepare");
      receipt = guardedFixture("delete", "/Documents/owned", state.owner);
      return JSON.stringify({ status: "prepared", receipt });
    },
  });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.guardedFile("mobile_device_file_delete",
    { deviceId: "one", path: "/Documents/owned" }), { code: "consent_denied" });
  assert.deepEqual(actions, ["prepare"]);
});

test("guarded failed native mutation is terminal, retaining its original receipt without replay", async (t) => {
  let receipt;
  const actions = [];
  const state = canonicalFixture({
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["createTargetDirectory"] }];
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-file") + 1];
      actions.push(action);
      if (action === "prepare") {
        receipt = guardedFixture("mkdir", "/Documents/failure", state.owner);
        return JSON.stringify({ status: "prepared", receipt });
      }
      const operation = guardedOperation("mkdir", receipt, action === "continue" ? "queued" : "failed");
      return JSON.stringify({ status: action === "continue" ? "accepted" : "failed",
        receipt, operationId: operation.operationId, operation,
        ...(action === "recover" ? { errorCode: "DeviceDirectoryAlreadyFile" } : {}) });
    },
  });
  t.after(() => state.backend.dispose());
  const input = { deviceId: "one", path: "/Documents/failure" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(state.backend.guardedFile("mobile_device_file_mkdir", input),
      { code: "DeviceDirectoryAlreadyFile" });
  }
  assert.deepEqual(actions, ["prepare", "continue", "recover", "recover"]);
});

test("guarded unknown acceptance retries original recovery without another device submission", async (t) => {
  let receipt;
  let reads = 0;
  const actions = [];
  const state = canonicalFixture({
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["createTargetDirectory"] }];
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-file") + 1];
      actions.push(action);
      if (action === "prepare") {
        receipt = guardedFixture("mkdir", "/Documents/uncertain", state.owner);
        return JSON.stringify({ status: "prepared", receipt });
      }
      if (action === "continue") {
        return JSON.stringify({ status: "acceptanceUnknown", receipt,
          errorCode: "GuardedAcceptanceUnknown" });
      }
      if (++reads === 1) {
        return JSON.stringify({ status: "readbackUnconfirmed", receipt,
          errorCode: "GuardedReadbackUnconfirmed" });
      }
      const operation = guardedOperation("mkdir", receipt, "succeeded");
      operation.result = { path: "/Documents/uncertain" };
      return JSON.stringify({ status: "succeeded", receipt,
        operationId: operation.operationId, operation, mutation: { path: "/Documents/uncertain" } });
    },
  });
  t.after(() => state.backend.dispose());
  const input = { deviceId: "one", path: "/Documents/uncertain" };
  await assert.rejects(state.backend.guardedFile("mobile_device_file_mkdir", input),
    { code: "GuardedReadbackUnconfirmed" });
  assert.equal((await state.backend.guardedFile("mobile_device_file_mkdir", input)).path, input.path);
  assert.deepEqual(actions, ["prepare", "continue", "recover", "recover"]);
});

test("accepted guarded files recover their original operation after view retirement", async (t) => {
  let receipt;
  let recoveries = 0;
  const actions = [];
  const state = canonicalFixture({
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["createTargetDirectory"] }];
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-file") + 1];
      actions.push(action);
      if (action === "prepare") {
        receipt = guardedFixture("mkdir", "/Documents/original", state.owner);
        return JSON.stringify({ status: "prepared", receipt });
      }
      const operation = guardedOperation("mkdir", receipt,
        action === "continue" ? "queued" : "succeeded");
      if (action === "recover" && ++recoveries === 1) {
        throw Object.assign(new Error("Original GET reply was lost"), { code: "owned_get_failed" });
      }
      if (action === "recover") operation.result = { path: "/Documents/original" };
      return JSON.stringify({
        status: action === "continue" ? "accepted" : "succeeded",
        receipt, operationId: operation.operationId, operation,
        ...(action === "recover" ? { mutation: { path: "/Documents/original" } } : {}),
      });
    },
  });
  t.after(() => state.backend.dispose());
  const input = { deviceId: "one", path: "/Documents/original" };
  await assert.rejects(state.backend.guardedFile("mobile_device_file_mkdir", input),
    { code: "owned_get_failed" });
  await state.retireAuthority({ observe: false });
  assert.equal((await state.backend.guardedFile("mobile_device_file_mkdir", input)).path, input.path);
  assert.deepEqual(actions, ["prepare", "continue", "recover", "recover"]);
});

test("cancelled guarded readback retains the original receipt for GET-only recovery", async (t) => {
  const entered = deferred();
  const release = deferred();
  const caller = new AbortController();
  const actions = [];
  let receipt;
  let recoveries = 0;
  const state = canonicalFixture({
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["createTargetDirectory"] }];
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-file") + 1];
      actions.push(action);
      if (action === "prepare") {
        receipt = guardedFixture("mkdir", "/Documents/original", state.owner);
        return JSON.stringify({ status: "prepared", receipt });
      }
      const operation = guardedOperation("mkdir", receipt,
        action === "continue" ? "queued" : "succeeded");
      if (action === "recover" && ++recoveries === 1) {
        entered.resolve();
        await release.promise;
      }
      if (action === "recover") operation.result = { path: "/Documents/original" };
      return JSON.stringify({
        status: action === "continue" ? "accepted" : "succeeded",
        receipt, operationId: operation.operationId, operation,
        ...(action === "recover" ? { mutation: { path: "/Documents/original" } } : {}),
      });
    },
  });
  t.after(() => state.backend.dispose());
  const input = { deviceId: "one", path: "/Documents/original" };
  const cancelled = state.backend.guardedFile("mobile_device_file_mkdir", input,
    { signal: caller.signal });
  const cancelledResult = assert.rejects(cancelled, { code: "cancelled" });
  await entered.promise;
  caller.abort();
  release.resolve();
  await cancelledResult;
  assert.equal((await state.backend.guardedFile("mobile_device_file_mkdir", input)).path, input.path);
  assert.deepEqual(actions, ["prepare", "continue", "recover", "recover"]);
});

test("disposed guarded owner cannot initiate a later original-receipt recovery", async (t) => {
  let receipt;
  const actions = [];
  const state = canonicalFixture({
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["createTargetDirectory"] }];
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-file") + 1];
      actions.push(action);
      if (action === "prepare") {
        receipt = guardedFixture("mkdir", "/Documents/original", state.owner);
        return JSON.stringify({ status: "prepared", receipt });
      }
      if (action === "recover") {
        throw Object.assign(new Error("Owned GET did not complete"), { code: "owned_get_failed" });
      }
      const operation = guardedOperation("mkdir", receipt);
      return JSON.stringify({ status: "accepted", receipt,
        operationId: operation.operationId, operation });
    },
  });
  t.after(() => state.backend.dispose());
  const input = { deviceId: "one", path: "/Documents/original" };
  await assert.rejects(state.backend.guardedFile("mobile_device_file_mkdir", input),
    { code: "owned_get_failed" });
  await state.backend.dispose();
  await assert.rejects(state.backend.guardedFile("mobile_device_file_mkdir", input),
    { code: "cancelled" });
  assert.deepEqual(actions, ["prepare", "continue", "recover"]);
});

test("a replacement host incarnation cannot inherit an accepted guarded mutation", async (t) => {
  const artifactState = new Map();
  let receipt;
  const actions = [];
  const first = canonicalFixture({
    artifactState,
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["createTargetDirectory"] }];
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-file") + 1];
      actions.push(action);
      if (action === "prepare") {
        receipt = guardedFixture("mkdir", "/Documents/owned", first.owner);
        return JSON.stringify({ status: "prepared", receipt });
      }
      if (action === "recover") throw Object.assign(new Error("Original GET failed"), { code: "owned_get_failed" });
      const operation = guardedOperation("mkdir", receipt);
      return JSON.stringify({ status: "accepted", receipt, operationId: operation.operationId, operation });
    },
  });
  t.after(() => first.backend.dispose());
  const input = { deviceId: "one", path: "/Documents/owned" };
  await assert.rejects(first.backend.guardedFile("mobile_device_file_mkdir", input),
    { code: "owned_get_failed" });
  let replacements = 0;
  const replacement = canonicalFixture({
    artifactState,
    connectionRef: { ...first.owner.connectionRef, pid: 54321 },
    async runCli() { replacements += 1; throw new Error("replacement read or mutation"); },
  });
  t.after(() => replacement.backend.dispose());
  await assert.rejects(replacement.backend.guardedFile("mobile_device_file_mkdir", input),
    { code: "runtime_incarnation_changed" });
  assert.equal(replacements, 0);
  assert.deepEqual(actions, ["prepare", "continue", "recover"]);
});

test("local guarded export uses backend-confirmed source path and verified zero/nonzero native readback", async (t) => {
  for (const bytes of [0, 5]) {
    const directory = await ownedTestDirectory(t, "export-owned-");
    const destination = join(directory, "payload");
    const content = Buffer.alloc(bytes, 65);
    const input = { deviceId: "one", bundleId: "native-app", path: "Documents/payload", output: directory };
    const actions = [];
    let approvals = 0;
    let receipt;
    let recoveries = 0;
    const state = canonicalFixture({
      confirmDestructive: async (request) => {
        approvals += 1;
        assert.equal(request.action, "file_pull");
        assert.match(request.message, /Host destination: /);
        assert.match(request.message, /payload/);
        return true;
      },
      client: {
        async getTargetCapabilities() {
          input.path = "Documents/replaced";
          input.output = "/wrong/destination";
          return [{ id: "target.files", version: 1, features: ["exportTargetFile"] },
            { id: "target.apps", version: 1, features: ["listTargetApps"] }];
        },
        async listTargetApps() {
          throw new Error("Sparse file app references must not use strict inventory validation.");
        },
        async listTargetAppReferences() {
          return [{ appId: "native-app", packageId: "com.example.app",
            "x-ailoha-target-host": { targetId: "one", providerId: "provider" } }];
        },
      },
      async runCli(args) {
        const action = args[args.indexOf("native-file") + 1];
        actions.push(action);
        if (action === "prepare") {
          assert.equal(args[args.indexOf("--path") + 1], "app://com.example.app/Documents/payload");
          assert.equal(args[args.indexOf("--destination") + 1], resolve(directory));
          assert.ok(args.includes("--overwrite"));
          receipt = guardedFixture("export", "app://com.example.app/Documents/payload", state.owner,
            { destinationPath: destination });
          return JSON.stringify({ status: "prepared", receipt });
        }
        const operation = {
          ...guardedOperation("export", receipt, action === "continue" ? "queued" : "succeeded"),
          artifactIds: ["owned-artifact"],
          ...(action === "recover" ? { result: { artifactId: "owned-artifact", devicePath: "Documents/payload" } } : {}),
        };
        if (action === "recover" && ++recoveries === 1) {
          await writeFile(destination, content);
          throw Object.assign(new Error("Original native GET reply was lost"), { code: "owned_get_failed" });
        }
        const artifact = {
          artifactId: "owned-artifact", kind: "file", status: "ready",
          contentType: "application/octet-stream", createdAt: "2026-10-10T00:00:00Z",
          targetId: "one", operationId: operation.operationId, fileName: "payload",
          size: bytes, sha256: stageHash(content),
        };
        if (action === "recover") assert.deepEqual(await readFile(destination), content);
        return JSON.stringify({ status: action === "continue" ? "accepted" : "downloaded",
          receipt, operationId: operation.operationId, operation,
          ...(action === "recover" ? { artifact, downloadedBytes: bytes, devicePath: "Documents/payload" } : {}) });
      },
    });
    t.after(() => state.backend.dispose());
    await assert.rejects(state.backend.guardedFile("mobile_device_file_pull", input), { code: "owned_get_failed" });
    const result = await state.backend.guardedFile("mobile_device_file_pull", {
      deviceId: "one", bundleId: "native-app", path: "Documents/payload", output: directory,
    });
    assert.deepEqual(result, {
      schemaVersion: "1.0", success: true, deviceId: "one",
      devicePath: "Documents/payload", hostPath: destination, size: bytes, operation: "pull",
    });
    assert.deepEqual(actions, ["prepare", "continue", "recover", "recover"]);
    assert.equal(approvals, 1);
  }
});

test("cancelled guarded input and unadvertised export never launch a device command", async (t) => {
  let launched = 0;
  const state = canonicalFixture({
    async runCli() { launched += 1; throw new Error("device command was admitted"); },
  });
  t.after(() => state.backend.dispose());
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(state.backend.guardedFile("mobile_device_file_mkdir",
    { deviceId: "one", path: "/Documents/new" }, { signal: abort.signal }), { code: "cancelled" });
  await assert.rejects(state.backend.invokeAction("mobile_device_file_pull",
    { deviceId: "one", path: "/Documents/new", output: "/owned/file" }),
  { code: "capability_not_supported" });
  assert.equal(launched, 0);
});

test("file transfer and mutation selectors cannot silently reinterpret a blank app as a device path", async (t) => {
  let launched = 0;
  const state = canonicalFixture({
    async runCli() { launched += 1; throw new Error("invalid app admitted native work"); },
  });
  t.after(() => state.backend.dispose());
  for (const identity of ["mobile_device_file_pull", "mobile_device_file_delete", "mobile_device_file_mkdir"]) {
    await assert.rejects(state.backend.guardedFile(identity, {
      deviceId: "one", bundleId: " \t", path: "/Documents/file",
      ...(identity === "mobile_device_file_pull" ? { output: "/owned/file" } : {}),
    }), { code: "invalid_request" });
  }
  await assert.rejects(state.backend.stageArtifact("mobile_device_file_push", {
    deviceId: "one", bundleId: " \t", path: "/Documents/file", input: "/owned/fixture",
  }), { code: "invalid_request" });
  assert.equal(launched, 0);
});

for (const status of [408, 499]) {
  test(`destructive HTTP ${status} uncertainty retains the original receipt without another mutation or approval`, async (t) => {
    let submissions = 0;
    let prompts = 0;
    const operationState = new Map();
    const state = canonicalFixture({
      operationState,
      confirmDestructive: async () => { prompts += 1; return true; },
      client: {
        async resetTarget() { submissions += 1; throw new AilohaProtocolError("http_error", { status }); },
      },
    });
    t.after(() => state.backend.dispose());
    await assert.rejects(state.backend.lifecycle("erase", "one", { confirm: true }));
    const original = [...operationState.values()][0];
    await assert.rejects(state.backend.lifecycle("erase", "one", { confirm: true }), { code: "lifecycle_outcome_uncertain" });
    assert.equal([...operationState.values()][0], original);
    assert.equal(original.invocation.targetId, "one");
    assert.equal(submissions, 1);
    assert.equal(prompts, 1);
  });
}

test("a disposed client with an unknown destructive outcome cannot erase the original receipt", async (t) => {
  let submissions = 0;
  const state = canonicalFixture({
    confirmDestructive: async () => true,
    client: {
      async resetTarget() { submissions += 1; throw new AilohaProtocolError("client_disposed"); },
    },
  });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.lifecycle("erase", "one", { confirm: true }));
  await assert.rejects(state.backend.lifecycle("erase", "one", { confirm: true }), { code: "lifecycle_outcome_uncertain" });
  assert.equal(submissions, 1);
});

test("late authoritative acceptance remains recoverable by GET despite outward approval expiry", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const operationState = new Map();
  let submissions = 0;
  let prompts = 0;
  const state = canonicalFixture({
    operationState,
    confirmDestructive: async () => { prompts += 1; return true; },
    client: {
      async resetTarget() { submissions += 1; clock = 60_001; return { operationId: "reset-one" }; },
    },
  });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.lifecycle("erase", "one", { confirm: true }), { code: "submission_outcome_unknown" });
  const original = [...operationState.values()][0];
  assert.equal(original.operationId, "reset-one");
  assert.equal(original.invocation.executionContext.revision, "1");
  const recovered = await state.backend.lifecycle("erase", "one", { confirm: true });
  assert.equal(recovered.id, "one");
  assert.equal(recovered.invocation.executionContext.revision, "1");
  assert.equal(submissions, 1);
  assert.equal(prompts, 1);
});
test("legacy remains the default and invalid opt-in never becomes a fallback", () => {
  assert.equal(mobileCanvasBackend(), "legacy");
  assert.equal(mobileCanvasBackend("legacy"), "legacy");
  assert.equal(mobileCanvasBackend("ailoha"), "ailoha");
  for (const value of ["", "Ailoha", "unknown"]) assert.throws(() => mobileCanvasBackend(value), /never falls back/);
});

const deviceFeatures = [
  { id: "target.hardware", version: 1, features: ["getTargetHardware"] },
  { id: "target.clipboard", version: 1, features: ["getTargetClipboard", "updateTargetClipboard"] },
  { id: "target.settings", version: 1, features: ["getTargetSettings", "updateTargetSettings"] },
  { id: "target.location", version: 1, features: ["clearTargetLocation", "updateTargetLocation"] },
  { id: "target.battery", version: 1, features: ["updateTargetBattery"] },
  { id: "target.network", version: 1, features: ["updateTargetNetwork", "applyTargetNativeNetworkProfile"] },
  { id: "target.telephony", version: 1, features: ["simulateTargetSms", "getTargetTelephony", "controlTargetCall"] },
  { id: "target.biometrics", version: 1, features: ["simulateTargetBiometricResult"] },
  { id: "target.apps", version: 1, features: ["listTargetApps"] },
  { id: "target.push", version: 1, features: ["sendTargetPushNotification"] },
  { id: "target.permissions", version: 1, features: ["listTargetPermissions", "updateTargetPermission"] },
];

function featureFixture(options = {}) {
  const wire = [];
  const platform = options.platform ?? "ios";
  let appearance = "light";
  let batteryLevel = options.batteryLevel === undefined ? 0.57 : options.batteryLevel;
  let batteryState = "charging";
  let clipboardText = "pasteboard";
  let latencyMs = null;
  let readsFail = false;
  let hardwareReadsFail = false;
  let smsGate = options.smsGate;
  let appGate = options.appGate;
  const hardwareGate = options.hardwareGate;
  const context = { targetId: "one" };
  const transport = {
    async response(path, request) {
      wire.push({ path, method: request.method, body: request.body });
      assert.ok(["GET", "POST", "PATCH", "DELETE", ...(options.allowPut ? ["PUT"] : [])].includes(request.method));
      if (request.method === "PUT" && ["typed_forbidden", "typed_timeout", "typed_accepted"].includes(options.putFailure)) {
        const status = options.putFailure === "typed_timeout" ? 408 : 403;
        throw Object.assign(new Error("private typed PUT diagnostics"), {
          name: "TargetHostTransportError", code: "HttpError", status,
          ...(options.putFailure === "typed_accepted" ? { operationId: "accepted-native-operation" } : {}),
        });
      }
      if (request.method === "PUT" && options.putFailure === "unknown") {
        throw new Error("private PUT transport diagnostics");
      }
      if (request.method === "PUT" && ["timeout", "server_timeout", "client_closed"].includes(options.putFailure)) {
        throw new AilohaProtocolError(options.putFailure === "server_timeout" ? "http_error" : "timeout",
          { status: options.putFailure === "client_closed" ? 499 : 408 });
      }
      const reply = (body, status = 200, location) =>
        ({ status, contentType: status === 204 ? null : "application/json", location, body });
      if (path.endsWith("/hardware")) {
        if (hardwareGate) await hardwareGate.promise;
        if (hardwareReadsFail) throw new Error("private hardware readback diagnostics");
        return reply({
          targetId: "one", platform, batteryLevel, batteryState,
          downloadBitsPerSecond: null, uploadBitsPerSecond: null, latencyMs,
          networkIsIndicatorOnly: platform === "ios", unreadable: ["location"],
          "x-ailoha-target-host": options.wrongOwner ? { ...context, providerId: "other" }
            : options.nullOwner ? { ...context, providerId: null } : context,
        });
      }
      if (path.endsWith("/clipboard")) {
        if (request.method === "PUT") clipboardText = JSON.parse(request.body).text;
        return reply({ contentType: "text/plain", text: clipboardText, "x-ailoha-target-host": context });
      }
      if (path.endsWith("/battery") && request.method === "PUT") {
        const input = JSON.parse(request.body);
        if (input.level !== undefined) batteryLevel = input.level;
        if (input.state !== undefined) batteryState = input.state;
        return reply({
          simulated: true, level: batteryLevel ?? 0,
          state: batteryLevel === null ? "unknown" : batteryState,
          "x-ailoha-target-host": context,
        });
      }
      if (path.endsWith("/network") && request.method === "PUT") {
        latencyMs = JSON.parse(request.body).latencyMs;
        return reply({ connectionProfiles: [], "x-ailoha-target-host": context });
      }
      if (path.endsWith("/location") && request.method === "PUT") return reply({
        simulated: true, ...JSON.parse(request.body), "x-ailoha-target-host": context,
      });
      if (path.endsWith("/settings/device") && request.method === "GET") {
        if (readsFail) throw new Error("private readback diagnostics");
        return reply({ namespace: "device", values: { appearance }, "x-ailoha-target-host": context });
      }
      if (path.endsWith("/settings/device") && request.method === "PATCH") {
        appearance = JSON.parse(request.body).values.appearance;
        return reply({ namespace: "device", values: { appearance }, "x-ailoha-target-host": context });
      }
      if (path.endsWith("/location") && request.method === "DELETE") return reply(null, 204);
      if (path.endsWith("/apps?includeSystem=true")) {
        if (appGate) await appGate.promise;
        return reply([{
          appId: "canonical/app-id", packageId: "com.example.native", state: "installed",
          "x-ailoha-target-host": context,
        }]);
      }
      if (path.endsWith("/telephony") && request.method === "GET") return reply({
        supported: true, platform, callState: "ringing",
        calls: [{ number: "+123", state: "RINGING" }], "x-ailoha-target-host": context,
      });
      if (path.includes("/permissions?appId=")) return reply([{
        name: "camera", ...(options.missingPlatformName ? {} : { platformName: "android.permission.CAMERA" }),
        status: options.permissionListStatus ?? "unknown",
        appId: "canonical/app-id", "x-ailoha-target-host": context,
      }]);
      if (path.endsWith("/permissions/camera") && request.method === "PUT") return reply({
        name: "camera", status: "unknown", appId: "canonical/app-id",
        affectedPermissions: options.missingGrants ? undefined : [
          { name: "camera", platformName: "android.permission.CAMERA", granted: null },
          { name: "camera", platformName: "android.permission.CAMERA_EXTRA", granted: true },
        ],
        "x-ailoha-target-host": context,
      });
      if (path.endsWith("/telephony/sms") || path.endsWith("/biometrics/results")
        || path.endsWith("/push/notifications") || path.endsWith("/telephony/calls/actions")
        || path.endsWith("/network/profiles/native")) {
        if (smsGate) await smsGate.promise;
        const kind = path.endsWith("/telephony/sms") ? "simulateTargetSms"
          : path.endsWith("/biometrics/results") ? "simulateTargetBiometricResult"
          : path.endsWith("/telephony/calls/actions") ? "controlTargetCall"
          : path.endsWith("/network/profiles/native") ? "applyTargetNativeNetworkProfile"
          : "sendTargetPushNotification";
        const operationId = `op-${kind}`;
        if (options.submitFailure === "unknown") throw new Error("private transport diagnostics");
        if (options.submitFailure === "typed_forbidden") {
          throw Object.assign(new Error("private typed POST diagnostics"), {
            name: "TargetHostTransportError", code: "HttpError", status: 403,
          });
        }
        if (options.submitFailure === "accepted") {
          return reply({ malformed: true }, 202, `/api/v1/operations/${operationId}`);
        }
        return reply({
          operationId, kind, status: "queued", destructive: false, targetId: "one", providerId: "provider",
          createdAt: "2026-10-10T03:00:00Z",
        }, 202, `/api/v1/operations/${operationId}`);
      }
      throw new Error("Unexpected canonical feature route");
    },
  };
  const state = fixture({
    featureCapabilities: options.featureCapabilities ?? deviceFeatures,
    features: createAilohaDeviceFeatures({
      transport, allowPut: options.allowPut, allowNativeFidelity: options.allowNativeFidelity,
    }),
    featureState: options.featureState,
    connectionRef: options.connectionRef,
    client: {
      async waitForOperation(id) {
        const result = id === "op-controlTargetCall" ? {
          supported: true, platform, callState: "ringing",
          calls: options.missingCalls ? undefined : [{ number: "+123", state: "RINGING" }],
          "x-ailoha-target-host": context,
        } : id === "op-simulateTargetBiometricResult" && options.allowNativeFidelity
          ? { action: "match", confirmed: platform === "android" ? options.biometricConfirmed ?? true : null } : undefined;
        const nativeProfile = id === "op-applyTargetNativeNetworkProfile" ? {
          networkIsIndicatorOnly: options.indicatorMismatch ? platform !== "ios" : platform === "ios",
          "x-ailoha-target-host": context,
        } : undefined;
        return {
          operationId: id, kind: id.slice(3), status: "succeeded", destructive: false,
          targetId: "one", providerId: "provider", createdAt: "2026-10-10T03:00:00Z",
          completedAt: "2026-10-10T03:00:01Z",
          ...(result === undefined && nativeProfile === undefined ? {} : { result: result ?? nativeProfile }),
        };
      },
    },
  });
  state.targets.get("one").nativeIdentity.platform = platform;
  return {
    ...state, wire,
    failReads() { readsFail = true; },
    allowReads() { readsFail = false; },
    failHardware() { hardwareReadsFail = true; },
    allowHardware() { hardwareReadsFail = false; },
    releaseSms() { smsGate?.resolve(); smsGate = null; },
    releaseApps() { appGate?.resolve(); appGate = null; },
    releaseHardware() { hardwareGate?.resolve(); },
  };
}

test("canonical feature transport preserves legacy hardware, clipboard, settings, clear, SMS and iOS scan outputs", async (t) => {
  const state = featureFixture();
  t.after(() => state.backend.dispose());
  assert.deepEqual(await state.backend.invokeAction("get_hardware", { deviceId: "one" }), {
    schemaVersion: "1.0", deviceId: "one", platform: "ios", batteryLevel: 57, batteryState: "charging",
    downloadBitsPerSecond: null, uploadBitsPerSecond: null, latencyMs: null,
    networkIsIndicatorOnly: true, unreadable: ["location"],
  });
  assert.deepEqual(await state.backend.invokeAction("get_clipboard", { deviceId: "one" }), {
    schemaVersion: "1.0", deviceId: "one", platform: "ios", text: "pasteboard",
  });
  assert.equal((await state.backend.invokeAction("get_settings", { deviceId: "one" })).appearance, "light");
  assert.equal((await state.backend.invokeAction("set_settings", { deviceId: "one", appearance: "dark" })).appearance, "dark");
  assert.deepEqual(await state.backend.invokeAction("clear_location", { deviceId: "one" }), {
    success: true, operation: "location-clear", deviceId: null,
  });
  assert.deepEqual(await state.backend.invokeAction("send_sms", { deviceId: "one", from: "+123", body: "hello" }), {
    success: true, operation: "sms-send", deviceId: "one",
  });
  assert.deepEqual(await state.backend.invokeAction("send_biometric", { deviceId: "one", action: "nomatch" }), {
    schemaVersion: "1.0", deviceId: "one", platform: "ios", action: "nomatch", confirmed: false,
  });
  assert.deepEqual(await state.backend.invokeAction("push_notification", {
    deviceId: "one", bundleId: "com.example.native", payload: '{"aps":{"alert":"hello"}}',
  }), { success: true, operation: "notification-push", deviceId: null });
  assert.deepEqual(state.wire.map(({ path, method }) => [method, path.replace("/api/v1/targets/one/", "")]), [
    ["GET", "hardware"], ["GET", "clipboard"], ["GET", "settings/device"],
    ["PATCH", "settings/device"], ["GET", "settings/device"], ["DELETE", "location"],
    ["POST", "telephony/sms"], ["POST", "biometrics/results"],
    ["GET", "apps?includeSystem=true"], ["POST", "push/notifications"],
  ]);
  assert.deepEqual(JSON.parse(state.wire[6].body), { phoneNumber: "+123", message: "hello" });
  assert.deepEqual(JSON.parse(state.wire[7].body), { result: "failure" });
  assert.deepEqual(JSON.parse(state.wire[9].body), {
    appId: "canonical/app-id", payload: { aps: { alert: "hello" } },
  });
});

test("feature capability negatives and lost readback do not become unsupported-verb or duplicate mutations", async (t) => {
  const disabled = featureFixture({ featureCapabilities: [] });
  t.after(() => disabled.backend.dispose());
  await assert.rejects(disabled.backend.deviceFeature("hardware_get", "one"), { code: "capability_not_supported" });
  assert.equal(disabled.wire.length, 0);
  const state = featureFixture();
  t.after(() => state.backend.dispose());
  state.failReads();
  await assert.rejects(state.backend.deviceFeature("settings_set", "one", { appearance: "dark" }));
  state.allowReads();
  assert.equal((await state.backend.deviceFeature("settings_set", "one", { appearance: "dark" })).appearance, "dark");
  assert.equal(state.wire.filter(({ method }) => method === "PATCH").length, 1);
  for (const [name, input] of [
    ["battery_set", { level: 80 }], ["network_set", { latencyMs: 100 }],
    ["location_set", { latitude: 1, longitude: 2 }], ["clipboard_set", { text: "hello" }],
    ["permission_list", { bundleId: "com.example.native" }],
    ["permission_set", { bundleId: "com.example.native", permission: "camera" }],
    ["calls", {}], ["call", { action: "place", number: "+123" }],
  ]) {
    await assert.rejects(state.backend.deviceFeature(name, "one", input), { code: "capability_not_supported" });
  }
  await assert.rejects(state.backend.deviceFeature("network_set", "one", { profile: "lte" }),
    { code: "capability_not_supported" });
  await assert.rejects(state.backend.deviceFeature("notification_push", "one", {
    bundleId: "com.example.missing", payload: '{"aps":{}}',
  }), { code: "app_identity_unavailable" });
  assert.equal(state.wire.filter(({ method }) => method === "POST").length, 0);
  assert.equal(state.wire.some(({ method }) => method === "PUT"), false);
});

test("draft native call and permission fidelity maps exact readback, fanout and actions for API and MCP", async (t) => {
  const state = featureFixture({ platform: "android", allowNativeFidelity: true, allowPut: true });
  t.after(() => state.backend.dispose());
  const base = "/api/v1/devices/one";
  const calls = { schemaVersion: "1.0", deviceId: "one", platform: "android",
    calls: [{ number: "+123", state: "RINGING" }] };
  assert.deepEqual(await (await state.backend.request(`${base}/calls`)).json(), calls);
  assert.deepEqual(await (await state.backend.request(`${base}/calls`, {
    method: "POST", body: JSON.stringify({ action: "place", number: "+123" }),
  })).json(), calls);
  const listed = await (await state.backend.request(`${base}/permissions?bundleId=com.example.native`)).json();
  assert.deepEqual(listed, {
    schemaVersion: "1.0", deviceId: "one", platform: "android", bundleId: "com.example.native",
    permissions: [{ name: "camera", platformName: "android.permission.CAMERA", granted: null }], total: 1,
  });
  const changed = await (await state.backend.request(`${base}/permissions`, {
    method: "POST", body: JSON.stringify({ bundleId: "com.example.native", permission: "camera", action: "reset" }),
  })).json();
  assert.deepEqual(changed, {
    schemaVersion: "1.0", success: true, deviceId: "one", bundleId: "com.example.native",
    permission: "camera", action: "reset",
    permissions: [
      { name: "camera", platformName: "android.permission.CAMERA", granted: null },
      { name: "camera", platformName: "android.permission.CAMERA_EXTRA", granted: true },
    ],
  });
  const binding = { contextRef: "ctx", scopeEpoch: "epoch", ownerProcessId: 1234,
    scope: { sessionId: "unique-session", viewId: "unique-view" } };
  const mcp = await createAilohaMcpDispatcher({
    version: "source-only", binding, allowPut: true, allowNativeFidelity: true,
    createBackend: async () => state.backend,
  });
  const call = async (name, input) => {
    const reply = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: { deviceId: "one", ...input } } });
    assert.notEqual(reply.result.isError, true, JSON.stringify(reply.result));
    return reply.result.structuredContent;
  };
  assert.deepEqual(await call("mobile_device_calls", {}), calls);
  assert.deepEqual(await call("mobile_device_call", { action: "accept", number: null }), calls);
  assert.deepEqual(await call("mobile_device_permission_list", { bundleId: "com.example.native" }), listed);
  assert.deepEqual(await call("mobile_device_permission_set", {
    bundleId: "com.example.native", permission: "camera",
  }), { ...changed, action: "grant" });
  assert.deepEqual(state.wire.filter(({ method }) => ["POST", "PUT"].includes(method))
    .map(({ path, method, body }) => [method, path, JSON.parse(body)]), [
    ["POST", "/api/v1/targets/one/telephony/calls/actions", { action: "place", phoneNumber: "+123" }],
    ["PUT", "/api/v1/targets/one/permissions/camera",
      { appId: "canonical/app-id", status: "unknown" }],
    ["POST", "/api/v1/targets/one/telephony/calls/actions", { action: "accept" }],
    ["PUT", "/api/v1/targets/one/permissions/camera",
      { appId: "canonical/app-id", status: "granted" }],
  ]);
});

test("draft native omissions fail closed without replaying accepted call or permission mutation", async (t) => {
  const missingCalls = featureFixture({ platform: "android", allowNativeFidelity: true, missingCalls: true });
  t.after(() => missingCalls.backend.dispose());
  const input = { deviceId: "one", action: "place", number: "+123" };
  await assert.rejects(missingCalls.backend.invokeAction("send_call", input), { code: "capability_not_supported" });
  await assert.rejects(missingCalls.backend.invokeAction("send_call", input), { code: "capability_not_supported" });
  assert.equal(missingCalls.wire.filter(({ method }) => method === "POST").length, 1);
  const missingGrants = featureFixture({ platform: "android", allowNativeFidelity: true,
    allowPut: true, missingGrants: true });
  t.after(() => missingGrants.backend.dispose());
  const permission = { deviceId: "one", bundleId: "com.example.native", permission: "camera" };
  await assert.rejects(missingGrants.backend.invokeAction("set_permission", permission),
    { code: "capability_not_supported" });
  await assert.rejects(missingGrants.backend.invokeAction("set_permission", permission),
    { code: "feature_outcome_uncertain" });
  assert.equal(missingGrants.wire.filter(({ method }) => method === "PUT").length, 1);
  const noCapability = featureFixture({ platform: "android", allowNativeFidelity: true, allowPut: true,
    featureCapabilities: deviceFeatures.filter(({ id }) => id !== "target.permissions" && id !== "target.telephony") });
  t.after(() => noCapability.backend.dispose());
  await assert.rejects(noCapability.backend.invokeAction("get_calls", { deviceId: "one" }),
    { code: "capability_not_supported" });
  await assert.rejects(noCapability.backend.invokeAction("set_permission", permission),
    { code: "capability_not_supported" });
  assert.equal(noCapability.wire.length, 0);
  const missingName = featureFixture({ platform: "android", allowNativeFidelity: true,
    missingPlatformName: true });
  t.after(() => missingName.backend.dispose());
  await assert.rejects(missingName.backend.invokeAction("list_permissions", {
    deviceId: "one", bundleId: "com.example.native",
  }), { code: "capability_not_supported" });
});

test("native denied permission and unconfirmed Android scan retain explicit false instead of inferred success", async (t) => {
  const state = featureFixture({
    platform: "android", allowNativeFidelity: true,
    biometricConfirmed: false, permissionListStatus: "denied",
  });
  t.after(() => state.backend.dispose());
  const permissions = await state.backend.invokeAction("list_permissions", {
    deviceId: "one", bundleId: "com.example.native",
  });
  assert.equal(permissions.permissions[0].granted, false);
  const scan = await state.backend.invokeAction("send_biometric", {
    deviceId: "one", action: "match", fingerId: 7,
  });
  assert.equal(scan.confirmed, false);
  assert.equal(state.wire.filter(({ method }) => method === "POST").length, 1);
  const ios = featureFixture({ allowNativeFidelity: true });
  t.after(() => ios.backend.dispose());
  assert.equal((await ios.backend.invokeAction("send_biometric", {
    deviceId: "one", action: "match",
  })).confirmed, false);
});

test("draft permission lookup and accepted call retain original target and process ownership", async (t) => {
  const gate = deferred();
  const state = featureFixture({ platform: "android", allowNativeFidelity: true,
    allowPut: true, appGate: gate });
  t.after(() => state.backend.dispose());
  const permission = { deviceId: "one", bundleId: "com.example.native", permission: "camera" };
  const pending = state.backend.invokeAction("set_permission", permission);
  for (let tries = 0; tries < 100 && !state.wire.some(({ path }) => path.endsWith("/apps?includeSystem=true")); tries += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  state.targets.get("one").providerId = "other";
  state.releaseApps();
  await assert.rejects(pending, { code: "operation_owner_mismatch" });
  assert.equal(state.wire.some(({ method }) => method === "PUT"), false);

  const featureState = new Map();
  const accepted = featureFixture({ platform: "android", allowNativeFidelity: true, featureState });
  t.after(() => accepted.backend.dispose());
  const input = { deviceId: "one", action: "place", number: "+123" };
  const delayed = deferred();
  accepted.client.waitForOperation = async () => delayed.promise;
  const call = accepted.backend.invokeAction("send_call", input);
  for (let tries = 0; tries < 100 && !accepted.wire.some(({ path }) => path.endsWith("/telephony/calls/actions")); tries += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const replacement = featureFixture({ platform: "android", allowNativeFidelity: true,
    featureState, connectionRef: { ...accepted.backend.connectionRef, pid: 99999 } });
  t.after(() => replacement.backend.dispose());
  await assert.rejects(replacement.backend.invokeAction("send_call", input), { code: "runtime_incarnation_changed" });
  assert.equal(replacement.wire.length, 0);
  delayed.resolve({
    operationId: "op-controlTargetCall", kind: "controlTargetCall", status: "succeeded",
    destructive: false, targetId: "one", providerId: "provider", createdAt: "2026-10-10T03:00:00Z",
    completedAt: "2026-10-10T03:00:01Z",
    result: { supported: true, platform: "android", callState: "ringing",
      calls: [{ number: "+123", state: "RINGING" }], "x-ailoha-target-host": { targetId: "one" } },
  });
  assert.equal((await call).calls[0].state, "RINGING");
  assert.equal(accepted.wire.filter(({ method }) => method === "POST").length, 1);
});

test("feature completion preserves the accepted operation ID and non-destructive effect before releasing its receipt", async (t) => {
  for (const change of [
    (operation) => ({ ...operation, operationId: "another-operation" }),
    (operation) => ({ ...operation, destructive: true }),
  ]) {
    const featureState = new Map();
    const state = featureFixture({ featureState });
    t.after(() => state.backend.dispose());
    const wait = state.client.waitForOperation;
    let mismatched = true;
    let waitedId;
    state.client.waitForOperation = async (id, options) => {
      waitedId = id;
      const operation = await wait(id, options);
      return mismatched ? change(operation) : operation;
    };
    const input = { deviceId: "one", from: "+123", body: "hello" };
    await assert.rejects(state.backend.invokeAction("send_sms", input), { code: "operation_owner_mismatch" });
    const receipt = [...featureState.values()][0];
    assert.equal(receipt.operationId, "op-simulateTargetSms");
    assert.equal(waitedId, receipt.operationId);
    assert.equal(receipt.completed, null);
    assert.equal(state.wire.filter(({ method }) => method === "POST").length, 1);
    mismatched = false;
    assert.equal((await state.backend.invokeAction("send_sms", input)).operation, "sms-send");
    assert.equal(featureState.size, 0);
    assert.equal(state.wire.filter(({ method }) => method === "POST").length, 1);
  }
});

test("source-conditional official PUT routes preserve all four legacy setter outputs and readback", async (t) => {
  const state = featureFixture({ platform: "android", allowPut: true });
  t.after(() => state.backend.dispose());
  const battery = await state.backend.invokeAction("set_battery", { deviceId: "one", level: 80 });
  assert.equal(battery.batteryLevel, 80);
  assert.equal(battery.networkIsIndicatorOnly, false);
  const network = await state.backend.invokeAction("set_network", { deviceId: "one", latencyMs: 125 });
  assert.equal(network.latencyMs, 125);
  assert.deepEqual(await state.backend.invokeAction("set_location", {
    deviceId: "one", latitude: 1.5, longitude: -2.5,
  }), { success: true, operation: "location-set", deviceId: null });
  assert.deepEqual(await state.backend.invokeAction("set_clipboard", {
    deviceId: "one", text: "new native text",
  }), { schemaVersion: "1.0", deviceId: "one", platform: "android", text: "new native text" });
  assert.deepEqual(state.wire.filter(({ method }) => method === "PUT")
    .map(({ path, body }) => [path, JSON.parse(body)]), [
    ["/api/v1/targets/one/battery", { level: 0.8 }],
    ["/api/v1/targets/one/network", { latencyMs: 125 }],
    ["/api/v1/targets/one/location", { latitude: 1.5, longitude: -2.5 }],
    ["/api/v1/targets/one/clipboard", { contentType: "text/plain", text: "new native text" }],
  ]);
});

test("state-only battery update preserves an unreadable level instead of projecting the native zero placeholder", async (t) => {
  const state = featureFixture({ platform: "android", allowPut: true, batteryLevel: null });
  t.after(() => state.backend.dispose());
  const hardware = await state.backend.invokeAction("set_battery", {
    deviceId: "one", state: "discharging",
  });
  assert.equal(hardware.batteryLevel, null);
  assert.equal(hardware.batteryState, "discharging");
  assert.deepEqual(state.wire.filter(({ method }) => method === "PUT")
    .map(({ path, body }) => [path, JSON.parse(body)]), [
    ["/api/v1/targets/one/battery", { state: "discharging" }],
  ]);
  assert.equal((await state.backend.deviceFeature("hardware_get", "one")).batteryLevel, null);
});

test("setter readback failures and wrong capability never resubmit an uncertain PUT", async (t) => {
  const state = featureFixture({ allowPut: true });
  t.after(() => state.backend.dispose());
  state.failReads();
  await assert.rejects(state.backend.invokeAction("set_settings", { deviceId: "one", appearance: "dark" }));
  state.allowReads();
  assert.equal((await state.backend.invokeAction("set_settings", {
    deviceId: "one", appearance: "dark",
  })).appearance, "dark");
  assert.equal(state.wire.filter(({ method }) => method === "PATCH").length, 1);
  state.failHardware();
  await assert.rejects(state.backend.invokeAction("set_battery", { deviceId: "one", level: 80 }));
  state.allowHardware();
  assert.equal((await state.backend.invokeAction("set_battery", {
    deviceId: "one", level: 80,
  })).batteryLevel, 80);
  assert.equal(state.wire.filter(({ method, path }) => method === "PUT" && path.endsWith("/battery")).length, 1);
  const uncertain = featureFixture({ allowPut: true, putFailure: "unknown" });
  t.after(() => uncertain.backend.dispose());
  await assert.rejects(uncertain.backend.invokeAction("set_location", {
    deviceId: "one", latitude: 1, longitude: 2,
  }));
  await assert.rejects(uncertain.backend.invokeAction("set_location", {
    deviceId: "one", latitude: 1, longitude: 2,
  }), { code: "feature_outcome_uncertain" });
  assert.equal(uncertain.wire.filter(({ method }) => method === "PUT").length, 1);
  for (const putFailure of ["timeout", "server_timeout", "client_closed"]) {
    const timeout = featureFixture({ allowPut: true, putFailure });
    t.after(() => timeout.backend.dispose());
    const timedOutInput = { deviceId: "one", level: 80 };
    await assert.rejects(timeout.backend.invokeAction("set_battery", timedOutInput),
      { code: putFailure === "server_timeout" ? "http_error" : "timeout" });
    await assert.rejects(timeout.backend.invokeAction("set_battery", timedOutInput),
      { code: "feature_outcome_uncertain" });
    assert.equal(timeout.wire.filter(({ method }) => method === "PUT").length, 1);
  }
  const disabled = featureFixture({ allowPut: true, featureCapabilities: [] });
  t.after(() => disabled.backend.dispose());
  await assert.rejects(disabled.backend.invokeAction("set_battery", {
    deviceId: "one", level: 20,
  }), { code: "capability_not_supported" });
  assert.equal(disabled.wire.length, 0);
});

test("official typed feature rejections evict definite 403 but retain 408 and accepted evidence", async (t) => {
  const input = { deviceId: "one", level: 80 };
  const options = { allowPut: true, putFailure: "typed_forbidden" };
  const denied = featureFixture(options);
  t.after(() => denied.backend.dispose());
  await assert.rejects(denied.backend.invokeAction("set_battery", input), { code: "http_error", status: 403 });
  options.putFailure = undefined;
  assert.equal((await denied.backend.invokeAction("set_battery", input)).batteryLevel, 80);
  assert.equal(denied.wire.filter(({ method }) => method === "PUT").length, 2);

  for (const putFailure of ["typed_timeout", "typed_accepted"]) {
    const uncertain = featureFixture({ allowPut: true, putFailure });
    t.after(() => uncertain.backend.dispose());
    await assert.rejects(uncertain.backend.invokeAction("set_battery", input));
    await assert.rejects(uncertain.backend.invokeAction("set_battery", input),
      { code: "feature_outcome_uncertain" });
    assert.equal(uncertain.wire.filter(({ method }) => method === "PUT").length, 1);
  }

  const postOptions = { submitFailure: "typed_forbidden" };
  const post = featureFixture(postOptions);
  t.after(() => post.backend.dispose());
  const sms = { deviceId: "one", from: "+123", body: "hello" };
  await assert.rejects(post.backend.invokeAction("send_sms", sms), { code: "http_error", status: 403 });
  postOptions.submitFailure = undefined;
  assert.equal((await post.backend.invokeAction("send_sms", sms)).operation, "sms-send");
  assert.equal(post.wire.filter(({ method }) => method === "POST").length, 2);
});

test("draft native profile and Android biometric require terminal evidence without inventing confirmation", async (t) => {
  const android = featureFixture({ platform: "android", allowNativeFidelity: true });
  t.after(() => android.backend.dispose());
  const network = await android.backend.invokeAction("set_network", {
    deviceId: "one", profile: "lte", latencyMs: 175,
  });
  assert.equal(network.networkIsIndicatorOnly, false);
  assert.equal(network.batteryLevel, 57);
  assert.deepEqual(await android.backend.invokeAction("send_biometric", {
    deviceId: "one", action: "match", fingerId: 7,
  }), { schemaVersion: "1.0", deviceId: "one", platform: "android", action: "match", confirmed: true });
  assert.deepEqual(android.wire.filter(({ method }) => method === "POST")
    .map(({ path, body }) => [path, JSON.parse(body)]), [
    ["/api/v1/targets/one/network/profiles/native", { profile: "lte", latencyMs: 175 }],
    ["/api/v1/targets/one/biometrics/results", { result: "success", fingerId: 7 }],
  ]);
  const ios = featureFixture({ allowNativeFidelity: true });
  t.after(() => ios.backend.dispose());
  assert.equal((await ios.backend.invokeAction("set_network", { deviceId: "one", profile: "wifi" }))
    .networkIsIndicatorOnly, true);
  await assert.rejects(ios.backend.invokeAction("set_network", {
    deviceId: "one", profile: "wifi", latencyMs: 100,
  }), { code: "capability_not_supported" });
  assert.equal(ios.wire.filter(({ method }) => method === "POST").length, 1);
  const recovered = featureFixture({ allowNativeFidelity: true });
  t.after(() => recovered.backend.dispose());
  recovered.failHardware();
  await assert.rejects(recovered.backend.invokeAction("set_network", {
    deviceId: "one", profile: "wifi",
  }));
  recovered.allowHardware();
  assert.equal((await recovered.backend.invokeAction("set_network", {
    deviceId: "one", profile: "wifi",
  })).networkIsIndicatorOnly, true);
  assert.equal(recovered.wire.filter(({ method }) => method === "POST").length, 1);
  const mismatch = featureFixture({ allowNativeFidelity: true, indicatorMismatch: true });
  t.after(() => mismatch.backend.dispose());
  const profile = { deviceId: "one", profile: "wifi" };
  await assert.rejects(mismatch.backend.invokeAction("set_network", profile), { code: "invalid_feature_response" });
  await assert.rejects(mismatch.backend.invokeAction("set_network", profile), { code: "invalid_feature_response" });
  assert.equal(mismatch.wire.filter(({ method }) => method === "POST").length, 1);
});

test("accepted feature work is single-flight and changed-incarnation retry never rebinds", async (t) => {
  const gate = deferred();
  const featureState = new Map();
  const first = featureFixture({ featureState, smsGate: gate });
  t.after(() => first.backend.dispose());
  const input = { deviceId: "one", from: "+123", body: "hello" };
  const pending = first.backend.invokeAction("send_sms", input);
  const concurrent = first.backend.invokeAction("send_sms", input);
  first.releaseSms();
  await Promise.all([pending, concurrent]);
  assert.equal(first.wire.filter(({ method }) => method === "POST").length, 1);
  const captured = featureFixture({ featureState, smsGate: deferred() });
  t.after(() => captured.backend.dispose());
  const unfinished = captured.backend.invokeAction("send_sms", input);
  await new Promise((resolve) => setImmediate(resolve));
  const changed = featureFixture({ featureState, connectionRef: { ...captured.backend.connectionRef, pid: 99999 } });
  t.after(() => changed.backend.dispose());
  await assert.rejects(changed.backend.invokeAction("send_sms", input), { code: "runtime_incarnation_changed" });
  assert.equal(changed.wire.length, 0);
  captured.releaseSms();
  await unfinished;
});

test("feature acceptance Location survives a truncated 202 while unknown submission cannot replay", async (t) => {
  const input = { deviceId: "one", from: "+123", body: "hello" };
  const accepted = featureFixture({ submitFailure: "accepted" });
  t.after(() => accepted.backend.dispose());
  assert.equal((await accepted.backend.invokeAction("send_sms", input)).operation, "sms-send");
  assert.equal(accepted.wire.filter(({ method }) => method === "POST").length, 1);
  const unknown = featureFixture({ submitFailure: "unknown" });
  t.after(() => unknown.backend.dispose());
  await assert.rejects(unknown.backend.invokeAction("send_sms", input));
  await assert.rejects(unknown.backend.invokeAction("send_sms", input), { code: "feature_outcome_uncertain" });
  assert.equal(unknown.wire.filter(({ method }) => method === "POST").length, 1);
});

test("feature results require original provider and resolved native package cannot dispatch after view retirement", async (t) => {
  const wrong = featureFixture({ wrongOwner: true });
  t.after(() => wrong.backend.dispose());
  await assert.rejects(wrong.backend.deviceFeature("hardware_get", "one"), { code: "invalid_feature_response" });
  const malformed = featureFixture({ nullOwner: true });
  t.after(() => malformed.backend.dispose());
  await assert.rejects(malformed.backend.deviceFeature("hardware_get", "one"), { code: "invalid_feature_response" });
  const appGate = deferred();
  const state = featureFixture({ appGate });
  t.after(() => state.backend.dispose());
  const pending = state.backend.invokeAction("push_notification", {
    deviceId: "one", bundleId: "com.example.native", payload: '{"aps":{}}',
  });

  test("target-only canonical response context is checked against the original provider inventory", async (t) => {
    const gate = deferred();
    const state = featureFixture({ hardwareGate: gate });
    t.after(() => state.backend.dispose());
    const pending = state.backend.deviceFeature("hardware_get", "one");
    for (let tries = 0; tries < 100 && state.wire.length === 0; tries += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(state.wire[0]?.path.endsWith("/hardware"), true);
    state.targets.get("one").providerId = "different-provider";
    state.releaseHardware();
    await assert.rejects(pending, { code: "operation_owner_mismatch" });
  });
  for (let tries = 0; tries < 100
    && !state.wire.some(({ path }) => path.endsWith("/apps?includeSystem=true")); tries += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(state.wire.some(({ path }) => path.endsWith("/apps?includeSystem=true")), true);
  state.retireContext();
  state.releaseApps();
  await assert.rejects(pending, { code: "view_closed" });
  assert.equal(state.wire.filter(({ method }) => method === "POST").length, 0);
});

test("cancelled API and MCP callers cannot submit a feature after native app lookup", async (t) => {
  const input = { deviceId: "one", bundleId: "com.example.native", payload: '{"aps":{}}' };
  for (const host of ["api", "mcp"]) {
    const state = featureFixture({ appGate: deferred() });
    t.after(() => state.backend.dispose());
    const caller = new AbortController();
    const dispatcher = host === "mcp" ? await createAilohaMcpDispatcher({
      version: "synthetic", binding: {
        contextRef: "ctx", scopeEpoch: "epoch", ownerProcessId: 1234,
        scope: { sessionId: "unique-session", viewId: "unique-view" },
      },
      createBackend: async () => state.backend,
    }) : null;
    if (dispatcher) t.after(() => dispatcher.dispose());
    const pending = host === "api"
      ? state.backend.request("/api/v1/devices/one/notifications", {
        method: "POST", body: JSON.stringify(input), signal: caller.signal,
      })
      : dispatcher.handle({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "mobile_device_notification_push", arguments: input },
      }, { signal: caller.signal });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline
      && !state.wire.some(({ path }) => path.endsWith("/apps?includeSystem=true"))) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(state.wire.some(({ path }) => path.endsWith("/apps?includeSystem=true")), true);
    caller.abort();
    state.releaseApps();
    const result = await pending;
    assert.equal(host === "api" ? (await result.json()).code
      : JSON.parse(result.result.content[0].text).code, "cancelled");
    assert.equal(state.wire.filter(({ method }) => method === "POST").length, 0);
  }
});

test("caller cancellation after feature submission does not abandon its captured receipt", async (t) => {
  const state = featureFixture({ smsGate: deferred() });
  t.after(() => state.backend.dispose());
  const caller = new AbortController();
  const input = { deviceId: "one", from: "+123", body: "hello" };
  const pending = state.backend.invokeAction("send_sms", input, { signal: caller.signal });
  for (let tries = 0; tries < 100 && !state.wire.some(({ method }) => method === "POST"); tries += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(state.wire.filter(({ method }) => method === "POST").length, 1);
  const recovery = state.backend.invokeAction("send_sms", input);
  const cancelled = assert.rejects(pending, { code: "cancelled" });
  caller.abort();
  state.releaseSms();
  await cancelled;
  assert.equal((await recovery).operation, "sms-send");
  assert.equal(state.wire.filter(({ method }) => method === "POST").length, 1);
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
  assert.equal((await unsupported.json()).code, "ui_contract_unavailable");
});

test("System UI identities fail explicitly without a canonical lossless tree or selector", async (t) => {
  const state = fixture();
  t.after(() => state.backend.dispose());
  for (const [action, path] of [
    ["ui_dump", "/api/v1/devices/one/ui"],
    ["ui_find", "/api/v1/devices/one/ui/find"],
    ["ui_tap", "/api/v1/devices/one/ui/tap"],
  ]) {
    await assert.rejects(state.backend.invokeAction(action, { deviceId: "one" }), { code: "ui_contract_unavailable", status: 501 });
    const response = await state.backend.request(path, { method: path.endsWith("/ui") ? "GET" : "POST", body: "{}" });
    assert.equal(response.status, 501);
    assert.equal((await response.json()).code, "ui_contract_unavailable");
  }
  const raw = await state.backend.request("/api/v1/devices/one/ui?raw=true");
  assert.equal(raw.status, 501);
  assert.equal((await raw.json()).code, "ui_contract_unavailable");
  assert.equal(state.calls.some(([kind]) => kind === "tap"), false);
});

function systemUiFixture(respond, options = {}) {
  let state;
  const systemUi = createAilohaSystemUiAdapter({
    signal: new AbortController().signal,
    transport: {
      async response(path, request) {
        state.calls.push(["system-ui", path, request]);
        return respond(path, request, state);
      },
    },
  });
  state = fixture({ ...options, systemUi });
  return state;
}

function systemUiResponse(kind, overrides = {}) {
  const targetHost = { targetId: "one", providerId: "provider", surfaceId: "surface/opaque", geometryRevision: 7 };
  const element = { role: "button", rawRole: "AXButton", label: "Save", value: null, identifier: "save",
    hint: "Stores changes", frame: { x: 10, y: 20, width: 40, height: 20 },
    enabled: true, focused: false, interactable: true, children: [] };
  const base = { targetId: "one", targetHost, uiRevision: "ui-r1" };
  const body = kind === "snapshot"
    ? { ...base, platform: "ios", root: { ...element, frame: null, children: [element] }, elementCount: 2 }
    : kind === "find"
      ? { ...base, matches: [{ element, path: "0", centerX: 30, centerY: 30 }], total: 2 }
      : { ...base, match: { element, path: "0", centerX: 30, centerY: 30 }, total: 2 };
  return { status: 200, contentType: "application/json", body: { ...body, ...overrides } };
}

test("shared source-approved System UI projects exact legacy shapes through actions and actual compatibility HTTP", async (t) => {
  const state = systemUiFixture((path) => systemUiResponse(
    path.includes("system-snapshot") ? "snapshot" : path.includes("/actions/tap") ? "tap" : "find",
    path.includes("includeRaw=true") ? { raw: "raw" } : {}));
  t.after(() => state.backend.dispose());
  const dump = await state.backend.invokeAction("ui_dump", { deviceId: "one", includeRaw: true });
  assert.deepEqual(Object.keys(dump), ["schemaVersion", "deviceId", "platform", "root", "elementCount", "raw"]);
  assert.equal(dump.root.frame, null);
  assert.deepEqual(dump.root.children[0].frame, {
    x: 10, y: 20, width: 40, height: 20, centerX: 30, centerY: 30,
  });
  assert.equal(dump.raw, "raw");
  const found = await state.backend.invokeAction("ui_find", { deviceId: "one", text: "Save", limit: 1 });
  assert.deepEqual(Object.keys(found), ["schemaVersion", "deviceId", "matches", "total"]);
  assert.equal(found.total, 2);
  assert.equal(found.matches[0].path, "0");
  assert.equal(found.matches[0].element.frame.centerY, 30);
  const tapped = await state.backend.invokeAction("ui_tap", { deviceId: "one", role: "AXButton" });
  assert.deepEqual(Object.keys(tapped), ["schemaVersion", "success", "deviceId", "match", "total"]);
  assert.equal(tapped.match.centerX, 30);
  assert.equal(tapped.match.element.frame.centerX, 30);
  const raw = await state.backend.request("/api/v1/devices/one/ui?raw=true");
  assert.equal((await raw.json()).raw, "raw");
  const find = await state.backend.request("/api/v1/devices/one/ui/find", {
    method: "POST", body: JSON.stringify({ text: "Save", limit: 1 }),
  });
  assert.equal((await find.json()).total, 2);
  assert.equal(state.calls.filter(([kind]) => kind === "system-ui").length, 6);
  assert.equal(state.calls.some(([kind]) => kind === "tap"), false);
  const nativeTap = state.calls.find(([kind, path]) => kind === "system-ui" && path.includes("/actions/tap"));
  assert.equal(JSON.parse(nativeTap[2].body).interactableOnly, false);
  assert.equal(JSON.parse(nativeTap[2].body).uiRevision, "ui-r1");
});

test("native System UI tap never posts after a changed context, geometry or process owner", async (t) => {
  const waiting = deferred();
  const state = systemUiFixture(async (path) => {
    if (path.includes("system-snapshot")) await waiting.promise;
    return systemUiResponse(path.includes("system-snapshot") ? "snapshot" : "tap");
  });
  t.after(() => state.backend.dispose());
  const pending = state.backend.uiTap("one", { text: "Save" });
  while (!state.calls.some(([kind]) => kind === "system-ui")) await new Promise((resolve) => setImmediate(resolve));
  state.selectHost("other");
  waiting.resolve();
  await assert.rejects(pending, { code: "selection_superseded" });
  assert.equal(state.calls.filter(([kind, path]) => kind === "system-ui" && path.includes("/actions/tap")).length, 0);
  const geometry = systemUiFixture((path) => {
    if (path.includes("system-snapshot")) geometry.geometryChanged();
    return systemUiResponse(path.includes("system-snapshot") ? "snapshot" : "tap");
  });
  t.after(() => geometry.backend.dispose());
  await assert.rejects(geometry.backend.uiTap("one", { text: "Save" }), { code: "system_ui_owner_changed" });
  assert.equal(geometry.calls.filter(([kind, path]) => kind === "system-ui" && path.includes("/actions/tap")).length, 0);
  const native = systemUiFixture((path, _request, state) => {
    if (path.includes("system-snapshot")) {
      state.targets.get("one").nativeIdentity = {
        ...state.targets.get("one").nativeIdentity, nativeId: "replacement-native",
      };
    }
    return systemUiResponse(path.includes("system-snapshot") ? "snapshot" : "tap");
  });
  t.after(() => native.backend.dispose());
  await assert.rejects(native.backend.uiTap("one", { text: "Save" }), { code: "system_ui_owner_changed" });
  assert.equal(native.calls.filter(([kind, path]) => kind === "system-ui" && path.includes("/actions/tap")).length, 0);
});

test("cancelled System UI caller cannot submit a tap after the captured snapshot", async (t) => {
  for (const channel of ["action", "http"]) {
    const controller = new AbortController();
    const state = systemUiFixture((path) => {
      if (path.includes("system-snapshot")) controller.abort();
      return systemUiResponse(path.includes("system-snapshot") ? "snapshot" : "tap");
    });
    t.after(() => state.backend.dispose());
    if (channel === "action") {
      await assert.rejects(
        state.backend.invokeAction("ui_tap", { deviceId: "one", text: "Save" }, { signal: controller.signal }),
        { code: "cancelled" },
      );
    } else {
      const response = await state.backend.request("/api/v1/devices/one/ui/tap", {
        method: "POST", body: '{"text":"Save"}', signal: controller.signal,
      });
      assert.equal((await response.json()).code, "cancelled");
    }
    assert.equal(state.calls.filter(([kind, path]) =>
      kind === "system-ui" && path.includes("/actions/tap")).length, 0);
  }
});

test("App UI or absent System UI capability never enables native System compatibility", async (t) => {
  const state = systemUiFixture(() => { throw new Error("System UI transport must not be used"); }, {
    client: { async getTargetCapabilities() {
      return [{ id: "surface.ui", version: 1, features: ["getTargetUiTree", "queryTargetElements", "tapTargetElement"] }];
    } },
  });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.uiDump("one"), { code: "capability_not_supported" });
  await assert.rejects(state.backend.uiFind("one", { text: "Save" }), { code: "capability_not_supported" });
  await assert.rejects(state.backend.uiTap("one", { text: "Save" }), { code: "capability_not_supported" });
  assert.equal(state.calls.some(([kind]) => kind === "system-ui"), false);
});

test("large legacy find limit is forwarded without truncation while caller-int32 overflow fails before native reads", async (t) => {
  const state = systemUiFixture((path) => path.includes("system-elements")
    ? systemUiResponse("find", {
      matches: Array.from({ length: 300 }, (_, index) => ({
        element: systemUiResponse("find").body.matches[0].element,
        path: `1/${index}`, centerX: 30, centerY: 30,
      })),
      total: 321,
    })
    : systemUiResponse("snapshot"));
  t.after(() => state.backend.dispose());
  const found = await state.backend.uiFind("one", { text: "Save", limit: 300 });
  assert.equal(found.total, 321);
  assert.equal(found.matches.length, 300);
  assert.equal(found.matches.at(-1).path, "1/299");
  assert.equal(state.calls.filter(([kind, path]) => kind === "system-ui"
    && path.includes("system-elements") && path.includes("limit=300")).length, 1);
  await assert.rejects(state.backend.uiFind("one", { text: "Save", limit: 2147483648 }),
    { code: "invalid_request" });
  assert.equal(state.calls.filter(([kind]) => kind === "system-ui").length, 1);
});

test("unknown native tap retains a single original receipt, definitive 403 releases, HTTP 408 never replays", async (t) => {
  for (const status of [403, 408, 502]) {
    const state = systemUiFixture((path) => {
      if (!path.includes("/actions/tap")) return systemUiResponse("snapshot");
      if (status < 500) {
        const error = new Error("typed native rejection");
        error.name = "TargetHostTransportError";
        error.code = "HttpError";
        error.status = status;
        error.response = { status };
        throw error;
      }
      return { status, contentType: "application/json", body: { error: "rejected" } };
    });
    t.after(() => state.backend.dispose());
    await assert.rejects(state.backend.uiTap("one", { text: "Save" }));
    const original = state.calls.filter(([kind, path]) => kind === "system-ui" && path.includes("/actions/tap")).length;
    assert.equal(original, 1);
    if (status !== 403) {
      await assert.rejects(state.backend.uiTap("one", { text: "Save" }), { code: "ui_tap_outcome_uncertain" });
      assert.equal(state.calls.filter(([kind, path]) => kind === "system-ui" && path.includes("/actions/tap")).length, 1);
    } else {
      await assert.rejects(state.backend.uiTap("one", { text: "Save" }));
      assert.equal(state.calls.filter(([kind, path]) => kind === "system-ui" && path.includes("/actions/tap")).length, 2);
    }
  }
});

test("typed 403 carrying accepted operation evidence cannot evict a native tap receipt", async (t) => {
  const error = Object.assign(new Error("accepted native tap"), {
    name: "TargetHostTransportError", code: "HttpError", status: 403,
    response: { status: 403 }, operationId: "accepted-tap",
  });
  const state = systemUiFixture((path) => {
    if (path.includes("/actions/tap")) throw error;
    return systemUiResponse("snapshot");
  });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.uiTap("one", { text: "Save" }), (actual) => actual === error);
  await assert.rejects(state.backend.uiTap("one", { text: "Save" }), { code: "ui_tap_outcome_uncertain" });
  assert.equal(state.calls.filter(([kind, path]) =>
    kind === "system-ui" && path.includes("/actions/tap")).length, 1);
});

test("completed native UI tap survives a failed authority read without another POST", async (t) => {
  const state = systemUiFixture((path) => {
    if (path.includes("/actions/tap")) {
      state.selectionStore.readSnapshot = async () => { throw new Error("authority read failed"); };
    }
    return systemUiResponse(path.includes("system-snapshot") ? "snapshot" : "tap");
  });
  t.after(() => state.backend.dispose());
  const originalRead = state.selectionStore.readSnapshot.bind(state.selectionStore);
  await assert.rejects(state.backend.uiTap("one", { text: "Save" }), /authority read failed/);
  assert.equal(state.calls.filter(([kind, path]) => kind === "system-ui" && path.includes("/actions/tap")).length, 1);
  state.selectionStore.readSnapshot = originalRead;
  const result = await state.backend.uiTap("one", { text: "Save" });
  assert.equal(result.success, true);
  assert.equal(state.calls.filter(([kind, path]) => kind === "system-ui" && path.includes("/actions/tap")).length, 1);
});

test("accepted native UI tap canceled during authority read retains its completed receipt", async (t) => {
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  let accepted = false;
  const state = systemUiFixture((path) => {
    if (path.includes("/actions/tap")) accepted = true;
    return systemUiResponse(path.includes("system-snapshot") ? "snapshot" : "tap");
  });
  t.after(() => { release.resolve(); return state.backend.dispose(); });
  const read = state.selectionStore.readSnapshot.bind(state.selectionStore);
  state.selectionStore.readSnapshot = async (...args) => {
    if (accepted) {
      accepted = false;
      entered.resolve();
      await release.promise;
    }
    return read(...args);
  };
  const pending = state.backend.uiTap("one", { text: "Save" }, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  release.resolve();
  await assert.rejects(pending, { code: "cancelled" });
  assert.equal((await state.backend.uiTap("one", { text: "Save" })).success, true);
  assert.equal(state.calls.filter(([kind, path]) =>
    kind === "system-ui" && path.includes("/actions/tap")).length, 1);
});

test("one cancelled native UI tap caller cannot poison a peer sharing its completed receipt", async (t) => {
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  let accepted = false;
  let reads = 0;
  const state = systemUiFixture((path) => {
    if (path.includes("/actions/tap")) accepted = true;
    return systemUiResponse(path.includes("system-snapshot") ? "snapshot" : "tap");
  });
  t.after(() => { release.resolve(); return state.backend.dispose(); });
  const read = state.selectionStore.readSnapshot.bind(state.selectionStore);
  state.selectionStore.readSnapshot = async (...args) => {
    if (accepted) {
      accepted = false;
      reads += 1;
      entered.resolve();
      await release.promise;
    }
    return read(...args);
  };
  const first = state.backend.uiTap("one", { text: "Save" }, { signal: controller.signal });
  await entered.promise;
  const peer = state.backend.uiTap("one", { text: "Save" });
  controller.abort();
  await assert.rejects(first, { code: "cancelled" });
  assert.equal(reads, 1);
  release.resolve();
  assert.equal((await peer).success, true);
  assert.equal(state.calls.filter(([kind, path]) =>
    kind === "system-ui" && path.includes("/actions/tap")).length, 1);
});

test("unknown native UI tap cannot move to a new process incarnation with the same host ID", async (t) => {
  const stateByIntent = new Map();
  const first = systemUiFixture((path) => path.includes("/actions/tap")
    ? { status: 408, contentType: "application/json", body: {} }
    : systemUiResponse("snapshot"), { systemUiState: stateByIntent });
  t.after(() => first.backend.dispose());
  await assert.rejects(first.backend.uiTap("one", { text: "Save" }));
  const second = systemUiFixture(() => { throw new Error("replacement transport must not be used"); }, {
    systemUiState: stateByIntent,
    connectionRef: { ...first.owner.connectionRef, processStartedAt: "2026-10-10T01:00:00Z" },
  });
  t.after(() => second.backend.dispose());
  await assert.rejects(second.backend.uiTap("one", { text: "Save" }), { code: "runtime_incarnation_changed" });
  assert.equal(second.calls.filter(([kind]) => kind === "system-ui").length, 0);
});

test("reveal projects the native target only when the selected provider advertises it", async (t) => {
  const state = fixture({ reveal: {
    async reveal(invocation) {
      state.calls.push(["reveal", invocation]);
      return state.targets.get(invocation.targetId);
    },
  } });
  t.after(() => state.backend.dispose());
  assert.equal((await state.backend.getDevice("one")).capabilities.reveal, true);
  const result = await state.backend.reveal("one");
  assert.equal(result.id, "one");
  assert.equal(result.nativeId, "real-native-one");
  assert.equal((await state.backend.getSelected()).hasSelection, false);
  assert.equal(state.calls.find(([kind]) => kind === "reveal")[1].connectionRef, state.backend.connectionRef);
  assert.equal(JSON.stringify(result).includes("connectionRef"), false);
  const response = await state.backend.request("/api/v1/devices/one/reveal", { method: "POST", body: "{}" });
  assert.equal(response.status, 200);
  assert.equal((await state.backend.getSelected()).device.id, "one");
  assert.equal((await response.json()).capabilities.reveal, true);
});

test("reveal requires a running capable provider and never invokes a native action otherwise", async (t) => {
  const state = fixture({ reveal: { async reveal() { throw new Error("unexpected POST"); } } });
  t.after(() => state.backend.dispose());
  state.targets.get("one").status = "stopped";
  await assert.rejects(state.backend.reveal("one"), { code: "capability_not_supported" });
  state.targets.get("one").status = "running";
  state.providers[0].state = "unavailable";
  await assert.rejects(state.backend.reveal("one"), { code: "capability_not_supported" });
  assert.equal(state.calls.some(([kind]) => kind === "reveal"), false);
  const missing = fixture();
  t.after(() => missing.backend.dispose());
  assert.equal((await missing.backend.getDevice("one")).capabilities.reveal, false);
  await assert.rejects(missing.backend.reveal("one"), { code: "capability_not_supported" });
});

test("reveal rejects stale context before POST and retains uncertain mutation under its original owner", async (t) => {
  const entered = deferred();
  const release = deferred();
  const state = canonicalFixture({ reveal: {
    async reveal(invocation) {
      state.calls.push(["reveal", invocation]);
      entered.resolve();
      await release.promise;
      throw new Error("transport outcome unknown");
    },
  } });
  t.after(() => state.backend.dispose());
  const pending = state.backend.reveal("one");
  const failed = assert.rejects(pending, /transport outcome unknown/);
  await entered.promise;
  await state.retireAuthority();
  await state.reopenAuthority();
  release.resolve();
  await failed;
  await assert.rejects(state.backend.reveal("one"), { code: "reveal_outcome_uncertain" });
  assert.equal(state.calls.filter(([kind]) => kind === "reveal").length, 1);
  assert.equal(state.calls.find(([kind]) => kind === "reveal")[1].executionContext.scopeEpoch, "original-epoch");
  assert.equal(state.calls.find(([kind]) => kind === "reveal")[1].connectionRef, state.backend.connectionRef);
});

test("completed reveal survives a failed authority read without another POST", async (t) => {
  const revealState = new Map();
  const state = fixture({ revealState, reveal: {
    async reveal(invocation) {
      state.calls.push(["reveal", invocation]);
      rejectNextRead = true;
      return state.targets.get(invocation.targetId);
    },
  } });
  t.after(() => state.backend.dispose());
  Object.defineProperty(state.selectionStore, "contextProjection", {
    value: { contextRef: "ctx-reveal", scopeEpoch: "original-epoch", revision: "7", ownerProcessId: 1234 },
  });
  const read = state.selectionStore.readSnapshot.bind(state.selectionStore);
  let rejectNextRead = false;
  state.selectionStore.readSnapshot = async () => {
    if (rejectNextRead) {
      rejectNextRead = false;
      throw new Error("authority read temporarily unavailable");
    }
    return read();
  };
  await assert.rejects(state.backend.reveal("one", { selectRevealed: true }), /authority read temporarily unavailable/);
  const receipt = [...revealState.values()][0];
  assert.equal(receipt.completed.targetId, "one");
  assert.equal(receipt.invocation.executionContext.scopeEpoch, "original-epoch");
  assert.equal(receipt.invocation.connectionRef, state.backend.connectionRef);
  const result = await state.backend.reveal("one", { selectRevealed: true });
  assert.equal(result.id, "one");
  assert.equal((await state.backend.getSelected()).device.id, "one");
  assert.equal(state.calls.filter(([kind]) => kind === "reveal").length, 1);
});

test("cancelled reveal caller cannot select an accepted completion; explicit recovery does not POST again", async (t) => {
  const controller = new AbortController();
  const state = fixture({ reveal: {
    async reveal(invocation) {
      state.calls.push(["reveal", invocation]);
      controller.abort();
      return state.targets.get(invocation.targetId);
    },
  } });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.reveal("one", {
    selectRevealed: true, signal: controller.signal,
  }), { code: "cancelled" });
  assert.equal((await state.backend.getSelected()).hasSelection, false);
  const result = await state.backend.reveal("one", { selectRevealed: true });
  assert.equal(result.id, "one");
  assert.equal((await state.backend.getSelected()).device.id, "one");
  assert.equal(state.calls.filter(([kind]) => kind === "reveal").length, 1);
});

test("reveal canceled during authority read retains completion without selecting or resubmitting", async (t) => {
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  let accepted = false;
  const state = fixture({ reveal: {
    async reveal(invocation) {
      state.calls.push(["reveal", invocation]);
      accepted = true;
      return state.targets.get(invocation.targetId);
    },
  } });
  t.after(() => { release.resolve(); return state.backend.dispose(); });
  const read = state.selectionStore.readSnapshot.bind(state.selectionStore);
  state.selectionStore.readSnapshot = async (...args) => {
    if (accepted) {
      accepted = false;
      entered.resolve();
      await release.promise;
    }
    return read(...args);
  };
  const pending = state.backend.reveal("one", { selectRevealed: true, signal: controller.signal });
  await entered.promise;
  controller.abort();
  release.resolve();
  await assert.rejects(pending, { code: "cancelled" });
  assert.equal((await state.backend.getSelected()).hasSelection, false);
  assert.equal((await state.backend.reveal("one", { selectRevealed: true })).id, "one");
  assert.equal((await state.backend.getSelected()).device.id, "one");
  assert.equal(state.calls.filter(([kind]) => kind === "reveal").length, 1);
});

test("one cancelled reveal caller cannot prevent a live peer from confirming the same native result", async (t) => {
  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  let accepted = false;
  const state = fixture({ reveal: {
    async reveal(invocation) {
      state.calls.push(["reveal", invocation]);
      accepted = true;
      return state.targets.get(invocation.targetId);
    },
  } });
  t.after(() => { release.resolve(); return state.backend.dispose(); });
  const read = state.selectionStore.readSnapshot.bind(state.selectionStore);
  state.selectionStore.readSnapshot = async (...args) => {
    if (accepted) {
      accepted = false;
      entered.resolve();
      await release.promise;
    }
    return read(...args);
  };
  const first = state.backend.reveal("one", { selectRevealed: true, signal: controller.signal });
  await entered.promise;
  const peer = state.backend.reveal("one", { selectRevealed: true });
  controller.abort();
  await assert.rejects(first, { code: "cancelled" });
  release.resolve();
  assert.equal((await peer).id, "one");
  assert.equal((await state.backend.getSelected()).device.id, "one");
  assert.equal(state.calls.filter(([kind]) => kind === "reveal").length, 1);
});

test("a definitive reveal rejection does not become permanent unknown acceptance", async (t) => {
  const revealState = new Map();
  let posts = 0;
  const state = fixture({ revealState, reveal: {
    async reveal(invocation) {
      posts += 1;
      if (posts === 1) throw new AilohaProtocolError("http_error", { status: 403 });
      return state.targets.get(invocation.targetId);
    },
  } });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.reveal("one"), { code: "http_error", status: 403 });
  assert.equal(revealState.size, 0);
  assert.equal((await state.backend.reveal("one")).id, "one");
  assert.equal(posts, 2);
});

test("typed reveal refusal with accepted operation evidence keeps the original receipt", async (t) => {
  const error = Object.assign(new Error("accepted reveal with refusal metadata"), {
    name: "TargetHostTransportError", status: 403, code: "HttpError",
    response: { status: 403 }, operationId: "accepted-reveal",
  });
  let posts = 0;
  const state = fixture({ reveal: createAilohaRevealAdapter({ transport: {
    async response() { posts += 1; throw error; },
  } }) });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.reveal("one"), (actual) => actual === error);
  await assert.rejects(state.backend.reveal("one"), { code: "reveal_outcome_uncertain" });
  assert.equal(posts, 1);
});

test("timeout with HTTP metadata never clears an uncertain reveal receipt", async (t) => {
  const revealState = new Map();
  let posts = 0;
  const state = fixture({ revealState, reveal: {
    async reveal() {
      posts += 1;
      throw new AilohaProtocolError("timeout", { status: 403 });
    },
  } });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.reveal("one"), { code: "timeout" });
  await assert.rejects(state.backend.reveal("one"), { code: "reveal_outcome_uncertain" });
  assert.equal(posts, 1);
  assert.equal(revealState.size, 1);
});

test("server HTTP 408 with response metadata never authorizes a second reveal POST", async (t) => {
  const revealState = new Map();
  let posts = 0;
  const reveal = createAilohaRevealAdapter({ transport: {
    async response() {
      posts += 1;
      const error = new Error("server timed out after receiving the POST");
      Object.assign(error, {
        name: "TargetHostTransportError", status: 408, code: "HttpError",
        response: { status: 408, contentType: "application/problem+json" },
      });
      throw error;
    },
  } });
  const state = fixture({ revealState, reveal });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.reveal("one"), { code: "http_error", status: 408 });
  await assert.rejects(state.backend.reveal("one"), { code: "reveal_outcome_uncertain" });
  assert.equal(posts, 1);
  assert.equal(revealState.size, 1);
});

test("a completed reveal cannot be confirmed from a replacement process incarnation", async (t) => {
  const revealState = new Map();
  const first = fixture({ revealState, reveal: {
    async reveal(invocation) {
      failRead = true;
      return first.targets.get(invocation.targetId);
    },
  } });
  t.after(() => first.backend.dispose());
  let failRead = false;
  const read = first.selectionStore.readSnapshot.bind(first.selectionStore);
  first.selectionStore.readSnapshot = async () => {
    if (failRead) { failRead = false; throw new Error("read unavailable"); }
    return read();
  };
  await assert.rejects(first.backend.reveal("one"), /read unavailable/);
  assert.equal(revealState.size, 1);
  const second = fixture({ revealState, connectionRef: { ...first.backend.connectionRef, pid: 99 },
    reveal: { async reveal() { throw new Error("unexpected POST"); } } });
  t.after(() => second.backend.dispose());
  await assert.rejects(second.backend.reveal("one"), { code: "runtime_incarnation_changed" });
  assert.equal(revealState.size, 1);
});

test("a late completed reveal cannot evict a newer same-key receipt", async (t) => {
  const revealState = new Map();
  const enteredRead = deferred();
  const releaseRead = deferred();
  const state = fixture({ revealState, reveal: {
    async reveal(invocation) {
      blockConfirmation = true;
      return state.targets.get(invocation.targetId);
    },
  } });
  t.after(() => state.backend.dispose());
  const read = state.selectionStore.readSnapshot.bind(state.selectionStore);
  let blockConfirmation = false;
  state.selectionStore.readSnapshot = async () => {
    if (blockConfirmation) {
      enteredRead.resolve();
      await releaseRead.promise;
      blockConfirmation = false;
    }
    return read();
  };
  const original = state.backend.reveal("one");
  await enteredRead.promise;
  const [key, receipt] = [...revealState][0];
  const replacement = { invocation: receipt.invocation, completed: null };
  revealState.set(key, replacement);
  releaseRead.resolve();
  await original;
  assert.equal(revealState.get(key), replacement);
});

for (const [field, replacement] of [
  ["serviceId", "another-service"], ["pid", 9876],
  ["startedAt", "2026-10-09T23:01:00Z"], ["processStartedAt", "2026-10-09T23:01:00Z"],
]) {
  test(`reveal refuses a changed ${field} even for the same persistent host ID`, async (t) => {
    const retained = new Map();
    const one = fixture({ revealState: retained, reveal: { async reveal() { throw new Error("unknown"); } } });
    t.after(() => one.backend.dispose());
    await assert.rejects(one.backend.reveal("one"), /unknown/);
    const two = fixture({ revealState: retained, connectionRef: {
      ...one.backend.connectionRef, [field]: replacement,
    }, reveal: { async reveal() { throw new Error("must not submit"); } } });
    t.after(() => two.backend.dispose());
    await assert.rejects(two.backend.reveal("one"), { code: "runtime_incarnation_changed" });
  });
}

test("concurrent reveal requests dispatch once and never borrow a later selection", async (t) => {
  const entered = deferred();
  const release = deferred();
  const state = canonicalFixture({ reveal: {
    async reveal(invocation) {
      state.calls.push(["reveal", invocation]);
      entered.resolve();
      await release.promise;
      return state.targets.get(invocation.targetId);
    },
  } });
  t.after(() => state.backend.dispose());
  const first = state.backend.reveal("one", { selectRevealed: true });
  await entered.promise;
  await assert.rejects(state.backend.reveal("one"), { code: "reveal_outcome_uncertain" });
  await state.advanceSelection();
  release.resolve();
  await assert.rejects(first, { code: "context_snapshot_superseded" });
  assert.equal((await state.backend.getSelected()).device.id, "two");
  assert.equal(state.calls.filter(([kind]) => kind === "reveal").length, 1);
  await assert.rejects(state.backend.reveal("one"), { code: "context_snapshot_superseded" });
});

test("reveal refuses authority changes during inventory before native dispatch", async (t) => {
  const state = canonicalFixture({ reveal: { async reveal() { throw new Error("unexpected POST"); } } });
  t.after(() => state.backend.dispose());
  const entered = deferred();
  const release = deferred();
  const get = state.client.getTarget;
  state.client.getTarget = async (...args) => {
    entered.resolve();
    await release.promise;
    return get(...args);
  };
  const pending = state.backend.reveal("one");
  const rejected = assert.rejects(pending, { code: "context_snapshot_superseded" });
  await entered.promise;
  await state.advanceSelection();
  release.resolve();
  await rejected;
  assert.equal(state.calls.some(([kind]) => kind === "reveal"), false);
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
  const state = canonicalFixture({ confirmDestructive: (context) => { captured = context; return consent.promise; } });
  t.after(() => state.backend.dispose());
  const resetting = state.backend.lifecycle("erase", "one", { confirm: true });
  const rejected = assert.rejects(resetting, { code: "context_snapshot_superseded" });
  await new Promise((resolve) => setImmediate(resolve));
  await state.backend.select("two");
  assert.equal(captured.invocation.targetId, "one");
  assert.equal(captured.invocation.executionContext.revision, "1");
  assert.equal(captured.invocation.connectionRef, state.backend.connectionRef);
  assert.equal(Object.isFrozen(captured.invocation), true);
  assert.equal(JSON.stringify(captured).includes("contextOwner"), false);
  assert.equal(captured.invocation.contextOwner.processStartedAt, "2026-10-10T00:00:00Z");
  assert.equal(JSON.stringify(captured).includes("connectionRef"), false);
  assert.equal(JSON.stringify(captured).includes(state.backend.connectionRef.serviceId), false);
  assert.equal(JSON.stringify(captured).includes(state.backend.connectionRef.processStartedAt), false);
  consent.resolve(false);
  await rejected;
  assert.equal(state.calls.some(([kind]) => kind === "reset"), false);
});

test("known revision replacement during post-approval target revalidation cancels before any DELETE", async (t) => {
  const state = canonicalFixture({ confirmDestructive: async () => true });
  t.after(() => state.backend.dispose());
  const entered = deferred();
  const release = deferred();
  const getTarget = state.client.getTarget;
  let reads = 0;
  state.client.getTarget = async (id) => {
    if (++reads === 2) { entered.resolve(); await release.promise; }
    return getTarget(id);
  };
  const pending = state.backend.lifecycle("delete", "one", { confirm: true });
  const rejected = assert.rejects(pending, { code: "context_snapshot_superseded" });
  await entered.promise;
  await state.advanceSelection();
  await rejected;
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.calls.some(([kind]) => kind === "delete"), false);
});

for (const cancellation of ["caller", "owner", "deadline"]) {
  test(`captured ${cancellation} cancellation after consume prevents a queued destructive POST and retains its uncertain owner`, async (t) => {
    if (cancellation === "deadline") t.mock.timers.enable({ apis: ["setTimeout"] });
    const caller = new AbortController();
    const queued = deferred();
    const entered = deferred();
    const operationState = new Map();
    let prompts = 0;
    let wirePosts = 0;
    const state = canonicalFixture({
      operationState,
      confirmDestructive: async () => { prompts += 1; return true; },
      client: {
        async resetTarget(id, options) {
          entered.resolve(options);
          await queued.promise;
          if (options.signal.aborted) throw new AilohaProtocolError("cancelled");
          wirePosts += 1;
          return { operationId: `reset-${id}` };
        },
      },
    });
    t.after(() => state.backend.dispose());
    const work = state.backend.lifecycle("erase", "one", { confirm: true }, { signal: caller.signal });
    const rejected = assert.rejects(work, { code: {
      caller: "consent_cancelled", owner: "view_closed", deadline: "submission_outcome_unknown",
    }[cancellation] });
    const options = await entered.promise;
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 15_000);
    if (cancellation === "caller") caller.abort();
    else if (cancellation === "owner") await state.backend.dispose();
    else t.mock.timers.tick(60_000);
    assert.equal(options.signal.aborted, true);
    queued.resolve();
    await rejected;
    assert.equal(wirePosts, 0);
    assert.equal(prompts, 1);
    const receipt = [...operationState.values()][0];
    assert.equal(receipt.invocation.targetId, "one");
    assert.equal(receipt.invocation.executionContext.revision, "1");
    assert.equal(receipt.uncertain, true);
    if (cancellation !== "owner") {
      await assert.rejects(state.backend.lifecycle("erase", "one", { confirm: true }), { code: "lifecycle_outcome_uncertain" });
      assert.equal(prompts, 1);
      assert.equal(wirePosts, 0);
    }
  });
}

test("a consumed approval with no whole millisecond remaining fails before client dispatch and does not create an uncertain receipt", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const operationState = new Map();
  let prompts = 0;
  const state = canonicalFixture({
    operationState,
    confirmDestructive: async () => { prompts += 1; clock = 59_999.5; return true; },
  });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.lifecycle("erase", "one", { confirm: true }), { code: "consent_timeout" });
  assert.equal(state.calls.some(([kind]) => kind === "reset"), false);
  assert.equal(operationState.size, 0);
  assert.equal(prompts, 1);
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

test("agentless controls use captured canonical view and explicit capability evidence across API/actions", async (t) => {
  const state = canonicalFixture({ client: {
    async getTargetCapabilities() {
      return [
        { id: "target.settings", version: 1, features: ["getTargetSettings", "updateTargetSettings"] },
        { id: "surface.input", version: 1, features: ["typeFocusedText"] },
      ];
    },
  }, controls: {
    supported() { return { key: true, button: true, text: true, rotate: true, presentation: true }; },
    async key(invocation, value) { state.calls.push(["key", invocation, value]); },
    async button(invocation, value) { state.calls.push(["button", invocation, value]); },
    async text(invocation, value, assertCurrent) {
      assertCurrent();
      state.calls.push(["text", invocation, value]);
    },
    async rotate(invocation, value) { state.calls.push(["rotate", invocation, value]); },
    async presentation(invocation, value) {
      state.calls.push(["presentation", invocation, value]);
      return { schemaVersion: "1.0", deviceId: invocation.targetId, platform: "ios",
        enabled: true, readable: true, overrides: [] };
    },
  } });
  t.after(() => state.backend.dispose());
  const device = await state.backend.getDevice("one");
  assert.equal(device.capabilities.text, true);
  assert.equal(device.capabilities.presentation, true);
  const key = await state.backend.invokeAction("press_key", { deviceId: "one", keyCode: 40 });
  assert.equal(key.operation, "press-key");
  assert.equal(state.calls.at(-1)[1].executionContext.revision, "1");
  const button = await state.backend.request("/api/v1/devices/one/input/button",
    { method: "POST", body: '{"button":"home"}' });
  assert.equal(button.status, 200);
  const text = await state.backend.request("/api/v1/devices/one/input/text",
    { method: "POST", body: '{"text":"literal \\\\u2603"}' });
  assert.equal(text.status, 200);
  assert.equal(state.calls.some(([kind]) => kind === "text"), true);
  const rotation = await state.backend.request("/api/v1/devices/one/input/rotate",
    { method: "POST", body: '{"orientation":"landscape-left"}' });
  assert.equal(rotation.status, 200);
  assert.deepEqual(state.calls.filter(([kind]) => kind === "rotate").map(([, , value]) => value), ["landscape-left"]);
  const presentation = await state.backend.request("/api/v1/devices/one/presentation",
    { method: "POST", body: '{"enabled":true,"time":"09:41"}' });
  assert.equal(presentation.status, 200);
  assert.deepEqual(state.calls.at(-1)[2], { enabled: true, time: "09:41" });
  const read = await state.backend.request("/api/v1/devices/one/presentation");
  assert.deepEqual(await read.json(), { schemaVersion: "1.0", deviceId: "one", platform: "ios",
    enabled: true, readable: true, overrides: [] });
  await state.advanceSelection();
  const later = await state.backend.invokeAction("press_button", { deviceId: "one", button: "home" });
  assert.equal(later.context.targetId, "one");
  assert.equal(state.calls.at(-1)[1].executionContext.revision, "2");
  assert.equal(state.calls.at(-1)[1].selectionGeneration, 0);
});

test("plain text cannot reach explicit fill when only the old capability is available", async (t) => {
  const state = canonicalFixture({ controls: {
    supported() { return { text: false }; },
    async fillElement() { state.calls.push(["fill"]); },
  } });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.input("text", "one", { text: "hello" }), { code: "capability_not_supported" });
  assert.equal(state.calls.some(([kind]) => kind === "fill"), false);
});

test("focused text pins input and rejects a superseded view before dispatch", async (t) => {
  for (const change of ["selection", "retirement"]) {
    const pending = deferred();
    const state = canonicalFixture({ controls: {
      supported() { return { text: true }; },
      async text(invocation, value, assertCurrent) {
        await pending.promise;
        assertCurrent();
        state.calls.push(["text", invocation, value]);
      },
    } });
    t.after(() => state.backend.dispose());
    const input = { text: "first" };
    const typing = state.backend.input("text", "one", input);
    input.text = "later";
    await new Promise((resolve) => setImmediate(resolve));
    if (change === "selection") await state.advanceSelection();
    else await state.retireAuthority();
    pending.resolve();
    await assert.rejects(typing, { code: change === "selection" ? "context_snapshot_superseded" : "view_closed" });
    assert.equal(state.calls.some(([kind]) => kind === "text"), false);
  }
});

test("input values remain immutable while the captured target is read", async (t) => {
  const gate = deferred();
  const input = { keyCode: 40 };
  const state = fixture({ client: {
    async getTarget(id) {
      await gate.promise;
      return state.targets.get(id);
    },
  }, controls: {
    supported() { return { key: true }; },
    async key(invocation, code) { state.calls.push(["key", invocation.targetId, code]); },
  } });
  t.after(() => state.backend.dispose());
  const sending = state.backend.input("key", "one", input);
  input.keyCode = 41;
  gate.resolve();
  await sending;
  assert.deepEqual(state.calls.filter(([kind]) => kind === "key"), [["key", "one", 40]]);
});

test("rotation invalidates prior geometry observations even when delivery is uncertain", async (t) => {
  const state = fixture({ controls: {
    supported() { return { rotate: true, tap: true }; },
    async rotate() { throw new Error("uncertain rotation"); },
  } });
  t.after(() => state.backend.dispose());
  await state.backend.display("one");
  await assert.rejects(state.backend.input("rotate", "one", { orientation: "landscape-left" }), /uncertain rotation/);
  await assert.rejects(state.backend.input("tap", "one", { x: 5, y: 50 }), { code: "stale_geometry" });
  assert.equal(state.calls.some(([kind]) => kind === "tap"), false);
});

for (const status of [408, 499]) {
  test(`video creation HTTP ${status} uncertainty cannot submit another create`, async (t) => {
    let creates = 0;
    const state = fixture({
      media: {
        async createVideo() { creates += 1; throw new AilohaProtocolError("http_error", { status }); },
      },
    });
    t.after(() => state.backend.dispose());
    await assert.rejects(state.backend.openVideo("one", () => {}, () => {}));
    await assert.rejects(state.backend.openVideo("one", () => {}, () => {}), { code: "video_create_uncertain" });
    assert.equal(creates, 1);
  });
}

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

for (const [name, code, status] of [
  ["HTTP 408", "http_error", 408],
  ["HTTP 499", "http_error", 499],
  ["disposed client", "client_disposed", undefined],
]) {
  test(`direct boot retains the original ${name} receipt without replacement reads or replay`, async (t) => {
    const operationState = new Map();
    const state = fixture({ operationState });
    t.after(() => state.backend.dispose());
    const start = state.client.startTarget;
    let submissions = 0;
    state.client.startTarget = async () => {
      submissions += 1;
      throw new AilohaProtocolError(code, { status });
    };
    await assert.rejects(state.backend.lifecycle("boot", "one"), { code });
    const receipt = [...operationState.values()][0];
    assert.ok(receipt);
    assert.equal(receipt.uncertain, true);
    state.client.startTarget = async (...args) => { submissions += 1; return start(...args); };
    const reads = state.calls.length;
    await assert.rejects(state.backend.lifecycle("boot", "one"), { code: "lifecycle_outcome_uncertain" });
    assert.equal([...operationState.values()][0], receipt);
    assert.equal(submissions, 1);
    assert.equal(state.calls.length, reads);
  });
}

test("a definitive direct boot HTTP403 rejection evicts only its receipt and allows a new submission", async (t) => {
  const operationState = new Map();
  const state = fixture({ operationState });
  t.after(() => state.backend.dispose());
  const start = state.client.startTarget;
  let submissions = 0;
  state.client.startTarget = async () => {
    submissions += 1;
    throw new AilohaProtocolError("http_error", { status: 403 });
  };
  await assert.rejects(state.backend.lifecycle("boot", "one"), { code: "http_error", status: 403 });
  assert.equal(operationState.size, 0);
  state.client.startTarget = async (...args) => { submissions += 1; return start(...args); };
  assert.equal((await state.backend.lifecycle("boot", "one")).id, "one");
  assert.equal(submissions, 2);
  assert.equal(operationState.size, 0);
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
  const state = canonicalFixture({
    operationState,
    async confirmDestructive() { approvals += 1; await approval.promise; return true; },
    client: {
      async waitForOperation(id) { throw new AilohaProtocolError("timeout", { operationId: id }); },
    },
  });
  t.after(() => state.backend.dispose());
  for (let index = 0; index < 65; index += 1) {
    const id = `target-${index}`;
    const target = { ...structuredClone(state.targets.get("one")), targetId: id };
    target.nativeIdentity.nativeId = `native-target-${index}`;
    state.targets.set(id, target);
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

const stageHash = (text) => createHash("sha256").update(text).digest("hex");

function stagedArtifactFixture(sourcePaths, kind, destination, owner, contents = []) {
  const date = "2026-10-10T00:00:00Z";
  const ticks = (value) => (BigInt(Date.parse(value)) + 62135596800000n) * 10000n;
  const connection = owner.connectionRef;
  const hostInstanceId = `host-${stageHash(`${connection.serviceId}\0${connection.pid}\0${ticks(connection.startedAt)}\0${ticks(connection.processStartedAt)}`)}`;
  return {
    kind, destination, expectedArtifactCount: sourcePaths.length,
    artifacts: sourcePaths.map((source, slot) => {
      const content = Buffer.from(contents[slot] ?? "");
      const proof = {
        targetHostId: "host", targetId: "one", providerId: "provider",
        nativeTargetId: "real-native-one", nativeTargetPlatform: "ios",
        hostInstanceId, sourcePathHash: stageHash(resolve(source)), destination,
        contextRef: "ctx-canonical-snapshot", scopeEpoch: "original-epoch", revision: "1",
        ownerProcessId: 1234, ownerStartedAt: date,
        stageId: "0123456789abcdef0123456789abcdef",
        expectedArtifactCount: sourcePaths.length, stageSlot: slot,
      };
      return {
        artifact: {
          artifactId: `stage-artifact-${slot}`, kind, status: "ready",
          contentType: "application/octet-stream", createdAt: date,
          fileName: basename(source), size: content.length, sha256: stageHash(content), targetId: "one",
          metadata: { ...proof },
        },
        proof,
      };
    }),
  };
}

function stagedOperation(kind, artifactIds, status = "queued") {
  return {
    operationId: kind === "deleteArtifact" ? "cleanup-operation" : "import-operation",
    kind, status, destructive: true, targetId: "one", providerId: "provider",
    createdAt: "2026-10-10T00:00:00Z", artifactIds,
  };
}

function stagedCleanup(receipt) {
  const cleanupArtifacts = receipt.artifacts.map((entry, index) => {
    const operation = {
      ...stagedOperation("deleteArtifact", [entry.artifact.artifactId], "succeeded"),
      operationId: `cleanup-operation-${index}`,
    };
    return {
      artifactId: entry.artifact.artifactId, status: "cleaned",
      attemptId: `abcdef0123456789abcdef012345678${index}`,
      operationId: operation.operationId, operation,
    };
  });
  const last = cleanupArtifacts.at(-1);
  return JSON.stringify({
    status: "cleaned", receipt, attemptId: last.attemptId,
    operation: last.operation, cleanupArtifacts,
  });
}

test("parent: file staging keeps the original destination across asynchronous capture", async (t) => {
  const input = {
    deviceId: "one", input: "/owned/original.bin", path: "/Documents/original.bin",
  };
  const commands = [];
  const state = canonicalFixture({
    client: {
      async getTargetCapabilities() {
        input.path = "/Documents/replacement.bin";
        return [{ id: "target.files", version: 1, features: ["importStagedTargetFile"] }];
      },
    },
    async runCli(args) {
      commands.push(args);
      throw Object.assign(new Error("Stop the owned probe before native upload"), { code: "probe_stopped" });
    },
  });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.stageArtifact("mobile_device_file_push", input), { code: "probe_stopped" });
  assert.equal(commands.length, 1);
  assert.equal(commands[0][commands[0].indexOf("--destination") + 1], "/Documents/original.bin");
});

test("parent: media staging retains original source identity after capture and unknown upload", async (t) => {
  const input = { deviceId: "one", paths: ["/owned/original.png"] };
  const commands = [];
  const state = canonicalFixture({
    client: {
      async getTargetCapabilities() {
        input.paths[0] = "/owned/replacement.png";
        return [{ id: "target.media", version: 1, features: ["importStagedTargetMediaBatch"] }];
      },
    },
    async runCli(args) {
      commands.push(args);
      throw Object.assign(new Error("The owned fixture lost the upload response"), { code: "probe_upload_unknown" });
    },
  });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.stageArtifact("mobile_device_media_add", input), { code: "probe_upload_unknown" });
  await assert.rejects(state.backend.stageArtifact("mobile_device_media_add", {
    deviceId: "one", paths: ["/owned/original.png"],
  }), { code: "artifact_acceptance_unknown" });
  assert.equal(commands.length, 1);
  assert.deepEqual(JSON.parse(commands[0][commands[0].indexOf("--sources") + 1]), ["/owned/original.png"]);
});

test("parent: staged completion preserves its accepted destructive operation identity without replay", async (t) => {
  const source = "/owned/original.bin";
  const commands = [];
  let receipt;
  let polls = 0;
  const state = canonicalFixture({
    confirmDestructive: async () => true,
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["importStagedTargetFile"] }];
      },
      async waitForOperation() {
        return {
          ...stagedOperation("importStagedTargetFile", ["stage-artifact-0"], "succeeded"),
          destructive: ++polls !== 1,
        };
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-stage") + 1];
      commands.push(action);
      if (action === "stage") {
        receipt = stagedArtifactFixture([source], "file", "/Documents/original.bin", state.owner);
        return JSON.stringify({ status: "ready", receipt });
      }
      if (action === "continue") return JSON.stringify({
        status: "accepted", receipt, attemptId: "0123456789abcdef0123456789abcdef",
        operation: stagedOperation("importStagedTargetFile", ["stage-artifact-0"]),
      });
      return stagedCleanup(receipt);
    },
  });
  t.after(() => state.backend.dispose());
  const input = { deviceId: "one", input: source, path: "/Documents/original.bin" };
  await assert.rejects(state.backend.stageArtifact("mobile_device_file_push", input), {
    code: "artifact_operation_mismatch",
  });
  assert.equal(commands.filter((action) => action === "continue").length, 1);
  const resumed = await state.backend.stageArtifact("mobile_device_file_push", input);
  assert.equal(resumed.success, true);
  assert.equal(commands.filter((action) => action === "continue").length, 1);
});

test("owned zero-byte file push uses exact native receipt, captured approval and GET-only completion", async (t) => {
  const dir = await ownedTestDirectory(t, "staged-owned-");
  const source = join(dir, "empty.txt");
  await writeFile(source, "");
  const artifactState = new Map();
  const commands = [];
  let prompts = 0;
  let receipt;
  const state = canonicalFixture({
    artifactState,
    confirmDestructive: async (request) => {
      prompts += 1;
      assert.equal(request.action, "file_push");
      assert.match(request.message, /Documents\/empty\.txt/);
      return true;
    },
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["importStagedTargetFile"] }];
      },
      async waitForOperation(id) {
        assert.equal(id, "import-operation");
        return { ...stagedOperation("importStagedTargetFile", ["stage-artifact-0"], "succeeded"),
          result: { size: 0 } };
      },
    },
    async runCli(args) {
      commands.push(args);
      assert.equal(args[0], "target");
      assert.ok(args.includes("--context-revision") && args.includes("original-epoch"));
      const action = args[args.indexOf("native-stage") + 1];
      if (action === "stage") {
        assert.deepEqual(JSON.parse(args[args.indexOf("--sources") + 1]), [source]);
        receipt = stagedArtifactFixture([source], "file", "/Documents/empty.txt", state.owner);
        return JSON.stringify({ status: "ready", receipt });
      }
      assert.equal(args[args.indexOf("--staged") + 1], JSON.stringify(receipt));
      if (action === "continue") {
        assert.ok(args.includes("--overwrite") && args.includes("--confirm"));
        return JSON.stringify({
          status: "accepted", receipt, attemptId: "0123456789abcdef0123456789abcdef",
          operation: stagedOperation("importStagedTargetFile", ["stage-artifact-0"]),
        });
      }
      assert.equal(action, "cleanup");
      return stagedCleanup(receipt);
    },
  });
  t.after(() => state.backend.dispose());
  const response = await state.backend.request("/api/v1/devices/one/files/push", {
    method: "POST", body: JSON.stringify({ hostPath: source, devicePath: "/Documents/empty.txt" }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, {
    schemaVersion: "1.0", success: true, deviceId: "one",
    devicePath: "/Documents/empty.txt", hostPath: source, size: 0, operation: "push",
  });
  assert.equal(prompts, 1);
  assert.deepEqual(commands.map((args) => args[args.indexOf("native-stage") + 1]),
    ["stage", "continue", "cleanup"]);
  assert.equal(artifactState.size, 0);
});

test("installed app selector uses its package and preserves a nonempty legacy push envelope", async (t) => {
  const dir = await ownedTestDirectory(t, "app-push-owned-");
  const source = join(dir, "seed.db");
  await writeFile(source, "abc");
  const requestedSource = relative(process.cwd(), source);
  const destination = "app://com.example.package/Documents/seed.db";
  let receipt;
  const actions = [];
  const state = canonicalFixture({
    confirmDestructive: async ({ message }) => {
      assert.match(message, /app:\/\/com\.example\.package\/Documents\/seed\.db/);
      return true;
    },
    client: {
      async getTargetCapabilities() {
        return [
          { id: "target.files", version: 1, features: ["importStagedTargetFile"] },
          { id: "target.apps", version: 1, features: ["listTargetApps"] },
        ];
      },
      async listTargetApps() {
        return [{
          appId: "workspace-app", packageId: "com.example.package",
          "x-ailoha-target-host": { targetId: "one", providerId: "provider" },
        }];
      },
      async waitForOperation() {
        return stagedOperation("importStagedTargetFile", ["stage-artifact-0"], "succeeded");
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-stage") + 1];
      actions.push(action);
      if (action === "stage") {
        assert.equal(args[args.indexOf("--destination") + 1], destination);
        receipt = stagedArtifactFixture([source], "file", destination, state.owner, ["abc"]);
        return JSON.stringify({ status: "ready", receipt });
      }
      if (action === "continue") return JSON.stringify({
        status: "accepted", receipt, attemptId: "0123456789abcdef0123456789abcdef",
        operation: stagedOperation("importStagedTargetFile", ["stage-artifact-0"]),
      });
      return stagedCleanup(receipt);
    },
  });
  t.after(() => state.backend.dispose());
  const response = await state.backend.request("/api/v1/devices/one/files/push", {
    method: "POST",
    body: JSON.stringify({ hostPath: requestedSource, devicePath: "Documents/seed.db", bundleId: "com.example.package" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    schemaVersion: "1.0", success: true, deviceId: "one",
    devicePath: "Documents/seed.db", hostPath: source, size: 3, operation: "push",
  });
  assert.deepEqual(actions, ["stage", "continue", "cleanup"]);
});

test("owned media paths use one native staged batch and project every accepted host path", async (t) => {
  const dir = await ownedTestDirectory(t, "media-owned-");
  const paths = [join(dir, "contact.vcf"), join(dir, "image.png")];
  const requestedPaths = [relative(process.cwd(), paths[0]), paths[1]];
  await Promise.all(paths.map((path) => writeFile(path, "")));
  const actions = [];
  let receipt;
  const state = canonicalFixture({
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.media", version: 1, features: ["importStagedTargetMediaBatch"] }];
      },
      async waitForOperation(id) {
        assert.equal(id, "import-operation");
        return { ...stagedOperation("importStagedTargetMediaBatch",
          ["stage-artifact-0", "stage-artifact-1"], "succeeded"),
        result: { addedArtifactIds: ["stage-artifact-0", "stage-artifact-1"] } };
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-stage") + 1];
      actions.push(action);
      if (action === "stage") {
        assert.deepEqual(JSON.parse(args[args.indexOf("--sources") + 1]), paths);
        assert.equal(args[args.indexOf("--destination") + 1], "batch");
        receipt = stagedArtifactFixture(paths, "media", "batch", state.owner);
        return JSON.stringify({ status: "ready", receipt });
      }
      assert.equal(args[args.indexOf("--staged") + 1], JSON.stringify(receipt));
      if (action === "continue") {
        assert.ok(!args.includes("--overwrite"));
        return JSON.stringify({
          status: "accepted", receipt, attemptId: "0123456789abcdef0123456789abcdef",
          operation: stagedOperation("importStagedTargetMediaBatch",
            ["stage-artifact-0", "stage-artifact-1"]),
        });
      }
      return stagedCleanup(receipt);
    },
  });
  t.after(() => state.backend.dispose());
  const response = await state.backend.request("/api/v1/devices/one/media", {
    method: "POST", body: JSON.stringify({ hostPaths: requestedPaths }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    schemaVersion: "1.0", deviceId: "one", platform: "ios", added: paths,
  });
  assert.deepEqual(actions, ["stage", "continue", "cleanup"]);
});

test("unrepresentable media batch never stages a truncated subset", async (t) => {
  let cliCalls = 0;
  const state = canonicalFixture({
    async runCli() { cliCalls += 1; assert.fail("oversized batch cannot reach staging"); },
  });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.stageArtifact("mobile_device_media_add", {
    deviceId: "one", paths: Array.from({ length: 17 }, (_, index) => `/owned/image-${index}.png`),
  }), { code: "artifact_media_batch_limit", status: 501 });
  assert.equal(cliCalls, 0);
});

test("concurrent same-destination calls cannot race a second native stage or device POST", async (t) => {
  const dir = await ownedTestDirectory(t, "concurrent-owned-");
  const source = join(dir, "concurrent.png");
  await writeFile(source, "");
  const stalled = deferred();
  const actions = [];
  let receipt;
  const state = canonicalFixture({
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.media", version: 1, features: ["importStagedTargetMediaBatch"] }];
      },
      async waitForOperation() {
        return { ...stagedOperation("importStagedTargetMediaBatch", ["stage-artifact-0"], "succeeded"),
          result: { addedArtifactIds: ["stage-artifact-0"] } };
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-stage") + 1];
      actions.push(action);
      if (action === "stage") {
        receipt = stagedArtifactFixture([source], "media", "batch", state.owner);
        await stalled.promise;
        return JSON.stringify({ status: "ready", receipt });
      }
      if (action === "continue") return JSON.stringify({
        status: "accepted", receipt, attemptId: "0123456789abcdef0123456789abcdef",
        operation: stagedOperation("importStagedTargetMediaBatch", ["stage-artifact-0"]),
      });
      return stagedCleanup(receipt);
    },
  });
  t.after(() => state.backend.dispose());
  const input = { deviceId: "one", paths: [source] };
  const first = state.backend.stageArtifact("mobile_device_media_add", input);
  await assert.rejects(state.backend.stageArtifact("mobile_device_media_add", input),
    { code: "artifact_operation_in_progress" });
  stalled.resolve();
  assert.deepEqual((await first).added, [source]);
  assert.deepEqual(actions, ["stage", "continue", "cleanup"]);
});

test("uncertain native device acceptance retains the original attempt without a second POST", async (t) => {
  const dir = await ownedTestDirectory(t, "unknown-owned-");
  const source = join(dir, "unknown.txt");
  await writeFile(source, "");
  let receipt;
  const actions = [];
  let prompts = 0;
  const state = canonicalFixture({
    confirmDestructive: async () => { prompts += 1; return true; },
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["importStagedTargetFile"] }];
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-stage") + 1];
      actions.push(action);
      if (action === "stage") {
        receipt = stagedArtifactFixture([source], "file", "/Documents/unknown.txt", state.owner);
        return JSON.stringify({ status: "ready", receipt });
      }
      assert.equal(action, "continue");
      return JSON.stringify({
        status: "acceptanceUnknown", receipt, attemptId: "0123456789abcdef0123456789abcdef",
        errorCode: "DeviceAcceptanceUnknown",
      });
    },
  });
  t.after(() => state.backend.dispose());
  const input = { deviceId: "one", input: source, path: "/Documents/unknown.txt" };
  await assert.rejects(state.backend.stageArtifact("mobile_device_file_push", input));
  await assert.rejects(state.backend.stageArtifact("mobile_device_file_push", input));
  assert.deepEqual(actions, ["stage", "continue"]);
  assert.equal(prompts, 1);
});

test("stalled native stage cannot continue after the original context is retired", async (t) => {
  const dir = await ownedTestDirectory(t, "stale-owned-");
  const source = join(dir, "stale.txt");
  await writeFile(source, "");
  let receipt;
  const actions = [];
  const state = canonicalFixture({
    confirmDestructive: async () => { assert.fail("stale stage cannot request consent"); },
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["importStagedTargetFile"] }];
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-stage") + 1];
      actions.push(action);
      receipt = stagedArtifactFixture([source], "file", "/Documents/stale.txt", state.owner);
      if (action === "cleanup") return stagedCleanup(receipt);
      if (action !== "stage") assert.fail("retired original cannot continue device work");
      await state.retireAuthority();
      return JSON.stringify({ status: "ready", receipt });
    },
  });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.stageArtifact("mobile_device_file_push", {
    deviceId: "one", input: source, path: "/Documents/stale.txt",
  }));
  assert.deepEqual(actions, ["stage", "cleanup"]);
});

test("a restarted same-key target host cannot inherit staged file authority", async (t) => {
  const dir = await ownedTestDirectory(t, "restart-owned-");
  const source = join(dir, "restart.txt");
  await writeFile(source, "");
  const actions = [];
  const artifactState = new Map();
  const state = canonicalFixture({
    artifactState,
    confirmDestructive: async () => { assert.fail("retired context cannot request consent"); },
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["importStagedTargetFile"] }];
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-stage") + 1];
      actions.push(action);
      const receipt = stagedArtifactFixture([source], "file", "/Documents/restart.txt", state.owner);
      if (action === "cleanup") return stagedCleanup(receipt);
      if (action !== "stage") assert.fail("replacement cannot continue original stage");
      await state.retireAuthority();
      return JSON.stringify({ status: "ready", receipt });
    },
  });
  t.after(() => state.backend.dispose());
  const input = { deviceId: "one", input: source, path: "/Documents/restart.txt" };
  await assert.rejects(state.backend.stageArtifact("mobile_device_file_push", input),
    { code: "view_closed" });
  const replacement = canonicalFixture({
    artifactState,
    connectionRef: { ...state.owner.connectionRef, pid: 54321 },
    async runCli() { assert.fail("replacement cannot restage original source"); },
  });
  t.after(() => replacement.backend.dispose());
  await assert.rejects(replacement.backend.stageArtifact("mobile_device_file_push", input),
    { code: "runtime_incarnation_changed" });
  assert.deepEqual(actions, ["stage", "cleanup"]);
});

test("accepted file import recovers from failed completion GET without restaging or resubmitting", async (t) => {
  const dir = await ownedTestDirectory(t, "recover-owned-");
  const source = join(dir, "recover.txt");
  await writeFile(source, "");
  const actions = [];
  let reads = 0;
  let receipt;
  const state = canonicalFixture({
    confirmDestructive: async () => true,
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["importStagedTargetFile"] }];
      },
      async waitForOperation(id) {
        assert.equal(id, "import-operation");
        if (++reads === 1) throw new Error("original operation GET temporarily failed");
        return stagedOperation("importStagedTargetFile", ["stage-artifact-0"], "succeeded");
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-stage") + 1];
      actions.push(action);
      if (action === "stage") {
        receipt = stagedArtifactFixture([source], "file", "/Documents/recover.txt", state.owner);
        return JSON.stringify({ status: "ready", receipt });
      }
      if (action === "continue") return JSON.stringify({
        status: "accepted", receipt, attemptId: "0123456789abcdef0123456789abcdef",
        operation: stagedOperation("importStagedTargetFile", ["stage-artifact-0"]),
      });
      assert.equal(action, "cleanup");
      return stagedCleanup(receipt);
    },
  });
  t.after(() => state.backend.dispose());
  const input = { deviceId: "one", input: source, path: "/Documents/recover.txt" };
  await assert.rejects(state.backend.stageArtifact("mobile_device_file_push", input),
    /original operation GET temporarily failed/);
  const result = await state.backend.stageArtifact("mobile_device_file_push", input);
  assert.equal(result.size, 0);
  assert.equal(reads, 2);
  assert.deepEqual(actions, ["stage", "continue", "cleanup"]);
});

test("late accepted staged import retains its receipt and recovers without a second approval", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const dir = await ownedTestDirectory(t, "late-owned-");
  const source = join(dir, "late.txt");
  await writeFile(source, "");
  let prompts = 0;
  let receipt;
  const actions = [];
  const state = canonicalFixture({
    confirmDestructive: async () => { prompts += 1; return true; },
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["importStagedTargetFile"] }];
      },
      async waitForOperation() {
        return stagedOperation("importStagedTargetFile", ["stage-artifact-0"], "succeeded");
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-stage") + 1];
      actions.push(action);
      if (action === "stage") {
        receipt = stagedArtifactFixture([source], "file", "/Documents/late.txt", state.owner);
        return JSON.stringify({ status: "ready", receipt });
      }
      if (action === "continue") {
        clock = 60_001;
        return JSON.stringify({
          status: "accepted", receipt, attemptId: "0123456789abcdef0123456789abcdef",
          operation: stagedOperation("importStagedTargetFile", ["stage-artifact-0"]),
        });
      }
      return stagedCleanup(receipt);
    },
  });
  t.after(() => state.backend.dispose());
  const input = { deviceId: "one", input: source, path: "/Documents/late.txt" };
  await assert.rejects(state.backend.stageArtifact("mobile_device_file_push", input),
    { code: "submission_outcome_unknown" });
  assert.equal((await state.backend.stageArtifact("mobile_device_file_push", input)).success, true);
  assert.equal(prompts, 1);
  assert.deepEqual(actions, ["stage", "continue", "cleanup"]);
});

test("staged readback uncertainty retries only original-host confirm GET before one continuation", async (t) => {
  const dir = await ownedTestDirectory(t, "confirm-owned-");
  const source = join(dir, "confirm.txt");
  await writeFile(source, "");
  let receipt;
  const actions = [];
  let confirms = 0;
  const state = canonicalFixture({
    confirmDestructive: async () => true,
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["importStagedTargetFile"] }];
      },
      async waitForOperation(id) {
        assert.equal(id, "import-operation");
        return stagedOperation("importStagedTargetFile", ["stage-artifact-0"], "succeeded");
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-stage") + 1];
      actions.push(action);
      if (action === "stage") {
        receipt = stagedArtifactFixture([source], "file", "/Documents/confirm.txt", state.owner);
        return JSON.stringify({ status: "readbackUnconfirmed", receipt,
          errorCode: "ArtifactReadbackUnconfirmed" });
      }
      if (action === "confirm") {
        assert.equal(args[args.indexOf("--staged") + 1], JSON.stringify(receipt));
        if (++confirms === 1) throw new Error("original artifact GET interrupted");
        return JSON.stringify({ status: "ready", receipt });
      }
      if (action === "continue") return JSON.stringify({
        status: "accepted", receipt, attemptId: "0123456789abcdef0123456789abcdef",
        operation: stagedOperation("importStagedTargetFile", ["stage-artifact-0"]),
      });
      return stagedCleanup(receipt);
    },
  });
  t.after(() => state.backend.dispose());
  const input = { deviceId: "one", input: source, path: "/Documents/confirm.txt" };
  await assert.rejects(state.backend.stageArtifact("mobile_device_file_push", input),
    /original artifact GET interrupted/);
  assert.equal((await state.backend.stageArtifact("mobile_device_file_push", input)).size, 0);
  assert.deepEqual(actions, ["stage", "confirm", "confirm", "continue", "cleanup"]);
});

test("uncertain original-host cleanup preserves accepted import and never repeats device continuation", async (t) => {
  const dir = await ownedTestDirectory(t, "cleanup-owned-");
  const source = join(dir, "cleanup.txt");
  await writeFile(source, "");
  const actions = [];
  let receipt;
  let cleanupCalls = 0;
  const state = canonicalFixture({
    confirmDestructive: async () => true,
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["importStagedTargetFile"] }];
      },
      async waitForOperation() {
        return stagedOperation("importStagedTargetFile", ["stage-artifact-0"], "succeeded");
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-stage") + 1];
      actions.push(action);
      if (action === "stage") {
        receipt = stagedArtifactFixture([source], "file", "/Documents/cleanup.txt", state.owner);
        return JSON.stringify({ status: "ready", receipt });
      }
      if (action === "continue") return JSON.stringify({
        status: "accepted", receipt, attemptId: "0123456789abcdef0123456789abcdef",
        operation: stagedOperation("importStagedTargetFile", ["stage-artifact-0"]),
      });
      assert.equal(action, "cleanup");
      if (++cleanupCalls === 1) return JSON.stringify({
        status: "cleanupAcceptanceUnknown", receipt, attemptId: "abcdef0123456789abcdef0123456780",
        cleanupArtifacts: [{
          artifactId: "stage-artifact-0", status: "acceptanceUnknown",
          attemptId: "abcdef0123456789abcdef0123456780",
        }],
      });
      return stagedCleanup(receipt);
    },
  });
  t.after(() => state.backend.dispose());
  const input = { deviceId: "one", input: source, path: "/Documents/cleanup.txt" };
  await assert.rejects(state.backend.stageArtifact("mobile_device_file_push", input),
    { code: "artifact_cleanup_unconfirmed" });
  assert.equal((await state.backend.stageArtifact("mobile_device_file_push", input)).success, true);
  assert.deepEqual(actions, ["stage", "continue", "cleanup", "cleanup"]);
});

test("denied file replacement cleans only original staged artifact without device continuation", async (t) => {
  const dir = await ownedTestDirectory(t, "denied-owned-");
  const source = join(dir, "denied.txt");
  await writeFile(source, "");
  let receipt;
  const actions = [];
  const artifactState = new Map();
  const state = canonicalFixture({
    artifactState, confirmDestructive: async () => false,
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["importStagedTargetFile"] }];
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-stage") + 1];
      actions.push(action);
      if (action === "stage") {
        receipt = stagedArtifactFixture([source], "file", "/Documents/denied.txt", state.owner);
        return JSON.stringify({ status: "ready", receipt });
      }
      assert.equal(action, "cleanup");
      return stagedCleanup(receipt);
    },
  });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.stageArtifact("mobile_device_file_push", {
    deviceId: "one", input: source, path: "/Documents/denied.txt",
  }), { code: "consent_denied" });
  assert.deepEqual(actions, ["stage", "cleanup"]);
  assert.equal(artifactState.size, 0);
});

test("native failed copy is never a successful zero-byte transfer and still cleans original staging", async (t) => {
  const dir = await ownedTestDirectory(t, "failed-owned-");
  const source = join(dir, "failed.txt");
  await writeFile(source, "");
  let receipt;
  const actions = [];
  const state = canonicalFixture({
    confirmDestructive: async () => true,
    client: {
      async getTargetCapabilities() {
        return [{ id: "target.files", version: 1, features: ["importStagedTargetFile"] }];
      },
      async waitForOperation() {
        return stagedOperation("importStagedTargetFile", ["stage-artifact-0"], "failed");
      },
    },
    async runCli(args) {
      const action = args[args.indexOf("native-stage") + 1];
      actions.push(action);
      if (action === "stage") {
        receipt = stagedArtifactFixture([source], "file", "/Documents/failed.txt", state.owner);
        return JSON.stringify({ status: "ready", receipt });
      }
      if (action === "continue") return JSON.stringify({
        status: "accepted", receipt, attemptId: "0123456789abcdef0123456789abcdef",
        operation: stagedOperation("importStagedTargetFile", ["stage-artifact-0"]),
      });
      return stagedCleanup(receipt);
    },
  });
  t.after(() => state.backend.dispose());
  const input = { deviceId: "one", input: source, path: "/Documents/failed.txt" };
  await assert.rejects(state.backend.stageArtifact("mobile_device_file_push", input),
    { code: "artifact_operation_failed" });
  await assert.rejects(state.backend.stageArtifact("mobile_device_file_push", input),
    { code: "artifact_operation_failed" });
  assert.deepEqual(actions, ["stage", "continue", "cleanup"]);
});
