#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { remoteRuntimeManifest } from "../lib/runtime-assets.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const thin = process.argv.includes("--thin");
const packageDirectory = thin ? "copilot-plugin-thin" : "copilot-plugin";
const output = join(root, ".build", packageDirectory, "mobile-canvas");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const archive = join(
  root,
  ".build",
  `mobile-canvas-copilot-plugin${thin ? "-thin" : ""}-v${version}.tar.gz`,
);

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

for (const relative of [
  ".claude-plugin",
  ".github/plugin",
  ".mcp.json",
  "assets",
  "extension.mjs",
  // The Windows App child bridges to this module, so it travels with the bundle exactly as the
  // Mobile entrypoint does. It registers no canvas off Windows, so shipping it everywhere is safe.
  "windows-extension.mjs",
  "extensions",
  "LICENSE",
  "package.json",
  "README.md",
  "web",
  "lib/runtime.mjs",
  "lib/runtime-assets.mjs",
  "lib/windows-app-helper.mjs",
  "scripts/mcp.mjs",
]) {
  const destination = join(output, relative);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(root, relative), destination, { recursive: true });
}

if (thin) {
  const manifest = JSON.parse(readFileSync(join(root, "runtimes", "manifest.json"), "utf8"));
  const remoteManifest = remoteRuntimeManifest(manifest);
  mkdirSync(join(output, "runtimes"), { recursive: true });
  writeFileSync(
    join(output, "runtimes", "manifest.json"),
    `${JSON.stringify(remoteManifest, null, 2)}\n`,
  );
} else {
  cpSync(join(root, "runtimes"), join(output, "runtimes"), { recursive: true });
}

rmSync(archive, { force: true });
execFileSync("tar", [
  "-czf",
  archive,
  "-C",
  join(root, ".build", packageDirectory),
  "mobile-canvas",
]);

console.log(`prepared Copilot plugin artifact in ${output}`);
console.log(`packed Copilot plugin artifact as ${archive}`);
