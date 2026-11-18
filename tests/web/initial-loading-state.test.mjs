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
  const start = script.match(/\nshowLoadingSelection\(\);\n([\s\S]*?)\nbootstrap\(\)/);
  assert.ok(start, "showLoadingSelection must run before bootstrap starts");
  assert.doesNotMatch(start[1], /\bawait\b|\.then\(/, "nothing asynchronous may delay the loading copy");
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

test("initial runtime preparation and inventory checking have separate truthful loading copy and no elapsed-time claims", () => {
  assert.match(html, /Preparing the runtime and local device services/);
  assert.match(script, /function showLoadingCatalog\(\)/);
  assert.match(script, /title: "Loading devices/);
  assert.match(script, /Reading device inventory and checking each target's capabilities/);
  assert.match(script, /bootstrap\(\)\s*\.then\(\(\) => \{\s*showLoadingCatalog\(\);\s*return refresh\(\);/);
  assert.match(html, /id="empty-state"[^>]+role="status"[^>]+aria-live="polite"/);
});

test("a slow first connection names its current step and how long it has waited", async () => {
  const { liveViewProgress, LIVE_VIEW_STEP_COUNT } = await import("../../web/canvas-state.js");
  const host = liveViewProgress("host", 500);
  assert.match(host.detail, /Starting the device host/);
  assert.equal(host.step, `Step 1 of ${LIVE_VIEW_STEP_COUNT}`);
  assert.equal(host.elapsed, "", "a quick step shows no counter");
  const capture = liveViewProgress("capture", 23_400);
  assert.match(capture.detail, /screen capture/);
  assert.equal(capture.elapsed, "23 s");
  const order = ["connecting", "catalog", "selecting", "session", "frame"].map((stage) => liveViewProgress(stage).step);
  assert.deepEqual(order, [1, 2, 3, 4, 5].map((step) => `Step ${step} of ${LIVE_VIEW_STEP_COUNT}`));
  assert.equal(liveViewProgress("unknown"), null);
  // The per-second counter is decorative; stage changes are what assistive technology announces.
  assert.match(html, /id="empty-state-progress"[^>]*aria-hidden="true"/);
  assert.match(html, /id="stream-overlay-progress"[^>]*aria-hidden="true"/);
});
