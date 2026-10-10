import { assertPublicResource } from "./errors.mjs";
import { isOpaqueId, surfaces, target as validateTarget } from "./protocol.mjs";
import { ailohaDisplayGeometry } from "../../web/ailoha-canvas-state.js";

const STATES = Object.freeze({
  running: "booted",
  stopped: "shutdown",
  starting: "booting",
  provisioning: "booting",
  rebooting: "booting",
  resetting: "booting",
  stopping: "shutting-down",
  deleting: "shutting-down",
  error: "unknown",
});

export const MOBILE_CAPABILITIES = Object.freeze([
  "boot", "shutdown", "restart", "erase", "delete", "reveal",
  "tap", "longPress", "swipe", "scroll", "text", "key", "button",
  "rotate", "screenshot", "liveStream", "recording",
]);

export class MobileAilohaError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "MobileAilohaError";
    this.code = code;
    this.status = status;
  }
}

export function publicSnapshot(value) {
  assertPublicResource(value, []);
  return immutableSnapshot(value);
}

export function immutableSnapshot(value) {
  const copy = structuredClone(value);
  const freeze = (entry) => {
    if (entry && typeof entry === "object") {
      Object.values(entry).forEach(freeze);
      Object.freeze(entry);
    }
    return entry;
  };
  return freeze(copy);
}

export function captureConnectionRef(value) {
  const fields = ["serviceId", "pid", "startedAt", "processStartedAt"];
  const allowed = new Set([...fields, "schema"]);
  const invalid = () => {
    throw new MobileAilohaError("runtime_connection_ref_invalid", "The official runtime lease lacks complete process-incarnation evidence.", 503);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some((key) => !allowed.has(key) || !Object.hasOwn(descriptors[key], "value")
    || !descriptors[key].enumerable)
    || fields.some((key) => !Object.hasOwn(descriptors, key))
    || !isOpaqueId(value.serviceId) || !Number.isSafeInteger(value.pid) || value.pid < 1
    || ["startedAt", "processStartedAt"].some((key) =>
      typeof value[key] !== "string" || value[key].length > 128 || !Number.isFinite(Date.parse(value[key])))
    || (value.schema !== undefined && !isOpaqueId(value.schema))) invalid();
  return Object.isFrozen(value) ? value : publicSnapshot(value);
}

export function sameConnectionRef(left, right) {
  if (!left || !right || ["serviceId", "pid", "startedAt", "processStartedAt"].some((key) =>
    !Object.hasOwn(left, key) || !Object.hasOwn(right, key))) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key]);
}

export function hasOperation(capabilities, operation, capabilityId) {
  return capabilities.some((capability) =>
    capability.version === 1 && (capabilityId === undefined || capability.id === capabilityId)
    && capability.features?.includes(operation));
}

export function requireSurface(target, surfaceId) {
  const candidates = target.surfaces.filter((surface) =>
    surfaceId === undefined || surface.surfaceId === surfaceId);
  if (candidates.length !== 1) {
    throw new MobileAilohaError(
      candidates.length === 0 ? "surface_unavailable" : "surface_ambiguous",
      candidates.length === 0
        ? "Ailoha has no matching surface for this target."
        : "Ailoha returned multiple surfaces; select an explicit surface.",
    );
  }
  return candidates[0];
}

export function projectSurfaceGeometry(surface) {
  surfaces([surface]);
  const { bounds } = surface;
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new MobileAilohaError("geometry_unavailable", "Ailoha has not reported usable logical bounds.");
  }
  return publicSnapshot(ailohaDisplayGeometry(surface, surface.surfaceId));
}

export function projectMobileTarget({ hostId, target, provider, supported = {}, surfaceId }) {
  if (!isOpaqueId(hostId)) throw new TypeError("An opaque Ailoha host ID is required.");
  validateTarget(target);
  if (provider.providerId !== target.providerId) {
    throw new MobileAilohaError("provider_identity_mismatch", "Ailoha target provenance does not match its provider.");
  }
  const native = target.nativeIdentity;
  const providerAvailable = provider.state !== "unavailable" && provider.state !== "disabled";
  const capabilities = Object.fromEntries(MOBILE_CAPABILITIES.map((name) => [
    name, providerAvailable && Object.hasOwn(supported, name) && supported[name] === true,
  ]));
  const matchingSurfaces = target.surfaces.filter((surface) =>
    surfaceId === undefined || surface.surfaceId === surfaceId);
  const surface = matchingSurfaces.length === 1 ? matchingSurfaces[0] : undefined;
  let display = null;
  if (surface?.bounds.width > 0 && surface.bounds.height > 0) {
    display = projectSurfaceGeometry(surface);
  }
  if (!display) {
    for (const name of ["tap", "longPress", "swipe", "scroll", "screenshot", "liveStream"]) {
      capabilities[name] = false;
    }
  }
  return publicSnapshot({
    schemaVersion: "1.0",
    backend: "ailoha",
    id: target.targetId,
    targetHostId: hostId,
    targetId: target.targetId,
    targetStatus: target.status,
    provider: target.providerId,
    providerState: provider.state,
    targetTypeId: target.targetTypeId,
    platform: native?.platform ?? "unknown",
    nativeId: native?.nativeId ?? null,
    ...(native?.platform === "ios" ? { udid: native.nativeId } : {}),
    ...(native ? { nativeIdentity: native } : {}),
    ...(native?.serial ? { serial: native.serial } : {}),
    ...(native?.isVirtual !== undefined ? { isVirtual: native.isVirtual } : {}),
    ...(native?.osVersion ? { osVersion: native.osVersion } : {}),
    ...(native?.modelIdentifier ? { modelIdentifier: native.modelIdentifier } : {}),
    ...(target.runtimeId ? { runtimeId: target.runtimeId } : {}),
    name: target.name || target.targetId,
    state: STATES[target.status],
    isAvailable: providerAvailable && target.status !== "error",
    surfaceId: surface?.surfaceId ?? null,
    surfaces: target.surfaces,
    surfaceStatus: surface ? "available" : matchingSurfaces.length > 1 ? "ambiguous" : "unavailable",
    display,
    capabilities,
  });
}

export function captureInvocation({ scope, device, selectionGeneration, surface, context, connectionRef, contextOwner }) {
  for (const value of [scope.sessionId, scope.viewId, device.targetHostId, device.targetId, device.provider]) {
    if (!isOpaqueId(value)) throw new TypeError("A captured Ailoha invocation requires explicit owner IDs.");
  }
  if (!Number.isSafeInteger(selectionGeneration) || selectionGeneration < 0) {
    throw new TypeError("A captured Ailoha invocation requires a selection generation.");
  }
  if (context !== undefined && (!isOpaqueId(context.contextRef) || !isOpaqueId(context.scopeEpoch)
    || typeof context.revision !== "string" || !/^(0|[1-9][0-9]{0,127})$/.test(context.revision)
    || !Number.isSafeInteger(context.ownerProcessId) || context.ownerProcessId < 1)) {
    throw new TypeError("A captured context requires its canonical reference, epoch, revision and product owner.");
  }
  const captured = publicSnapshot({
    scope: { sessionId: scope.sessionId, viewId: scope.viewId },
    targetHostId: device.targetHostId,
    targetId: device.targetId,
    providerId: device.provider,
    selectionGeneration,
    ...(context ? { executionContext: context } : {}),
    ...(surface ? {
      surfaceId: surface.surfaceId,
      geometry: projectSurfaceGeometry(surface),
    } : {}),
    ...(device.nativeIdentity ? { nativeIdentity: device.nativeIdentity } : {}),
  });
  if (connectionRef === undefined && contextOwner === undefined) return captured;
  const invocation = { ...captured };
  if (connectionRef !== undefined) Object.defineProperty(invocation, "connectionRef", { value: captureConnectionRef(connectionRef) });
  if (contextOwner !== undefined) {
    if (!contextOwner || typeof contextOwner !== "object" || Array.isArray(contextOwner)) {
      throw new MobileAilohaError("context_owner_invalid", "The captured canonical process owner is incomplete or mismatched.", 503);
    }
    const descriptors = Object.getOwnPropertyDescriptors(contextOwner);
    if (!context || ![Object.prototype, null].includes(Object.getPrototypeOf(contextOwner))
      || Object.getOwnPropertySymbols(contextOwner).length
      || Object.keys(descriptors).sort().join() !== "processId,processStartedAt"
      || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
      || contextOwner.processId !== context.ownerProcessId || typeof contextOwner.processStartedAt !== "string"
      || contextOwner.processStartedAt.length > 128 || !Number.isFinite(Date.parse(contextOwner.processStartedAt))) {
      throw new MobileAilohaError("context_owner_invalid", "The captured canonical process owner is incomplete or mismatched.", 503);
    }
    Object.defineProperty(invocation, "contextOwner", { value: Object.isFrozen(contextOwner) ? contextOwner : publicSnapshot(contextOwner) });
  }
  return Object.freeze(invocation);
}

export function assertObservedGeometry(invocation, observed) {
  const geometry = invocation.geometry;
  if (!geometry || !observed
    || observed.geometryRevision !== geometry.geometryRevision
    || observed.surfaceId !== invocation.surfaceId
    || observed.coordinate !== geometry.coordinate) {
    throw new MobileAilohaError(
      "stale_geometry",
      "Input requires the captured surface's observed coordinate space and geometry revision.",
    );
  }
  return geometry;
}

export function assertLogicalPoint(geometry, x, y) {
  if (![x, y].every((value) => typeof value === "number" && Number.isFinite(value))
    || x < geometry.pointX || x > geometry.pointX + geometry.pointWidth
    || y < geometry.pointY || y > geometry.pointY + geometry.pointHeight) {
    throw new MobileAilohaError("invalid_coordinates", "Input coordinates must lie within observed logical bounds.", 400);
  }
}
