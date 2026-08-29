import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseDeviceCapability,
  catalogPlatforms,
  organizeDiagnostics,
} from "../../web/canvas-state.js";

test("destructive actions respect backend capabilities", () => {
  assert.equal(canUseDeviceCapability(null, "delete"), false);
  assert.equal(canUseDeviceCapability({ capabilities: { delete: false } }, "delete"), false);
  assert.equal(canUseDeviceCapability({ capabilities: { delete: true } }, "delete"), true);
  assert.equal(canUseDeviceCapability({ capabilities: {} }, "delete"), true);
});

test("orders usable iOS before Android", () => {
  assert.deepEqual(catalogPlatforms({
    devices: [{ platform: "android" }, { platform: "ios" }],
    diagnostics: [{ platform: "ios", available: true, ready: false, checks: [] }],
  }), ["ios", "android"]);
});

test("orders Android before unavailable iOS", () => {
  assert.deepEqual(catalogPlatforms({
    devices: [{ platform: "android" }],
    diagnostics: [{ platform: "ios", available: false, ready: false, checks: [] }],
  }), ["android", "ios"]);
});

test("unavailable diagnostics keep only safe HTTPS documentation actions", () => {
  const result = organizeDiagnostics([
    {
      platform: "ios",
      available: false,
      ready: false,
      checks: [
        {
          name: "iOS",
          status: "error",
          message: "iOS requires Xcode.",
          actions: [
            {
              type: "open-url",
              target: "https://github.com/Redth/mobile-canvas-ghcp/blob/main/docs/ios-setup.md",
              label: "Learn more",
            },
            {
              type: "open-url",
              target: "http://example.com/unsafe",
              label: "Unsafe",
            },
          ],
        },
      ],
    },
  ]);

  assert.deepEqual(result.notices, []);
  assert.deepEqual(result.popover, []);
  assert.equal(result.unavailable.length, 1);
  assert.deepEqual(result.unavailable[0].checks[0].actions, [
    {
      type: "open-url",
      target: "https://github.com/Redth/mobile-canvas-ghcp/blob/main/docs/ios-setup.md",
      label: "Learn more",
    },
  ]);
});

test("non-documentation remediation stays in the existing notice surface", () => {
  const action = {
    type: "open-system-settings",
    target: "screen-recording",
    label: "Open Screen Recording",
  };
  const result = organizeDiagnostics([
    {
      platform: "ios",
      available: true,
      ready: false,
      checks: [
        {
          name: "ScreenCaptureKit fallback",
          status: "warning",
          message: "Grant Screen Recording.",
          actions: [action],
        },
      ],
    },
  ]);

  assert.deepEqual(result.unavailable, []);
  assert.deepEqual(result.popover, []);
  assert.deepEqual(result.notices[0].actions, [action]);
});
