import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const modulePath = join(root, "windows-extension.mjs");
const childPath = join(root, "extensions", "windows-app", "extension.mjs");
const rootExtensionPath = join(root, "extension.mjs");
const verifyPluginPath = join(root, "scripts", "verify-plugin.mjs");
const rootIconPath = join(root, "assets", "icon.png");
const childIconPath = join(root, "extensions", "windows-app", "assets", "icon.png");

// The full 1:1 action surface mapped onto the `mobile-canvas windows <verb>` CLI.
const actions = [
  "get_windows_capabilities",
  "search_windows_apps",
  "list_running_windows",
  "launch_windows_app",
  "launch_windows_executable",
  "attach_windows_window",
  "get_windows_app_session",
  "list_windows_app_windows",
  "select_windows_app_window",
  "reveal_windows_app_window",
  "restore_windows_app_window",
  "release_windows_app_session",
  "dump_windows_ui_tree",
  "find_windows_ui_elements",
  "act_on_windows_ui_element",
  "wait_for_windows_ui",
  "capture_windows_screenshot",
  "get_windows_geometry",
  "click_windows_app",
  "drag_windows_app",
  "scroll_windows_app",
  "press_windows_app_key",
  "type_windows_app_text",
];

const source = readFileSync(modulePath, "utf8");

test("the plugin child bridges to the shared Windows module that exists on disk", () => {
  assert.ok(existsSync(childPath), "extensions/windows-app/extension.mjs exists");
  const childSource = readFileSync(childPath, "utf8");
  const importPath = /import\s+["']([^"']+)["'];/.exec(childSource)?.[1];
  assert.equal(importPath, "../../windows-extension.mjs", "child imports the root module");
  assert.ok(existsSync(resolve(dirname(childPath), importPath)), "the imported module exists");
  assert.ok(existsSync(modulePath), "windows-extension.mjs exists at the repo root");
});

test("the child canvas icon is byte-identical to the shared icon", () => {
  assert.ok(existsSync(childIconPath), "child icon exists");
  assert.ok(existsSync(rootIconPath), "root icon exists");
  assert.ok(
    readFileSync(childIconPath).equals(readFileSync(rootIconPath)),
    "child icon equals the shared assets/icon.png byte-for-byte",
  );
});

test("the Windows canvas uses distinct IDs that never collide with the Mobile canvas", () => {
  assert.match(source, /"windows-app"/, "declares the plugin-install canvas id");
  assert.match(source, /"windows-app-local"/, "declares the local canvas id");
  assert.ok(!source.includes("mobile-device"), "does not borrow the mobile-device canvas id");
  assert.ok(!source.includes("mobile-device-local"), "does not borrow the local mobile id");
  assert.ok(!source.includes("Mobile Device"), "does not borrow the Mobile Device display name");

  // The Mobile identity must be untouched by this addition.
  const mobileSource = readFileSync(rootExtensionPath, "utf8");
  assert.ok(mobileSource.includes("mobile-device"), "extension.mjs keeps the mobile-device id");
  assert.ok(
    mobileSource.includes("mobile-device-local"),
    "extension.mjs keeps the local mobile id",
  );
  assert.ok(mobileSource.includes("Mobile Device"), "extension.mjs keeps the Mobile Device name");
});

test("the canvas registers only on Windows", () => {
  assert.match(
    source,
    /process\.platform === "win32"/,
    "gates support on the win32 platform",
  );
  assert.match(
    source,
    /joinSession\(\{\s*canvases:\s*supported\s*\?/,
    "joinSession only receives the canvas when supported",
  );
});

test("canvas open and close both scope to the windows surface", () => {
  assert.ok(
    source.includes('"canvas", "open", "--surface", "windows"'),
    "canvas open passes --surface windows",
  );
  assert.ok(
    source.includes('"canvas", "close", "--surface", "windows"'),
    "canvas close passes --surface windows",
  );
});

test("every expected action is declared exactly once", () => {
  for (const action of actions) {
    const declarations = source.match(new RegExp(`name:\\s*"${action}"`, "g")) ?? [];
    assert.equal(declarations.length, 1, `${action} is declared exactly once`);
  }
});

test("every action carries an inputSchema", () => {
  const inputSchemas = source.match(/inputSchema:/g) ?? [];
  assert.ok(
    inputSchemas.length >= actions.length,
    `at least one inputSchema per action (${inputSchemas.length} >= ${actions.length})`,
  );

  // Each action declaration block, up to the next action, must contain an inputSchema.
  const declarations = actions
    .map((action) => ({ action, index: source.indexOf(`name: "${action}"`) }))
    .sort((left, right) => left.index - right.index);
  for (let position = 0; position < declarations.length; position += 1) {
    const start = declarations[position].index;
    const end =
      position + 1 < declarations.length ? declarations[position + 1].index : source.length;
    assert.ok(
      source.slice(start, end).includes("inputSchema:"),
      `${declarations[position].action} declares an inputSchema`,
    );
  }
});

test("no action exposes a raw window handle concept", () => {
  assert.ok(!/hwnd/i.test(source), "source never mentions hwnd");
  assert.ok(!/nativeHandle/i.test(source), "source never mentions nativeHandle");
});

test("the windows surface is never crossed with the mobile surface", () => {
  assert.ok(!/mobile/i.test(source), "the Windows module never references the mobile surface");
  const surfaceFlags = source.match(/--surface/g) ?? [];
  const windowsSurfaces = source.match(/"--surface", "windows"/g) ?? [];
  assert.equal(
    surfaceFlags.length,
    windowsSurfaces.length,
    "every --surface argument is paired with windows",
  );
});

test("the module only ever shells out through execFile", () => {
  assert.ok(source.includes("execFile"), "uses execFile");
  assert.ok(!/\bexec\s*\(/.test(source), "never calls the shell-interpreting exec()");
});

test("verify-plugin verifies both plugin children", () => {
  const verifySource = readFileSync(verifyPluginPath, "utf8");
  assert.ok(verifySource.includes("mobile-canvas"), "verify-plugin references mobile-canvas");
  assert.ok(verifySource.includes("windows-app"), "verify-plugin references windows-app");
});

test("windows-extension.mjs parses as an ES module", () => {
  const result = spawnSync(process.execPath, ["--check", modulePath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || "node --check failed");
});
