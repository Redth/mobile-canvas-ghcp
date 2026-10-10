import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { productModule } from "../ailoha-test-module.mjs";
const { AilohaMobileBackend } = await import(productModule("lib/ailoha/mobile-backend.mjs"));
const { mobileCanvasBackend } = await import(productModule("lib/backend.mjs"));
const { createAilohaMediaAdapter } = await import(productModule("lib/ailoha/media-adapter.mjs"));
const { AilohaProtocolError } = await import(productModule("lib/ailoha/errors.mjs"));
const { publicSnapshot, MobileAilohaError } = await import(productModule("lib/ailoha/mobile-projection.mjs"));
const { createAilohaContextStore } = await import(productModule("lib/ailoha/context-adapter.mjs"));
const { ARTIFACT_FEATURE_GATES } = await import(productModule("lib/ailoha/artifact-features.mjs"));

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

const stageHash = (text) => createHash("sha256").update(text).digest("hex");

function stagedFixture(sourcePaths, kind, destination, owner, contents = []) {
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
        receipt = stagedFixture([source], "file", "/Documents/original.bin", state.owner);
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
  const dir = await mkdtemp(join(process.cwd(), "tests/scripts/fixtures/staged-owned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
        receipt = stagedFixture([source], "file", "/Documents/empty.txt", state.owner);
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
  const dir = await mkdtemp(join(process.cwd(), "tests/scripts/fixtures/app-push-owned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
        receipt = stagedFixture([source], "file", destination, state.owner, ["abc"]);
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
  const dir = await mkdtemp(join(process.cwd(), "tests/scripts/fixtures/media-owned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
        receipt = stagedFixture(paths, "media", "batch", state.owner);
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
  const dir = await mkdtemp(join(process.cwd(), "tests/scripts/fixtures/concurrent-owned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
        receipt = stagedFixture([source], "media", "batch", state.owner);
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
  const dir = await mkdtemp(join(process.cwd(), "tests/scripts/fixtures/unknown-owned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
        receipt = stagedFixture([source], "file", "/Documents/unknown.txt", state.owner);
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
  const dir = await mkdtemp(join(process.cwd(), "tests/scripts/fixtures/stale-owned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
      receipt = stagedFixture([source], "file", "/Documents/stale.txt", state.owner);
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
  const dir = await mkdtemp(join(process.cwd(), "tests/scripts/fixtures/restart-owned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
      const receipt = stagedFixture([source], "file", "/Documents/restart.txt", state.owner);
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
  const dir = await mkdtemp(join(process.cwd(), "tests/scripts/fixtures/recover-owned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
        receipt = stagedFixture([source], "file", "/Documents/recover.txt", state.owner);
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
  const dir = await mkdtemp(join(process.cwd(), "tests/scripts/fixtures/late-owned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
        receipt = stagedFixture([source], "file", "/Documents/late.txt", state.owner);
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
  const dir = await mkdtemp(join(process.cwd(), "tests/scripts/fixtures/confirm-owned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
        receipt = stagedFixture([source], "file", "/Documents/confirm.txt", state.owner);
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
  const dir = await mkdtemp(join(process.cwd(), "tests/scripts/fixtures/cleanup-owned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
        receipt = stagedFixture([source], "file", "/Documents/cleanup.txt", state.owner);
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
  const dir = await mkdtemp(join(process.cwd(), "tests/scripts/fixtures/denied-owned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
        receipt = stagedFixture([source], "file", "/Documents/denied.txt", state.owner);
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
  const dir = await mkdtemp(join(process.cwd(), "tests/scripts/fixtures/failed-owned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
        receipt = stagedFixture([source], "file", "/Documents/failed.txt", state.owner);
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

test("unadvertised artifact reads and five mutation gates never dispatch device IO", async (t) => {
  const state = fixture();
  t.after(() => state.backend.dispose());
  const cases = [
    ["mobile_device_file_list", "GET", "/files?bundleId=com.example.app&path=Documents"],
    ["mobile_device_file_pull", "POST", "/files/pull"],
    ["mobile_device_file_push", "POST", "/files/push"],
    ["mobile_device_file_delete", "POST", "/files/delete"],
    ["mobile_device_file_mkdir", "POST", "/files/mkdir"],
    ["mobile_device_media_add", "POST", "/media"],
    ["mobile_device_log", "GET", "/log?text=fault&seconds=300"],
    ["mobile_device_crashes", "GET", "/crashes?text=example"],
    ["mobile_device_crash_report", "GET", "/crashes/report-id"],
  ];
  for (const [identity, method, suffix] of cases) {
    const readable = ["mobile_device_file_list", "mobile_device_log",
      "mobile_device_crashes", "mobile_device_crash_report"].includes(identity);
    const failure = readable
      ? { code: "capability_not_supported", status: 501 }
      : { code: "artifact_contract_unavailable", message: ARTIFACT_FEATURE_GATES[identity], status: 501 };
    await assert.rejects(state.backend.invokeAction(identity, {
      deviceId: "one", ...(identity === "mobile_device_crash_report" ? { crashId: "report-id" } : {}),
    }), {
      ...failure,
    });
    const response = await state.backend.request(`/api/v1/devices/one${suffix}`, {
      method, ...(method === "POST" ? { body: JSON.stringify({ devicePath: "/fixture", hostPath: "/owned" }) } : {}),
    });
    assert.equal(response.status, 501, identity);
    assert.deepEqual(await response.json(), readable
      ? { ...failure, message: `${identity} is not supported by this Ailoha opt-in or the selected target's advertised capabilities.` }
      : failure);
  }
  assert.equal(state.calls.some(([kind]) => !["get"].includes(kind)), false);
  const wrongMethod = await state.backend.request("/api/v1/devices/one/files/delete", { method: "GET" });
  assert.equal(wrongMethod.status, 501);
  assert.equal((await wrongMethod.json()).code, "capability_not_supported");
  const wrongPath = await state.backend.request("/api/v1/devices/one/files/unknown", { method: "POST" });
  assert.equal(wrongPath.status, 501);
  assert.equal((await wrongPath.json()).code, "capability_not_supported");
  const malformed = await state.backend.request("/api/v1/devices/one/files/push", { method: "POST", body: "not-json" });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, "invalid_request");
  const malformedPath = await state.backend.request("/api/v1/devices/%ZZ/files");
  assert.equal(malformedPath.status, 400);
  assert.equal((await malformedPath.json()).code, "invalid_request");
  const malformedCrash = await state.backend.request("/api/v1/devices/one/crashes/%ZZ");
  assert.equal(malformedCrash.status, 400);
  assert.equal((await malformedCrash.json()).code, "invalid_request");
  assert.equal(state.calls.some(([kind]) => kind !== "get"), false);
});

test("captured native read features preserve exact file, log and crash envelopes", async (t) => {
  const calls = [];
  const context = { "x-ailoha-target-host": { targetId: "one", providerId: "provider" } };
  const state = canonicalFixture({
    client: {
      async getTargetCapabilities() {
        return [
          { id: "target.files", version: 1, features: ["queryTargetFiles"] },
          { id: "target.diagnostics", version: 1,
            features: ["queryTargetLogs", "queryTargetCrashes", "getTargetCrashDetail"] },
          { id: "target.apps", version: 1, features: ["listTargetApps"] },
        ];
      },
      async listTargetApps(id) {
        calls.push(["apps", id]);
        return [{ appId: "native-app", packageId: "com.example.app", ...context }];
      },
      async queryTargetFiles(id, path) {
        calls.push(["files", id, path]);
        return {
          path, nativePath: "/Documents", total: 1,
          files: [{ name: "zero", path: `${path}/zero`, nativePath: "/Documents/zero",
            type: "file", size: 0, ...context }],
        };
      },
      async queryTargetLogs(id, query) {
        calls.push(["logs", id, query]);
        return { total: 2, entries: [
          { nativeTimestamp: "first", nativeLevel: "verbose", nativeSource: "app",
            source: "native", message: "one", ...context },
          { nativeTimestamp: "second", nativeLevel: "fatal", nativeSource: "app",
            source: "native", message: "two", ...context },
        ] };
      },
      async queryTargetCrashes(id, query) {
        calls.push(["crashes", id, query]);
        return { total: 3, crashes: [{
          crashId: "report", nativeName: "App", nativeTimestamp: "raw time", nativeKind: "ANR", ...context,
        }] };
      },
      async getTargetCrashDetail(id, crashId) {
        calls.push(["detail", id, crashId]);
        return { crashId, nativeName: "App", nativeTimestamp: "raw time", content: "full stack", ...context };
      },
    },
  });
  t.after(() => state.backend.dispose());
  const files = await state.backend.readArtifact("mobile_device_file_list", {
    deviceId: "one", bundleId: "native-app", path: "Documents",
  });
  assert.equal(files.files[0].size, 0);
  assert.equal(files.files[0].path, "/Documents/zero");
  assert.deepEqual(calls.slice(0, 2), [["apps", "one"], ["files", "one", "app://com.example.app/Documents"]]);
  const logs = await state.backend.readArtifact("mobile_device_log", {
    deviceId: "one", bundleId: "native-app", level: "fatal", seconds: 300, limit: 2,
  });
  assert.deepEqual(logs.entries.map((entry) => entry.level), ["verbose", "fatal"]);
  assert.equal(logs.total, 2);
  assert.equal(calls.find(([kind]) => kind === "logs")[2].appId, "com.example.app");
  assert.equal(calls.find(([kind]) => kind === "logs")[2].level, "critical");
  assert.equal((await state.backend.readArtifact("mobile_device_crashes", {
    deviceId: "one", text: "App", limit: 1,
  })).total, 3);
  assert.equal((await state.backend.readArtifact("mobile_device_crash_report", {
    deviceId: "one", crashId: "report",
  })).content, "full stack");
  assert.equal(JSON.stringify(files).includes("connectionRef"), false);
  assert.equal(calls.some(([kind]) => ["push", "delete", "media"].includes(kind)), false);
});

test("stale view revision cannot borrow a newer app lookup for a file read", async (t) => {
  let state;
  state = canonicalFixture({
    client: {
      async getTargetCapabilities() {
        return [
          { id: "target.files", version: 1, features: ["queryTargetFiles"] },
          { id: "target.apps", version: 1, features: ["listTargetApps"] },
        ];
      },
      async listTargetApps() {
        await state.advanceSelection();
        return [{ appId: "app", packageId: "app",
          "x-ailoha-target-host": { targetId: "one", providerId: "provider" } }];
      },
      async queryTargetFiles() { throw new Error("stale intent crossed native read boundary"); },
    },
  });
  t.after(() => state.backend.dispose());
  await assert.rejects(state.backend.readArtifact("mobile_device_file_list", {
    deviceId: "one", bundleId: "app",
  }), { code: "context_snapshot_superseded" });
});

for (const retirement of ["revision", "detach"]) {
  test(`parent regression: native log read cannot return usable output after ${retirement} of its original view`, async (t) => {
    let state;
    state = canonicalFixture({
      client: {
        async getTargetCapabilities() {
          return [{ id: "target.diagnostics", version: 1, features: ["queryTargetLogs"] }];
        },
        async queryTargetLogs() {
          if (retirement === "revision") await state.advanceSelection();
          else await state.retireAuthority();
          return {
            total: 1,
            entries: [{
              nativeTimestamp: "original time", nativeLevel: "info", nativeSource: "native-app",
              source: "native", message: "original-owner-only",
              "x-ailoha-target-host": { targetId: "one", providerId: "provider" },
            }],
          };
        },
      },
    });
    t.after(() => state.backend.dispose());
    await assert.rejects(state.backend.readArtifact("mobile_device_log", { deviceId: "one" }));
  });
}

test("read adapters reject invalid limits before inventory and refuse ambiguous/foreign/incomplete results", async (t) => {
  let apps = [{ appId: "app", packageId: "pkg",
    "x-ailoha-target-host": { targetId: "one", providerId: "provider" } }];
  let listing = {
    path: "app://pkg/", nativePath: "/", total: 1,
    files: [{ name: "empty", path: "app://pkg/empty", nativePath: "/empty",
      type: "file", size: 0, "x-ailoha-target-host": { targetId: "one", providerId: "provider" } }],
  };
  const state = fixture({
    client: {
      async getTargetCapabilities() {
        return [
          { id: "target.files", version: 1, features: ["queryTargetFiles"] },
          { id: "target.apps", version: 1, features: ["listTargetApps"] },
          { id: "target.diagnostics", version: 1, features: ["queryTargetCrashes"] },
        ];
      },
      async listTargetApps() { return apps; },
      async queryTargetFiles() { return listing; },
      async queryTargetCrashes() { return { total: 0, crashes: [] }; },
    },
  });
  t.after(() => state.backend.dispose());
  for (const input of [
    { deviceId: "one", limit: 0 }, { deviceId: "one", limit: 501 },
  ]) {
    await assert.rejects(state.backend.readArtifact("mobile_device_crashes", input),
      { code: "artifact_contract_unavailable", status: 501 });
  }
  assert.deepEqual(state.calls, []);
  apps = [...apps, { ...apps[0], appId: "another" }];
  await assert.rejects(state.backend.readArtifact("mobile_device_file_list", {
    deviceId: "one", bundleId: "pkg",
  }), { code: "capability_not_supported", status: 501 });
  apps = apps.slice(0, 1);
  listing = { ...listing, total: 2 };
  await assert.rejects(state.backend.readArtifact("mobile_device_file_list", {
    deviceId: "one", bundleId: "pkg",
  }), { code: "invalid_artifact_listing", status: 502 });
  listing = { ...listing, total: 1, files: [{
    ...listing.files[0], "x-ailoha-target-host": { targetId: "one", providerId: "other" },
  }] };
  await assert.rejects(state.backend.readArtifact("mobile_device_file_list", {
    deviceId: "one", bundleId: "pkg",
  }), { code: "artifact_owner_mismatch", status: 502 });
});

test("an in-flight native read cannot return data after revision, retirement or native identity changes", async (t) => {
  for (const change of ["revision", "retirement", "native"]) {
    const entered = deferred();
    const finish = deferred();
    const state = canonicalFixture({
      client: {
        async getTargetCapabilities() {
          return [{ id: "target.diagnostics", version: 1, features: ["queryTargetCrashes"] }];
        },
        async queryTargetCrashes(id) {
          assert.equal(id, "one");
          entered.resolve();
          await finish.promise;
          return { total: 0, crashes: [] };
        },
      },
    });
    t.after(() => state.backend.dispose());
    const pending = state.backend.readArtifact("mobile_device_crashes", { deviceId: "one" });
    await entered.promise;
    if (change === "revision") await state.advanceSelection();
    if (change === "retirement") await state.retireAuthority();
    if (change === "native") state.targets.get("one").nativeIdentity.nativeId = "replacement-native-id";
    finish.resolve();
    await assert.rejects(pending, {
      code: change === "native" ? "artifact_owner_mismatch"
        : change === "retirement" ? "view_closed" : "context_snapshot_superseded",
    });
    assert.equal(state.calls.filter(([name]) => name === "get").every(([, id]) => id === "one"), true);
  }
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
