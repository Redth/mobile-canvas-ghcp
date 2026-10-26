import { immutableSnapshot, MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";
import { parseJsonObjects } from "./json-objects.mjs";
import { isOpaqueId } from "./protocol.mjs";

const verified = new WeakSet();
const receipts = new WeakMap();
const publicErrors = new Map([
  ["CanonicalCapabilityUnsupported", "The selected owner does not support this canonical inspection capability."],
  ["ContextAgentSelectionRequired", "A verified native instance must be explicitly selected in this named context."],
  ["ContextRevisionConflict", "The named context changed during inspection; read its current selection before retrying."],
  ["ContextClosed", "The captured named context is closed. No reopen, retry or fallback was attempted."],
  ["AgentNotFound", "The exact selected native runtime is no longer registered. No replacement was selected."],
  ["AgentAmbiguous", "Native runtime registration is ambiguous. Choose an unambiguous exact instance."],
  ["AgentInstanceUnverified", "The selected runtime does not supply verified native-instance evidence."],
  ["AgentInstanceMismatch", "The live native process no longer matches the selected runtime instance."],
  ["AgentTargetCorrelationUndeclared", "The native runtime does not declare its complete Target Host/target pair."],
  ["AgentTargetCorrelationMismatch", "The native runtime belongs to a different Target Host/target pair."],
  ["ContextOwnerUnavailable", "The selected canonical owner is unavailable. No fallback was attempted."],
  ["AgentTransportUnsupported", "The selected native runtime lacks a supported canonical app transport. No fallback was attempted."],
  ["unsupported-capability", "The selected owner does not advertise the required canonical app transport capability."],
  ["AgentTransportStale", "The canonical app transport no longer proves the selected target owner. Read the current binding before retrying."],
  ...["transport-failed", "internal-error", "timeout", "cancelled", "not-admitted", "invalid-path"]
    .map((code) => [code, "The original canonical app exchange failed. It was not replayed."]),
]);
const selectionKeys = ["workspaceId", "applicationId", "targetHostId", "targetId", "surfaceId", "agentId", "runtimeInstanceId"];
const observedKeys = ["hostInstanceId", "geometryRevision", "coordinateSpace", "applicationEvidence", "runtimeInstanceEvidence"];
const provenanceKeys = ["targetHostId", "targetId", "surfaceId", "applicationId", "agentId", "runtimeInstanceId"];
const invalid = () => { throw new MobileAilohaError("invocation_metadata_invalid",
  "The canonical invocation receipt did not preserve its bounded original context and exchange outcome. No replay was attempted.", 502); };
const record = (value, required, optional = []) => value !== null && typeof value === "object" && !Array.isArray(value)
  && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const id = (value, maximum = 128) => isOpaqueId(value) && value.length <= maximum && value.trim().length > 0
  && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const revision = (value) => typeof value === "string" && /^(0|[1-9][0-9]{0,127})$/.test(value);

export function captureMetadataContext({ snapshot, scope, route }) {
  if (snapshot?.state !== "open" || !snapshot.contextProjection || !scope || !["require-agent", "target-host"].includes(route)) invalid();
  return immutableSnapshot({ scope, contextRef: snapshot.contextProjection.contextRef,
    scopeEpoch: snapshot.identity.scopeEpoch, revision: snapshot.identity.revision,
    selection: Object.fromEntries(selectionKeys.map((key) => [key,
      route === "target-host" && ["agentId", "runtimeInstanceId"].includes(key) ? null : snapshot.selection?.[key] ?? null])),
    hostInstanceId: snapshot.contextProjection.hostInstanceId ?? null,
    runtimeInstanceEvidence: route === "target-host" ? "unsupported" : snapshot.contextProjection.runtimeInstanceEvidence });
}

export function validateInvocationMetadata(meta, expected) {
  try {
    if (!expected || Buffer.byteLength(JSON.stringify(meta)) > 64 * 1024
      || !record(meta, ["ailoha.executionContext"], ["ailoha.agentExchange"])) invalid();
    const context = meta["ailoha.executionContext"];
    if (!record(context, ["contextRef", "scope", "scopeEpoch", "revision", "capturedAt", "selection", "observed", "provenance"])
      || !id(context.contextRef) || !id(context.scopeEpoch) || !revision(context.revision)
      || context.contextRef !== expected.contextRef || context.scopeEpoch !== expected.scopeEpoch || context.revision !== expected.revision
      || !record(context.scope, ["sessionId", "viewId"])
      || !id(context.scope.sessionId) || !id(context.scope.viewId)
      || context.scope.sessionId !== expected.scope.sessionId || context.scope.viewId !== expected.scope.viewId
      || typeof context.capturedAt !== "string" || context.capturedAt.length > 128
      || !/^\d{4}-\d\d-\d\dT/.test(context.capturedAt) || !Number.isFinite(Date.parse(context.capturedAt))
      || !record(context.selection, selectionKeys)
      || context.selection.workspaceId !== null || context.selection.applicationId !== null
      || selectionKeys.some((key) => context.selection[key] !== expected.selection[key]
        || (context.selection[key] !== null && !id(context.selection[key], 256) && key !== "agentId"))
      || (context.selection.agentId !== null && context.selection.agentId !== `agent-${context.selection.runtimeInstanceId}`)
      || (context.selection.runtimeInstanceId !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(context.selection.runtimeInstanceId))
      || !record(context.provenance, provenanceKeys)
      || provenanceKeys.some((key) => !["explicit", "context", "absent", "not-requested"].includes(context.provenance[key]))) invalid();
    const observed = context.observed;
    if (observed !== null && (!record(observed, observedKeys)
      || observedKeys.some((key) => observed[key] !== null && !id(observed[key], 256))
      || observed.runtimeInstanceEvidence !== expected.runtimeInstanceEvidence
      || observed.applicationEvidence !== null
      || (expected.hostInstanceId !== null && observed.hostInstanceId !== expected.hostInstanceId))) invalid();
    if (observed === null && (expected.hostInstanceId !== null || expected.runtimeInstanceEvidence !== "unsupported")) invalid();
    if (Object.hasOwn(meta, "ailoha.agentExchange")) {
      const exchange = meta["ailoha.agentExchange"];
      if (!record(exchange, ["requestId", "commitAttempted", "admitted", "completed", "effectMayBeUnknown"], ["errorCode"])
        || typeof exchange.requestId !== "string" || !/^[a-f0-9]{32}$/.test(exchange.requestId)
        || ["commitAttempted", "admitted", "completed", "effectMayBeUnknown"].some((key) => typeof exchange[key] !== "boolean")
        || (exchange.admitted && !exchange.commitAttempted) || (exchange.completed && !exchange.admitted)
        || exchange.effectMayBeUnknown !== (!exchange.completed && (exchange.commitAttempted || exchange.admitted))
        || (Object.hasOwn(exchange, "errorCode") && (exchange.completed || typeof exchange.errorCode !== "string"
          || !/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(exchange.errorCode)))) invalid();
    }
    const captured = publicSnapshot({
      "ailoha.executionContext": {
        contextRef: context.contextRef, scope: context.scope, scopeEpoch: context.scopeEpoch,
        revision: context.revision, selection: context.selection,
      },
      ...(Object.hasOwn(meta, "ailoha.agentExchange") ? { "ailoha.agentExchange": meta["ailoha.agentExchange"] } : {}),
    });
    verified.add(captured);
    return captured;
  } catch {
    invalid();
  }
}

export function invocationMetadata(value) {
  return value ? receipts.get(value) : undefined;
}

export function withInvocationMetadata(value, metadata) {
  if (metadata !== undefined) {
    if (!verified.has(metadata)) invalid();
    receipts.set(value, metadata);
    if (Object.isExtensible(value)) Object.defineProperty(value, "_meta", { value: metadata, enumerable: true, configurable: true });
  }

  return value;
}

export function canonicalAppFailure(code, metadata) {
  const selected = publicErrors.has(code) ? code : metadata?.["ailoha.agentExchange"]?.errorCode ?? code;
  return withInvocationMetadata(new MobileAilohaError(publicErrors.has(selected) ? selected : "semantic_operation_failed",
    publicErrors.get(selected) ?? "The canonical inspection operation failed.",
    ["AgentTransportUnsupported", "unsupported-capability"].includes(selected) ? 501
      : ["ContextClosed", "AgentTransportStale", "cancelled"].includes(selected) ? 409 : 502), metadata);
}

export function copyInvocationMetadata(source, target) {
  return withInvocationMetadata(target, invocationMetadata(source));
}

export function readCliInvocationStderr(raw, expected, failed) {
  try {
    const records = parseJsonObjects(raw, 128 * 1024, 8, failed === false ? 1 : 2);
    let payload;
    if (failed === true || (failed === null && !Object.hasOwn(records[0], "_meta"))) {
      payload = records.shift();
      if (!record(payload, ["error", "type", "retryable"], ["suggestions"])
        || typeof payload.error !== "string" || payload.error.length > 8192
        || typeof payload.type !== "string" || !/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(payload.type)
        || payload.retryable !== false
        || (Object.hasOwn(payload, "suggestions") && (!Array.isArray(payload.suggestions)
          || payload.suggestions.length > 8 || payload.suggestions.some((entry) => typeof entry !== "string" || entry.length > 512)))) invalid();
    }
    let metadata;
    if (records.length > 1) invalid();
    if (records.length) {
      if (!record(records[0], ["_meta"])) invalid();
      metadata = validateInvocationMetadata(records[0]._meta, expected);
    }
    return { payload, metadata };
  } catch {
    invalid();
  }
}
