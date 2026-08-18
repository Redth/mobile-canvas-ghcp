import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const script = readFileSync(join(webRoot, "device-canvas.js"), "utf8");
const html = readFileSync(join(webRoot, "index.html"), "utf8");

function body(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Expected a ${name} function`);
  const open = script.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < script.length; index++) {
    if (script[index] === "{") depth++;
    if (script[index] === "}" && --depth === 0) return script.slice(open, index + 1);
  }
  assert.fail(`Could not read the body of ${name}`);
}

test("the create dialog markup ships no options of its own", () => {
  // Both hosts render this markup, so an option baked in here would be shown before any catalog
  // load and would survive one that failed.
  assert.match(html, /<select id="create-runtime"[^>]*><\/select>/);
  assert.match(html, /<select id="create-device-type"[^>]*><\/select>/);
});

test("opening the create dialog reloads the catalog when it has nothing to offer", () => {
  const opener = body("openCreateDialog");
  assert.match(opener, /needsCatalogForCreate\(state\.catalog\)/);
  assert.match(opener, /populateCreateOptions\(\)/);
  assert.match(opener, /await loadCatalog\(\)/);
  // A failed reload still has to repopulate, or the dropdowns keep the loading placeholder.
  assert.match(opener, /finally\s*\{[^}]*populateCreateOptions\(\)/s);
});

test("the create dialog always fills both dropdowns, empty catalog included", () => {
  const populate = body("populateCreateOptions");
  assert.match(populate, /Loading installed runtimes/);
  assert.match(populate, /No compatible runtime installed/);
  assert.match(populate, /Loading device types/);
  assert.match(populate, /No compatible device type found/);
  assert.match(populate, /elements\.createSubmit\.disabled = /);
});

test("the runtime change handler does not forward its event as an argument", () => {
  // populateCreateOptions reads state, not arguments; passing the listener directly used to hand it
  // a DOM event.
  assert.match(
    script,
    /elements\.createRuntime\.addEventListener\("change", \(\) => populateCreateOptions\(\)\)/,
  );
});
