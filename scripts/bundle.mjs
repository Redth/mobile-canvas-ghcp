#!/usr/bin/env node
// Packs built binaries into runtimes/ so a plugin install carries them.
//
// Each runtime is added independently, because a release matrix builds every
// architecture on its own runner; the manifest is merged rather than replaced
// so `--rid osx-x64` never discards what `--rid osx-arm64` already wrote.
//
// Usage: node scripts/bundle.mjs --rid osx-arm64 [--from .build/bin]

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceHash } from "./source-hash.mjs";
import {
  validateWindowsAppHelperEntry,
  windowsAppHelperFilesForRid,
} from "../lib/windows-app-helper.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimesDir = process.env.MOBILE_CANVAS_RUNTIMES_DIR
  ? resolve(process.env.MOBILE_CANVAS_RUNTIMES_DIR)
  : join(packageRoot, "runtimes");

// .NET runtime identifier -> the `${process.platform}-${process.arch}` value
// Node reports on that machine, which is what the resolver looks up.
const PLATFORM_KEYS = {
  "osx-arm64": "darwin-arm64",
  "osx-x64": "darwin-x64",
  "linux-arm64": "linux-arm64",
  "linux-x64": "linux-x64",
  "win-arm64": "win32-arm64",
  "win-x64": "win32-x64",
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument: ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const rid = args.rid;
if (!rid) {
  console.error("usage: node scripts/bundle.mjs --rid <rid> [--from <dir>]");
  console.error(`supported rids: ${Object.keys(PLATFORM_KEYS).join(", ")}`);
  process.exit(2);
}

const platformKey = PLATFORM_KEYS[rid];
if (!platformKey) throw new Error(`unsupported rid: ${rid}`);

const sourceDir = resolve(packageRoot, args.from ?? ".build/bin");
const suffix = rid.startsWith("win-") ? ".exe" : "";
const executable = `mobile-canvas${suffix}`;
const helperFiles = windowsAppHelperFilesForRid(rid);

// The capture helper only exists on macOS, where it owns direct simulator
// framebuffer capture, ScreenCaptureKit fallback, and VideoToolbox encoding.
const wanted = [
  { name: executable, required: true },
  ...helperFiles.map((name) => ({ name, required: true })),
  ...(!rid.startsWith("win-")
    ? [{ name: `mobile-screencap${suffix}`, required: false }]
    : []),
];

const files = {};
let primaryHash = null;

for (const { name, required } of wanted) {
  const source = join(sourceDir, name);
  if (!existsSync(source)) {
    if (required) {
      throw new Error(`missing ${name} in ${sourceDir} -- run scripts/build.sh first`);
    }
    continue;
  }

  const bytes = readFileSync(source);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (name === executable) primaryHash = sha256;

  const archive = `${rid}/${name}.gz`;
  mkdirSync(join(runtimesDir, rid), { recursive: true });
  // Maximum compression: this is written once per release and read on every
  // cold start, so trading pack time for download size is always correct.
  const packed = gzipSync(bytes, { level: 9 });
  writeFileSync(join(runtimesDir, archive), packed);

  files[name] = { archive, sha256, size: bytes.length };
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  console.log(`  ${name}: ${mb(bytes.length)} MB -> ${mb(packed.length)} MB`);
}

const manifestPath = join(runtimesDir, "manifest.json");
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { runtimes: {} };

manifest.version = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
).version;
manifest.distribution = {
  repository: "Redth/mobile-canvas-ghcp",
  tag: process.env.MOBILE_CANVAS_RELEASE_TAG || `v${manifest.version}`,
};
// Recorded so CI can tell whether runtimes/ still matches src/ without rebuilding.
// Comparing the built bytes cannot answer that: Native AOT is not bit-reproducible,
// so a rebuild of identical source differs anyway.
manifest.sourceHash = sourceHash().hash;
const entry = { rid, executable, id: primaryHash, files };
if (helperFiles.length > 0) entry.helpers = helperFiles;
validateWindowsAppHelperEntry(platformKey, entry);
manifest.runtimes[platformKey] = entry;

// Sorted so a rebuild of one architecture produces no incidental diff noise
// in the others, keeping release commits readable.
manifest.runtimes = Object.fromEntries(
  Object.entries(manifest.runtimes).sort(([a], [b]) => a.localeCompare(b)),
);

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const total = readdirSync(runtimesDir, { recursive: true })
  .map((entry) => join(runtimesDir, entry))
  .filter((path) => statSync(path).isFile())
  .reduce((sum, path) => sum + statSync(path).size, 0);

console.log(`bundled ${rid} as ${platformKey}`);
console.log(`runtimes/ total: ${(total / 1024 / 1024).toFixed(1)} MB`);
