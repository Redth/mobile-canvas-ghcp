import { AilohaProtocolError } from "./errors.mjs";

export const TARGET_HOST_PROFILE = "ailoha.target-host/v1";

const hostStates = ["ready", "degraded", "maintenance"];
const providerStates = ["ready", "degraded", "unavailable", "disabled"];
export const targetStates = Object.freeze([
  "provisioning", "stopped", "starting", "running", "stopping",
  "rebooting", "resetting", "deleting", "error",
]);
export const operationStates = Object.freeze([
  "queued", "running", "succeeded", "failed", "cancelling", "cancelled",
]);
const surfaceKinds = ["display", "window", "webview", "remote-display"];
const orientations = ["portrait", "landscape", "unknown"];
const errorCodes = [
  "element-not-found", "stale-element-reference", "element-not-interactable",
  "invalid-selector", "timeout", "unknown-command", "unsupported-capability",
  "invalid-path", "internal-error",
];

function requireValid(condition) {
  if (!condition) throw new AilohaProtocolError("invalid_response");
}

function record(value, required, optional = [], allowExtensions = false) {
  requireValid(value !== null && typeof value === "object" && !Array.isArray(value));
  requireValid(required.every((key) => Object.hasOwn(value, key)));
  if (!allowExtensions) {
    requireValid(Object.keys(value).every((key) => required.includes(key) || optional.includes(key)));
  }
  return value;
}

function string(value, minimum = 0, maximum = Infinity) {
  requireValid(typeof value === "string" && value.length >= minimum);
  if (maximum !== Infinity) requireValid([...value].length <= maximum);
}

export function isOpaqueId(value) {
  if (typeof value !== "string" || !value || value === "." || value === ".."
    || /[\r\n\u2028\u2029]/u.test(value)) return false;
  try {
    encodeURIComponent(value);
    return true;
  } catch (error) {
    if (error instanceof URIError) return false;
    throw error;
  }
}

function opaque(value) {
  requireValid(isOpaqueId(value));
}

function optional(value, key, validate) {
  if (Object.hasOwn(value, key)) validate(value[key]);
}

function number(value, minimum = -Infinity) {
  requireValid(typeof value === "number" && Number.isFinite(value) && value >= minimum);
}

function timestamp(value) {
  string(value, 1);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.exec(value);
  requireValid(parts !== null);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  requireValid(month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]
    && Number.isFinite(Date.parse(value)));
}

function collection(value, validate, identity) {
  requireValid(Array.isArray(value));
  value.forEach(validate);
  if (identity) {
    requireValid(new Set(value.map((entry) => entry[identity])).size === value.length);
  }
  return value;
}

function capability(value) {
  record(value, ["id", "version"], ["features"]);
  string(value.id, 1);
  requireValid(Number.isSafeInteger(value.version) && value.version >= 1);
  optional(value, "features", (features) => {
    collection(features, (feature) => string(feature));
    requireValid(new Set(features).size === features.length);
  });
}

export function capabilities(value) {
  return collection(value, capability);
}

export function hostStatus(value) {
  record(value, ["profile", "hostId", "version", "state", "capabilities"]);
  string(value.profile, 1);
  if (value.profile !== TARGET_HOST_PROFILE) {
    throw new AilohaProtocolError("incompatible_profile");
  }
  opaque(value.hostId);
  string(value.version, 1);
  requireValid(hostStates.includes(value.state));
  capabilities(value.capabilities);
  return value;
}

function provider(value) {
  record(value, ["providerId", "name", "version", "state", "capabilities"], ["description"]);
  opaque(value.providerId);
  string(value.name, 1);
  string(value.version, 1);
  requireValid(providerStates.includes(value.state));
  capabilities(value.capabilities);
  optional(value, "description", (description) => string(description));
}

export function providers(value) {
  return collection(value, provider, "providerId");
}

function bounds(value) {
  record(value, ["x", "y", "width", "height"], ["coordinate"], true);
  number(value.x);
  number(value.y);
  number(value.width, 0);
  number(value.height, 0);
  optional(value, "coordinate", (coordinate) => requireValid(["window", "screen"].includes(coordinate)));
}

function surface(value) {
  record(value, ["surfaceId", "kind", "bounds", "geometryRevision", "capabilities"],
    ["name", "pixelDensity", "orientation"]);
  opaque(value.surfaceId);
  requireValid(surfaceKinds.includes(value.kind));
  bounds(value.bounds);
  requireValid(Number.isSafeInteger(value.geometryRevision)
    && value.geometryRevision >= 0 && value.geometryRevision <= 0xffff_ffff);
  capabilities(value.capabilities);
  optional(value, "name", (name) => string(name));
  optional(value, "pixelDensity", (density) => {
    number(density);
    requireValid(density > 0);
  });
  optional(value, "orientation", (orientation) => requireValid(orientations.includes(orientation)));
}

export function surfaces(value) {
  return collection(value, surface, "surfaceId");
}

function nativeIdentity(value) {
  const strings = ["platform", "nativeId", "serial", "provider", "modelIdentifier", "osVersion"];
  record(value, ["platform", "nativeId"], strings.slice(2).concat("isVirtual"));
  for (const key of strings) optional(value, key, (entry) => string(entry, 1, 256));
  optional(value, "isVirtual", (entry) => requireValid(typeof entry === "boolean"));
}

export function target(value) {
  record(value, ["targetId", "providerId", "targetTypeId", "status", "surfaces"],
    ["runtimeId", "templateId", "name", "createdAt", "updatedAt", "labels", "nativeIdentity"]);
  for (const key of ["targetId", "providerId", "targetTypeId"]) opaque(value[key]);
  for (const key of ["runtimeId", "templateId"]) optional(value, key, opaque);
  optional(value, "name", (name) => string(name));
  requireValid(targetStates.includes(value.status));
  surfaces(value.surfaces);
  optional(value, "createdAt", (createdAt) => {
    if (createdAt !== null) timestamp(createdAt);
  });
  optional(value, "updatedAt", timestamp);
  optional(value, "labels", (labels) => {
    record(labels, [], [], true);
    Object.values(labels).forEach((label) => string(label));
  });
  optional(value, "nativeIdentity", nativeIdentity);
  return value;
}

export function targets(value) {
  return collection(value, target, "targetId");
}

export function createRequest(value) {
  record(value, ["providerId", "targetTypeId"],
    ["runtimeId", "templateId", "name", "labels", "configuration", "start"]);
  for (const key of ["providerId", "targetTypeId", "runtimeId", "templateId"]) {
    optional(value, key, opaque);
  }
  optional(value, "name", (name) => string(name));
  optional(value, "labels", (labels) => {
    record(labels, [], [], true);
    Object.values(labels).forEach((label) => string(label));
  });
  optional(value, "configuration", (configuration) => record(configuration, [], [], true));
  optional(value, "start", (start) => requireValid(typeof start === "boolean"));
  return value;
}

export function lifecycleRequest(value) {
  record(value, [], ["reason", "options", "requestId"]);
  optional(value, "reason", (reason) => string(reason));
  optional(value, "options", (options) => record(options, [], [], true));
  optional(value, "requestId", opaque);
  return value;
}

export function operation(value) {
  record(value, ["operationId", "kind", "status", "destructive", "createdAt"],
    ["targetId", "providerId", "requestId", "progress", "startedAt", "completedAt",
      "result", "artifactIds", "problem", "cancelRequested", "cancellationProblem", "cleanupProblem"]);
  for (const key of ["operationId", "targetId", "providerId", "requestId"]) {
    optional(value, key, opaque);
  }
  string(value.kind, 1);
  requireValid(operationStates.includes(value.status));
  requireValid(typeof value.destructive === "boolean");
  for (const key of ["createdAt", "startedAt", "completedAt"]) optional(value, key, timestamp);
  optional(value, "progress", (progress) => {
    number(progress, 0);
    requireValid(progress <= 1);
  });
  optional(value, "result", (result) => record(result, [], [], true));
  optional(value, "artifactIds", (artifactIds) => collection(artifactIds, opaque));
  optional(value, "cancelRequested", (requested) => requireValid(typeof requested === "boolean"));
  for (const key of ["problem", "cancellationProblem", "cleanupProblem"]) {
    optional(value, key, (problem) => problemDetails(problem, problem?.status));
  }
  return value;
}

export function operations(value) {
  return collection(value, operation, "operationId");
}

export function artifact(value) {
  record(value, ["artifactId", "kind", "status", "contentType", "createdAt"], [
    "fileName", "size", "sha256", "targetId", "surfaceId", "operationId", "expiresAt", "metadata",
  ]);
  opaque(value.artifactId);
  string(value.kind, 1);
  requireValid(["uploading", "ready", "expired", "deleting", "failed"].includes(value.status));
  string(value.contentType, 1);
  timestamp(value.createdAt);
  optional(value, "fileName", string);
  optional(value, "expiresAt", timestamp);
  optional(value, "size", (size) => requireValid(Number.isSafeInteger(size) && size >= 0));
  optional(value, "sha256", (hash) => requireValid(typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash)));
  for (const key of ["targetId", "surfaceId", "operationId"]) optional(value, key, opaque);
  optional(value, "metadata", (metadata) => record(metadata, [], [], true));
  return value;
}

export function videoSession(value) {
  record(value, ["videoSessionId", "targetId", "surfaceId", "codec", "state", "websocketUrl", "createdAt"], [
    "geometryRevision", "source", "sourceDetail", "profile", "maxFramesPerSecond", "maxBitrateKbps", "keyFrameIntervalMs",
  ]);
  for (const key of ["videoSessionId", "targetId", "surfaceId"]) opaque(value[key]);
  requireValid(value.codec === "h264");
  requireValid(["ready", "streaming", "paused", "stopping", "stopped", "error"].includes(value.state));
  string(value.websocketUrl, 1);
  timestamp(value.createdAt);
  optional(value, "geometryRevision", (revision) => requireValid(Number.isInteger(revision) && revision >= 0 && revision <= 0xffffffff));
  optional(value, "source", string);
  optional(value, "sourceDetail", string);
  optional(value, "profile", (profile) => requireValid(["baseline", "main", "high"].includes(profile)));
  for (const [key, minimum, maximum] of [
    ["maxFramesPerSecond", 1, 120], ["maxBitrateKbps", 64, Number.MAX_SAFE_INTEGER], ["keyFrameIntervalMs", 100, Number.MAX_SAFE_INTEGER],
  ]) {
    optional(value, key, (entry) => requireValid(Number.isSafeInteger(entry) && entry >= minimum && entry <= maximum));
  }
  return value;
}

export function problemDetails(value, status) {
  record(value, ["type", "title", "status"], [], true);
  string(value.type);
  string(value.title);
  requireValid(Number.isInteger(value.status) && value.status >= 100 && value.status <= 599
    && value.status === status);
  optional(value, "detail", (detail) => string(detail));
  optional(value, "instance", (instance) => string(instance));
  optional(value, "errorCode", (code) => requireValid(errorCodes.includes(code)));
  for (const key of ["type", "instance"]) {
    optional(value, key, (uri) => {
      requireValid(!/[\s\u0000-\u001f\u007f]/u.test(uri));
      try {
        new URL(uri, "http://127.0.0.1");
      } catch (error) {
        if (error instanceof TypeError) throw new AilohaProtocolError("invalid_response");
        throw error;
      }
    });
  }
  return value;
}
