import assert from "node:assert/strict";
import test from "node:test";
import {
  formatUserFacingMessage,
  organizeDiagnostics,
} from "../../web/canvas-state.js";

const expected =
  "idb_companion was not found. Run "
  + "`brew tap facebook/fb && brew trust facebook/fb && brew install facebook/fb/idb`, "
  + "or set MOBILE_CANVAS_IDB_COMPANION or IDB_COMPANION_PATH to the executable.";

test("missing IDB API errors use the current Meta installation", () => {
  assert.equal(
    formatUserFacingMessage(
      "idb_companion was not found. Install it with Homebrew or set "
      + "MOBILE_CANVAS_IDB_COMPANION.",
    ),
    expected,
  );
});

test("missing IDB diagnostics use the same actionable guidance", () => {
  const { popover } = organizeDiagnostics([
    {
      checks: [
        {
          name: "idb_companion",
          status: "error",
          message: "Install idb_companion or set MOBILE_CANVAS_IDB_COMPANION.",
        },
      ],
    },
  ]);

  assert.equal(popover[0].message, expected);
});

test("optional missing IDB diagnostics stay out of the device dropdown", () => {
  const { popover } = organizeDiagnostics([
    {
      checks: [
        {
          name: "idb_companion",
          status: "warning",
          message: "Optional idb_companion is unavailable. Compatibility fallbacks are disabled.",
        },
      ],
    },
  ]);

  assert.deepEqual(popover, []);
});

test("transient Android emulator discovery state stays out of the device dropdown", () => {
  const { popover } = organizeDiagnostics([
    {
      checks: [
        {
          name: "emulator-discovery",
          status: "warning",
          message: "No emulator discovery directory yet. It appears once an emulator starts.",
        },
      ],
    },
  ]);

  assert.deepEqual(popover, []);
});

test("unrelated runtime failures pass through unchanged", () => {
  const message = "idb_companion exited with code 1";
  assert.equal(formatUserFacingMessage(message), message);
});

test("aggregate native and IDB failures retain both transport reasons", () => {
  const message =
    "iOS input is unavailable. Bundled Simulator HID: helper exited; "
    + "IDB fallback: idb_companion was not found.";
  assert.equal(formatUserFacingMessage(message), message);
});
