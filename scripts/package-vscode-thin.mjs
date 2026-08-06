#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = join(root, "vscode");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;
const output = join(root, ".build", "mobile-canvas-vscode-thin.vsix");

try {
  execFileSync(node, [join(root, "scripts", "prepare-vscode.mjs"), "--thin"], {
    stdio: "inherit",
  });
  execFileSync(
    npm,
    ["exec", "--", "vsce", "package", "--out", output],
    { cwd: extensionRoot, stdio: "inherit" },
  );
  execFileSync(node, [join(root, "scripts", "verify-vsix.mjs"), output], {
    stdio: "inherit",
  });
} finally {
  execFileSync(node, [join(root, "scripts", "prepare-vscode.mjs")], {
    stdio: "inherit",
  });
}
