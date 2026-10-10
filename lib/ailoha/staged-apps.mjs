import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import { operation, isOpaqueId } from "./protocol.mjs";
import { MobileAilohaError } from "./mobile-projection.mjs";

function invalid(code, message, status = 502) {
  throw new MobileAilohaError(code, message, status);
}

export async function localAppPackage(path) {
  if (typeof path !== "string" || !path.trim() || path.includes("\0")) {
    invalid("invalid_request", "A host package path is required.", 400);
  }
  const sourcePath = resolve(path);
  let stat;
  try {
    stat = await lstat(sourcePath);
    if (!stat.isSymbolicLink()) await access(sourcePath, constants.R_OK);
  } catch (error) {
    if (!["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"].includes(error.code)) throw error;
    invalid("package_unreadable", "The host package path does not name a readable local package.", 400);
  }
  if (stat.isSymbolicLink() || !(stat.isFile() || (stat.isDirectory() && /\.app$/i.test(sourcePath)))) {
    invalid("invalid_package", "Expected a regular .apk, .ipa, .zip file or a .app bundle directory, not a link.", 400);
  }
  if (stat.isFile() && !/\.(apk|ipa|zip)$/i.test(sourcePath)) {
    invalid("invalid_package", "Expected a .apk, .ipa, or .zip package file.", 400);
  }
  return sourcePath;
}

function readJson(output) {
  try {
    const value = JSON.parse(output);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // A successful native CLI invocation must return one JSON object.
  }
  invalid("stage_invalid_response", "The canonical staged app command returned an invalid response.");
}

function contextArgs(invocation) {
  const { contextRef, scopeEpoch, revision } = invocation.executionContext ?? {};
  if (!isOpaqueId(contextRef) || !isOpaqueId(scopeEpoch) || !/^(0|[1-9]\d*)$/.test(revision ?? "")) {
    invalid("context_not_bound", "Staged app management requires an exact named context revision.", 409);
  }
  return ["--context", contextRef, "--context-epoch", scopeEpoch, "--context-revision", revision];
}

function verifyStage(stage, invocation, sourcePath) {
  const proof = stage.proof;
  const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
  if (!isOpaqueId(stage.artifactId) || !isAbsolute(stage.sourcePath)
    || stage.sourcePath !== sourcePath || !/^[a-f0-9]{64}$/.test(stage.receipt)
    || !Number.isSafeInteger(stage.size) || stage.size < 0 || !/^[a-f0-9]{64}$/.test(stage.sha256)
    || !proof || typeof proof !== "object" || !isOpaqueId(proof.hostInstanceId)
    || !Number.isSafeInteger(proof.ownerProcessId) || proof.ownerProcessId < 1
    || typeof proof.ownerStartedAt !== "string" || !proof.ownerStartedAt
    || proof.sourcePathHash !== hash(sourcePath)
    || proof.receiptHash !== hash(stage.receipt)
    || proof.packageName !== basename(sourcePath) + (sourcePath.toLowerCase().endsWith(".app") ? ".zip" : "")
    || proof.targetHostId !== invocation.targetHostId || proof.targetId !== invocation.targetId
    || proof.providerId !== invocation.providerId
    || proof.nativeTargetId !== invocation.nativeIdentity?.nativeId
    || proof.nativeTargetPlatform !== invocation.nativeIdentity?.platform
    || proof.contextRef !== invocation.executionContext?.contextRef
    || proof.scopeEpoch !== invocation.executionContext?.scopeEpoch
    || proof.revision !== invocation.executionContext?.revision
    || proof.ownerProcessId !== invocation.executionContext?.ownerProcessId
    || proof.ownerStartedAt !== invocation.executionContext?.processStartedAt) {
    invalid("stage_owner_mismatch", "The staged artifact receipt does not identify the captured host, target, package and view.");
  }
  Object.freeze(proof);
  return Object.freeze(stage);
}

function readOperation(output, kind, invocation, artifactId) {
  const result = readJson(output);
  try { operation(result); }
  catch {
    invalid("stage_invalid_response", "The canonical staged app command returned an invalid operation.");
  }
  if (result.kind !== kind || (kind !== "deleteArtifact" && result.targetId !== invocation.targetId)
    || (result.targetId !== undefined && result.targetId !== invocation.targetId)
    || (result.providerId !== undefined && result.providerId !== invocation.providerId)
    || (artifactId && result.artifactIds?.length && !result.artifactIds.includes(artifactId))) {
    invalid("operation_owner_mismatch", "The accepted staged app operation belongs to another target or artifact.");
  }
  return result;
}

export function createStagedAppCli({ runCli }) {
  if (typeof runCli !== "function") throw new TypeError("A verified canonical CLI runner is required.");
  return Object.freeze({
    async stage(invocation, sourcePath) {
      const output = await runCli(["target", "app", "stage", invocation.targetId,
        "--package", sourcePath, "--target-host", invocation.targetHostId,
        ...contextArgs(invocation), "--json"]);
      return verifyStage(readJson(output), invocation, sourcePath);
    },
    async install(invocation, staged) {
      const output = await runCli(["target", "app", "install-staged",
        "--staged", JSON.stringify(staged), ...contextArgs(invocation), "--confirm", "--json"]);
      return readOperation(output, "installTargetApp", invocation, staged.artifactId);
    },
    async cleanup(invocation, staged) {
      const output = await runCli(["target", "app", "stage-cleanup",
        "--staged", JSON.stringify(staged), "--context", invocation.executionContext.contextRef,
        "--context-epoch", invocation.executionContext.scopeEpoch, "--confirm", "--json"]);
      return readOperation(output, "deleteArtifact", invocation, staged.artifactId);
    },
  });
}
