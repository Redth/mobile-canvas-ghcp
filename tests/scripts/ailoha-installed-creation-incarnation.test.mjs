import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import "./fixtures/ailoha-installed-hooks.mjs";
import * as sdk from "./fixtures/ailoha-sdk-double.mjs";
import { catalogIds } from "./fixtures/ailoha-catalog-creation.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { HostBridge } = require(join(root, "vscode/out/hostBridge.js"));
const { scenario, sourceSha } = sdk;
const variants = [
  { serviceId: "replacement-service" },
  { pid: 54321 },
  { startedAt: "2026-10-09T23:00:01Z" },
  { processStartedAt: "2026-10-09T23:00:00Z" },
];

for (const [kind, product] of [
  ["github", join(root, ".build/copilot-plugin-thin/mobile-canvas")],
  ["vscode", join(root, "vscode/dist")],
]) {
  test(`${kind} prepared creation receipts retain private incarnation through the actual host adapter`, async (t) => {
    const { createRuntimeCanvasHost } = await import(pathToFileURL(join(product, "lib/ailoha/runtime-backend.mjs")).href);
    const { mobileErrorResult } = await import(pathToFileURL(join(product, "lib/ailoha/mobile-backend.mjs")).href);
    for (const changed of variants) {
      for (const outcome of ["unknown", "http408", "http499", "pending", "completed"]) {
        await t.test(`${Object.keys(changed)[0]} ${outcome} is blocked before replacement IO and never rekeyed`, async () => {
          const scratch = join(process.env.AILOHA_TEST_ARTIFACT_ROOT ?? join(root, ".build"),
            `creation-incarnation-${kind}-${randomUUID()}`);
          const previousContext = process.env.AILOHA_TEST_CONTEXT_STATE;
          const connectionRef = { ...scenario.connectionRef };
          mkdirSync(scratch, { recursive: true });
          process.env.AILOHA_TEST_CONTEXT_STATE = join(scratch, "context.json");
          scenario.calls.length = 0;
          scenario.createdTargets.clear();
          scenario.operations.clear();
          sdk.enableCatalogCreation();
          const scope = { sessionId: randomUUID(), viewId: "creation-incarnation-view" };
          const host = createRuntimeCanvasHost({
            scope, runtime: async () => ({ sdk, pin: { version: "synthetic-only", sourceSha } }),
          });
          const messages = [];
          const bridge = kind === "vscode" ? new HostBridge(undefined, scope.sessionId, scope.viewId, {
            async postMessage(message) { messages.push(message); return true; },
          }, { appendLine() {} }, undefined, host) : null;
          async function open() {
            if (bridge) await bridge.handleMessage({ type: "ready" });
            else await host.openCanvas();
          }
          async function close() {
            if (bridge) await bridge.setVisible(false);
            else await host.closeCanvas();
          }
          async function reopen() {
            if (bridge) await bridge.setVisible(true);
            await open();
          }
          async function create(input) {
            if (!bridge) {
              try { return { status: 200, body: await host.invokeAction("create_device", input) }; }
              catch (error) {
                const body = mobileErrorResult(error);
                return { status: body.status, body };
              }
            }
            const id = randomUUID();
            await bridge.handleMessage({
              type: "api", id, path: "/api/v1/devices", method: "POST", body: JSON.stringify(input),
            });
            const result = messages.find((message) => message.id === id);
            assert.equal(result.type, "api-result");
            return { status: result.status, body: JSON.parse(new TextDecoder().decode(result.body)) };
          }
          try {
            await open();
            const frozen = host.connectionRef;
            assert.equal(Object.isFrozen(frozen), true);
            const catalog = await host.invokeAction("get_device_catalog");
            const input = {
              platform: "ios", name: `${kind}-${outcome}-${Object.keys(changed)[0]}`,
              runtimeId: catalog.runtimes.find((runtime) => runtime.catalogSelection.providerId === catalogIds.iosProvider
                && runtime.catalogSelection.runtimeId === catalogIds.runtime).id,
              deviceTypeId: catalog.deviceTypes.find((type) => type.catalogSelection.providerId === catalogIds.iosProvider
                && type.targetTypeId === catalogIds.type).id,
            };
            scenario.creationAcceptance = outcome === "unknown" ? "unknown" : undefined;
            scenario.creationSubmissionStatus = outcome === "http408" ? 408 : outcome === "http499" ? 499 : undefined;
            scenario.creationPollFailure = outcome === "pending";
            scenario.creationTargetStatus = outcome === "completed" ? "stopped" : undefined;
            const failed = await create(input);
            assert.ok(failed.status >= 400);
            if (outcome === "pending" || outcome === "completed") {
              assert.equal(failed.body.operationId, "creation/operation-1%2F");
            }
            if (scenario.creationSubmissionStatus !== undefined) {
              assert.equal(failed.body.upstreamStatus, scenario.creationSubmissionStatus);
              assert.equal(scenario.createdTargets.size, 0);
            }
            assert.equal(scenario.calls.filter((call) => call.path === "/api/v1/targets" && call.method === "POST").length, 1);
            await close();
            scenario.connectionRef = { ...connectionRef, ...changed };
            scenario.creationAcceptance = undefined;
            scenario.creationSubmissionStatus = undefined;
            scenario.creationPollFailure = false;
            scenario.creationTargetStatus = undefined;
            for (const target of scenario.createdTargets.values()) target.status = "running";
            await reopen();
            const before = scenario.calls.length;
            const blocked = await create(input);
            assert.equal(blocked.status, 409);
            assert.equal(blocked.body.code, "runtime_incarnation_changed");
            assert.equal(scenario.calls.length, before);
            assert.equal(JSON.stringify(blocked.body).includes("connectionRef"), false);
            assert.equal(JSON.stringify(blocked.body).includes(frozen.serviceId), false);
            await close();
            scenario.connectionRef = connectionRef;
            await reopen();
            const recoveryBefore = scenario.calls.length;
            const recovered = await create(input);
            if (outcome === "unknown" || outcome === "http408" || outcome === "http499") {
              assert.equal(recovered.body.code, "creation_outcome_uncertain");
              assert.equal(scenario.calls.length, recoveryBefore);
            } else {
              assert.equal(recovered.status, 200);
              assert.equal(recovered.body.state, "booted");
              assert.equal(recovered.body.acceptedOperation.operationId, failed.body.operationId);
              assert.equal(Object.hasOwn(recovered.body.invocation, "connectionRef"), false);
            }
            assert.equal(scenario.calls.filter((call) => call.path === "/api/v1/targets" && call.method === "POST").length, 1);
            assert.equal(scenario.calls.some((call) => call.method === "DELETE" || /\/actions\/start$/.test(call.path ?? "")), false);
            assert.equal(scenario.calls.some((call) => call.path === "/api/v1/host/stop"), false);
          } finally {
            if (bridge) { bridge.dispose(); await bridge.closed(); }
            else await host.closeCanvas();
            scenario.connectionRef = connectionRef;
            scenario.creationAcceptance = undefined;
            scenario.creationSubmissionStatus = undefined;
            scenario.creationPollFailure = false;
            scenario.creationTargetStatus = undefined;
            if (previousContext === undefined) delete process.env.AILOHA_TEST_CONTEXT_STATE;
            else process.env.AILOHA_TEST_CONTEXT_STATE = previousContext;
            rmSync(scratch, { recursive: true, force: true });
          }
          assert.equal(scenario.leases.size, 0);
          assert.equal(scenario.videos.size, 0);
        });
      }
    }
  });
}
