import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isActivityAddressedTo,
  MOBILE_SURFACE,
  normalizeSurface,
} from "../../web/canvas-state.js";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const canvas = readFileSync(join(webRoot, "device-canvas.js"), "utf8");

const panel = {
  sessionId: "session",
  instanceId: "panel-a",
  surface: MOBILE_SURFACE,
};

test("an activity event addressed to this panel is accepted", () => {
  assert.equal(
    isActivityAddressedTo(
      { kind: "tap", sessionId: "session", instanceId: "panel-a", surface: "mobile" },
      panel,
    ),
    true,
  );
});

test("another panel's activity is never addressed to this one", () => {
  assert.equal(
    isActivityAddressedTo(
      { kind: "tap", sessionId: "session", instanceId: "panel-b", surface: "mobile" },
      panel,
    ),
    false,
  );
});

test("activity from another product surface is refused even with matching identifiers", () => {
  assert.equal(
    isActivityAddressedTo(
      { kind: "text", sessionId: "session", instanceId: "panel-a", surface: "windows" },
      panel,
    ),
    false,
  );
});

test("a panel on another surface does not accept mobile activity", () => {
  assert.equal(
    isActivityAddressedTo(
      { kind: "tap", sessionId: "session", instanceId: "panel-a", surface: "mobile" },
      { ...panel, surface: "windows" },
    ),
    false,
  );
});

test("events without a surface are mobile, as every host before surfaces produced", () => {
  assert.equal(normalizeSurface(undefined), MOBILE_SURFACE);
  assert.equal(
    isActivityAddressedTo(
      { kind: "tap", sessionId: "session", instanceId: "panel-a" },
      panel,
    ),
    true,
  );
});

test("bare CLI activity is followed only by hosts that opt in", () => {
  const unscoped = { kind: "tap", deviceId: "ios:one" };
  assert.equal(isActivityAddressedTo(unscoped, panel), false);
  assert.equal(isActivityAddressedTo(unscoped, { ...panel, followUnscoped: true }), true);
});

test("the canvas carries its granted surface through bootstrap and event filtering", () => {
  assert.match(canvas, /fragment\.get\("surface"\)/);
  assert.match(canvas, /JSON\.stringify\(\{ secret, sessionId, instanceId, surface \}\)/);
  assert.match(canvas, /sessionStorage\.setItem\("mobile-canvas-surface"/);
  assert.match(canvas, /isActivityAddressedTo\(activity, \{/);
});
