import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";

const { parseNativeStageOutcome, parseNativeDispatchOutcome } =
  await import(productModule("lib/ailoha/artifact-stage-protocol.mjs"));

const hash = (text) => createHash("sha256").update(text).digest("hex");
const date = "2026-10-10T00:00:00Z";
const invocation = {
  targetHostId: "host", targetId: "target", providerId: "provider",
  nativeIdentity: { nativeId: "native-device", platform: "ios" },
  executionContext: {
    contextRef: "ctx-original", scopeEpoch: "epoch", revision: "9",
    ownerProcessId: 42, processStartedAt: date,
  },
  contextOwner: { processId: 42, processStartedAt: date },
  connectionRef: { serviceId: "host", pid: 3, startedAt: date, processStartedAt: date },
};
const epochTicks = (BigInt(Date.parse(date)) + 62135596800000n) * 10000n;
const hostInstanceId = `host-${hash(`host\0${3}\0${epochTicks}\0${epochTicks}`)}`;
const fileExpected = {
  invocation, kind: "file", destination: "/Documents/zero", sourcePaths: ["/local/zero"],
  action: "continue",
};

function stage(expected = fileExpected, count = expected.sourcePaths.length) {
  const artifacts = expected.sourcePaths.slice(0, count).map((source, slot) => {
    const proof = {
      targetHostId: "host", targetId: "target", providerId: "provider",
      nativeTargetId: "native-device", nativeTargetPlatform: "ios",
      hostInstanceId, sourcePathHash: hash(source), destination: expected.destination,
      contextRef: "ctx-original", scopeEpoch: "epoch", revision: "9",
      ownerProcessId: 42, ownerStartedAt: date,
      stageId: "0123456789abcdef0123456789abcdef",
      expectedArtifactCount: expected.sourcePaths.length, stageSlot: slot,
    };
    return {
      artifact: {
        artifactId: `artifact-${slot}`, kind: expected.kind, status: "ready",
        contentType: "application/octet-stream", createdAt: date,
        fileName: source.split("/").at(-1), size: 0, sha256: hash(""), targetId: "target",
        metadata: { ...proof },
      },
      proof,
    };
  });
  return { kind: expected.kind, destination: expected.destination,
    expectedArtifactCount: expected.sourcePaths.length, artifacts };
}

const clone = (value) => structuredClone(value);
const stageText = (receipt, status = "ready") => JSON.stringify({ status, receipt });
const dispatchText = (receipt, status, extras = {}) => JSON.stringify({
  status, receipt, attemptId: "abcdef0123456789abcdef0123456789", ...extras,
});
const operation = (kind = "importStagedTargetFile") => ({
  operationId: "operation", kind, status: "queued", destructive: true,
  targetId: "target", providerId: "provider", createdAt: date,
  artifactIds: ["artifact-0"],
});
const fails = (fn, code) => assert.throws(fn, { name: "MobileAilohaError", code });

test("ready zero-byte native file yields immutable own receipt and exact continuation JSON", () => {
  const receipt = stage();
  const parsed = parseNativeStageOutcome(stageText(receipt), fileExpected);
  assert.equal(parsed.status, "ready");
  assert.equal(parsed.receipt.artifacts[0].artifact.size, 0);
  assert.equal(parsed.receiptJson, JSON.stringify(receipt));
  assert.deepEqual(JSON.parse(parsed.receiptJson), parsed.receipt);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.receipt.artifacts[0].proof));
  assert.notEqual(parsed.receipt, receipt);
  receipt.artifacts[0].proof.targetId = "altered";
  assert.equal(parsed.receipt.artifacts[0].proof.targetId, "target");
});

test("foreign owner, incarnation, context, native identity and proof metadata fail closed", () => {
  const changes = [
    ["artifact_stage_owner_mismatch", (r) => { r.artifacts[0].proof.providerId = "foreign"; }],
    ["artifact_stage_owner_mismatch", (r) => { r.artifacts[0].proof.hostInstanceId = "host-restarted"; }],
    ["artifact_stage_context_mismatch", (r) => { r.artifacts[0].proof.ownerStartedAt = "2026-10-11T00:00:00Z"; }],
    ["artifact_stage_context_mismatch", (r) => { r.artifacts[0].proof.revision = "10"; }],
    ["artifact_stage_native_identity_mismatch", (r) => { r.artifacts[0].proof.nativeTargetId = "replacement"; }],
    ["artifact_stage_source_mismatch", (r) => { r.artifacts[0].proof.sourcePathHash = hash("other"); }],
    ["artifact_stage_metadata_mismatch", (r) => { r.artifacts[0].artifact.metadata.destination = "/other"; }],
    ["artifact_stage_invalid_receipt", (r) => { r.artifacts[0].artifact.sha256 = "g".repeat(64); }],
  ];
  for (const [code, mutate] of changes) {
    const receipt = clone(stage());
    mutate(receipt);
    fails(() => parseNativeStageOutcome(stageText(receipt), fileExpected), code);
  }
});

test("counts, distinct IDs, slot permutation, stage identity and size bound are enforced", () => {
  const expected = { ...fileExpected, kind: "media", destination: "batch",
    sourcePaths: ["/local/first", "/local/second"] };
  const valid = stage(expected);
  valid.artifacts.reverse();
  assert.equal(parseNativeStageOutcome(stageText(valid), expected).receipt.artifacts.length, 2);
  const corruptions = [
    ["artifact_stage_count_mismatch", (r) => { r.expectedArtifactCount = 1; }],
    ["artifact_stage_source_mismatch", (r) => { r.artifacts[0].proof.stageSlot = r.artifacts[1].proof.stageSlot; }],
    ["artifact_stage_artifact_mismatch", (r) => { r.artifacts[0].artifact.artifactId = r.artifacts[1].artifact.artifactId; }],
    ["artifact_stage_slot_mismatch", (r) => {
      r.artifacts[0].proof.stageId = "f".repeat(32);
      r.artifacts[0].artifact.metadata.stageId = "f".repeat(32);
    }],
    ["artifact_stage_slot_mismatch", (r) => { r.artifacts[0].proof.expectedArtifactCount = 1; }],
    ["artifact_stage_invalid_receipt", (r) => { r.artifacts[0].artifact.size = -1; }],
  ];
  for (const [code, mutate] of corruptions) {
    const receipt = clone(valid);
    mutate(receipt);
    fails(() => parseNativeStageOutcome(stageText(receipt), expected), code);
  }
  const oversized = stage();
  oversized.artifacts[0].artifact.metadata.padding = "x".repeat(65536);
  fails(() => parseNativeStageOutcome(stageText(oversized), fileExpected), "artifact_stage_receipt_too_large");
  fails(() => parseNativeStageOutcome(stageText(stage(), "ready"),
    { ...fileExpected, sourcePaths: ["relative"] }), "artifact_stage_invalid_expected");
  fails(() => parseNativeStageOutcome(stageText(stage(), "ready"),
    { ...fileExpected, sourcePaths: ["/local/different"] }), "artifact_stage_source_mismatch");
});

test("incomplete stage retains its original receipt but never projects ready", () => {
  const expected = { ...fileExpected, kind: "media", destination: "batch",
    sourcePaths: ["/local/first", "/local/second"] };
  const receipt = stage(expected, 1);
  const parsed = parseNativeStageOutcome(JSON.stringify({
    status: "uploadIncomplete", receipt, errorCode: "ArtifactStageIncomplete",
    primaryErrorCode: "ArtifactReadbackUnconfirmed",
  }), expected);
  assert.equal(parsed.errorCode, "ArtifactStageIncomplete");
  assert.equal(parsed.primaryErrorCode, "ArtifactReadbackUnconfirmed");
  assert.equal(parsed.receiptJson, JSON.stringify(receipt));
  fails(() => parseNativeStageOutcome(stageText(receipt), expected), "artifact_stage_count_mismatch");
});

test("unknown acceptance preserves stable attempt and receipt, without inventing an operation", () => {
  const receipt = stage();
  const text = dispatchText(receipt, "acceptanceUnknown", { errorCode: "DeviceAcceptanceUnknown" });
  const first = parseNativeDispatchOutcome(text, fileExpected);
  const second = parseNativeDispatchOutcome(text, fileExpected);
  assert.equal(first.attemptId, second.attemptId);
  assert.equal(first.receiptJson, JSON.stringify(receipt));
  assert.equal(first.operation, undefined);
  assert.ok(Object.isFrozen(first));
  fails(() => parseNativeDispatchOutcome(dispatchText(receipt, "acceptanceUnknown",
    { operation: operation() }), fileExpected), "artifact_stage_operation_mismatch");
  fails(() => parseNativeDispatchOutcome(dispatchText(receipt, "acceptanceUnknown",
    { attemptId: "" }), fileExpected), "artifact_stage_invalid_outcome");
});

test("accepted native operation must match kind, target, provider and staged artifact", () => {
  const receipt = stage();
  const valid = parseNativeDispatchOutcome(dispatchText(receipt, "accepted",
    { operation: operation() }), fileExpected);
  assert.equal(valid.operation.kind, "importStagedTargetFile");
  assert.ok(Object.isFrozen(valid.operation));
  for (const patch of [
    { kind: "importStagedTargetMedia" }, { targetId: "foreign" }, { providerId: "foreign" },
    { destructive: false }, { artifactIds: ["foreign"] },
  ]) {
    fails(() => parseNativeDispatchOutcome(dispatchText(receipt, "accepted",
      { operation: { ...operation(), ...patch } }), fileExpected), "artifact_stage_operation_mismatch");
  }
  fails(() => parseNativeDispatchOutcome(dispatchText(receipt, "accepted"), fileExpected),
    "artifact_stage_invalid_outcome");
  fails(() => parseNativeDispatchOutcome(dispatchText(receipt, "accepted",
    { operation: operation() }), { ...fileExpected, invocation: {
      ...invocation, connectionRef: { ...invocation.connectionRef, pid: 4 },
    } }), "artifact_stage_owner_mismatch");
});

test("cleanup requires matching artifact progress and a verified delete operation", () => {
  const expected = { ...fileExpected, action: "cleanup" };
  const receipt = stage();
  const deletion = { ...operation("deleteArtifact"), status: "succeeded" };
  const cleanupArtifacts = [{
    artifactId: "artifact-0", status: "cleaned", attemptId: "abcdef0123456789abcdef0123456789",
    operationId: "operation", operation: deletion,
  }];
  const accepted = parseNativeDispatchOutcome(dispatchText(receipt, "cleaned",
    { operation: deletion, cleanupArtifacts }), expected);
  assert.equal(accepted.cleanupArtifacts[0].operation.kind, "deleteArtifact");
  assert.equal(accepted.operation.operationId, "operation");
  for (const corruption of [
    [{ ...cleanupArtifacts[0], artifactId: "foreign" }],
    [{ ...cleanupArtifacts[0], operation: operation("importStagedTargetFile") }],
    [{ ...cleanupArtifacts[0], operationId: "other" }],
  ]) fails(() => parseNativeDispatchOutcome(dispatchText(receipt, "cleaned",
    { operation: deletion, cleanupArtifacts: corruption }), expected),
  corruption[0].artifactId === "foreign" ? "artifact_stage_invalid_outcome" : "artifact_stage_operation_mismatch");
  fails(() => parseNativeDispatchOutcome(dispatchText(receipt, "accepted",
    { operation: operation() }), expected), "artifact_stage_invalid_outcome");
  fails(() => parseNativeDispatchOutcome(dispatchText(receipt, "cleaned",
    { operation: deletion, cleanupArtifacts }), fileExpected), "artifact_stage_invalid_outcome");
});

test("partial cleanup and GET-only uncertainty retain their artifact and attempt evidence", () => {
  const expected = { ...fileExpected, action: "cleanup" };
  const receipt = stage();
  const cleanupArtifacts = [{
    artifactId: "artifact-0", status: "readbackUnconfirmed", attemptId: "artifact-0",
  }];
  const uncertain = parseNativeDispatchOutcome(dispatchText(receipt, "readbackUnconfirmed", {
    attemptId: "artifact-0", errorCode: "ArtifactReadbackUnconfirmed", cleanupArtifacts,
  }), expected);
  assert.equal(uncertain.attemptId, "artifact-0");
  assert.equal(uncertain.receiptJson, JSON.stringify(receipt));
  const pending = parseNativeDispatchOutcome(dispatchText(receipt, "cleanupAcceptanceUnknown", {
    attemptId: "artifact-0",
    cleanupArtifacts: [{ ...cleanupArtifacts[0], status: "acceptanceUnknown" }],
  }), expected);
  assert.equal(pending.status, "cleanupAcceptanceUnknown");
  fails(() => parseNativeDispatchOutcome(dispatchText(receipt, "cleaned",
    { cleanupArtifacts }), expected), "artifact_stage_invalid_outcome");
});

test("timestamps include native sub-millisecond ticks when binding host identity", () => {
  const fractional = {
    ...fileExpected,
    invocation: {
      ...invocation,
      connectionRef: {
        ...invocation.connectionRef,
        startedAt: "2026-10-10T00:00:00.1234567Z",
      },
    },
  };
  const receipt = stage();
  receipt.artifacts[0].proof.hostInstanceId = `host-${hash(
    `host\0${3}\0${epochTicks + 1234567n}\0${epochTicks}`,
  )}`;
  receipt.artifacts[0].artifact.metadata.hostInstanceId = receipt.artifacts[0].proof.hostInstanceId;
  assert.equal(parseNativeStageOutcome(stageText(receipt), fractional).status, "ready");
});

test("canonical context owner is captured separately when execution context omits processStartedAt", () => {
  const actual = {
    ...fileExpected,
    invocation: {
      ...invocation,
      executionContext: {
        contextRef: "ctx-original", scopeEpoch: "epoch", revision: "9", ownerProcessId: 42,
      },
    },
  };
  assert.equal(parseNativeStageOutcome(stageText(stage()), actual).status, "ready");
});

test("accepted media batch validates operation kind and staged artifact identities", () => {
  const expected = { ...fileExpected, kind: "media", destination: "batch",
    sourcePaths: ["/local/first", "/local/second"] };
  const receipt = stage(expected);
  const batch = {
    ...operation("importStagedTargetMediaBatch"),
    artifactIds: ["artifact-0", "artifact-1"],
  };
  assert.equal(parseNativeDispatchOutcome(dispatchText(receipt, "accepted",
    { operation: batch }), expected).operation.kind, "importStagedTargetMediaBatch");
  for (const patch of [{ artifactIds: ["artifact-0", "artifact-0"] },
    { artifactIds: ["artifact-0", "other"] }, { kind: "importStagedTargetMedia" }]) {
    fails(() => parseNativeDispatchOutcome(dispatchText(receipt, "accepted",
      { operation: { ...batch, ...patch } }), expected), "artifact_stage_operation_mismatch");
  }
});
