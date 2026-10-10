import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";

const { parseGuardedFileOutcome } =
  await import(productModule("lib/ailoha/guarded-file-protocol.mjs"));

const date = "2026-10-10T00:00:00.1234567Z";
const ticks = (BigInt(Date.parse(date)) + 62135596800000n) * 10000n + 4567n;
const host = `host-${createHash("sha256").update(`host\0${3}\0${ticks}\0${ticks}`).digest("hex")}`;
const attemptId = "0123456789abcdef0123456789abcdef";
const invocation = {
  targetHostId: "host", targetId: "target", providerId: "provider",
  nativeIdentity: { platform: "ios", nativeId: "device", isVirtual: true },
  executionContext: {
    contextRef: "original", scopeEpoch: "epoch", revision: "7",
    ownerProcessId: 42, processStartedAt: date,
  },
  contextOwner: { processId: 42, processStartedAt: date },
  connectionRef: { serviceId: "host", pid: 3, startedAt: date, processStartedAt: date },
};
const expected = {
  invocation, kind: "export", path: "app://package/Documents/empty",
  appId: null, recursive: false, destinationPath: "/owned/empty", overwrite: true,
  maximumBytes: 1048576,
};
const copy = (value) => structuredClone(value);
const failure = (run, code) => assert.throws(run, { name: "MobileAilohaError", code });

function receipt(options = expected) {
  return {
    kind: options.kind,
    owner: {
      hostInstanceId: host, targetId: "target", providerId: "provider",
      registrationEpoch: "01234567-89ab-cdef-0123-456789abcdef",
      nativeIdentity: copy(invocation.nativeIdentity),
    },
    targetHostId: "host", path: options.path, attemptId,
    contextRef: "original", scopeEpoch: "epoch", revision: "7",
    ownerProcessId: 42, ownerStartedAt: date, appId: options.appId,
    recursive: options.recursive, destinationPath: options.destinationPath,
    overwrite: options.overwrite, maximumBytes: options.maximumBytes,
  };
}

function nativeOperation(options = expected, status = "queued") {
  return {
    operationId: "operation", requestId: attemptId,
    targetId: "target", providerId: "provider", destructive: options.kind === "delete",
    kind: { export: "exportTargetFile", delete: "deleteTargetFileWithOptions",
      mkdir: "createTargetDirectory" }[options.kind],
    status, createdAt: date,
    ...(options.kind === "export" ? { artifactIds: ["export-artifact"] } : {}),
  };
}

function outcome(status, options = expected, extra = {}) {
  return JSON.stringify({ status, receipt: receipt(options), ...extra });
}

test("prepared original view captures immutable native, owner, destination and requested options", () => {
  const native = receipt();
  const result = parseGuardedFileOutcome(JSON.stringify({ status: "prepared", receipt: native }), expected);
  assert.equal(result.receiptJson, JSON.stringify(native));
  assert.ok(Object.isFrozen(result.receipt.owner.nativeIdentity));
  native.owner.nativeIdentity.nativeId = "replacement";
  assert.equal(result.receipt.owner.nativeIdentity.nativeId, "device");
  assert.equal(result.receipt.destinationPath, "/owned/empty");
  assert.equal(result.receipt.overwrite, true);
});

test("foreign provider, host incarnation, revision, native identity and export options cannot prepare", () => {
  for (const [code, change] of [
    ["guarded_file_receipt_mismatch", (r) => { r.owner.providerId = "foreign"; }],
    ["guarded_file_receipt_mismatch", (r) => { r.owner.hostInstanceId = "host-restarted"; }],
    ["guarded_file_receipt_mismatch", (r) => { r.revision = "8"; }],
    ["guarded_file_receipt_mismatch", (r) => { r.ownerStartedAt = "2026-10-10T00:00:00.1234568Z"; }],
    ["guarded_file_receipt_mismatch", (r) => { r.owner.nativeIdentity.nativeId = "foreign"; }],
    ["guarded_file_receipt_mismatch", (r) => { r.destinationPath = "/owned/different"; }],
    ["guarded_file_receipt_mismatch", (r) => { r.overwrite = false; }],
    ["guarded_file_receipt_mismatch", (r) => { r.maximumBytes = 100; }],
    ["guarded_file_receipt_mismatch", (r) => { r.attemptId = "foreign"; }],
    ["guarded_file_receipt_too_large", (r) => { r.owner.nativeIdentity.extra = "x".repeat(65536); }],
  ]) {
    const value = receipt();
    change(value);
    failure(() => parseGuardedFileOutcome(JSON.stringify({ status: "prepared", receipt: value }),
      expected), code);
  }
});

test("accepted operation must match original request, owner, kind and destructive flag", () => {
  const accepted = parseGuardedFileOutcome(outcome("accepted", expected, {
    operationId: "operation", operation: nativeOperation(),
  }), expected);
  assert.equal(accepted.operation.requestId, attemptId);
  for (const alteration of [
    { requestId: "foreign" }, { targetId: "foreign" }, { providerId: "foreign" },
    { kind: "deleteTargetFileWithOptions" }, { destructive: true },
  ]) {
    failure(() => parseGuardedFileOutcome(outcome("accepted", expected, {
      operationId: "operation", operation: { ...nativeOperation(), ...alteration },
    }), expected), "guarded_file_operation_mismatch");
  }
  failure(() => parseGuardedFileOutcome(outcome("accepted", expected, {
    operationId: "wrong", operation: nativeOperation(),
  }), expected), "guarded_file_operation_mismatch");
});

test("unknown acceptance retains exact receipt without inventing a successful export", () => {
  const unknown = parseGuardedFileOutcome(outcome("acceptanceUnknown", expected, {
    errorCode: "GuardedReadbackUnconfirmed", operationId: "operation",
  }), expected);
  assert.equal(unknown.receipt.attemptId, attemptId);
  assert.equal(unknown.operationId, "operation");
  assert.equal(unknown.operation, undefined);
  assert.equal(unknown.downloadedBytes, undefined);
  failure(() => parseGuardedFileOutcome(outcome("downloaded", expected, {
    operationId: "operation", operation: nativeOperation(expected, "succeeded"),
  }), expected), "guarded_file_artifact_mismatch");
});

test("failed temporary output cleanup retains both primary and cleanup error codes", () => {
  const result = parseGuardedFileOutcome(outcome("readbackUnconfirmed", expected, {
    errorCode: "GuardedTemporaryCleanupFailed", operationId: "operation",
    operation: nativeOperation(expected, "succeeded"),
    primaryFailureCode: "InvalidData", cleanupFailureCode: "AccessDenied",
  }), expected);
  assert.equal(result.primaryFailureCode, "InvalidData");
  assert.equal(result.cleanupFailureCode, "AccessDenied");
  failure(() => parseGuardedFileOutcome(outcome("readbackUnconfirmed", expected, {
    errorCode: "GuardedTemporaryCleanupFailed", primaryFailureCode: "InvalidData",
  }), expected), "guarded_file_invalid_outcome");
});

test("streamed empty file requires original confirmed artifact, SHA-256 and actual zero bytes", () => {
  const artifact = {
    artifactId: "export-artifact", kind: "file", status: "ready",
    contentType: "application/octet-stream", createdAt: date,
    targetId: "target", operationId: "operation", fileName: "empty", size: 0,
    sha256: createHash("sha256").update("").digest("hex"),
  };
  const completion = {
    operationId: "operation", operation: { ...nativeOperation(expected, "succeeded"),
      result: { artifactId: "export-artifact", devicePath: "Documents/empty" } },
    artifact, downloadedBytes: 0, devicePath: "Documents/empty",
  };
  const result = parseGuardedFileOutcome(outcome("downloaded", expected, completion), expected);
  assert.equal(result.downloadedBytes, 0);
  assert.equal(result.devicePath, "Documents/empty");
  assert.equal(result.receipt.destinationPath, "/owned/empty");
  for (const corrupted of [
    { ...completion, downloadedBytes: 1 },
    { ...completion, artifact: { ...artifact, targetId: "foreign" } },
    { ...completion, artifact: { ...artifact, sha256: "broken" } },
    { ...completion, artifact: { ...artifact, size: expected.maximumBytes + 1 } },
    { ...completion, operation: { ...completion.operation, artifactIds: ["foreign"] } },
  ]) {
    failure(() => parseGuardedFileOutcome(outcome("downloaded", expected, corrupted), expected),
      "guarded_file_artifact_mismatch");
  }
  for (const corrupted of [
    { ...completion, devicePath: null },
    { ...completion, devicePath: "Documents/../elsewhere" },
    { ...completion, devicePath: "Documents/different" },
    { ...completion, operation: { ...completion.operation, result: { artifactId: "foreign", devicePath: "Documents/empty" } } },
    { ...completion, operation: { ...completion.operation, result: undefined } },
  ]) {
    failure(() => parseGuardedFileOutcome(outcome("downloaded", expected, corrupted), expected),
      "guarded_file_device_path_unconfirmed");
  }
  failure(() => parseGuardedFileOutcome(outcome("readbackUnconfirmed", expected, {
    devicePath: "Documents/empty", operationId: "operation",
  }), expected), "guarded_file_device_path_unconfirmed");
});

test("delete and mkdir only report backend-confirmed terminal mutation paths", () => {
  for (const kind of ["delete", "mkdir"]) {
    const options = { ...expected, kind, path: "app://package/Documents/fixture",
      appId: null, destinationPath: null, overwrite: false, recursive: kind === "delete" };
    const result = parseGuardedFileOutcome(outcome("succeeded", options, {
      operationId: "operation", operation: nativeOperation(options, "succeeded"),
      mutation: { path: "Documents/fixture" },
    }), options);
    assert.equal(result.mutation.path, "Documents/fixture");
    failure(() => parseGuardedFileOutcome(outcome("succeeded", options, {
      operationId: "operation", operation: nativeOperation(options, "succeeded"),
    }), options), "guarded_file_mutation_mismatch");
    failure(() => parseGuardedFileOutcome(outcome("succeeded", options, {
      operationId: "operation", operation: nativeOperation(options, "succeeded"),
      mutation: { path: "" },
    }), options), "guarded_file_mutation_mismatch");
  }
});
