import { MobileAilohaError } from "./mobile-projection.mjs";

export const ARTIFACT_FEATURE_GATES = Object.freeze({
  mobile_device_file_list: "Ailoha file listings omit the resolved directory, complete total and reusable entry paths; the provider also caps results at 5,000.",
  mobile_device_file_pull: "Ailoha exports a file to an artifact, but does not return the legacy overwritten host destination and verified transferred byte count.",
  mobile_device_file_push: "Ailoha stages a host artifact and requires a confirmed import; the legacy overwritten destination and completed transfer byte count cannot be reported from its operation receipt.",
  mobile_device_file_delete: "The current Ailoha provider recursively deletes directories even when the legacy recursive flag is false; scoped human deletion consent is also unavailable.",
  mobile_device_file_mkdir: "The reviewed Ailoha file service does not expose a compatible mkdir operation and resolved-path result.",
  mobile_device_media_add: "Ailoha imports one staged photo, video or audio artifact; it does not support legacy host-path lists, accepted-path results or iOS vCards.",
  mobile_device_log: "Ailoha device logs do not expose the legacy message filter, complete match total, newest-first guarantee or process/subsystem fields.",
  mobile_device_crashes: "Ailoha crash listings do not expose the legacy process-name text filter, complete match total or newest-first guarantee.",
  mobile_device_crash_report: "Ailoha crash details omit the full report content; its separate export artifact is not the legacy report response.",
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
  const match = /^\/api\/v1\/devices\/[^/?#]+\/(files(?:\/(?:pull|push|delete|mkdir))?|media|log|crashes(?:\/[^/?#]+)?)(\?[^#]*)?$/.exec(path);
  if (!match || (match[2] && method !== "GET")) return null;
  const operation = match[1].startsWith("crashes/") ? "crash-report" : match[1];
  return API_OPERATIONS[`${method} ${operation}`] ?? null;
}

export function artifactFeatureError(identity) {
  const reason = ARTIFACT_FEATURE_GATES[identity];
  if (!reason) throw new TypeError("Unknown Mobile Canvas artifact feature identity.");
  return new MobileAilohaError("artifact_contract_unavailable", reason, 501);
}
