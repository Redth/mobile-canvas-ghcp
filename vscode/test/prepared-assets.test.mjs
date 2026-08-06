import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("prepared extension assets contain the shared runtime and UI", () => {
  for (const relative of [
    "dist/web/index.html",
    "dist/web/create-device-options.js",
    "dist/web/device-canvas.js",
    "dist/lib/runtime.mjs",
    "dist/lib/runtime-assets.mjs",
    "dist/lib/mcp-vscode-proxy.mjs",
    "dist/scripts/mcp-vscode.mjs",
    "dist/runtimes/manifest.json",
    "dist/LICENSE",
    "media/vscode-theme.css",
    "media/vscode-theme.js",
  ]) {
    assert.equal(existsSync(join(extensionRoot, relative)), true, relative);
  }

  const extensionPackage = JSON.parse(
    readFileSync(join(extensionRoot, "package.json"), "utf8"),
  );
  const runtimeManifest = JSON.parse(
    readFileSync(join(extensionRoot, "dist/runtimes/manifest.json"), "utf8"),
  );
  assert.equal(runtimeManifest.version, extensionPackage.version);
});
