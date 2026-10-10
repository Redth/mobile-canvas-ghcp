#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDarwinHelperEntries,
  remoteRuntimeManifest,
} from "../lib/runtime-assets.mjs";
import { prepareAilohaGraph, prepareSemanticGraph } from "./prepare-ailoha-graph.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const thin = process.argv.includes("--thin");
const runtimeDirectoryIndex = process.argv.indexOf("--runtime-dir");
const runtimeDirectory = runtimeDirectoryIndex < 0 ? join(root, "runtimes")
  : resolve(process.argv[runtimeDirectoryIndex + 1] ?? "");
if (runtimeDirectoryIndex >= 0 && (!process.argv[runtimeDirectoryIndex + 1] || thin)) {
  throw new Error("--runtime-dir requires a directory and bundled (not thin) packaging.");
}
const packageDirectory = thin ? "copilot-plugin-thin" : "copilot-plugin";
const output = join(root, ".build", packageDirectory, "mobile-canvas");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const archive = join(
  root,
  ".build",
  `mobile-canvas-copilot-plugin${thin ? "-thin" : ""}-v${version}.tar.gz`,
);
const runtimeManifest = JSON.parse(readFileSync(join(runtimeDirectory, "manifest.json"), "utf8"));

assertDarwinHelperEntries(runtimeManifest, { context: "Copilot plugin runtime manifest" });

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

for (const relative of [
  ".claude-plugin",
  ".github/plugin",
  ".mcp.json",
  "assets",
  "extension.mjs",
  "extensions",
  "LICENSE",
  "package.json",
  "README.md",
  "web",
  "lib/runtime.mjs",
  "lib/runtime-assets.mjs",
  "lib/ailoha",
  "lib/backend.mjs",
  "scripts/mcp.mjs",
]) {
  const destination = join(output, relative);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(root, relative), destination, { recursive: true });
}
const wsRoot = join(root, "node_modules", "ws");
cpSync(wsRoot, join(output, "node_modules", "ws"), { recursive: true });
prepareAilohaGraph(output);
prepareSemanticGraph(output);

if (thin) {
  const remoteManifest = remoteRuntimeManifest(runtimeManifest);
  mkdirSync(join(output, "runtimes"), { recursive: true });
  writeFileSync(
    join(output, "runtimes", "manifest.json"),
    `${JSON.stringify(remoteManifest, null, 2)}\n`,
  );
} else {
  cpSync(runtimeDirectory, join(output, "runtimes"), { recursive: true });
}

rmSync(archive, { force: true });
execFileSync("tar", [
  "-czf",
  archive,
  "-C",
  join(root, ".build", packageDirectory),
  "mobile-canvas",
], { env: { ...process.env, COPYFILE_DISABLE: "1" } });

console.log(`prepared Copilot plugin artifact in ${output}`);
console.log(`packed Copilot plugin artifact as ${archive}`);
