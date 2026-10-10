import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { productModule } from "../ailoha-test-module.mjs";
import * as sdkDouble from "./fixtures/ailoha-sdk-double.mjs";

const { AilohaRecordingCoordinator } = await import(productModule("lib/ailoha/recording-coordinator.mjs"));
const { recordingOutputPath } = await import(productModule("lib/ailoha/recording-artifact.mjs"));
const { createRuntimeMobileBackend } = await import(productModule("lib/ailoha/runtime-backend.mjs"));

const invocation = Object.freeze({
  targetHostId: "host-one", targetId: "target-one", surfaceId: "surface-one", providerId: "provider-one",
  nativeIdentity: { platform: "ios", isVirtual: true },
  executionContext: { contextRef: "ctx-captured", scopeEpoch: "epoch-captured", revision: "7", ownerProcessId: 123 },
});
const path = "/safe/recording.mp4";
const record = (state = "recording") => ({
  recordingId: "recording-one", targetHostId: invocation.targetHostId,
  targetId: invocation.targetId, surfaceId: invocation.surfaceId, state,
  outputFile: path, startedAt: "2026-10-10T01:00:00Z",
  ...(state === "completed" ? { artifactId: "artifact-one" } : {}),
});

function fixture({ run } = {}) {
  const calls = [];
  let active = null;
  const coordinator = new AilohaRecordingCoordinator({
    output: async (output, platform) => {
      assert.equal(platform, "ios");
      return output ?? path;
    },
    async run(args, options) {
      const action = args[1];
      calls.push({ action, args, options });
      assert.deepEqual(args.slice(2, 7), ["--context", "ctx-captured", "--context-epoch", "epoch-captured", "--json"]);
      if (run) return run(action, args, calls);
      if (action === "status") return JSON.stringify(active);
      if (action === "start") {
        assert.equal(active, null);
        assert.deepEqual(args.slice(7), [
          "--target-host", "host-one", "--target", "target-one", "--surface", "surface-one",
          "--context-revision", "7", "--output", path, "--timeout", "180",
        ]);
        active = record();
        return JSON.stringify(active);
      }
      if (action === "stop") {
        active = null;
        return JSON.stringify(record("completed"));
      }
      throw new Error("unexpected command");
    },
  });
  return { coordinator, calls };
}

test("canonical CLI owns recording lifecycle and the captured view/target/destination", async () => {
  const { coordinator, calls } = fixture();
  const started = await coordinator.start(invocation);
  assert.deepEqual(started, {
    deviceId: "target-one", isRecording: true, outputPath: path,
    startedAt: "2026-10-10T01:00:00Z", timeoutSeconds: 180,
  });
  assert.equal((await coordinator.status(invocation)).isRecording, true);
  assert.deepEqual(await coordinator.status({ ...invocation, targetId: "target-two" }), {
    deviceId: "target-two", isRecording: false, outputPath: null, startedAt: null, timeoutSeconds: null,
  });
  await assert.rejects(coordinator.stop("target-two"), { code: "recording_not_tracked" });
  assert.equal((await coordinator.stop("target-one")).isRecording, false);
  await coordinator.finalize();
  assert.deepEqual(calls.map((call) => call.action), ["status", "start", "status", "stop"]);
});

test("lost start acceptance is not replayed; only captured status/stop can recover it", async () => {
  const calls = [];
  let active = null;
  const { coordinator } = fixture({
    run(action, _args) {
      calls.push(action);
      if (action === "status") return JSON.stringify(active);
      if (action === "start") {
        active = record();
        throw new Error("lost accepted start response");
      }
      if (action === "stop") {
        active = null;
        return JSON.stringify(record("completed"));
      }
    },
  });
  await assert.rejects(coordinator.start(invocation), /lost accepted start/);
  await assert.rejects(coordinator.start(invocation), { code: "recording_already_tracked" });
  assert.equal((await coordinator.status(invocation)).isRecording, true);
  await coordinator.finalize();
  assert.deepEqual(calls, ["status", "start", "status", "status", "status", "stop"]);
});

test("close uses native pending-start recovery when status cannot name the accepted recording", async () => {
  const calls = [];
  const { coordinator } = fixture({
    run(action) {
      calls.push(action);
      if (action === "status") return "null";
      if (action === "start") throw new Error("lost native start acknowledgement");
      if (action === "stop") return JSON.stringify(record("completed"));
    },
  });
  const starting = coordinator.start(invocation);
  const closing = coordinator.finalize();
  await assert.rejects(starting, /lost native start/);
  await closing;
  assert.deepEqual(calls, ["status", "start", "stop"]);
});

test("lost stop response and failed download retain original owner without a second stop", async () => {
  let stops = 0;
  const calls = [];
  const { coordinator } = fixture({
    run(action) {
      calls.push(action);
      if (action === "status") return JSON.stringify(stops ? record("completed") : null);
      if (action === "start") return JSON.stringify(record());
      if (action === "stop") {
        if (++stops === 1) throw new Error("canonical accepted stop but download failed");
        return JSON.stringify(record("completed"));
      }
    },
  });
  await coordinator.start(invocation, { outputPath: path });
  await assert.rejects(coordinator.stop("target-one"), /download failed/);
  await assert.rejects(coordinator.start(invocation), { code: "recording_already_tracked" });
  await assert.rejects(coordinator.finalize(), { code: "recording_stop_unresolved" });
  assert.equal(coordinator.tracked, true);
  assert.deepEqual(calls, ["status", "start", "stop", "status", "status", "status"]);
});

test("an ambiguous failed stop cannot submit a second CLI stop even after a terminal artifact", async () => {
  let stops = 0;
  const { coordinator } = fixture({
    run(action) {
      if (action === "status") return JSON.stringify(stops ? record("completed") : null);
      if (action === "start") return JSON.stringify(record());
      if (action === "stop") {
        stops += 1;
        throw new Error("the native stop outcome is ambiguous");
      }
    },
  });
  await coordinator.start(invocation);
  await assert.rejects(coordinator.stop("target-one"), /ambiguous/);
  await assert.rejects(coordinator.stop("target-one"), { code: "recording_stop_unresolved" });
  await assert.rejects(coordinator.finalize(), { code: "recording_stop_unresolved" });
  assert.equal(stops, 1);
  assert.equal(coordinator.tracked, true);
});

test("cancelling is nonterminal and mismatched host/target/surface/output never clears owner", async () => {
  let status = "cancelling";
  let active = false;
  const { coordinator } = fixture({
    run(action) {
      if (action === "status") return JSON.stringify(active ? record(status) : null);
      if (action === "start") { active = true; return JSON.stringify(record(status)); }
      if (action === "stop") return JSON.stringify(status === "cancelling"
        ? { ...record(status), artifactId: "artifact-unsettled" } : record("completed"));
    },
  });
  await coordinator.start(invocation);
  await assert.rejects(coordinator.stop("target-one"), { code: "recording_not_finalized" });
  status = "completed";
  await assert.rejects(coordinator.finalize(), { code: "recording_stop_unresolved" });
  assert.equal(coordinator.tracked, true);
  for (const field of ["targetHostId", "targetId", "surfaceId", "outputFile"]) {
    const { coordinator: wrong } = fixture({
      run(action) {
        if (action === "status") return JSON.stringify(null);
        return JSON.stringify({ ...record(), [field]: "replacement" });
      },
    });
    await assert.rejects(wrong.start(invocation), { code: "recording_owner_mismatch" });
    assert.equal(wrong.tracked, true);
  }
});

test("same-key concurrent starts submit exactly one native start and release a bounded slot", async () => {
  let accept;
  const blocked = new Promise((resolve) => { accept = resolve; });
  let starts = 0;
  let active = false;
  const { coordinator } = fixture({
    async run(action) {
      if (action === "status") return JSON.stringify(active ? record() : null);
      if (action === "start") {
        starts += 1;
        await blocked;
        active = true;
        return JSON.stringify(record());
      }
      active = false;
      return JSON.stringify(record("completed"));
    },
  });
  const first = coordinator.start(invocation);
  const second = coordinator.start(invocation);
  accept();
  assert.equal((await first).isRecording, true);
  await assert.rejects(second, { code: "recording_already_tracked" });
  assert.equal(starts, 1);
  await coordinator.finalize();
  assert.equal(coordinator.tracked, false);
});

test("close queued during an unacknowledged start finalizes that accepted owner before releasing", async () => {
  let accept;
  const pendingStart = new Promise((resolve) => { accept = resolve; });
  const commands = [];
  let tracked = false;
  const { coordinator } = fixture({
    async run(action) {
      commands.push(action);
      if (action === "status") return JSON.stringify(tracked ? record() : null);
      if (action === "start") {
        await pendingStart;
        tracked = true;
        return JSON.stringify(record());
      }
      tracked = false;
      return JSON.stringify(record("completed"));
    },
  });
  const starting = coordinator.start(invocation);
  const closing = coordinator.finalize();
  await Promise.resolve();
  assert.equal(commands.includes("stop"), false);
  accept();
  await starting;
  await closing;
  assert.equal(coordinator.tracked, false);
  assert.deepEqual(commands, ["status", "start", "status", "stop"]);
});

test("the shared owner refuses a 65th queued recording intent without dispatching it", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const { coordinator } = fixture({
    async run() {
      calls += 1;
      await blocked;
      return "null";
    },
  });
  const pending = Array.from({ length: 64 }, () => coordinator.status(invocation));
  await assert.rejects(coordinator.status(invocation), { code: "recording_queue_limit" });
  release();
  await Promise.all(pending);
  assert.equal(calls, 64);
});

test("an externally finalized recording clears only after its captured output exists", async () => {
  await mkdir(join(process.cwd(), ".build"), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), ".build", "recording-"));
  const outputFile = join(directory, "captured.mp4");
  let active = false;
  const { coordinator, calls } = fixture({
    run(action) {
      if (action === "status") return JSON.stringify(active ? { ...record(), outputFile } : null);
      if (action === "start") {
        active = true;
        return JSON.stringify({ ...record(), outputFile });
      }
      throw new Error("An externally finalized recording must not be stopped twice.");
    },
  });
  try {
    await coordinator.start(invocation, { outputPath: outputFile });
    active = false;
    await assert.rejects(coordinator.status(invocation), { code: "recording_state_unresolved" });
    assert.equal(coordinator.tracked, true);
    await writeFile(outputFile, "synthetic-mp4-fixture");
    const status = await coordinator.status(invocation);
    assert.equal(status.isRecording, false);
    assert.equal(status.outputPath, outputFile);
    assert.equal(coordinator.tracked, false);
    await assert.rejects(recordingOutputPath(outputFile, "ios"), { code: "recording_output_exists" });
    assert.equal(calls.filter((call) => call.action === "stop").length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a replacement runtime lease retains the original view's recording owner", async () => {
  await mkdir(join(process.cwd(), ".build"), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), ".build", "recording-lease-"));
  const previousContext = process.env.AILOHA_TEST_CONTEXT_STATE;
  const recordingState = {};
  const scope = { sessionId: randomUUID(), viewId: randomUUID() };
  const outputPath = join(directory, "original.mp4");
  process.env.AILOHA_TEST_CONTEXT_STATE = join(directory, "context.json");
  sdkDouble.scenario.recordingEnabled = true;
  const create = () => createRuntimeMobileBackend({
    scope, recordingState,
    runtime: async () => ({
      sdk: sdkDouble, pin: { version: "synthetic-only", sourceSha: sdkDouble.sourceSha },
    }),
  });
  let first;
  let replacement;
  try {
    first = await create();
    await first.select("opaque/target");
    assert.equal((await first.recordingStart("opaque/target", { outputPath })).isRecording, true);
    const captured = recordingState.coordinator;
    assert.equal(captured.tracked, true);
    await first.dispose();
    replacement = await create();
    assert.equal(recordingState.coordinator, captured);
    assert.equal((await replacement.recordingStatus("opaque/target")).outputPath, outputPath);
    assert.equal((await replacement.recordingStop("opaque/target")).isRecording, false);
    assert.equal((await readFile(outputPath, "utf8")), "synthetic-mp4-fixture");
    const commands = (await readFile(`${process.env.AILOHA_TEST_CONTEXT_STATE}.recording-calls`, "utf8")).trim().split("\n");
    assert.equal(commands.filter((action) => action === "start").length, 1);
    assert.equal(commands.filter((action) => action === "stop").length, 1);
  } finally {
    await replacement?.dispose();
    await first?.dispose();
    sdkDouble.scenario.recordingEnabled = false;
    if (previousContext === undefined) delete process.env.AILOHA_TEST_CONTEXT_STATE;
    else process.env.AILOHA_TEST_CONTEXT_STATE = previousContext;
    await rm(directory, { recursive: true, force: true });
  }
});

test("host output rejects invalid paths and generates unique local recording destinations", async () => {
  await assert.rejects(recordingOutputPath("../recording.mp4", "ios"), { code: "invalid_output" });
  await assert.rejects(recordingOutputPath("/safe/file.mov", "ios"), { code: "invalid_output" });
  await assert.rejects(recordingOutputPath(undefined, "remote"), { code: "recording_platform_unsupported" });
  assert.equal(await recordingOutputPath(path, "ios"), path);
  const first = await recordingOutputPath(undefined, "ios");
  const second = await recordingOutputPath(undefined, "ios");
  assert.notEqual(first, second);
  assert.match(first, /\.mobile-canvas\/artifacts\/recordings\/ios-.*\.mp4$/);
});
