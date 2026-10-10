import { MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";
import { isOpaqueId } from "./protocol.mjs";

const LEGACY_LEVELS = new Set(["verbose", "debug", "info", "warning", "error", "fatal"]);
const MAX_INLINE_CRASH_REPORT_BYTES = 1024 * 1024;

function invalid(message) {
  throw new MobileAilohaError("invalid_artifact_diagnostics", message, 502);
}

function owner(deviceId, platform) {
  if (!isOpaqueId(deviceId) || !["ios", "android"].includes(platform)) {
    throw new MobileAilohaError("invalid_request", "Diagnostics require a captured device and platform.", 400);
  }
}

function resultCount(total, entries) {
  if (!Array.isArray(entries) || !Number.isSafeInteger(total) || total < entries.length) {
    invalid("Ailoha omitted the complete native diagnostic match count.");
  }
}

function crashReport(entry) {
  if (!entry || !isOpaqueId(entry.crashId)
    || typeof entry.nativeName !== "string" || !entry.nativeName
    || typeof entry.nativeTimestamp !== "string" || !entry.nativeTimestamp
    || (entry.appId !== undefined && entry.appId !== null && typeof entry.appId !== "string")
    || (entry.nativeKind !== undefined && entry.nativeKind !== null && typeof entry.nativeKind !== "string")) {
    invalid("Ailoha omitted the raw native crash identity or report metadata.");
  }
  return {
    id: entry.crashId, name: entry.nativeName, bundleId: entry.appId ?? null,
    timestamp: entry.nativeTimestamp, kind: entry.nativeKind ?? null,
  };
}

export function projectDeviceLogs({ deviceId, platform, result }) {
  owner(deviceId, platform);
  resultCount(result?.total, result?.entries);
  const entries = result.entries.map((entry) => {
    if (!entry || typeof entry.nativeTimestamp !== "string" || !entry.nativeTimestamp
      || !LEGACY_LEVELS.has(entry.nativeLevel)
      || typeof entry.nativeSource !== "string" || entry.source !== "native"
      || typeof entry.message !== "string"
      || (entry.processId !== undefined && entry.processId !== null
        && (!Number.isSafeInteger(entry.processId) || entry.processId < 0))
      || (entry.subsystem !== undefined && entry.subsystem !== null && typeof entry.subsystem !== "string")) {
      invalid("Ailoha omitted a raw native log field required by the legacy result.");
    }
    return {
      timestamp: entry.nativeTimestamp, level: entry.nativeLevel,
      source: entry.nativeSource, message: entry.message,
      processId: entry.processId ?? null, subsystem: entry.subsystem ?? null,
    };
  });
  return publicSnapshot({ schemaVersion: "1.0", deviceId, platform, entries, total: result.total });
}

export function projectDeviceCrashes({ deviceId, platform, result }) {
  owner(deviceId, platform);
  resultCount(result?.total, result?.crashes);
  return publicSnapshot({
    schemaVersion: "1.0", deviceId, platform,
    crashes: result.crashes.map(crashReport), total: result.total,
  });
}

export function projectDeviceCrashReport({ deviceId, result }) {
  if (!isOpaqueId(deviceId)) {
    throw new MobileAilohaError("invalid_request", "Crash details require a captured device.", 400);
  }
  if (typeof result?.content !== "string" || Buffer.byteLength(result.content, "utf8") > MAX_INLINE_CRASH_REPORT_BYTES) {
    invalid("Ailoha did not return a complete bounded native crash report; use the artifact export for larger reports.");
  }
  return publicSnapshot({
    schemaVersion: "1.0", deviceId, report: crashReport(result), content: result.content,
  });
}
