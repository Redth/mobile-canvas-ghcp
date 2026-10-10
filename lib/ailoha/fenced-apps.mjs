import { appOp, isOpaqueId, operation } from "./protocol.mjs";
import { AilohaProtocolError } from "./errors.mjs";
import { immutableSnapshot, MobileAilohaError } from "./mobile-projection.mjs";
import { contextArgs } from "./staged-apps.mjs";

const RECEIPT_SCHEMA = "ailoha.target-app-action/v2";
const MODES = ["allow", "deny", "ignored", "default", "foreground"];
const RECEIPT_FIELDS = [
  "schema", "action", "attemptId", "contextRef", "scopeEpoch", "revision", "ownerProcessId", "ownerStartedAt",
  "targetHostId", "stamp", "appId", "packageId", "version", "buildNumber", "installationEvidence",
];
const OP_FIELDS = ["appOpId", "currentMode", "requestedMode", "uidScoped"];

function invalid(code, message) {
  throw new MobileAilohaError(code, message, 502);
}

function readObject(output) {
  let value;
  try { value = JSON.parse(output); }
  catch { invalid("app_action_invalid_response", "The canonical app action command returned invalid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("app_action_invalid_response", "The canonical app action command did not return an object.");
  }
  return value;
}

function hasFields(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return required.every((key) => Object.hasOwn(descriptors, key))
    && Object.entries(descriptors).every(([key, descriptor]) =>
      [...required, ...optional].includes(key)
      && Object.hasOwn(descriptor, "value") && descriptor.enumerable);
}

function capturedAction(value, invocation, request) {
  const { stamp } = value;
  const op = request.operation !== undefined;
  if (!hasFields(value, [...RECEIPT_FIELDS, ...(op ? OP_FIELDS : [])])
    || !hasFields(stamp, ["hostInstanceId", "targetId", "providerId", "registrationEpoch", "nativeIdentity", "receipt"])
    || !hasFields(stamp?.nativeIdentity, ["platform", "nativeId"],
      ["isVirtual", "serial", "provider", "modelIdentifier", "osVersion"])
    || Buffer.byteLength(JSON.stringify(value), "utf8") > 64 * 1024
    || value.schema !== RECEIPT_SCHEMA || value.action !== (op ? "app-op" : "uninstall")
    || !/^[a-f0-9]{32}$/.test(value.attemptId)
    || value.contextRef !== invocation.executionContext?.contextRef
    || value.scopeEpoch !== invocation.executionContext?.scopeEpoch
    || value.revision !== invocation.executionContext?.revision
    || value.ownerProcessId !== invocation.contextOwner?.processId
    || value.ownerStartedAt !== invocation.contextOwner?.processStartedAt
    || value.ownerProcessId !== invocation.executionContext?.ownerProcessId
    || value.targetHostId !== invocation.targetHostId
    || stamp?.targetId !== invocation.targetId || stamp.providerId !== invocation.providerId
    || stamp.nativeIdentity?.platform !== invocation.nativeIdentity?.platform
    || stamp.nativeIdentity?.nativeId !== invocation.nativeIdentity?.nativeId
    || (stamp.nativeIdentity?.isVirtual !== undefined
      && typeof stamp.nativeIdentity.isVirtual !== "boolean")
    || ["serial", "provider", "modelIdentifier", "osVersion"].some((key) =>
      stamp.nativeIdentity?.[key] !== undefined
      && typeof stamp.nativeIdentity[key] !== "string")
    || !isOpaqueId(stamp.hostInstanceId)
    || !isOpaqueId(stamp.registrationEpoch)
    || !isOpaqueId(stamp.receipt) || stamp.receipt.length > 256
    || value.appId !== request.appId || value.packageId !== request.packageId
    || value.version !== request.version || value.buildNumber !== request.buildNumber
    || typeof value.version !== "string"
    || typeof value.buildNumber !== "string"
    || typeof value.installationEvidence !== "string"
    || !/^[a-f0-9]{64}$/.test(value.installationEvidence)
    || (op && (value.appOpId !== request.operation || value.requestedMode !== request.mode
      || !MODES.includes(value.currentMode) || typeof value.uidScoped !== "boolean"))) {
    invalid("app_action_capture_mismatch",
      "The canonical app action receipt does not bind the original context, native installation and requested action.");
  }
  return immutableSnapshot({
    appId: value.appId, packageId: value.packageId, receipt: value,
    ...(op ? {
      operation: value.appOpId, currentMode: value.currentMode,
      requestedMode: value.requestedMode, uidScoped: value.uidScoped,
    } : {}),
  });
}

function accepted(output, kind, invocation) {
  const value = readObject(output);
  try { operation(value); }
  catch { invalid("app_action_invalid_response", "The canonical app action did not return a valid accepted operation."); }
  if (value.kind !== kind || !isOpaqueId(value.operationId)
    || value.targetId !== invocation.targetId
    || (value.providerId !== undefined && value.providerId !== invocation.providerId)) {
    const mismatch = new MobileAilohaError("app_action_owner_mismatch",
      "The accepted app action belongs to another operation, target or provider.", 502);
    if (isOpaqueId(value.operationId)) mismatch.operationId = value.operationId;
    throw mismatch;
  }
  return value;
}

async function submit(runCli, args, kind, invocation, options) {
  try {
    return accepted(await runCli(args, options), kind, invocation);
  } catch (error) {
    if (error instanceof AilohaProtocolError && error.status === 202 && error.operationId
      && error.operation !== undefined) {
      try { accepted(JSON.stringify(error.operation), kind, invocation); }
      catch (mismatch) {
        if (mismatch instanceof MobileAilohaError && mismatch.code === "app_action_owner_mismatch") {
          mismatch.operationId = error.operationId;
        }
        throw mismatch;
      }
    }
    throw error;
  }
}

export function createFencedAppCli({ runCli }) {
  if (typeof runCli !== "function") throw new TypeError("A verified canonical CLI runner is required.");
  return Object.freeze({
    async capture(invocation, request, options) {
      const output = await runCli([
        "target", "app", "action-capture", invocation.targetId,
        "--app-id", request.appId, "--package-id", request.packageId,
        ...(request.operation === undefined ? [] : ["--app-op", request.operation, "--mode", request.mode]),
        ...contextArgs(invocation), "--json",
      ], options);
      return capturedAction(readObject(output), invocation, request);
    },
    async uninstall(invocation, receipt, options) {
      return submit(runCli, [
        "target", "app", "uninstall-fenced", "--receipt", JSON.stringify(receipt),
        ...contextArgs(invocation), "--confirm", "--json",
      ], "uninstallFencedTargetApp", invocation, options);
    },
    async setAppOp(invocation, receipt, options) {
      return submit(runCli, [
        "target", "app", "set-app-op-fenced", "--receipt", JSON.stringify(receipt),
        ...contextArgs(invocation), "--confirm", "--json",
      ], "updateFencedTargetAppOp", invocation, options);
    },
    readback(completed, proof) {
      const result = completed?.result;
      try { appOp(result); }
      catch { invalid("app_action_readback_invalid", "The completed app operation has no canonical readback."); }
      if (result.appId !== proof.appId || result.appOpId !== proof.operation
        || typeof result.uidScoped !== "boolean") {
        invalid("app_action_readback_invalid", "The effective app operation belongs to another app or has unknown UID scope.");
      }
      return immutableSnapshot({
        appId: result.appId, appOpId: result.appOpId, mode: result.mode, uidScoped: result.uidScoped,
      });
    },
  });
}
