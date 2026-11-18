import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { productModule } from "../ailoha-test-module.mjs";
import * as sdkDouble from "./fixtures/ailoha-sdk-double.mjs";

const { createRuntimeCanvasHost, createRuntimeMobileBackend } = await import(productModule("lib/ailoha/runtime-backend.mjs"));
const root = fileURLToPath(new URL("../..", import.meta.url));
const runtime = async () => ({ sdk: sdkDouble, pin: { version: "synthetic-only", sourceSha: sdkDouble.sourceSha } });

function contextState(t) {
  mkdirSync(join(root, ".build"), { recursive: true });
  const directory = mkdtempSync(join(root, ".build/host-recovery-"));
  const previous = process.env.AILOHA_TEST_CONTEXT_STATE;
  process.env.AILOHA_TEST_CONTEXT_STATE = join(directory, "context.json");
  t.after(() => {
    if (previous === undefined) delete process.env.AILOHA_TEST_CONTEXT_STATE;
    else process.env.AILOHA_TEST_CONTEXT_STATE = previous;
    rmSync(directory, { recursive: true, force: true });
    sdkDouble.scenario.lostHostId = null;
  });
}

test("reopening the same view after its Target Host exits starts a fresh host under a fresh view authority", async (t) => {
  contextState(t);
  const { scenario } = sdkDouble;
  scenario.calls.length = 0;
  const stages = [];
  const host = createRuntimeCanvasHost({ scope: { sessionId: randomUUID(), viewId: "recovering" }, runtime });
  host.subscribeProgress((stage) => stages.push(stage));
  t.after(() => host.closeCanvas());
  await host.openCanvas({ deviceId: "opaque/target" });
  assert.deepEqual(stages, ["runtime", "context", "host", "connecting", "ready"]);
  const before = (await host.invokeAction("get_selected_device", {}));
  assert.equal(before.device.id, "opaque/target");

  scenario.lostHostId = "synthetic-host";
  scenario.hostIncarnation += 1;
  const ensuresBefore = scenario.calls.filter((call) => call.ensure).length;
  await host.openCanvas({ deviceId: "opaque/target" });

  const ensures = scenario.calls.filter((call) => call.ensure).slice(ensuresBefore).map((call) => call.ensure.targetHostId);
  assert.deepEqual(ensures, ["synthetic-host", undefined], "the lost host is not pinned again");
  const after = await host.invokeAction("get_selected_device", {});
  assert.equal(after.device.id, "opaque/target");
  assert.notEqual(after.contextBinding.scopeEpoch, before.contextBinding.scopeEpoch,
    "intents captured against the lost host's authority cannot be replayed into the new one");
});

test("background binding never takes over a view authority after its host is lost", async (t) => {
  contextState(t);
  const { scenario } = sdkDouble;
  const scope = { sessionId: randomUUID(), viewId: "background" };
  const host = createRuntimeCanvasHost({ scope, runtime });
  t.after(() => host.closeCanvas());
  await host.openCanvas({ deviceId: "opaque/target" });
  scenario.lostHostId = "synthetic-host";
  scenario.hostIncarnation += 1;
  await assert.rejects(createRuntimeMobileBackend({ scope, runtime, allowContextReopen: false }),
    { code: "RuntimeHostNotFound" });
});
