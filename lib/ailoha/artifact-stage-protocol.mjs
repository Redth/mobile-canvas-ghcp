import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import { operation, artifact, isOpaqueId } from "./protocol.mjs";
import { MobileAilohaError, immutableSnapshot } from "./mobile-projection.mjs";

const MAX_RECEIPT_BYTES = 64 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const STAGE_ID = /^[a-f0-9]{32}$/i;
const PROOF_KEYS = [
  "targetHostId", "targetId", "providerId", "nativeTargetId", "nativeTargetPlatform",
  "hostInstanceId", "sourcePathHash", "destination", "contextRef", "scopeEpoch",
  "revision", "ownerProcessId", "ownerStartedAt", "stageId", "expectedArtifactCount", "stageSlot",
];

function invalid(code, message) {
  throw new MobileAilohaError(code, message, 502);
}

function requireStage(condition, code = "artifact_stage_invalid_receipt") {
  if (!condition) invalid(code, "The native staged receipt is incomplete or does not match its captured authority.");
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value, required, optional = []) {
  return object(value) && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// DateTimeOffset.UtcTicks includes the four sub-millisecond decimal places that Date.parse discards.
export function utcTicks(value) {
  if (typeof value !== "string") return null;
  const match = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.(\d{1,7}))?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  const milliseconds = Date.parse(value);
  if (!match || !Number.isFinite(milliseconds)) return null;
  return (BigInt(milliseconds) + 62135596800000n) * 10000n
    + BigInt((match[1] ?? "").padEnd(7, "0").slice(3, 7) || "0");
}

export function hostInstanceId(ref) {
  if (!object(ref) || !isOpaqueId(ref.serviceId)
    || !Number.isSafeInteger(ref.pid) || ref.pid < 1) return null;
  const started = utcTicks(ref.startedAt);
  const processStarted = utcTicks(ref.processStartedAt);
  if (started === null || processStarted === null) return null;
  return `host-${hash(`${ref.serviceId}\0${ref.pid}\0${started}\0${processStarted}`)}`;
}

function expectedAuthority(expected) {
  const invocation = expected?.invocation;
  const context = invocation?.executionContext;
  const owner = invocation?.contextOwner;
  const sources = expected?.sourcePaths;
  const host = hostInstanceId(invocation?.connectionRef);
  if (!object(invocation) || !object(context) || !object(owner) || !host
    || !["file", "media"].includes(expected.kind)
    || typeof expected.destination !== "string" || !expected.destination
    || !Array.isArray(sources) || sources.length < 1 || sources.length > 16
    || (expected.kind === "file" && sources.length !== 1)
    || ![invocation.targetHostId, invocation.targetId, invocation.providerId,
      context.contextRef, context.scopeEpoch, context.revision].every(isOpaqueId)
    || !Number.isSafeInteger(owner.processId) || owner.processId < 1
    || owner.processId !== context.ownerProcessId || utcTicks(owner.processStartedAt) === null
    || (context.processStartedAt !== undefined && context.processStartedAt !== owner.processStartedAt)
    || !sources.every((source) => typeof source === "string" && source.length > 0
      && !source.includes("\0") && isAbsolute(source))) {
    throw new MobileAilohaError("artifact_stage_invalid_expected",
      "Native staging requires absolute source paths and complete original invocation authority.", 400);
  }
  const native = invocation.nativeIdentity;
  if (!object(native) || !isOpaqueId(native.nativeId) || !isOpaqueId(native.platform)) {
    throw new MobileAilohaError("artifact_stage_invalid_expected",
      "Native staging requires a complete captured native device identity.", 400);
  }
  return { invocation, context, owner, sources, host };
}

function readOutcome(text, required, optional) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 256 * 1024) {
    invalid("artifact_stage_invalid_outcome", "Native staging returned an unbounded or non-JSON outcome.");
  }
  let value;
  try { value = JSON.parse(text); }
  catch { invalid("artifact_stage_invalid_outcome", "Native staging did not return JSON."); }
  if (!exactFields(value, required, optional)) {
    invalid("artifact_stage_invalid_outcome", "Native staging returned an unexpected outcome shape.");
  }
  return value;
}

function receiptFor(value, expected, authority) {
  requireStage(exactFields(value, ["kind", "destination", "artifacts", "expectedArtifactCount"]));
  const receiptJson = JSON.stringify(value);
  requireStage(Buffer.byteLength(receiptJson, "utf8") <= MAX_RECEIPT_BYTES, "artifact_stage_receipt_too_large");
  const { invocation, context, owner, sources, host } = authority;
  requireStage(value.kind === expected.kind && value.destination === expected.destination,
    "artifact_stage_destination_mismatch");
  requireStage(Number.isSafeInteger(value.expectedArtifactCount)
    && value.expectedArtifactCount === sources.length && Array.isArray(value.artifacts)
    && value.artifacts.length >= 1 && value.artifacts.length <= sources.length,
  "artifact_stage_count_mismatch");
  const stageIds = new Set();
  const slots = new Set();
  const ids = new Set();
  for (const entry of value.artifacts) {
    requireStage(exactFields(entry, ["artifact", "proof"]));
    const { proof } = entry;
    const item = entry.artifact;
    requireStage(exactFields(proof, PROOF_KEYS.filter((key) =>
      !["nativeTargetId", "nativeTargetPlatform"].includes(key)),
    ["nativeTargetId", "nativeTargetPlatform"]));
    requireStage(STAGE_ID.test(proof.stageId) && Number.isSafeInteger(proof.stageSlot)
      && proof.stageSlot >= 0 && proof.stageSlot < sources.length
      && !slots.has(proof.stageSlot) && proof.expectedArtifactCount === sources.length,
    "artifact_stage_slot_mismatch");
    slots.add(proof.stageSlot);
    stageIds.add(proof.stageId);
    requireStage(proof.targetHostId === invocation.targetHostId
      && proof.targetId === invocation.targetId && proof.providerId === invocation.providerId
      && proof.hostInstanceId === host && proof.destination === expected.destination,
    "artifact_stage_owner_mismatch");
    requireStage((proof.nativeTargetId ?? null) === (invocation.nativeIdentity?.nativeId ?? null)
      && (proof.nativeTargetPlatform ?? null) === (invocation.nativeIdentity?.platform ?? null),
    "artifact_stage_native_identity_mismatch");
    requireStage(proof.contextRef === context.contextRef && proof.scopeEpoch === context.scopeEpoch
      && proof.revision === context.revision && proof.ownerProcessId === owner.processId
      && utcTicks(proof.ownerStartedAt) !== null
      && utcTicks(proof.ownerStartedAt) === utcTicks(owner.processStartedAt),
    "artifact_stage_context_mismatch");
    const source = resolve(sources[proof.stageSlot]);
    requireStage(proof.sourcePathHash === hash(source), "artifact_stage_source_mismatch");
    try { artifact(item); }
    catch { requireStage(false); }
    requireStage(item.kind === expected.kind && item.status === "ready"
      && isOpaqueId(item.artifactId) && !ids.has(item.artifactId)
      && item.targetId === invocation.targetId
      && item.fileName === basename(source)
      && Number.isSafeInteger(item.size) && item.size >= 0
      && typeof item.sha256 === "string" && HEX.test(item.sha256),
    "artifact_stage_artifact_mismatch");
    ids.add(item.artifactId);
    requireStage(exactFields(item.metadata, PROOF_KEYS.filter((key) =>
      !["nativeTargetId", "nativeTargetPlatform"].includes(key)),
    ["nativeTargetId", "nativeTargetPlatform"])
      && PROOF_KEYS.every((key) => (item.metadata[key] ?? null) === (proof[key] ?? null)),
    "artifact_stage_metadata_mismatch");
  }
  requireStage(stageIds.size === 1, "artifact_stage_slot_mismatch");
  return { receipt: immutableSnapshot(value), receiptJson };
}

function errorFields(value) {
  for (const key of ["errorCode", "primaryErrorCode"]) {
    if (Object.hasOwn(value, key) && (typeof value[key] !== "string"
      || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value[key]))) {
      invalid("artifact_stage_invalid_outcome", "Native staging returned an invalid error code.");
    }
  }
}

export function parseNativeStageOutcome(text, expected) {
  const authority = expectedAuthority(expected);
  const value = readOutcome(text, ["status", "receipt"], ["errorCode", "primaryErrorCode"]);
  errorFields(value);
  if (!["ready", "uploadIncomplete", "readbackUnconfirmed", "cleanupOrOwnerUnconfirmed"].includes(value.status)) {
    invalid("artifact_stage_invalid_outcome", "Native staging returned an unknown stage status.");
  }
  if (value.status === "ready" && (value.errorCode !== undefined || value.primaryErrorCode !== undefined)) {
    invalid("artifact_stage_invalid_outcome", "A ready stage cannot carry an error.");
  }
  const result = receiptFor(value.receipt, expected, authority);
  requireStage(value.status !== "ready"
    || result.receipt.artifacts.length === result.receipt.expectedArtifactCount,
  "artifact_stage_count_mismatch");
  return Object.freeze({
    status: value.status, ...result,
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
    ...(value.primaryErrorCode === undefined ? {} : { primaryErrorCode: value.primaryErrorCode }),
  });
}

function checkedOperation(value, receipt, expected, cleanupArtifactId) {
  try { operation(value); }
  catch { invalid("artifact_stage_operation_mismatch", "Native staging returned an invalid operation."); }
  const kind = cleanupArtifactId ? "deleteArtifact" : expected.kind === "file"
    ? "importStagedTargetFile" : expected.destination === "batch" || expected.sourcePaths.length > 1
      ? "importStagedTargetMediaBatch" : "importStagedTargetMedia";
  if (value.kind !== kind || value.targetId !== expected.invocation.targetId
    || value.providerId !== expected.invocation.providerId || value.destructive !== true
    || (value.artifactIds !== undefined && (value.artifactIds.length !== (cleanupArtifactId ? 1 : receipt.artifacts.length)
      || new Set(value.artifactIds).size !== value.artifactIds.length
      || value.artifactIds.some((id) => !receipt.artifacts.some((entry) =>
        entry.artifact.artifactId === id) || (cleanupArtifactId && id !== cleanupArtifactId))))) {
    invalid("artifact_stage_operation_mismatch", "Native staging returned an operation for another mutation or owner.");
  }
  return immutableSnapshot(value);
}

export function parseNativeDispatchOutcome(text, expected) {
  const authority = expectedAuthority(expected);
  if (!["continue", "cleanup"].includes(expected.action)) {
    throw new MobileAilohaError("artifact_stage_invalid_expected",
      "Dispatch parsing requires an explicit continue or cleanup action.", 400);
  }
  const value = readOutcome(text, ["status", "receipt", "attemptId"],
    ["operation", "errorCode", "cleanupArtifacts"]);
  errorFields(value);
  if (!["accepted", "acceptanceUnknown", "readbackUnconfirmed", "uploadIncomplete",
    "cleaned", "cleanupAcceptanceUnknown", "cleanupFailed"].includes(value.status)
    || typeof value.attemptId !== "string" || (value.attemptId !== "" && !isOpaqueId(value.attemptId))) {
    invalid("artifact_stage_invalid_outcome", "Native staging returned an invalid dispatch status or attempt.");
  }
  if (expected.action === "continue" && !["accepted", "acceptanceUnknown",
    "readbackUnconfirmed", "uploadIncomplete"].includes(value.status)
    || expected.action === "cleanup" && !["cleaned", "cleanupAcceptanceUnknown",
      "cleanupFailed", "readbackUnconfirmed"].includes(value.status)) {
    invalid("artifact_stage_invalid_outcome", "Native staging returned a status for another dispatch action.");
  }
  if (["accepted", "cleaned"].includes(value.status) && value.errorCode !== undefined) {
    invalid("artifact_stage_invalid_outcome", "A completed dispatch cannot carry an error.");
  }
  const result = receiptFor(value.receipt, expected, authority);
  if (value.status === "accepted" && (!STAGE_ID.test(value.attemptId) || !object(value.operation))
    || value.status === "acceptanceUnknown" && !STAGE_ID.test(value.attemptId)
    || expected.action === "continue" && ["readbackUnconfirmed", "uploadIncomplete"].includes(value.status)
      && (value.attemptId !== "" || value.operation !== undefined)
    || value.status === "accepted" && result.receipt.artifacts.length !== expected.sourcePaths.length) {
    invalid("artifact_stage_invalid_outcome", "Native staging returned an inconsistent dispatch outcome.");
  }
  if (value.operation !== undefined && value.status !== "cleaned"
    && !value.status.startsWith("cleanup") && value.status !== "accepted"
    && !(expected.action === "cleanup" && value.status === "readbackUnconfirmed")) {
    invalid("artifact_stage_operation_mismatch", "Uncertain device acceptance cannot report an unrelated operation.");
  }
  let cleanupArtifacts;
  if (value.cleanupArtifacts !== undefined) {
    if (!["cleaned", "cleanupAcceptanceUnknown", "cleanupFailed", "readbackUnconfirmed"].includes(value.status)
      || !Array.isArray(value.cleanupArtifacts) || value.cleanupArtifacts.length < 1
      || value.cleanupArtifacts.length > result.receipt.artifacts.length) {
      invalid("artifact_stage_invalid_outcome", "Native staging returned an invalid cleanup progress list.");
    }
    const seen = new Set();
    cleanupArtifacts = value.cleanupArtifacts.map((entry) => {
      if (!exactFields(entry, ["artifactId", "status", "attemptId"],
        ["operationId", "operation", "errorCode"])
        || !["acceptanceUnknown", "readbackUnconfirmed", "failed", "acceptedUnconfirmed", "cleaned"].includes(entry.status)
        || !result.receipt.artifacts.some((item) => item.artifact.artifactId === entry.artifactId)
        || seen.has(entry.artifactId) || !isOpaqueId(entry.attemptId)
        || entry.operationId !== undefined && !isOpaqueId(entry.operationId)) {
        invalid("artifact_stage_invalid_outcome", "Native staging returned invalid cleanup artifact evidence.");
      }
      seen.add(entry.artifactId);
      if (entry.operation !== undefined) checkedOperation(entry.operation, result.receipt, expected, entry.artifactId);
      if (entry.operationId !== undefined && entry.operation !== undefined
        && entry.operationId !== entry.operation.operationId) {
        invalid("artifact_stage_operation_mismatch", "Cleanup operation identity differs from its progress marker.");
      }
      return immutableSnapshot(entry);
    });
    const ordered = [...result.receipt.artifacts].sort((left, right) =>
      left.proof.stageSlot - right.proof.stageSlot);
    if (cleanupArtifacts.some((entry, index) => entry.artifactId !== ordered[index].artifact.artifactId)
      || cleanupArtifacts.slice(0, -1).some((entry) => entry.status !== "cleaned")) {
      invalid("artifact_stage_invalid_outcome", "Native cleanup progress is not the original stage order.");
    }
    if (cleanupArtifacts.at(-1).attemptId !== value.attemptId
      || value.status === "cleaned" && (cleanupArtifacts.length !== result.receipt.artifacts.length
        || cleanupArtifacts.some((entry) => entry.status !== "cleaned"))) {
      invalid("artifact_stage_invalid_outcome", "Native cleanup progress does not match its outcome.");
    }
    const current = cleanupArtifacts.at(-1);
    if (value.operation !== undefined && current.operation !== undefined
      && value.operation.operationId !== current.operation.operationId) {
      invalid("artifact_stage_operation_mismatch", "Cleanup result differs from its current operation.");
    }
    if (value.status === "cleaned" && (!current.operationId && !current.operation?.operationId)
      || value.status === "cleaned" && current.operation && current.operation.status !== "succeeded"
      || value.status === "cleaned" && value.operation && value.operation.status !== "succeeded"
      || value.status === "cleanupFailed" && current.status !== "failed"
      || value.status === "readbackUnconfirmed" && current.status !== "readbackUnconfirmed") {
      invalid("artifact_stage_invalid_outcome", "Native cleanup status lacks matching progress.");
    }
  } else if (["cleaned", "cleanupAcceptanceUnknown", "cleanupFailed"].includes(value.status)) {
    invalid("artifact_stage_invalid_outcome", "Native cleanup outcome has no artifact progress.");
  }
  const op = value.operation === undefined ? undefined
    : checkedOperation(value.operation, result.receipt, expected,
      cleanupArtifacts?.at(-1)?.artifactId && value.status !== "accepted"
        ? cleanupArtifacts.at(-1).artifactId : undefined);
  return Object.freeze({
    status: value.status, ...result, attemptId: value.attemptId,
    ...(op === undefined ? {} : { operation: op }),
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
    ...(cleanupArtifacts === undefined ? {} : { cleanupArtifacts: Object.freeze(cleanupArtifacts) }),
  });
}
