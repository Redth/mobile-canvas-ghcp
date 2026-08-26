#!/usr/bin/env node

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDarwinHelperEntries,
  remoteRuntimeManifest,
} from "../lib/runtime-assets.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = join(root, "vscode");
const output = join(extensionRoot, "dist");
const extensionPackage = JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8"));
const runtimeManifest = JSON.parse(readFileSync(join(root, "runtimes", "manifest.json"), "utf8"));
const targetIndex = process.argv.indexOf("--target");
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : null;
const thin = process.argv.includes("--thin");

assertDarwinHelperEntries(runtimeManifest, { context: "VS Code runtime manifest" });

if (target && thin) {
  throw new Error("--target and --thin cannot be combined");
}

if (extensionPackage.version !== runtimeManifest.version) {
  throw new Error(
    `VS Code extension version ${extensionPackage.version} does not match runtime bundle ${runtimeManifest.version}`,
  );
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

cpSync(join(root, "web"), join(output, "web"), { recursive: true });

if (thin) {
  const remoteManifest = remoteRuntimeManifest(runtimeManifest);
  mkdirSync(join(output, "runtimes"), { recursive: true });
  writeFileSync(
    join(output, "runtimes", "manifest.json"),
    `${JSON.stringify(remoteManifest, null, 2)}\n`,
  );
} else if (target) {
  const entry = runtimeManifest.runtimes?.[target];
  if (!entry) {
    throw new Error(
      `runtime manifest has no ${target}; available: ${Object.keys(runtimeManifest.runtimes ?? {}).join(", ")}`,
    );
  }

  const filteredManifest = {
    ...runtimeManifest,
    runtimes: { [target]: entry },
  };
  mkdirSync(join(output, "runtimes"), { recursive: true });
  writeFileSync(
    join(output, "runtimes", "manifest.json"),
    `${JSON.stringify(filteredManifest, null, 2)}\n`,
  );
  for (const file of Object.values(entry.files ?? {})) {
    if (!file.archive) {
      throw new Error(
        `cannot package ${target}: its runtime is remote-only; build the release runtimes first`,
      );
    }
    const destination = join(output, "runtimes", file.archive);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, "runtimes", file.archive), destination);
  }
} else {
  cpSync(join(root, "runtimes"), join(output, "runtimes"), { recursive: true });
}

for (const relative of [
  "lib/runtime.mjs",
  "lib/runtime-assets.mjs",
  "lib/mcp-vscode-proxy.mjs",
  "scripts/mcp-vscode.mjs",
  "LICENSE",
]) {
  const destination = join(output, relative);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(root, relative), destination);
}

mkdirSync(join(root, ".build"), { recursive: true });
const flavor = thin ? " (thin)" : target ? ` for ${target}` : "";
console.log(`prepared VS Code extension assets in ${output}${flavor}`);
