import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const stylesheet = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "device-canvas.css"),
  "utf8",
);

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesheet.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Expected a ${selector} rule`);
  return match[1];
}

test("optional shell rows cannot displace the device workspace", () => {
  assert.match(
    rule(".app-shell"),
    /grid-template-areas:\s*"topbar"\s*"diagnostics"\s*"workspace"/,
  );
  assert.match(rule(".topbar"), /grid-area:\s*topbar/);
  assert.match(rule(".diagnostic-notices"), /grid-area:\s*diagnostics/);
  assert.match(rule(".workspace"), /grid-area:\s*workspace/);
});

test("device interaction preserves the normal cursor and click feedback", () => {
  assert.doesNotMatch(rule("#device-screen"), /cursor\s*:/);
  assert.match(rule("#device-screen"), /touch-action:\s*none/);
  assert.match(rule(".input-indicator.active"), /animation:\s*input-ping/);
});
