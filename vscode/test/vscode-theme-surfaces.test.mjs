import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const adapter = readFileSync(join(root, "vscode", "media", "vscode-theme.css"), "utf8");
const mobileCss = readFileSync(join(root, "web", "device-canvas.css"), "utf8");
const windowsCss = readFileSync(join(root, "web", "windows", "windows-canvas.css"), "utf8");

/**
 * The adapter is the only host-specific styling either renderer gets. It has to remap every token
 * both shared stylesheets define, or one surface would keep GitHub colours inside a VS Code theme.
 */
/** The base token block each shared stylesheet declares. Layout variables elsewhere are not themes. */
function baseTokens(css) {
  const start = css.indexOf(":root {");
  const block = css.slice(start, css.indexOf("\n}", start));
  return new Set([...block.matchAll(/^\s{2}(--[a-z-]+):/gm)].map((match) => match[1]));
}

test("the VS Code adapter remaps every token both shared stylesheets define", () => {
  const mobileTokens = baseTokens(mobileCss);
  const windowsTokens = baseTokens(windowsCss);
  const shared = [...mobileTokens].filter((token) => windowsTokens.has(token));
  assert.ok(shared.length > 20, "the two stylesheets share a real token vocabulary");

  const remapped = new Set(
    [...adapter.matchAll(/^\s{2}(--[a-z-]+):/gm)].map((match) => match[1]),
  );
  // Every colour token either renderer resolves has to be remapped, or one surface would keep
  // GitHub colours — or worse, follow the OS colour scheme — inside a VS Code theme. Radii and
  // durations are theme-independent by design and the adapter overrides the radii on purpose.
  const themed = [...new Set([...mobileTokens, ...windowsTokens])].filter(
    (token) => token !== "--motion-fast",
  );
  const missing = themed.filter((token) => !remapped.has(token));
  assert.deepEqual(missing, [], "tokens the VS Code theme never remaps");
});

test("the adapter styles the chrome each renderer actually declares", () => {
  // Shared between the two shells.
  for (const selector of [".topbar", ".topbar-actions", ".icon-button", ".selector-glyph"]) {
    assert.ok(adapter.includes(selector), `adapter must cover ${selector}`);
    assert.ok(
      mobileCss.includes(selector) && windowsCss.includes(selector),
      `${selector} must exist in both shells`,
    );
  }
  // Surface-specific chrome, each covered by the adapter and named only by its own renderer.
  assert.ok(adapter.includes(".device-selector") && mobileCss.includes(".device-selector"));
  assert.ok(adapter.includes(".app-selector") && windowsCss.includes(".app-selector"));
  assert.ok(adapter.includes(".device-popover") && mobileCss.includes(".device-popover"));
  assert.ok(adapter.includes(".app-popover") && windowsCss.includes(".app-popover"));
  assert.ok(adapter.includes(".tabstrip") && windowsCss.includes(".tabstrip"));
  assert.equal(mobileCss.includes(".app-selector"), false, "surfaces do not share markup names");
  assert.equal(windowsCss.includes(".device-selector"), false);
});

test("the adapter only ever applies inside a VS Code host", () => {
  const rules = adapter.split("}").filter((rule) => rule.trim().startsWith(":root"));
  for (const rule of rules) {
    assert.match(
      rule.trim(),
      /^:root\[data-host="vscode"\]/,
      "a rule that is not host-scoped would change the GitHub canvas too",
    );
  }
});
