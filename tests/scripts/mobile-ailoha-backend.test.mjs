import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
const { AilohaMobileBackend } = await import(productModule("lib/ailoha/mobile-backend.mjs"));
const { mobileCanvasBackend } = await import(productModule("lib/backend.mjs"));
const { createAilohaMediaAdapter } = await import(productModule("lib/ailoha/media-adapter.mjs"));
const { AilohaProtocolError } = await import(productModule("lib/ailoha/errors.mjs"));
const { publicSnapshot, MobileAilohaError } = await import(productModule("lib/ailoha/mobile-projection.mjs"));
const { createAilohaContextStore } = await import(productModule("lib/ailoha/context-adapter.mjs"));
const { AilohaRecordingCoordinator } = await import(productModule("lib/ailoha/recording-coordinator.mjs"));

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
  const client = {
    async getHostStatus() { return { hostId: "host", profile: "ailoha.target-host/v1", version: "test", state: "ready", capabilities: [] }; },
    async listProviders() { return providers; },
    async listTargets() { return [...targets.values()]; },
    async getTarget(id) { calls.push(["get", id]); return { ...targets.get(id), surfaces: [surface()] }; },
    async getTargetCapabilities() { return capabilities; },
    async listProviderTargetTypes() { return [
      { targetTypeId: "type", kind: "simulator", platform: "ios" },
    ]; },
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
    saveScreenshot: options.saveScreenshot,
    recording: options.recording,
    recordingAvailable: options.recordingAvailable,
    finalizeRecordings: options.finalizeRecordings,
    operationState: options.operationState,
    videoState: options.videoState,
  });
  return {
    backend, calls, targets, providers, client, media, cleanups, selectionStore, capabilities, owner,
    retireContext() { contextState = "detached"; },
    geometryChanged() { revision += 1; },
    selectHost(hostId) { selection = { targetHostId: hostId, targetId: "one" }; },
  };
}

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

test("shared recording API and action identifiers preserve legacy outputs and captured owner across selection", async () => {
  const recordings = [];
  let tracked = false;
  const state = fixture({
    recording: {
      get tracked() { return tracked; },
      async start(invocation, input) {
        recordings.push(["start", invocation, input]);
        tracked = true;
        return { deviceId: invocation.targetId, isRecording: true, outputPath: "/host/record.mp4",
          startedAt: "2026-10-10T01:00:00Z", timeoutSeconds: input.timeoutSeconds };
      },
      async status(invocation) {
        recordings.push(["status", invocation.targetId]);
        return { deviceId: invocation.targetId, isRecording: tracked && invocation.targetId === "one",
          outputPath: tracked && invocation.targetId === "one" ? "/host/record.mp4" : null };
      },
      async stop(deviceId) {
        recordings.push(["stop", deviceId]);
        tracked = false;
        return { deviceId, isRecording: false, outputPath: "/host/record.mp4" };
      },
      async finalize() { if (tracked) await this.stop("one"); },
    },
    finalizeRecordings: true,
  });
  state.capabilities.push({ id: "surface.capture", version: 1,
    features: ["startTargetRecording", "getTargetRecording", "stopTargetRecording"] });
  assert.equal((await state.backend.getDevice("one")).capabilities.recording, true);
  const response = await state.backend.request("/api/v1/devices/one/recording/start", {
    method: "POST", body: JSON.stringify({ timeoutSeconds: 180 }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    deviceId: "one", isRecording: true, outputPath: "/host/record.mp4",
    startedAt: "2026-10-10T01:00:00Z", timeoutSeconds: 180,
  });
  assert.equal(recordings[0][1].targetHostId, "host");
  assert.equal(recordings[0][1].surfaceId, "surface/opaque");
  await state.backend.select("two");
  assert.deepEqual(await state.backend.invokeAction("get_recording_status", { deviceId: "two" }), {
    deviceId: "two", isRecording: false, outputPath: null,
  });
  await state.backend.dispose();
  assert.deepEqual(recordings.at(-1), ["stop", "one"]);
  assert.ok(state.calls.findIndex((call) => call[0] === "client-dispose")
    > state.calls.findIndex((call) => call[0] === "release-end"));
  assert.equal(state.calls.some((call) => call[0] === "stop"), false);
});

test("cancelled recording API and action intents cannot start after target preparation", async () => {
  const entered = deferred();
  const targetReady = deferred();
  let starts = 0;
  const state = fixture({
    recording: { async start() { starts++; } },
  });
  state.capabilities.push({ id: "surface.capture", version: 1,
    features: ["startTargetRecording", "getTargetRecording", "stopTargetRecording"] });
  const getTarget = state.client.getTarget.bind(state.client);
  state.client.getTarget = async (id) => {
    entered.resolve();
    await targetReady.promise;
    return getTarget(id);
  };
  const caller = new AbortController();
  const pending = state.backend.request("/api/v1/devices/one/recording/start", {
    method: "POST", signal: caller.signal,
  });
  await entered.promise;
  caller.abort();
  targetReady.resolve();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "request_cancelled");
  await assert.rejects(state.backend.invokeAction("start_recording", { deviceId: "one" },
    { signal: caller.signal }), { code: "request_cancelled" });
  assert.equal(starts, 0);
  await state.backend.dispose();
});

test("unavailable recovery hides recording despite capture support and rejects starts", async () => {
  let starts = 0;
  const state = fixture({
    recordingAvailable: false,
    recording: {
      async start() { starts++; },
      async status() { return { deviceId: "one", isRecording: false }; },
    },
  });
  state.capabilities.push({ id: "surface.capture", version: 1,
    features: ["startTargetRecording", "getTargetRecording", "stopTargetRecording"] });
  await state.backend.select("one");
  assert.equal((await state.backend.getDevice("one")).capabilities.recording, false);
  await assert.rejects(state.backend.recordingStart("one"), { code: "capability_not_supported" });
  assert.equal(starts, 0);
  await state.backend.dispose();
});

test("recording finalization failure prevents lease release and retry stays on original target", async () => {
  let failures = 1;
  let stops = 0;
  const state = fixture({
    recording: {
      get tracked() { return true; },
      async finalize() {
        stops += 1;
        if (failures--) throw new Error("artifact download failed");
      },
    },
    finalizeRecordings: true,
  });
  await assert.rejects(state.backend.dispose(), /artifact download failed/);
  assert.equal(state.calls.some((call) => call[0] === "release-begin"), false);
  await state.backend.dispose();
  assert.equal(stops, 2);
  assert.equal(state.calls.filter((call) => call[0] === "release-begin").length, 1);
});

test("retired contexts reject new recording work but finalize the captured owner", async () => {
  let owner;
  let tracked = false;
  const finalized = [];
  const state = fixture({
    recording: {
      get tracked() { return tracked; },
      async start(invocation) {
        owner = invocation;
        tracked = true;
        return { deviceId: invocation.targetId, isRecording: true, outputPath: "/host/record.mp4" };
      },
      async finalize() {
        finalized.push(owner);
        tracked = false;
      },
    },
    finalizeRecordings: true,
  });
  state.capabilities.push({ id: "surface.capture", version: 1,
    features: ["startTargetRecording", "getTargetRecording", "stopTargetRecording"] });
  await state.backend.recordingStart("one");
  state.retireContext();
  await assert.rejects(state.backend.recordingStart("two"), { code: "view_closed" });
  await state.backend.dispose();
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].targetHostId, "host");
  assert.equal(finalized[0].targetId, "one");
  assert.equal(finalized[0].surfaceId, "surface/opaque");
  assert.equal(state.calls.filter((call) => call[0] === "release-end").length, 1);
  assert.equal(state.calls.some((call) => call[0] === "stop"), false);
});

test("view close waits for a concurrent accepted recording start before releasing its lease", async () => {
  const entered = deferred();
  const accepted = deferred();
  const calls = [];
  let active = false;
  const record = (state = "recording") => ({
    recordingId: "owned-recording", targetHostId: "host", targetId: "one",
    surfaceId: "surface/opaque", outputFile: "/host/record.mp4", state,
    ...(state === "completed" ? { artifactId: "owned-artifact" } : {}),
  });
  const recording = new AilohaRecordingCoordinator({
    output: async () => "/host/record.mp4",
    async run(args, options) {
      const action = args[1];
      calls.push(action);
      if (action === "status") return JSON.stringify(active ? record() : null);
      if (action === "start") {
        options.beforeDispatch();
        entered.resolve();
        await accepted.promise;
        active = true;
        return JSON.stringify(record());
      }
      if (action === "stop") {
        active = false;
        return JSON.stringify(record("completed"));
      }
      if (action === "recover") return JSON.stringify({
        ...record("completed"), outcome: "downloaded", hostInstanceId: "instance-one",
        stopOperationId: "stop-operation-one", stopRequestId: "stop-request-one",
        contextRef: "ctx-canonical-snapshot", scopeEpoch: "original-epoch", contextRevision: "1",
        downloadedAt: "2026-10-10T01:02:00Z", downloadedLength: 21,
      });
      throw new Error("Unexpected recording command");
    },
  });
  const state = canonicalFixture({ recording, finalizeRecordings: true });
  state.capabilities.push({ id: "surface.capture", version: 1,
    features: ["startTargetRecording", "getTargetRecording", "stopTargetRecording"] });
  const caller = new AbortController();
  const starting = state.backend.recordingStart("one", {}, { signal: caller.signal });
  await entered.promise;
  caller.abort();
  const closing = state.backend.dispose();
  assert.equal(state.calls.some((call) => call[0] === "release-begin"), false);
  accepted.resolve();
  await starting;
  await closing;
  assert.deepEqual(calls, ["status", "start", "status", "stop", "recover"]);
  assert.equal(state.calls.filter((call) => call[0] === "release-end").length, 1);
  assert.equal(recording.tracked, false);
});

test("cancelled recording start after canonical status never dispatches or retains an unaccepted owner", async () => {
  const entered = deferred();
  const statusReady = deferred();
  const commands = [];
  const recording = new AilohaRecordingCoordinator({
    output: async () => "/host/record.mp4",
    async run(args) {
      commands.push(args[1]);
      if (args[1] !== "status") throw new Error("Cancelled intent submitted recording start.");
      entered.resolve();
      await statusReady.promise;
      return "null";
    },
  });
  const state = canonicalFixture({ recording });
  state.capabilities.push({ id: "surface.capture", version: 1,
    features: ["startTargetRecording", "getTargetRecording", "stopTargetRecording"] });
  const caller = new AbortController();
  const pending = state.backend.request("/api/v1/devices/one/recording/start", {
    method: "POST", signal: caller.signal,
  });
  await entered.promise;
  caller.abort();
  statusReady.resolve();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "request_cancelled");
  assert.deepEqual(commands, ["status"]);
  assert.equal(recording.tracked, false);
  await state.backend.dispose();
});

test("remote and non-virtual targets advertise no recording even when capture methods exist", async (t) => {
  const state = fixture({ recording: { async start() { throw new Error("must not reach"); } } });
  t.after(() => state.backend.dispose());
  state.capabilities.push({ id: "surface.capture", version: 1,
    features: ["startTargetRecording", "getTargetRecording", "stopTargetRecording"] });
  state.client.listProviderTargetTypes = async () => [{ targetTypeId: "type", kind: "remote", platform: "ios" }];
  assert.equal((await state.backend.getDevice("one")).capabilities.recording, false);
  const response = await state.backend.request("/api/v1/devices/one/recording/start", { method: "POST" });
  assert.equal(response.status, 501);
  assert.equal((await response.json()).code, "capability_not_supported");
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
  assert.equal(captured.invocation.executionContext.processStartedAt, "2026-10-10T00:00:00Z");
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
