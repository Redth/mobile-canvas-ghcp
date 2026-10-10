import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
const { AilohaMobileBackend } = await import(productModule("lib/ailoha/mobile-backend.mjs"));
const { mobileCanvasBackend } = await import(productModule("lib/backend.mjs"));
const { createAilohaMediaAdapter } = await import(productModule("lib/ailoha/media-adapter.mjs"));
const { createAilohaDeviceFeatures } = await import(productModule("lib/ailoha/device-features.mjs"));
const { AilohaProtocolError } = await import(productModule("lib/ailoha/errors.mjs"));
const { publicSnapshot, MobileAilohaError } = await import(productModule("lib/ailoha/mobile-projection.mjs"));
const { createAilohaContextStore } = await import(productModule("lib/ailoha/context-adapter.mjs"));
const { createAilohaMcpDispatcher } = await import(productModule("lib/ailoha/mcp-host.mjs"));

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
  const featureCapabilities = options.featureCapabilities ?? [];
  const providers = [{ providerId: "provider", name: "Provider", version: "1", state: "ready", capabilities: featureCapabilities }];
  const capabilities = [{ id: "target.lifecycle", version: 1, features: ["startTarget", "stopTarget", "rebootTarget", "resetTarget", "deleteTarget"] }, ...featureCapabilities];
  const client = {
    async getHostStatus() { return { hostId: "host", profile: "ailoha.target-host/v1", version: "test", state: "ready", capabilities: [] }; },
    async listProviders() { return providers; },
    async listTargets() { return [...targets.values()]; },
    async getTarget(id) { calls.push(["get", id]); return { ...targets.get(id), surfaces: [surface()] }; },
    async getTargetCapabilities() { return capabilities; },
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
    confirmDestructive: options.confirmDestructive,
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
  let batteryLevel = 0.57;
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
      if (request.method === "PUT" && options.putFailure === "unknown") {
        throw new Error("private PUT transport diagnostics");
      }
      const reply = (body, status = 200, location) =>
        ({ status, contentType: status === 204 ? null : "application/json", location, body });
      if (path.endsWith("/hardware")) {
        if (hardwareGate) await hardwareGate.promise;
        if (hardwareReadsFail) throw new Error("private hardware readback diagnostics");
        return reply({
          targetId: "one", platform, batteryLevel, batteryState: "charging",
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
        batteryLevel = JSON.parse(request.body).level;
        return reply({ simulated: true, level: batteryLevel, "x-ailoha-target-host": context });
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
  const disabled = featureFixture({ allowPut: true, featureCapabilities: [] });
  t.after(() => disabled.backend.dispose());
  await assert.rejects(disabled.backend.invokeAction("set_battery", {
    deviceId: "one", level: 20,
  }), { code: "capability_not_supported" });
  assert.equal(disabled.wire.length, 0);
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
