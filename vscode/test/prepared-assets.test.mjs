import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertDarwinHelperEntries } from "../../lib/runtime-assets.mjs";

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("prepared extension assets contain the shared runtime and UI", () => {
  for (const relative of [
    "dist/web/index.html",
    "dist/web/ailoha-video-protocol.js",
    "dist/web/ailoha-video-receiver.js",
    "dist/web/ailoha-video-player.js",
    "dist/web/ailoha-canvas-state.js",
    "dist/web/canvas-state.js",
    "dist/web/create-device-options.js",
    "dist/web/device-canvas.js",
    "dist/lib/runtime.mjs",
    "dist/lib/runtime-assets.mjs",
    "dist/lib/mcp-vscode-proxy.mjs",
    "dist/lib/ailoha/index.mjs",
    "dist/lib/ailoha/index.d.mts",
    "dist/lib/ailoha/errors.mjs",
    "dist/lib/ailoha/protocol.mjs",
    "dist/lib/ailoha/mobile-backend.mjs",
    "dist/lib/ailoha/destructive-consent.mjs",
    "dist/lib/ailoha/mobile-projection.mjs",
    "dist/lib/ailoha/media-adapter.mjs",
    "dist/lib/ailoha/runtime-sdk.mjs",
    "dist/lib/ailoha/runtime-backend.mjs",
    "dist/lib/ailoha/context-adapter.mjs",
    "dist/lib/ailoha/canvas-host.mjs",
    "dist/lib/ailoha/github-adapter.mjs",
    "dist/lib/ailoha/mcp-host.mjs",
    "dist/lib/ailoha/mcp-catalog.json",
    "dist/lib/backend.mjs",
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
  assertDarwinHelperEntries(runtimeManifest, { context: "prepared VS Code assets" });
  assert.equal(runtimeManifest.version, extensionPackage.version);
  for (const runtime of Object.values(runtimeManifest.runtimes)) {
    for (const file of Object.values(runtime.files)) {
      if (file.archive) {
        assert.equal(
          existsSync(join(extensionRoot, "dist/runtimes", file.archive)),
          true,
          file.archive,
        );
      } else {
        assert.match(file.asset, /^mobile-(canvas|screencap)-v.+\.gz$/);
      }
    }
  }
});
