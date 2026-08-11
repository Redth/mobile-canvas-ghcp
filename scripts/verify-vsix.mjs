#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vsix = resolve(process.argv[2] ?? join(root, ".build", "mobile-canvas-vscode.vsix"));

if (!existsSync(vsix)) {
  throw new Error(`VSIX does not exist: ${vsix}`);
}

const extracted = mkdtempSync(join(tmpdir(), "mobile-canvas-vsix-"));
try {
  extractVsix(vsix, extracted);
  verifyExtracted(extracted);
} finally {
  rmSync(extracted, { recursive: true, force: true });
}

function verifyExtracted(directory) {
  const entries = new Set(listFiles(directory));
  const readEntry = (path) => readFileSync(join(directory, ...path.split("/")), "utf8");
  const extensionPackage = JSON.parse(readEntry("extension/package.json"));
  const runtimeManifest = JSON.parse(
    readEntry("extension/dist/runtimes/manifest.json"),
  );

  for (const path of [
    "extension/readme.md",
    "extension/LICENSE.txt",
    "extension/package.json",
    "extension/out/extension.js",
    "extension/media/activitybar.svg",
    "extension/media/icon.png",
    "extension/media/vscode-theme.css",
    "extension/media/vscode-theme.js",
    "extension/media/vscode-transport.js",
    "extension/dist/web/index.html",
    "extension/dist/web/canvas-state.js",
    "extension/dist/web/create-device-options.js",
    "extension/dist/web/device-canvas.css",
    "extension/dist/web/device-canvas.js",
    "extension/dist/lib/runtime.mjs",
    "extension/dist/lib/mcp-vscode-proxy.mjs",
    "extension/dist/scripts/mcp-vscode.mjs",
    "extension/dist/runtimes/manifest.json",
  ]) {
    if (!entries.has(path)) {
      throw new Error(`VSIX is missing ${path}`);
    }
  }

  for (const [platform, runtime] of Object.entries(runtimeManifest.runtimes ?? {})) {
    for (const file of Object.values(runtime.files ?? {})) {
      if (file.archive) {
        const path = `extension/dist/runtimes/${file.archive}`;
        if (!entries.has(path)) {
          throw new Error(`VSIX is missing ${platform} runtime archive ${file.archive}`);
        }
      } else if (!file.asset) {
        throw new Error(`${platform} runtime has neither a bundled archive nor a release asset`);
      }
    }
  }

  for (const path of entries) {
    if (
      path.startsWith("extension/src/")
      || path.startsWith("extension/test/")
      || path.startsWith("extension/.vscode-test/")
      || path.endsWith(".map")
    ) {
      throw new Error(`VSIX contains development-only file ${path}`);
    }
  }

  if (extensionPackage.version !== runtimeManifest.version) {
    throw new Error(
      `VSIX extension version ${extensionPackage.version} does not match runtime version ${runtimeManifest.version}`,
    );
  }
  if (!extensionPackage.extensionKind?.includes("ui")) {
    throw new Error("VSIX must run in the local UI extension host.");
  }
  if (extensionPackage.icon !== "media/icon.png") {
    throw new Error("VSIX must declare the marketplace icon at media/icon.png.");
  }
  for (const name of [
    "mobileCanvas_selectedDevice",
    "mobileCanvas_screenshot",
    "mobileCanvas_uiTree",
  ]) {
    if (!extensionPackage.contributes?.languageModelTools?.some(
      (tool) => tool.name === name && tool.canBeReferencedInPrompt === true,
    )) {
      throw new Error(`VSIX is missing attachable chat tool ${name}.`);
    }
  }

  const sizeMiB = statSync(vsix).size / 1024 / 1024;
  if (sizeMiB > 100) {
    throw new Error(`VSIX is unexpectedly large: ${sizeMiB.toFixed(1)} MiB`);
  }

  console.log(
    `verified ${entries.size} VSIX entries, `
    + `${Object.keys(runtimeManifest.runtimes).length} runtimes, `
    + `${sizeMiB.toFixed(1)} MiB`,
  );
}

function extractVsix(source, destination) {
  if (process.platform === "win32") {
    const archive = join(destination, "mobile-canvas-vsix.zip");
    copyFileSync(source, archive);
    try {
      execFileSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Expand-Archive -LiteralPath $env:MC_VSIX -DestinationPath $env:MC_DEST -Force",
        ],
        {
          env: { ...process.env, MC_VSIX: archive, MC_DEST: destination },
          stdio: "inherit",
        },
      );
    } finally {
      rmSync(archive, { force: true });
    }
    return;
  }
  execFileSync("unzip", ["-q", source, "-d", destination]);
}

function listFiles(rootDirectory) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(relative(rootDirectory, path).split(sep).join("/"));
      }
    }
  };
  visit(rootDirectory);
  return files;
}
