import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { productModule } from "../ailoha-test-module.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const product = fileURLToPath(new URL("../../", productModule("lib/ailoha/runtime-sdk.mjs")));

function fixture(t, content, directory = false) {
  const parent = join(root, ".build");
  mkdirSync(parent, { recursive: true });
  const output = mkdtempSync(join(parent, "ailoha-runtime-pin-test-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  cpSync(join(product, "lib", "ailoha"), join(output, "lib", "ailoha"), { recursive: true });
  cpSync(join(product, "web", "ailoha-canvas-state.js"), join(output, "web", "ailoha-canvas-state.js"));
  writeFileSync(join(output, "package.json"), '{"type":"module"}\n');
  const pin = join(output, "lib", "ailoha", "runtime-package.json");
  rmSync(pin, { force: true });
  if (directory) mkdirSync(pin);
  else if (content !== undefined) writeFileSync(pin, content);
  return pathToFileURL(join(output, "lib", "ailoha", "runtime-sdk.mjs")).href;
}

test("only an absent pin reports the public runtime as unprepared", async (t) => {
  const { loadAilohaRuntimeSdk } = await import(fixture(t));
  await assert.rejects(loadAilohaRuntimeSdk(), { code: "ailoha_runtime_unavailable", status: 503 });
});

for (const [name, content] of [
  ["malformed JSON", '{"synthetic-private-diagnostic":'],
  ["null", "null"],
  ["array", "[]"],
  ["missing provenance", "{}"],
  ["empty version", JSON.stringify({ schema: "mobile-canvas.ailoha-runtime/v1", version: "", sourceSha: "a".repeat(40) })],
  ["invalid source", JSON.stringify({ schema: "mobile-canvas.ailoha-runtime/v1", version: "0.0.0-synthetic", sourceSha: "not-a-source-pin" })],
]) {
  test(`runtime pin loading rejects ${name} explicitly before SDK resolution`, async (t) => {
    const { loadAilohaRuntimeSdk } = await import(fixture(t, content));
    await assert.rejects(loadAilohaRuntimeSdk(), (error) => {
      assert.equal(error.code, "ailoha_runtime_pin_invalid");
      assert.equal(error.status, 503);
      assert.equal(JSON.stringify(error).includes("synthetic-private-diagnostic"), false);
      assert.equal(Object.hasOwn(error, "cause"), false);
      return true;
    });
  });
}

test("an unreadable pin reports a sanitized read failure rather than missing runtime availability", async (t) => {
  const { loadAilohaRuntimeSdk } = await import(fixture(t, undefined, true));
  await assert.rejects(loadAilohaRuntimeSdk(), (error) => {
    assert.equal(error.code, "ailoha_runtime_pin_unreadable");
    assert.equal(error.status, 503);
    assert.equal(error.message.includes(".build"), false);
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  });
});
