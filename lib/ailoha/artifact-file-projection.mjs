import { MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";
import { isOpaqueId } from "./protocol.mjs";

function invalid(message) {
  throw new MobileAilohaError("invalid_artifact_listing", message, 502);
}

function legacyPath(nativePath, bundleId) {
  if (typeof nativePath !== "string") invalid("Ailoha omitted a device file path.");
  const prefix = bundleId ? `app://${bundleId}/` : "/";
  if (!nativePath.startsWith(prefix)) invalid("Ailoha returned a file outside the captured device address.");
  const relative = bundleId ? nativePath.slice(prefix.length) : nativePath;
  if (relative.split("/").some((part) => part === "." || part === "..")) {
    invalid("Ailoha returned a noncanonical device file path.");
  }
  return relative;
}

function requireNativePath(raw, canonical, platform, bundleId) {
  const expected = bundleId
    ? platform === "ios" ? `/${canonical}` : canonical || "."
    : canonical;
  if (raw !== expected) invalid("Ailoha did not preserve the native device file path.");
  return raw;
}

export function projectFileListing({ deviceId, platform, bundleId, listing }) {
  if (!isOpaqueId(deviceId) || !["ios", "android"].includes(platform)
    || (bundleId !== undefined && bundleId !== null && (!isOpaqueId(bundleId) || bundleId.includes("/")))) {
    throw new MobileAilohaError("invalid_request", "File listing requires a captured device and app identity.", 400);
  }
  if (!listing || !Array.isArray(listing.files) || !Number.isSafeInteger(listing.total)
    || listing.total < 0 || listing.total !== listing.files.length) {
    invalid("Ailoha did not return a complete directory listing with its exact total.");
  }
  const canonicalPath = legacyPath(listing.path, bundleId);
  const path = requireNativePath(listing.nativePath, canonicalPath, platform, bundleId);
  const files = listing.files.map((entry) => {
    if (!entry || typeof entry.name !== "string" || !entry.name
      || entry.name.includes("/") || entry.name === "." || entry.name === ".."
      || !["file", "directory"].includes(entry.type)) {
      invalid("Ailoha returned an invalid device file entry.");
    }
    const canonicalFilePath = legacyPath(entry.path, bundleId);
    const expected = canonicalPath === "/" ? `/${entry.name}`
      : canonicalPath ? `${canonicalPath}/${entry.name}` : entry.name;
    if (canonicalFilePath !== expected) invalid("Ailoha returned a file path outside the listed directory.");
    const filePath = requireNativePath(entry.nativePath, canonicalFilePath, platform, bundleId);
    if (entry.type === "file" && (!Number.isSafeInteger(entry.size) || entry.size < 0)) {
      invalid("Ailoha did not report an actual file size, including zero for an empty file.");
    }
    if (entry.nativeModified !== undefined && typeof entry.nativeModified !== "string") {
      invalid("Ailoha returned an invalid native modification timestamp.");
    }
    return {
      name: entry.name, path: filePath, isDirectory: entry.type === "directory",
      size: entry.type === "directory" ? 0 : entry.size,
      modified: entry.nativeModified ?? null,
    };
  });
  return publicSnapshot({ schemaVersion: "1.0", deviceId, platform, path, files, total: listing.total });
}
