import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { productModule } from "../ailoha-test-module.mjs";
import * as sdkDouble from "./fixtures/ailoha-sdk-double.mjs";

const { AilohaRecordingCoordinator } = await import(productModule("lib/ailoha/recording-coordinator.mjs"));
const { captureRecordingStartInput, recordingOutputPath } = await import(productModule("lib/ailoha/recording-artifact.mjs"));
const { createRuntimeMobileBackend } = await import(productModule("lib/ailoha/runtime-backend.mjs"));
const { createVerifiedAilohaCli, hasVerifiedRecordingRecovery } = await import(productModule("lib/ailoha/runtime-sdk.mjs"));

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
const recovery = (entry = record("completed"), overrides = {}) => ({
  ...entry, outcome: "downloaded", hostInstanceId: entry.hostInstanceId ?? "instance-one",
  stopOperationId: "stop-operation-one", stopRequestId: "stop-request-one",
  contextRef: "ctx-captured", scopeEpoch: "epoch-captured", contextRevision: "7",
  downloadedAt: "2026-10-10T01:02:00Z", downloadedLength: 21,
  ...overrides,
});
const unresolved = (outcome = "pending", entry = record()) => ({
  ...entry, outcome, code: "RecordingPending",
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
      if (action === "recover") return JSON.stringify(recovery());
      throw new Error("unexpected command");
    },
  });
  return { coordinator, calls };
}

test("recording inputs retain only validated scalars before asynchronous coordination", () => {
  const input = { timeoutSeconds: 180, outputPath: path, ignored: "not a recording option" };
  const captured = captureRecordingStartInput(input);
  input.timeoutSeconds = 1;
  input.outputPath = "/safe/replacement.mp4";
  assert.deepEqual(captured, { timeoutSeconds: 180, outputPath: path });
  assert.equal(Object.isFrozen(captured), true);
  assert.deepEqual(captureRecordingStartInput(), { timeoutSeconds: 180 });
  for (const invalid of [null, [], 0, "record", { timeoutSeconds: null }, { timeoutSeconds: 3601 }]) {
    assert.throws(() => captureRecordingStartInput(invalid), { code: "invalid_request" });
  }
  for (const invalid of ["relative.mp4", "/safe/file.mov", "", 42]) {
    assert.throws(() => captureRecordingStartInput({ outputPath: invalid }), { code: "invalid_output" });
  }
});

test("recording status advertises possible recovery writes only in the Ailoha MCP catalog", async () => {
  const { ailohaMcpCatalog } = await import(productModule("lib/ailoha/mcp-host.mjs"));
  const catalog = await ailohaMcpCatalog();
  const status = catalog.find((tool) => tool.name === "mobile_device_recording_status");
  assert.equal(status.annotations.readOnlyHint, false);
  assert.equal(status.annotations.destructiveHint, false);
  assert.match(status.description, /download the original recording/);
  const { readFile } = await import("node:fs/promises");
  const baseline = JSON.parse(await readFile(new URL(productModule("lib/ailoha/mcp-catalog.json")), "utf8"));
  assert.equal(baseline.tools.find((tool) => tool.name === "mobile_device_recording_status").annotations.readOnlyHint, true);
});

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
  assert.deepEqual(calls.map((call) => call.action), ["status", "start", "status", "stop", "recover"]);
});

test("an untracked same-view host cannot finalize another host's accepted recording", async () => {
  const calls = [];
  let active = null;
  const run = async (args) => {
    const action = args[1];
    calls.push(action);
    if (action === "status") return JSON.stringify(active);
    if (action === "start") {
      active = record();
      return JSON.stringify(active);
    }
    if (action === "stop") {
      active = null;
      return JSON.stringify(record("completed"));
    }
    if (action === "recover") return JSON.stringify(recovery());
    throw new Error("Unexpected recording command.");
  };
  const output = async () => path;
  const original = new AilohaRecordingCoordinator({ run, output });
  const other = new AilohaRecordingCoordinator({ run, output });
  await original.start(invocation);
  const changedView = {
    ...invocation, executionContext: { ...invocation.executionContext, revision: "8" },
  };
  assert.equal((await other.status(changedView)).isRecording, true);
  assert.equal(other.tracked, false);
  await assert.rejects(other.start(changedView), { code: "recording_already_tracked" });
  assert.equal(other.tracked, false);
  await assert.rejects(other.stop("target-one"), { code: "recording_not_tracked" });
  await other.finalize();
  assert.equal(active?.state, "recording");
  assert.equal(calls.filter((action) => action === "stop").length, 0);
  await original.finalize();
  assert.equal(calls.filter((action) => action === "stop").length, 1);
  assert.equal(original.tracked, false);
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
      if (action === "recover") return JSON.stringify(recovery());
    },
  });
  await assert.rejects(coordinator.start(invocation), /lost accepted start/);
  await assert.rejects(coordinator.start(invocation), { code: "recording_already_tracked" });
  assert.equal((await coordinator.status(invocation)).isRecording, true);
  await coordinator.finalize();
  assert.deepEqual(calls, ["status", "start", "status", "status", "status", "stop", "recover"]);
});

test("pending canonical status retains the original owner without pinning an empty recording ID", async () => {
  let state = "pending";
  let starts = 0;
  let stops = 0;
  const owned = {
    ...record(), hostInstanceId: "instance-one",
    contextRef: "ctx-captured", scopeEpoch: "epoch-captured", contextRevision: "7",
  };
  const { coordinator } = fixture({
    run(action) {
      if (action === "status") {
        if (!starts) return "null";
        return JSON.stringify(state === "pending"
          ? { ...owned, state, recordingId: "" } : { ...owned, state });
      }
      if (action === "start") {
        starts += 1;
        throw new Error("accepted start response lost");
      }
      if (action === "recover") return JSON.stringify(recovery({
        ...owned, state: "completed", artifactId: "artifact-one",
      }));
      stops += 1;
      return JSON.stringify({ ...owned, state: "completed", artifactId: "artifact-one" });
    },
  });
  await assert.rejects(coordinator.start(invocation), /response lost/);
  assert.equal((await coordinator.status(invocation)).isRecording, true);
  await assert.rejects(coordinator.start(invocation), { code: "recording_already_tracked" });
  state = "recording";
  assert.equal((await coordinator.status(invocation)).isRecording, true);
  assert.equal((await coordinator.stop("target-one")).isRecording, false);
  assert.equal(starts, 1);
  assert.equal(stops, 1);
});

test("unassigned pending recovery omits recording and operation IDs without permitting stop replay", async () => {
  const { recordingId: _unassigned, ...pending } = record("pending");
  let accepted = false;
  let stops = 0;
  const { coordinator } = fixture({
    run(action) {
      if (action === "status") return JSON.stringify(accepted
        ? { ...pending, hostInstanceId: "instance-one", requestId: "start-request-one" } : null);
      if (action === "start") {
        accepted = true;
        throw new Error("unacknowledged start");
      }
      if (action === "stop") {
        stops += 1;
        throw new Error("stop acceptance unknown");
      }
      if (action === "recover") return JSON.stringify({
        ...pending, hostInstanceId: "instance-one", requestId: "start-request-one",
        contextRef: "ctx-captured", scopeEpoch: "epoch-captured", contextRevision: "7",
        outcome: "unknown", code: "RecordingAcceptanceUnknown",
      });
    },
  });
  await assert.rejects(coordinator.start(invocation), /unacknowledged start/);
  assert.equal((await coordinator.status(invocation)).isRecording, true);
  await assert.rejects(coordinator.stop("target-one"), /stop acceptance unknown/);
  await assert.rejects(coordinator.finalize(), { code: "recording_recovery_unknown" });
  await assert.rejects(coordinator.start(invocation), { code: "recording_recovery_unknown" });
  assert.equal(stops, 1);
  assert.equal(coordinator.tracked, true);
});

test("canonical context and host incarnation cannot change after an accepted pending start", async () => {
  let status = null;
  let stops = 0;
  const { coordinator } = fixture({
    run(action) {
      if (action === "status") return JSON.stringify(status);
      if (action === "start") throw new Error("accepted start response lost");
      stops += 1;
      return JSON.stringify(record("completed"));
    },
  });
  await assert.rejects(coordinator.start(invocation), /response lost/);
  status = { ...record("pending"), recordingId: "", hostInstanceId: "instance-one",
    contextRef: "ctx-captured", scopeEpoch: "epoch-captured", contextRevision: "7" };
  assert.equal((await coordinator.status(invocation)).isRecording, true);
  status = { ...record(), hostInstanceId: "instance-two",
    contextRef: "ctx-captured", scopeEpoch: "epoch-captured", contextRevision: "7" };
  await assert.rejects(coordinator.status(invocation), { code: "recording_owner_mismatch" });
  status = { ...status, hostInstanceId: "instance-one", scopeEpoch: "epoch-replaced" };
  await assert.rejects(coordinator.status(invocation), { code: "recording_owner_mismatch" });
  await assert.rejects(coordinator.start(invocation), { code: "recording_owner_mismatch" });
  assert.equal(coordinator.tracked, true);
  assert.equal(stops, 0);
});

test("close uses native pending-start recovery when status cannot name the accepted recording", async () => {
  const calls = [];
  const { coordinator } = fixture({
    run(action) {
      calls.push(action);
      if (action === "status") return "null";
      if (action === "start") throw new Error("lost native start acknowledgement");
      if (action === "stop") return JSON.stringify(record("completed"));
      if (action === "recover") return JSON.stringify(recovery());
    },
  });
  const starting = coordinator.start(invocation);
  const closing = coordinator.finalize();
  await assert.rejects(starting, /lost native start/);
  await closing;
  assert.deepEqual(calls, ["status", "start", "stop", "recover"]);
});

test("lost stop response and failed download retain original owner without a second stop", async () => {
  let stops = 0;
  const calls = [];
  const { coordinator } = fixture({
    run(action) {
      calls.push(action);
      if (action === "status") return JSON.stringify(stops ? record("completed") : null);
      if (action === "start") return JSON.stringify(record());
      if (action === "recover") return JSON.stringify({
        ...unresolved("downloadFailed", record("completed")), code: "ArtifactDownloadFailed",
      });
      if (action === "stop") {
        if (++stops === 1) throw new Error("canonical accepted stop but download failed");
        return JSON.stringify(record("completed"));
      }
    },
  });
  await coordinator.start(invocation, { outputPath: path });
  await assert.rejects(coordinator.stop("target-one"), /download failed/);
  await assert.rejects(coordinator.start(invocation), { code: "recording_recovery_download_failed" });
  await assert.rejects(coordinator.finalize(), { code: "recording_recovery_download_failed" });
  assert.equal(coordinator.tracked, true);
  assert.deepEqual(calls, ["status", "start", "stop", "recover", "recover"]);
});

test("an ambiguous failed stop cannot submit a second CLI stop even after a terminal artifact", async () => {
  let stops = 0;
  const { coordinator } = fixture({
    run(action) {
      if (action === "status") return JSON.stringify(stops ? record("completed") : null);
      if (action === "start") return JSON.stringify(record());
      if (action === "recover") return JSON.stringify(unresolved());
      if (action === "stop") {
        stops += 1;
        throw new Error("the native stop outcome is ambiguous");
      }
    },
  });
  await coordinator.start(invocation);
  await assert.rejects(coordinator.stop("target-one"), /ambiguous/);
  await assert.rejects(coordinator.stop("target-one"), { code: "recording_recovery_pending" });
  await assert.rejects(coordinator.finalize(), { code: "recording_recovery_pending" });
  assert.equal(stops, 1);
  assert.equal(coordinator.tracked, true);
});

test("a known failed or unattempted stop remains owned without resubmission", async () => {
  for (const [outcome, code] of [
    ["failed", "RecordingStopFailed"],
    ["notAttempted", "RecordingStopNotAttempted"],
  ]) {
    let stops = 0;
    const { coordinator } = fixture({
      run(action) {
        if (action === "status") return "null";
        if (action === "start") return JSON.stringify(record());
        if (action === "stop") {
          stops += 1;
          throw new Error("original stop outcome unavailable");
        }
        if (action === "recover") return JSON.stringify({
          ...unresolved(outcome, record("failed")), code,
        });
      },
    });
    await coordinator.start(invocation);
    await assert.rejects(coordinator.stop("target-one"), /outcome unavailable/);
    const expected = `recording_recovery_${outcome === "notAttempted" ? "not_attempted" : outcome}`;
    await assert.rejects(coordinator.stop("target-one"), { code: expected });
    await assert.rejects(coordinator.finalize(), { code: expected });
    assert.equal(coordinator.tracked, true);
    assert.equal(stops, 1);
  }
});

test("failed artifact download retries only captured recovery after active pointer deletion", async () => {
  let outcome = "downloadFailed";
  let stops = 0;
  const calls = [];
  const { coordinator } = fixture({
    run(action) {
      calls.push(action);
      if (action === "status") return "null";
      if (action === "start") return JSON.stringify(record());
      if (action === "stop") {
        stops += 1;
        return JSON.stringify(record("completed"));
      }
      if (action === "recover") return JSON.stringify(outcome === "downloaded"
        ? recovery() : { ...unresolved(outcome, record("completed")), code: "ArtifactDownloadFailed" });
    },
  });
  await coordinator.start(invocation);
  await assert.rejects(coordinator.stop("target-one"), { code: "recording_recovery_download_failed" });
  await assert.rejects(coordinator.finalize(), { code: "recording_recovery_download_failed" });
  assert.equal(coordinator.tracked, true);
  outcome = "downloaded";
  assert.equal((await coordinator.status(invocation)).isRecording, false);
  assert.equal(coordinator.tracked, false);
  assert.equal(stops, 1);
  assert.deepEqual(calls, ["status", "start", "stop", "recover", "recover", "recover"]);
});

test("lost successful recovery response replays only its durable receipt", async () => {
  let recoveries = 0;
  let stops = 0;
  const { coordinator } = fixture({
    run(action) {
      if (action === "status") return "null";
      if (action === "start") return JSON.stringify(record());
      if (action === "stop") {
        stops += 1;
        return JSON.stringify(record("completed"));
      }
      if (action === "recover") {
        recoveries += 1;
        if (recoveries === 1) throw new Error("completed recovery response lost");
        return JSON.stringify(recovery());
      }
    },
  });
  await coordinator.start(invocation);
  await assert.rejects(coordinator.stop("target-one"), /response lost/);
  assert.equal(coordinator.tracked, true);
  await coordinator.finalize();
  assert.equal(coordinator.tracked, false);
  assert.equal(stops, 1);
  assert.equal(recoveries, 2);
});

test("a downloaded receipt must match every pinned owner and stop identity", async () => {
  const begun = {
    ...record(), hostInstanceId: "instance-one",
    operationId: "start-operation-one", requestId: "start-request-one",
  };
  const stopped = {
    ...record("completed"), hostInstanceId: "instance-one",
    operationId: "terminal-operation-one", stopOperationId: "stop-operation-one",
    stopRequestId: "stop-request-one",
  };
  const valid = recovery({
    ...stopped, operationId: begun.operationId, requestId: begun.requestId,
  });
  for (const field of [
    "recordingId", "targetHostId", "hostInstanceId", "targetId", "surfaceId", "outputFile",
    "contextRef", "scopeEpoch", "contextRevision", "operationId", "requestId",
    "stopOperationId", "stopRequestId", "artifactId",
  ]) {
    let stops = 0;
    const { coordinator } = fixture({
      run(action) {
        if (action === "status") return "null";
        if (action === "start") return JSON.stringify(begun);
        if (action === "stop") {
          stops += 1;
          return JSON.stringify(stopped);
        }
        if (action === "recover") return JSON.stringify({ ...valid, [field]: "/replacement.mp4" });
      },
    });
    await coordinator.start(invocation);
    await assert.rejects(coordinator.stop("target-one"), { code: "recording_owner_mismatch" }, field);
    await assert.rejects(coordinator.finalize(), { code: "recording_owner_mismatch" }, field);
    assert.equal(coordinator.tracked, true, field);
    assert.equal(stops, 1, field);
  }
  for (const invalid of [
    { state: "failed" }, { state: "cancelled" }, { artifactId: undefined },
    { stopOperationId: undefined }, { stopRequestId: undefined },
    { downloadedAt: undefined }, { downloadedLength: -1 }, { downloadedLength: 0 },
  ]) {
    let stops = 0;
    const { coordinator } = fixture({
      run(action) {
        if (action === "status") return "null";
        if (action === "start") return JSON.stringify(begun);
        if (action === "stop") {
          stops += 1;
          return JSON.stringify(stopped);
        }
        if (action === "recover") return JSON.stringify({ ...valid, ...invalid });
      },
    });
    await coordinator.start(invocation);
    await assert.rejects(coordinator.stop("target-one"), { code: "recording_owner_mismatch" });
    assert.equal(coordinator.tracked, true);
    assert.equal(stops, 1);
  }
});

test("cancelling is nonterminal and mismatched host/target/surface/output never clears owner", async () => {
  let status = "cancelling";
  let active = false;
  const { coordinator } = fixture({
    run(action) {
      if (action === "status") return JSON.stringify(active ? record(status) : null);
      if (action === "start") { active = true; return JSON.stringify(record(status)); }
      if (action === "recover") return JSON.stringify(unresolved());
      if (action === "stop") return JSON.stringify(status === "cancelling"
        ? { ...record(status), artifactId: "artifact-unsettled" } : record("completed"));
    },
  });
  await coordinator.start(invocation);
  await assert.rejects(coordinator.stop("target-one"), { code: "recording_not_finalized" });
  status = "completed";
  await assert.rejects(coordinator.finalize(), { code: "recording_recovery_pending" });
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

test("a failed or cancelled recording never reports a completed stop even with an artifact", async () => {
  for (const state of ["failed", "cancelled", "canceled"]) {
    let active = false;
    let stops = 0;
    const { coordinator } = fixture({
      run(action) {
        if (action === "status") return JSON.stringify(active ? record() : null);
        if (action === "start") { active = true; return JSON.stringify(record()); }
        if (action === "recover") return JSON.stringify({
          ...unresolved("failed", record(state)), code: "RecordingTerminalFailed",
        });
        if (action === "stop") {
          stops += 1;
          return JSON.stringify({ ...record(state), artifactId: "artifact-needs-verification" });
        }
      },
    });
    await coordinator.start(invocation);
    await assert.rejects(coordinator.stop("target-one"), { code: "recording_not_finalized" });
    await assert.rejects(coordinator.finalize(), { code: "recording_recovery_failed" });
    assert.equal(coordinator.tracked, true);
    assert.equal(stops, 1);
  }
});

test("a failed stop response can recover a later proven completed recording without another stop", async () => {
  let stops = 0;
  let ready = false;
  const { coordinator } = fixture({
    run(action) {
      if (action === "status") return "null";
      if (action === "start") return JSON.stringify(record());
      if (action === "stop") {
        stops += 1;
        return JSON.stringify({ ...record("failed"), artifactId: "artifact-one" });
      }
      if (action === "recover") return JSON.stringify(ready
        ? recovery() : { ...unresolved("pending"), code: "RecordingOperationPending" });
    },
  });
  await coordinator.start(invocation);
  await assert.rejects(coordinator.stop("target-one"), { code: "recording_not_finalized" });
  await assert.rejects(coordinator.finalize(), { code: "recording_recovery_pending" });
  ready = true;
  await coordinator.finalize();
  assert.equal(stops, 1);
  assert.equal(coordinator.tracked, false);
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
      if (action === "recover") return JSON.stringify(recovery());
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
      if (action === "recover") return JSON.stringify(recovery());
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
  assert.deepEqual(commands, ["status", "start", "status", "stop", "recover"]);
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

test("an externally written MP4 never proves the captured recording finalized", async () => {
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
    await writeFile(outputFile, "");
    await assert.rejects(coordinator.status(invocation), { code: "recording_state_unresolved" });
    await writeFile(outputFile, "synthetic-mp4-fixture");
    await assert.rejects(coordinator.status(invocation), { code: "recording_state_unresolved" });
    await assert.rejects(coordinator.finalize(), { code: "recording_state_unresolved" });
    await assert.rejects(coordinator.start(invocation, { outputPath: outputFile }), { code: "recording_state_unresolved" });
    assert.equal(coordinator.tracked, true);
    await assert.rejects(recordingOutputPath(outputFile, "ios"), { code: "recording_output_exists" });
    assert.equal(calls.filter((call) => call.action === "start").length, 1);
    assert.equal(calls.filter((call) => call.action === "stop").length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lost stop response cannot clear owner from a file without an authoritative receipt", async () => {
  await mkdir(join(process.cwd(), ".build"), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), ".build", "recording-stop-"));
  const outputFile = join(directory, "landed.mp4");
  let active = false;
  let stops = 0;
  const { coordinator } = fixture({
    async run(action) {
      if (action === "status") return JSON.stringify(active ? { ...record(), outputFile } : null);
      if (action === "start") {
        active = true;
        return JSON.stringify({ ...record(), outputFile });
      }
      if (action === "recover") return JSON.stringify(unresolved("unknown", {
        ...record("completed"), outputFile,
      }));
      stops += 1;
      active = false;
      await writeFile(outputFile, "synthetic-mp4-fixture");
      throw new Error("accepted stop response lost after artifact landing");
    },
  });
  try {
    await coordinator.start(invocation, { outputPath: outputFile });
    await assert.rejects(coordinator.stop("target-one"), /response lost/);
    await assert.rejects(coordinator.finalize(), { code: "recording_recovery_unknown" });
    assert.equal(coordinator.tracked, true);
    assert.equal(stops, 1);
    assert.equal(await readFile(outputFile, "utf8"), "synthetic-mp4-fixture");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a replacement recording ID on the same target and output never changes the captured owner", async () => {
  let active = false;
  let stops = 0;
  const { coordinator } = fixture({
    run(action) {
      if (action === "status") return JSON.stringify(active
        ? { ...record(), recordingId: "replacement-recording" } : null);
      if (action === "start") {
        active = true;
        return JSON.stringify(record());
      }
      stops += 1;
      return JSON.stringify(record("completed"));
    },
  });
  await coordinator.start(invocation);
  await assert.rejects(coordinator.status(invocation), { code: "recording_owner_mismatch" });
  await assert.rejects(coordinator.finalize(), { code: "recording_owner_mismatch" });
  await assert.rejects(coordinator.start(invocation), { code: "recording_owner_mismatch" });
  assert.equal(coordinator.tracked, true);
  assert.equal(stops, 0);
});

test("a lost start only pins its recording ID after the original owner-matched status", async () => {
  let active = false;
  let stops = 0;
  const { coordinator } = fixture({
    run(action) {
      if (action === "status") return JSON.stringify(active ? record() : null);
      if (action === "start") {
        active = true;
        throw new Error("lost accepted start response");
      }
      if (action === "recover") return JSON.stringify(recovery({
        ...record("completed"), recordingId: "replacement-recording",
      }));
      stops += 1;
      return JSON.stringify({ ...record("completed"), recordingId: "replacement-recording" });
    },
  });
  await assert.rejects(coordinator.start(invocation), /lost accepted/);
  assert.equal((await coordinator.status(invocation)).isRecording, true);
  await assert.rejects(coordinator.stop("target-one"), { code: "recording_owner_mismatch" });
  assert.equal(stops, 1);
  assert.equal(coordinator.tracked, true);
  await assert.rejects(coordinator.stop("target-one"), { code: "recording_owner_mismatch" });
  assert.equal(stops, 1);
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
    process.env.AILOHA_TEST_RECOVERY_COMMANDS = "missing";
    replacement = await create();
    assert.equal(recordingState.coordinator, captured);
    assert.equal((await replacement.getDevice("opaque/target")).capabilities.recording, false);
    await assert.rejects(replacement.recordingStart("opaque/target", { outputPath: join(directory, "new.mp4") }),
      { code: "capability_not_supported" });
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
    delete process.env.AILOHA_TEST_RECOVERY_COMMANDS;
    if (previousContext === undefined) delete process.env.AILOHA_TEST_CONTEXT_STATE;
    else process.env.AILOHA_TEST_CONTEXT_STATE = previousContext;
    await rm(directory, { recursive: true, force: true });
  }
});

test("verified offline command discovery gates new recording without touching the target", async () => {
  await mkdir(join(process.cwd(), ".build"), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), ".build", "recording-commands-"));
  const previousContext = process.env.AILOHA_TEST_CONTEXT_STATE;
  process.env.AILOHA_TEST_CONTEXT_STATE = join(directory, "context.json");
  sdkDouble.scenario.recordingEnabled = true;
  const scope = { sessionId: randomUUID(), viewId: randomUUID() };
  const create = () => createRuntimeMobileBackend({
    scope, recordingState: {},
    runtime: async () => ({
      sdk: sdkDouble, pin: { version: "synthetic-only", sourceSha: sdkDouble.sourceSha },
    }),
  });
  let backend;
  try {
    process.env.AILOHA_TEST_RECOVERY_COMMANDS = "missing";
    backend = await create();
    await backend.select("opaque/target");
    assert.equal((await backend.getDevice("opaque/target")).capabilities.recording, false);
    const blocked = await backend.request("/api/v1/devices/opaque%2Ftarget/recording/start", {
      method: "POST", body: JSON.stringify({ outputPath: join(directory, "blocked.mp4") }),
    });
    assert.equal(blocked.status, 501);
    assert.equal((await blocked.json()).code, "capability_not_supported");
    assert.equal((await backend.recordingStatus("opaque/target")).isRecording, false);
    assert.deepEqual((await readFile(`${process.env.AILOHA_TEST_CONTEXT_STATE}.recording-calls`, "utf8")).trim().split("\n"),
      ["status"]);
    await backend.dispose();
    backend = null;
    for (const mode of ["malformed", "fail"]) {
      process.env.AILOHA_TEST_RECOVERY_COMMANDS = mode;
      await assert.rejects(create(), { code: mode === "malformed" ? "ailoha_commands_invalid" : "ailoha_cli_failed" });
    }
  } finally {
    await backend?.dispose();
    sdkDouble.scenario.recordingEnabled = false;
    delete process.env.AILOHA_TEST_RECOVERY_COMMANDS;
    if (previousContext === undefined) delete process.env.AILOHA_TEST_CONTEXT_STATE;
    else process.env.AILOHA_TEST_CONTEXT_STATE = previousContext;
    await rm(directory, { recursive: true, force: true });
  }
});

test("recording recovery requires one honest bounded command descriptor", async () => {
  const descriptors = [
    { command: "recording start", description: "Start", mutating: true },
    { command: "recording recover", description: "Download", mutating: true },
  ];
  const probe = (value) => hasVerifiedRecordingRecovery(async (args) => {
    assert.deepEqual(args, ["commands", "--json"]);
    return typeof value === "string" ? value : JSON.stringify(value);
  });
  assert.equal(await probe(descriptors), true);
  assert.equal(await probe(descriptors.slice(0, 1)), false);
  for (const invalid of [[], {}, "not-json", [{ command: "recording recover", mutating: true }],
    [{ ...descriptors[1], mutating: false }], [...descriptors, descriptors[1]], " ".repeat(512 * 1024 + 1)]) {
    await assert.rejects(probe(invalid), { code: "ailoha_commands_invalid" });
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

test("verified CLI preserves only typed nonzero recording recovery stdout", async () => {
  const pin = { version: "synthetic-only", sourceSha: "a".repeat(40) };
  const launchFor = (response) => createVerifiedAilohaCli({
    pin,
    sdk: {
      async getVerifiedCliLaunch() {
        return {
          ...pin, file: process.execPath,
          args: ["-e", `process.stdout.write(${JSON.stringify(response)});process.exit(1)`],
        };
      },
    },
  });
  const pending = JSON.stringify({
    outcome: "pending", code: "RecordingPending", recordingId: "",
    targetHostId: "host-one", targetId: "target-one", surfaceId: "surface-one",
  });
  assert.equal(await launchFor(pending)(["recording", "recover", "--json"]), pending);
  await assert.rejects(launchFor(pending)(["recording", "stop", "--json"]), { code: "ailoha_cli_failed" });
  await assert.rejects(launchFor(JSON.stringify({ outcome: "downloaded" }))(
    ["recording", "recover", "--json"]), { code: "ailoha_cli_failed" });
  await assert.rejects(launchFor("<unstructured failure>")(
    ["recording", "recover", "--json"]), { code: "ailoha_cli_failed" });
  const controller = new AbortController();
  const aborted = createVerifiedAilohaCli({
    pin,
    sdk: {
      async getVerifiedCliLaunch() {
        return {
          ...pin, file: process.execPath,
          args: ["-e", `process.stdout.write(${JSON.stringify(pending)});setInterval(() => {}, 1000)`],
        };
      },
    },
  });
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    await assert.rejects(aborted(["recording", "recover", "--json"], { signal: controller.signal }),
      { code: "ailoha_cli_cancelled" });
  } finally {
    clearTimeout(timer);
  }
});
