// Resolves the mobile-canvas executable for the current machine.
//
// A Copilot plugin install is a plain file copy: nothing is built, nothing is
// downloaded, and `npm install` never runs (the @github/copilot-sdk import is
// satisfied by the app runtime, not by node_modules). So the executable has to
// already be in the repository for the plugin to work on a fresh install.
//
// Shipping it gzipped keeps a 26 MB Native AOT binary down to ~10 MB per
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

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimesDir = join(packageRoot, "runtimes");
const cacheRoot = join(homedir(), ".mobile-canvas", "runtimes");

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
// Keying on the executable's own hash means a rebuilt binary lands in a new
// directory automatically, so an upgrade can never serve a stale cache and
// there is no version number to keep in sync.
function extractBundled(entry) {
  const target = join(cacheRoot, `${platformKey()}-${entry.id.slice(0, 12)}`);
  const resolved = join(target, entry.executable);
  if (existsSync(resolved)) return resolved;

  mkdirSync(cacheRoot, { recursive: true });
  const staging = mkdtempSync(join(cacheRoot, ".staging-"));
  try {
    for (const [name, file] of Object.entries(entry.files)) {
      const archive = join(runtimesDir, file.archive);
      if (!existsSync(archive)) {
        throw new Error(`bundled archive is missing: ${file.archive}`);
      }
      const bytes = gunzipSync(readFileSync(archive));
      const actual = sha256(bytes);
      if (actual !== file.sha256) {
        throw new Error(
          `checksum mismatch for ${name}: expected ${file.sha256}, got ${actual}`,
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
      if (!existsSync(resolved)) throw error;
      rmSync(staging, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  return resolved;
}

/**
 * Returns the executable to run, plus where it came from, so callers can
 * explain a failure instead of surfacing a bare ENOENT.
 */
export function resolveCommand() {
  const override = process.env.MOBILE_CANVAS_COMMAND;
  if (override && existsSync(override)) {
    return { command: override, source: "MOBILE_CANVAS_COMMAND" };
  }

  // A locally built or script-installed binary wins over the bundle so
  // contributors test their own build without clearing a cache.
  const local = join(packageRoot, "bin", EXECUTABLE);
  if (existsSync(local)) return { command: local, source: "bundled (uncompressed)" };

  const manifest = readManifest();
  const entry = manifest?.runtimes?.[platformKey()];
  if (entry) {
    return { command: extractBundled(entry), source: `bundled (${entry.rid})` };
  }

  for (const candidate of [
    join(homedir(), ".local", "bin", EXECUTABLE),
    join(homedir(), ".dotnet", "tools", EXECUTABLE),
  ]) {
    if (existsSync(candidate)) return { command: candidate, source: candidate };
  }

  if (manifest) {
    const supported = Object.keys(manifest.runtimes ?? {}).sort().join(", ");
    throw new Error(
      `no bundled binary for ${platformKey()} (this build ships: ${supported}). ` +
        `Controlling an iOS Simulator requires macOS. Install with ` +
        `"dotnet tool install -g MobileCanvas.Tool" or point MOBILE_CANVAS_COMMAND at a build.`,
    );
  }

  return { command: EXECUTABLE, source: "PATH" };
}
