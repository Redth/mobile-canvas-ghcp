import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { productModule } from "../ailoha-test-module.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const product = fileURLToPath(new URL("../../", productModule("lib/ailoha/runtime-sdk.mjs")));
const { createVerifiedAilohaCli } = await import(productModule("lib/ailoha/runtime-sdk.mjs"));

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

  function cliFixture(t) {
    mkdirSync(join(root, ".build"), { recursive: true });
    const scratch = mkdtempSync(join(root, ".build/ailoha-cli-budget-"));
    t.after(() => rmSync(scratch, { recursive: true }));
    const wire = join(scratch, "owned-wire");
    const pin = { version: "synthetic-only", sourceSha: "a".repeat(40) };
    const launch = { file: process.execPath, args: [join(root, "tests/scripts/fixtures/ailoha-cli-budget-target.mjs")], ...pin };
    return { wire, pin, launch };
  }

  test("verified CLI cannot start a child after caller cancellation during SDK launch resolution", async (t) => {
    const { wire, pin, launch } = cliFixture(t);
    const caller = new AbortController();
    let resolve;
    const cli = createVerifiedAilohaCli({ pin, sdk: {
      getVerifiedCliLaunch() { return new Promise((complete) => { resolve = complete; }); },
    } });
    const work = cli([wire], { signal: caller.signal, timeoutMs: 100 });
    const rejected = assert.rejects(work, { code: "ailoha_cli_cancelled" });
    await Promise.resolve();
    caller.abort();
    await rejected;
    resolve(launch);
    await new Promise((complete) => setImmediate(complete));
    assert.equal(existsSync(wire), false);
  });

  test("verified CLI total budget includes delayed SDK launch and rejects before child dispatch", async (t) => {
    const { wire, pin, launch } = cliFixture(t);
    let resolve;
    const cli = createVerifiedAilohaCli({ pin, sdk: {
      getVerifiedCliLaunch() { return new Promise((complete) => { resolve = complete; }); },
    } });
    await assert.rejects(cli([wire], { timeoutMs: 20 }), { code: "ailoha_cli_timeout" });
    resolve(launch);
    await new Promise((complete) => setImmediate(complete));
    assert.equal(existsSync(wire), false);
  });

  test("an actual owned child startup is cancelled by the validated remaining budget before its synthetic wire", async (t) => {
    const { wire, pin, launch } = cliFixture(t);
    const cli = createVerifiedAilohaCli({ pin, sdk: { async getVerifiedCliLaunch() { return launch; } } });
    await assert.rejects(cli([wire], { timeoutMs: 30 }), (error) => {
      assert.ok(["ailoha_cli_timeout", "ailoha_cli_failed"].includes(error.code));
      return true;
    });
    assert.equal(existsSync(wire), false);
  });

  test("native stage preserves a typed nonzero receipt without broadening ordinary CLI budgets", async () => {
    const pin = { version: "synthetic-only", sourceSha: "a".repeat(40) };
    const outcome = { status: "readbackUnconfirmed", receipt: { kind: "file", artifacts: [] } };
    const script = `process.stdout.write(${JSON.stringify(JSON.stringify(outcome))}); process.exit(2)`;
    const cli = createVerifiedAilohaCli({ pin, sdk: {
      async getVerifiedCliLaunch() {
        return { file: process.execPath, args: ["-e", script], ...pin };
      },
    } });
    assert.deepEqual(JSON.parse(await cli(["target", "native-stage", "stage"], { timeoutMs: 30_001 })), outcome);
    await assert.rejects(cli(["context", "get"], { timeoutMs: 30_001 }), { code: "ailoha_cli_budget_invalid" });
  });
});
