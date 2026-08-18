import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const preparePlugin = read("scripts", "prepare-plugin.mjs");
const prepareVsCode = read("scripts", "prepare-vscode.mjs");
const verifyPlugin = read("scripts", "verify-plugin.mjs");
const verifyVsix = read("scripts", "verify-vsix.mjs");
const installScript = read("scripts", "install.sh");
const stampVersion = read("scripts", "stamp-version.mjs");

/**
 * One bundle ships both canvases. These tests exist because a missing file in a packaging list is
 * invisible until an installed plugin fails to load a child extension on somebody else's machine.
 */

test("the plugin bundle carries both extension entrypoints and their shared modules", () => {
  for (const entry of [
    '"extension.mjs"',
    '"windows-extension.mjs"',
    '"extensions"',
    '"web"',
    '"lib/runtime.mjs"',
    '"lib/windows-app-helper.mjs"',
  ]) {
    assert.ok(preparePlugin.includes(entry), `prepare-plugin.mjs must ship ${entry}`);
  }
});

test("the plugin verifier requires both immediate children, not just the mobile one", () => {
  assert.match(verifyPlugin, /"mobile-canvas"/);
  assert.match(verifyPlugin, /"windows-app"/);
  assert.match(verifyPlugin, /extension\.mjs/);
  assert.match(verifyPlugin, /assets", "icon\.png/);
});

test("the source install writes the Windows entrypoint beside the Mobile one", () => {
  assert.match(installScript, /install -m 600 "\$\{REPO_ROOT\}\/extension\.mjs"/);
  assert.match(installScript, /install -m 600 "\$\{REPO_ROOT\}\/windows-extension\.mjs"/);
});

test("the VS Code bundle copies the whole shared web tree, so both renderers travel", () => {
  assert.match(prepareVsCode, /cpSync\(join\(root, "web"\), join\(output, "web"\), \{ recursive: true \}\)/);
});

test("the VSIX verifier requires the Windows renderer, icon, and chat tools", () => {
  for (const entry of [
    "extension/media/windows-activitybar.svg",
    "extension/dist/web/annexb.js",
    "extension/dist/web/windows/index.html",
    "extension/dist/web/windows/windows-canvas.css",
    "extension/dist/web/windows/windows-canvas.js",
    "extension/dist/web/windows/windows-state.js",
  ]) {
    assert.ok(verifyVsix.includes(entry), `verify-vsix.mjs must require ${entry}`);
  }
  for (const tool of [
    "mobileCanvas_selectedDevice",
    "mobileCanvas_screenshot",
    "mobileCanvas_uiTree",
    "windowsCanvas_selectedApp",
    "windowsCanvas_screenshot",
    "windowsCanvas_uiTree",
  ]) {
    assert.ok(verifyVsix.includes(tool), `verify-vsix.mjs must require ${tool}`);
  }
});

test("both products carry the one bundle version, so stamping stays a single list", () => {
  const packageManifest = JSON.parse(read("package.json"));
  const vscodeManifest = JSON.parse(read("vscode", "package.json"));
  const pluginManifest = JSON.parse(read(".github", "plugin", "plugin.json"));
  const runtimeManifest = JSON.parse(read("runtimes", "manifest.json"));

  assert.equal(vscodeManifest.version, packageManifest.version);
  assert.equal(pluginManifest.version, packageManifest.version);
  assert.equal(runtimeManifest.version, packageManifest.version);
  // The Windows canvas adds no manifest of its own, so it adds nothing to stamp.
  assert.doesNotMatch(stampVersion, /windows-extension/);
});

test("the Windows extension is listed in the published npm file set", () => {
  const packageManifest = JSON.parse(read("package.json"));
  assert.ok(packageManifest.files.includes("extension.mjs"));
  assert.ok(packageManifest.files.includes("windows-extension.mjs"));
  assert.ok(packageManifest.files.includes("extensions/"));
});
