import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const html = readFileSync(join(webRoot, "index.html"), "utf8");
const script = readFileSync(join(webRoot, "device-canvas.js"), "utf8");

test("the empty-state markup starts in a truthful loading presentation, not the final empty copy", () => {
  const section = html.match(/<section id="empty-state"[\s\S]*?<\/section>/);
  assert.ok(section, "Expected an #empty-state section");
  assert.match(section[0], /Opening live view/);
  assert.doesNotMatch(section[0], /Select a device/);
  // The "create device" action is only meaningful once we truly have no selection; it must not be
  // visible during the initial loading presentation.
  assert.match(section[0], /id="empty-state-action"[^>]*class="[^"]*\bhidden\b/);
});

test("the selector chip starts with connecting copy rather than a false \"no device\" claim", () => {
  assert.match(html, /id="selector-detail"[^>]*>Opening live view/);
  assert.doesNotMatch(html, /id="selector-detail"[^>]*>No device selected/);
});

test("script drives the loading presentation into the empty state before bootstrap runs", () => {
  assert.match(script, /function showLoadingSelection\(\)/);
  const loadingBody = script.match(/function showLoadingSelection\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(loadingBody, "Expected a showLoadingSelection body");
  assert.match(loadingBody[1], /configureEmptyState\(/);
  assert.match(loadingBody[1], /elements\.empty\.classList\.remove\("hidden"\)/);
  // showLoadingSelection must actually run before the async catalog/selection resolution kicks off,
  // otherwise the loading copy would never reach the screen.
  assert.match(script, /showLoadingSelection\(\);\s*\n\s*bootstrap\(\)/);
});

test("configureEmptyState renders without an action so the loading state has no dead create button", () => {
  const configureBody = script.match(/function configureEmptyState\([\s\S]*?\n\}/);
  assert.ok(configureBody, "Expected a configureEmptyState body");
  assert.match(configureBody[0], /if \(action\)/);
  assert.match(configureBody[0], /elements\.emptyAction\.classList\.add\("hidden"\)/);
});

test("resolving with no selection still restores the real empty-selection copy via existing production code", () => {
  const body = script.match(/function showEmptySelection\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(body, "Expected a showEmptySelection body");
  assert.match(body[1], /title: "Select a device"/);
  assert.match(body[1], /action: \{ id: "create"/);
});
