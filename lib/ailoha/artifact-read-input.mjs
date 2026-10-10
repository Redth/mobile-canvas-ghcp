import { MobileAilohaError } from "./mobile-projection.mjs";
import { isOpaqueId } from "./protocol.mjs";

const READ_PARAMETERS = Object.freeze({
  mobile_device_file_list: new Set(["bundleId", "path"]),
  mobile_device_log: new Set(["bundleId", "level", "text", "seconds", "limit"]),
  mobile_device_crashes: new Set(["text", "limit"]),
  mobile_device_crash_report: new Set(),
});

function invalid(message) {
  throw new MobileAilohaError("invalid_request", message, 400);
}

function unavailable(message) {
  throw new MobileAilohaError("artifact_contract_unavailable", message, 501);
}

export function artifactApiInput(identity, path) {
  const url = new URL(path, "http://localhost");
  const allowed = READ_PARAMETERS[identity];
  if (!allowed) throw new TypeError("Unknown read-only artifact identity.");
  const input = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || Object.hasOwn(input, key)) invalid("Invalid or repeated artifact query parameter.");
    if (["seconds", "limit"].includes(key)) {
      if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) invalid(`Invalid ${key} query parameter.`);
      input[key] = Number(value);
    } else {
      input[key] = value;
    }
  }
  if (identity === "mobile_device_crash_report") {
    const match = /\/crashes\/([^/?#]+)$/.exec(url.pathname);
    if (!match) invalid("Missing crash report identifier.");
    input.crashId = decodeURIComponent(match[1]);
  }
  return input;
}

export function artifactFilePath(path, packageId) {
  if (path !== undefined && path !== null && typeof path !== "string") invalid("Invalid device path.");
  const value = path ?? "";
  if (value.length > 4096 || /[\\\0\r\n]/.test(value)
    || value.split("/").some((part) => part === "..")) invalid("Invalid device path.");
  if (packageId !== undefined) {
    if (!isOpaqueId(packageId) || packageId.includes("/")) invalid("Invalid installed app package.");
    const stripped = value.replace(/^\/+/, "");
    const relative = stripped === "." ? "" : stripped;
    if (relative.split("/").some((part) => part === "." || part === "" && relative !== "")) {
      unavailable("This app-relative path cannot be represented by the canonical file address.");
    }
    return `app://${packageId}/${relative}`;
  }
  if (value && !value.startsWith("/")) {
    unavailable("This relative device path has no equivalent canonical absolute address.");
  }
  return value || "/";
}

export function artifactQueryLimit(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value)) invalid("Artifact query limit must be an integer.");
  if (value < 1 || value > maximum) {
    unavailable("The legacy query limit cannot be represented by the bounded native query.");
  }
  return value;
}

export function artifactQueryText(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") invalid("Artifact query text must be a string.");
  return value;
}
