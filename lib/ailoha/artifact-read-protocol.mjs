import { AilohaProtocolError } from "./errors.mjs";
import { isOpaqueId } from "./protocol.mjs";

function invalid() {
  throw new AilohaProtocolError("invalid_response");
}

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value;
}

function owned(entry, targetId) {
  const context = object(object(entry)["x-ailoha-target-host"]);
  if (context.targetId !== targetId || !isOpaqueId(context.providerId)) invalid();
  return entry;
}

function entries(value, field, targetId, maximum) {
  object(value);
  if (!Array.isArray(value[field]) || value[field].length > maximum
    || (value.total !== undefined && (!Number.isSafeInteger(value.total) || value.total < value[field].length))) {
    invalid();
  }
  value[field].forEach((entry) => owned(entry, targetId));
  return value;
}

export function artifactReadQuery(query, allowed, maximum) {
  object(query);
  if (Object.keys(query).some((key) => !allowed.includes(key) || typeof query[key] !== "string"
    || query[key].length > 4096 || query[key].includes("\0"))) {
    throw new AilohaProtocolError("invalid_options");
  }
  if (query.appId !== undefined && !isOpaqueId(query.appId)) throw new AilohaProtocolError("invalid_options");
  if (query.level !== undefined
    && !["trace", "debug", "info", "warning", "error", "critical"].includes(query.level)) {
    throw new AilohaProtocolError("invalid_options");
  }
  for (const key of ["since", "until"]) {
    if (query[key] !== undefined && (!/^\d{4}-\d{2}-\d{2}T/.test(query[key])
      || !Number.isFinite(Date.parse(query[key])))) throw new AilohaProtocolError("invalid_options");
  }
  if (query.limit !== undefined && (!/^[1-9]\d*$/.test(query.limit)
    || Number(query.limit) > maximum)) throw new AilohaProtocolError("invalid_options");
  return query;
}

export function targetInstalledApps(value, targetId) {
  if (!Array.isArray(value) || value.length > 10_000) invalid();
  value.forEach((entry) => {
    owned(entry, targetId);
    if (!isOpaqueId(entry.appId)
      || (entry.packageId != null && !isOpaqueId(entry.packageId))) invalid();
  });
  return value;
}

export function targetFileListing(value, targetId) {
  entries(value, "files", targetId, 5_000);
  if (typeof value.path !== "string" || value.path.length > 4096
    || !Number.isSafeInteger(value.total)
    || (value.nativePath !== undefined && typeof value.nativePath !== "string")) invalid();
  value.files.forEach((entry) => {
    if (typeof entry.name !== "string" || !["file", "directory"].includes(entry.type)
      || (entry.path !== undefined && typeof entry.path !== "string")
      || (entry.nativePath !== undefined && typeof entry.nativePath !== "string")
      || (entry.nativeModified !== undefined && typeof entry.nativeModified !== "string")
      || (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0))) invalid();
  });
  return value;
}

export function targetLogListing(value, targetId) {
  entries(value, "entries", targetId, 10_000);
  value.entries.forEach((entry) => {
    if (typeof entry.message !== "string" || typeof entry.source !== "string"
      || (entry.nativeLevel !== undefined && typeof entry.nativeLevel !== "string")
      || (entry.nativeTimestamp !== undefined && typeof entry.nativeTimestamp !== "string")
      || (entry.nativeSource !== undefined && typeof entry.nativeSource !== "string")
      || (entry.processId != null && (!Number.isSafeInteger(entry.processId) || entry.processId < 0))
      || (entry.subsystem != null && typeof entry.subsystem !== "string")) invalid();
  });
  return value;
}

export function targetCrashListing(value, targetId) {
  entries(value, "crashes", targetId, 500);
  value.crashes.forEach((entry) => {
    if (!isOpaqueId(entry.crashId) || (entry.nativeName !== undefined && typeof entry.nativeName !== "string")
      || (entry.nativeTimestamp !== undefined && typeof entry.nativeTimestamp !== "string")
      || (entry.nativeKind != null && typeof entry.nativeKind !== "string")) invalid();
  });
  return value;
}

export function targetCrashDetail(value, targetId, crashId) {
  owned(value, targetId);
  if (value.crashId !== crashId || typeof value.content !== "string"
    || Buffer.byteLength(value.content, "utf8") > 1024 * 1024) invalid();
  return value;
}
