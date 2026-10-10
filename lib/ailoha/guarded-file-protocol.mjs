import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { artifact, isOpaqueId, operation } from "./protocol.mjs";
import { hostInstanceId, utcTicks } from "./artifact-stage-protocol.mjs";
import { immutableSnapshot, MobileAilohaError } from "./mobile-projection.mjs";

const HEX_ID = /^[a-f0-9]{32}$/i;
const GUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/i;
const RECEIPT_KEYS = [
  "kind", "owner", "targetHostId", "path", "attemptId", "contextRef",
  "scopeEpoch", "revision", "ownerProcessId", "ownerStartedAt",
];
const RECEIPT_OPTIONS = ["appId", "recursive", "destinationPath", "overwrite", "maximumBytes"];

function invalid(code) {
  throw new MobileAilohaError(code, "The guarded file outcome does not match its original authority.", 502);
}

function record(value, required, optional = []) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function checkedReceipt(value, expected) {
  const invocation = expected?.invocation;
  const context = invocation?.executionContext;
  const owner = invocation?.contextOwner;
  const host = hostInstanceId(invocation?.connectionRef);
  if (!invocation || !context || !owner || !host
    || !["export", "delete", "mkdir"].includes(expected.kind)
    || typeof expected.path !== "string" || !expected.path
    || expected.path.length > 4096 || expected.path.includes("\0")
    || invocation.nativeIdentity === null || typeof invocation.nativeIdentity !== "object"
    || Array.isArray(invocation.nativeIdentity)
    || ![invocation.nativeIdentity.platform, invocation.nativeIdentity.nativeId].every(isOpaqueId)
    || ![invocation.targetHostId, invocation.targetId, invocation.providerId,
      context.contextRef, context.scopeEpoch, context.revision].every(isOpaqueId)
    || !Number.isSafeInteger(owner.processId) || owner.processId < 1
    || utcTicks(owner.processStartedAt) === null
    || !Number.isSafeInteger(expected.maximumBytes) || expected.maximumBytes < 1) {
    throw new MobileAilohaError("guarded_file_invalid_expected",
      "A guarded file operation requires complete captured native and named-view authority.", 400);
  }
  const receiptJson = JSON.stringify(value);
  if (Buffer.byteLength(receiptJson, "utf8") > 64 * 1024) invalid("guarded_file_receipt_too_large");
  if (!record(value, RECEIPT_KEYS, RECEIPT_OPTIONS)
    || !record(value.owner, ["hostInstanceId", "targetId", "providerId",
      "registrationEpoch", "nativeIdentity"])
    || !GUID.test(value.owner.registrationEpoch)
    || value.owner.registrationEpoch === "00000000-0000-0000-0000-000000000000"
    || value.owner.hostInstanceId !== host
    || value.owner.targetId !== invocation.targetId
    || value.owner.providerId !== invocation.providerId
    || !isDeepStrictEqual(value.owner.nativeIdentity, invocation.nativeIdentity)
    || value.targetHostId !== invocation.targetHostId
    || value.path !== expected.path || value.kind !== expected.kind
    || !HEX_ID.test(value.attemptId)
    || value.contextRef !== context.contextRef
    || value.scopeEpoch !== context.scopeEpoch || value.revision !== context.revision
    || value.ownerProcessId !== owner.processId
    || value.ownerProcessId !== context.ownerProcessId
    || utcTicks(value.ownerStartedAt) !== utcTicks(owner.processStartedAt)
    || (context.processStartedAt !== undefined
      && utcTicks(context.processStartedAt) !== utcTicks(owner.processStartedAt))
    || (value.appId ?? null) !== (expected.appId ?? null)
    || (value.recursive ?? false) !== (expected.recursive ?? false)
    || (value.destinationPath ?? null) !== (expected.destinationPath ?? null)
    || (value.overwrite ?? false) !== (expected.overwrite ?? false)
    || value.maximumBytes !== expected.maximumBytes
    || (expected.kind === "export" && !isAbsolute(value.destinationPath))
    || (expected.kind !== "export" && value.destinationPath != null)
    || (expected.kind !== "mkdir" && value.appId != null)
    || (expected.kind === "mkdir" && value.recursive)) {
    invalid("guarded_file_receipt_mismatch");
  }
  return { receipt: immutableSnapshot(value), receiptJson };
}

function checkedOperation(value, receipt) {
  try { operation(value); }
  catch { invalid("guarded_file_operation_mismatch"); }
  if (value.requestId !== receipt.attemptId
    || value.targetId !== receipt.owner.targetId || value.providerId !== receipt.owner.providerId
    || value.kind !== ({ export: "exportTargetFile", delete: "deleteTargetFileWithOptions",
      mkdir: "createTargetDirectory" })[receipt.kind]
    || value.destructive !== (receipt.kind === "delete")) {
    invalid("guarded_file_operation_mismatch");
  }
  return immutableSnapshot(value);
}

export function parseGuardedFileOutcome(text, expected) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 256 * 1024) {
    invalid("guarded_file_invalid_outcome");
  }
  let value;
  try { value = JSON.parse(text); }
  catch { invalid("guarded_file_invalid_outcome"); }
  if (!record(value, ["status", "receipt"], ["errorCode", "operationId",
    "operation", "artifact", "downloadedBytes", "devicePath", "mutation",
    "primaryFailureCode", "cleanupFailureCode"])
    || !["prepared", "accepted", "acceptanceUnknown", "rejected", "succeeded",
      "downloaded", "failed", "readbackUnconfirmed"].includes(value.status)
    || ["errorCode", "primaryFailureCode", "cleanupFailureCode"].some((key) =>
      value[key] != null && (typeof value[key] !== "string"
        || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value[key])))
    || (value.primaryFailureCode != null || value.cleanupFailureCode != null)
      && (value.status !== "readbackUnconfirmed"
        || value.errorCode !== "GuardedTemporaryCleanupFailed"
        || value.primaryFailureCode == null || value.cleanupFailureCode == null)) {
    invalid("guarded_file_invalid_outcome");
  }
  const result = checkedReceipt(value.receipt, expected);
  const receipt = result.receipt;
  const complete = ["succeeded", "downloaded"].includes(value.status);
  if (value.operationId != null && !isOpaqueId(value.operationId)) invalid("guarded_file_operation_mismatch");
  const accepted = value.operation == null ? null : checkedOperation(value.operation, receipt);
  if (accepted && value.operationId != null && accepted.operationId !== value.operationId) {
    invalid("guarded_file_operation_mismatch");
  }
  if (value.status === "prepared" && (accepted || value.operationId != null || value.errorCode != null)
    || complete && (value.errorCode != null || !accepted || accepted.status !== "succeeded"
      || value.operationId !== accepted.operationId)
    || value.status === "accepted" && !accepted
    || value.status === "downloaded" && receipt.kind !== "export"
    || value.status === "succeeded" && receipt.kind === "export") {
    invalid("guarded_file_invalid_outcome");
  }
  if (value.mutation != null) {
    if (!record(value.mutation, ["path"]) || typeof value.mutation.path !== "string"
      || !value.mutation.path.trim() || value.status !== "succeeded") {
      invalid("guarded_file_mutation_mismatch");
    }
  }
  if (value.status === "succeeded" && !value.mutation) invalid("guarded_file_mutation_mismatch");
  if (value.artifact != null) {
    try { artifact(value.artifact); }
    catch { invalid("guarded_file_artifact_mismatch"); }
    if (receipt.kind !== "export" || value.artifact.kind !== "file"
      || value.artifact.status !== "ready"
      || value.artifact.targetId !== receipt.owner.targetId
      || value.artifact.operationId != null && value.artifact.operationId !== accepted?.operationId
      || !Number.isSafeInteger(value.artifact.size) || value.artifact.size < 0
      || value.artifact.size > receipt.maximumBytes || !DIGEST.test(value.artifact.sha256)
      || !accepted?.artifactIds || accepted.artifactIds.length !== 1
      || accepted.artifactIds[0] !== value.artifact.artifactId) {
      invalid("guarded_file_artifact_mismatch");
    }
  }
  if (value.downloadedBytes != null && (!Number.isSafeInteger(value.downloadedBytes)
    || value.downloadedBytes < 0 || value.status !== "downloaded")) {
    invalid("guarded_file_artifact_mismatch");
  }
  if (value.status === "downloaded"
    && (!value.artifact || value.downloadedBytes !== value.artifact.size)) {
    invalid("guarded_file_artifact_mismatch");
  }
  if (value.status === "downloaded") {
    if (typeof value.devicePath !== "string" || !value.devicePath.trim()
      || value.devicePath.length > 4096 || value.devicePath.includes("\0")
      || value.devicePath.split(/[\\/]/).includes("..")
      || !record(accepted?.result, ["artifactId", "devicePath"])
      || accepted.result.artifactId !== value.artifact.artifactId
      || accepted.result.devicePath !== value.devicePath) {
      invalid("guarded_file_device_path_unconfirmed");
    }
  } else if (value.devicePath != null) {
    invalid("guarded_file_device_path_unconfirmed");
  }
  return Object.freeze({ status: value.status, ...result,
    ...(value.errorCode == null ? {} : { errorCode: value.errorCode }),
    ...(value.operationId == null ? {} : { operationId: value.operationId }),
    ...(accepted ? { operation: accepted } : {}),
    ...(value.mutation ? { mutation: immutableSnapshot(value.mutation) } : {}),
    ...(value.artifact ? { artifact: immutableSnapshot(value.artifact) } : {}),
    ...(value.downloadedBytes == null ? {} : { downloadedBytes: value.downloadedBytes }),
    ...(value.devicePath == null ? {} : { devicePath: value.devicePath }),
    ...(value.primaryFailureCode == null ? {} : { primaryFailureCode: value.primaryFailureCode }),
    ...(value.cleanupFailureCode == null ? {} : { cleanupFailureCode: value.cleanupFailureCode }),
  });
}
