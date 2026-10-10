import { MobileAilohaError } from "./mobile-projection.mjs";
import { isOpaqueId } from "./protocol.mjs";

export const ARTIFACT_FEATURE_GATES = Object.freeze({
  mobile_device_file_list: "The selected target must advertise a complete, owner-verified listing; listings beyond the native result cap cannot be projected as complete.",
  mobile_device_file_pull: "The backend-confirmed export device path and verified host destination/byte-count recovery require the reviewed guarded-file native source; pull is not publicly enabled.",
  mobile_device_file_push: "File push requires the verified native-stage CLI, a captured original owner and genuine scoped overwrite approval; no public native runtime is pinned.",
  mobile_device_file_delete: "Native guarded original-view deletion requires a backend-confirmed mutation path and genuine scoped human consent; no public native runtime is pinned.",
  mobile_device_file_mkdir: "Native guarded original-view directory creation requires a backend-confirmed mutation path; no public native runtime is pinned.",
  mobile_device_media_add: "Media import requires the verified native-stage CLI and complete owner-fenced batch receipts; no public native runtime is pinned.",
  mobile_device_log: "The selected target must advertise an owner-verified filtered log query with a complete pre-limit total.",
  mobile_device_crashes: "The selected target must advertise an owner-verified filtered crash query with a complete pre-limit total.",
  mobile_device_crash_report: "The selected target must advertise complete bounded crash detail; larger reports require a verified streamed export.",
});

const API_OPERATIONS = Object.freeze({
  "GET files": "mobile_device_file_list",
  "POST files/pull": "mobile_device_file_pull",
  "POST files/push": "mobile_device_file_push",
  "POST files/delete": "mobile_device_file_delete",
  "POST files/mkdir": "mobile_device_file_mkdir",
  "POST media": "mobile_device_media_add",
  "GET log": "mobile_device_log",
  "GET crashes": "mobile_device_crashes",
  "GET crash-report": "mobile_device_crash_report",
});

export function artifactApiGate(method, path) {
  const match = /^\/api\/v1\/devices\/([^/?#]+)\/(files(?:\/(?:pull|push|delete|mkdir))?|media|log|crashes(?:\/([^/?#]+))?)(\?[^#]*)?$/.exec(path);
  if (!match || (match[4] && method !== "GET")) return null;
  const operation = match[2].startsWith("crashes/") ? "crash-report" : match[2];
  const identity = API_OPERATIONS[`${method} ${operation}`];
  if (!identity) return null;
  try {
    if (!isOpaqueId(decodeURIComponent(match[1]))
      || (match[3] && !isOpaqueId(decodeURIComponent(match[3])))) {
      throw new URIError("Invalid opaque identity");
    }
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    throw new MobileAilohaError("invalid_request", "Artifact routes require escaped opaque device and crash identifiers.", 400);
  }
  return identity;
}

export function artifactFeatureError(identity) {
  const reason = ARTIFACT_FEATURE_GATES[identity];
  if (!reason) throw new TypeError("Unknown Mobile Canvas artifact feature identity.");
  return new MobileAilohaError("artifact_contract_unavailable", reason, 501);
}
