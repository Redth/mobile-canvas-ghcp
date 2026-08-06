#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = join(root, "vscode");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;
const supportedTargets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
];
const manifest = JSON.parse(
  readFileSync(join(root, "runtimes", "manifest.json"), "utf8"),
);
const targets = supportedTargets.filter((target) => manifest.runtimes?.[target]);

if (targets.length === 0) {
  throw new Error("runtime manifest contains no VS Code target platforms");
}

try {
  for (const target of targets) {
    const output = join(root, ".build", `mobile-canvas-vscode-${target}.vsix`);
    execFileSync(node, [join(root, "scripts", "prepare-vscode.mjs"), "--target", target], {
      stdio: "inherit",
    });
    execFileSync(
      npm,
      [
        "exec",
        "--",
        "vsce",
        "package",
        "--target",
        target,
        "--out",
        output,
      ],
      { cwd: extensionRoot, stdio: "inherit" },
    );
    execFileSync(node, [join(root, "scripts", "verify-vsix.mjs"), output], {
      stdio: "inherit",
    });
  }
} finally {
  execFileSync(node, [join(root, "scripts", "prepare-vscode.mjs")], {
    stdio: "inherit",
  });
}
