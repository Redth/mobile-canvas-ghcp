// Resolves the mobile-canvas executable for the current machine.
//
// A Copilot plugin install is a plain file copy: nothing is built and `npm
// install` never runs (the @github/copilot-sdk import is satisfied by the app
// runtime, not by node_modules). The checked-in manifest therefore resolves a
// checksummed release asset on first use.
//
// Publishing it gzipped keeps a 26 MB Native AOT binary down to ~10 MB per
// architecture, and gzip is byte-exact so the adhoc code signature that macOS
// requires on arm64 survives the round trip. Extracting also launders the
// com.apple.quarantine attribute Gatekeeper would otherwise attach when a user
// installs from a downloaded archive, because the file is written by this
// process rather than unpacked by the browser.

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeAssetUrl } from "./runtime-assets.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimesDir = join(packageRoot, "runtimes");
const defaultCacheRoot = join(homedir(), ".mobile-canvas", "runtimes");
const maxArchiveBytes = 128 * 1024 * 1024;
const maxRuntimeBytes = 512 * 1024 * 1024;

// Windows executables carry .exe. The bundled path reads the name from the
// manifest, but the PATH and tool-install fallbacks have to derive it.
export const EXECUTABLE = process.platform === "win32" ? "mobile-canvas.exe" : "mobile-canvas";

/** Key used in runtimes/manifest.json, e.g. "darwin-arm64". */
export function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function readManifest() {
  const file = join(runtimesDir, "manifest.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// Extracts every file for this platform into a content-addressed directory.
// The manifest historically keyed `entry.id` only on mobile-canvas. Include every
// file hash here so a helper-only rebuild cannot reuse a cache containing stale
// native assets.
export async function materializeRuntime(manifest, entry, options = {}) {
  const runtimeDirectory = options.runtimesDir ?? runtimesDir;
  const cacheRoot =
    options.cacheRoot
    ?? process.env.MOBILE_CANVAS_CACHE_DIR
    ?? defaultCacheRoot;
  const key = options.platformKey ?? platformKey();
  const target = join(cacheRoot, `${key}-${runtimeContentId(entry).slice(0, 12)}`);
  const resolved = join(target, entry.executable);
  if (hasEveryMaterializedFile(target, entry)) return resolved;
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });

  mkdirSync(cacheRoot, { recursive: true });
  const staging = mkdtempSync(join(cacheRoot, ".staging-"));
  try {
    for (const [name, file] of Object.entries(entry.files)) {
      if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > maxRuntimeBytes) {
        throw new Error(`invalid declared runtime size for ${name}: ${file.size}`);
      }
      const archive = file.archive ? join(runtimeDirectory, file.archive) : null;
      const packed = archive && existsSync(archive)
        ? readFileSync(archive)
        : await downloadArchive(manifest, entry, name, options);
      const bytes = gunzipSync(packed, { maxOutputLength: file.size });
      const actual = sha256(bytes);
      if (actual !== file.sha256) {
        throw new Error(
          `checksum mismatch for ${name}: expected ${file.sha256}, got ${actual}`,
        );
      }
      if (bytes.length !== file.size) {
        throw new Error(
          `size mismatch for ${name}: expected ${file.size}, got ${bytes.length}`,
        );
      }
      const staged = join(staging, name);
      writeFileSync(staged, bytes);
      chmodSync(staged, 0o755);
    }

    try {
      renameSync(staging, target);
    } catch (error) {
      // Another canvas panel or MCP server extracted the same build first.
      // Its directory is equally valid, so adopt it rather than failing.
      if (!hasEveryMaterializedFile(target, entry)) throw error;
      rmSync(staging, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  return resolved;
}

function runtimeContentId(entry) {
  const files = Object.entries(entry.files ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, file]) => `${name}\0${file.sha256}\0${file.size}`)
    .join("\n");
  return sha256(Buffer.from(files));
}

function hasEveryMaterializedFile(target, entry) {
  return Object.keys(entry.files ?? {}).every((name) => existsSync(join(target, name)));
}

async function downloadArchive(manifest, entry, fileName, options) {
  const url = runtimeAssetUrl(
    manifest,
    entry,
    fileName,
    options.baseUrl ?? process.env.MOBILE_CANVAS_RUNTIME_BASE_URL,
  );
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error(`cannot download ${fileName}: this Node.js runtime has no fetch implementation`);
  }

  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  if (!response.ok) {
    throw new Error(`failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
  }

  const archiveLimit = options.maxArchiveBytes ?? maxArchiveBytes;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > archiveLimit) {
    throw new Error(`refusing oversized runtime archive from ${url}: ${contentLength} bytes`);
  }
  if (!response.body) {
    throw new Error(`failed to download ${url}: response has no body`);
  }

  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.byteLength;
    if (received > archiveLimit) {
      throw new Error(`refusing oversized runtime archive from ${url}: more than ${archiveLimit} bytes`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, received);
}

function hasEveryBundledArchive(entry) {
  return Object.values(entry.files ?? {}).every(
    (file) => file.archive && existsSync(join(runtimesDir, file.archive)),
  );
}

/**
 * Returns the executable to run, plus where it came from, so callers can
 * explain a failure instead of surfacing a bare ENOENT.
 */
export async function resolveCommand() {
  const override = process.env.MOBILE_CANVAS_COMMAND;
  if (override && existsSync(override)) {
    return { command: override, source: "MOBILE_CANVAS_COMMAND" };
  }

  // A locally built or script-installed binary wins over the release asset so
  // contributors test their own build without clearing a cache.
  const local = join(packageRoot, "bin", EXECUTABLE);
  if (existsSync(local)) return { command: local, source: "bundled (uncompressed)" };

  const manifest = readManifest();
  const entry = manifest?.runtimes?.[platformKey()];
  if (entry && hasEveryBundledArchive(entry)) {
    return {
      command: await materializeRuntime(manifest, entry),
      source: `bundled (${entry.rid})`,
    };
  }

  for (const candidate of [
    join(homedir(), ".local", "bin", EXECUTABLE),
    join(homedir(), ".dotnet", "tools", EXECUTABLE),
  ]) {
    if (existsSync(candidate)) return { command: candidate, source: candidate };
  }

  if (entry) {
    return {
      command: await materializeRuntime(manifest, entry),
      source: `downloaded (${entry.rid})`,
    };
  }

  if (manifest) {
    const supported = Object.keys(manifest.runtimes ?? {}).sort().join(", ");
    throw new Error(
      `no runtime for ${platformKey()} (this manifest supports: ${supported}). ` +
        `Controlling an iOS Simulator requires macOS. Install with ` +
        `"dotnet tool install -g MobileCanvas.Tool" or point MOBILE_CANVAS_COMMAND at a build.`,
    );
  }

  return { command: EXECUTABLE, source: "PATH" };
}
