import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import "./fixtures/ailoha-installed-hooks.mjs";
import * as sdk from "./fixtures/ailoha-sdk-double.mjs";
import { ownedTestDirectory } from "./fixtures/owned-test-directory.mjs";
import { productModule } from "../ailoha-test-module.mjs";
const { createRuntimeCanvasHost } = await import(productModule("lib/ailoha/runtime-backend.mjs"));
const { createAilohaMcpDispatcher } = await import(productModule("lib/ailoha/mcp-host.mjs"));
const { getAilohaContextStore } = await import(productModule("lib/ailoha/context-adapter.mjs"));
const { createVerifiedAilohaCli } = await import(productModule("lib/ailoha/runtime-sdk.mjs"));
const require = createRequire(import.meta.url);
const { HostBridge } = require("../../vscode/out/hostBridge.js");

for (const hostName of ["github", "vscode"]) {
  for (const available of [true, false]) {
    test(`${hostName} real shared host adapter and named MCP ${available ? "consume source-only fresh 54-target catalog" : "refuse old peer without fanout"}`, async (t) => {
      const directory = await ownedTestDirectory(t, `source-catalog-${hostName}-`);
      const previous = process.env.AILOHA_TEST_CONTEXT_STATE;
      process.env.AILOHA_TEST_CONTEXT_STATE = join(directory, "contexts.json");
      const { scenario, sourceSha } = sdk;
      scenario.calls.length = 0;
      scenario.targetCatalogSourceContract = available;
      scenario.targets.clear();
      for (let index = 0; index < 54; index += 1) {
        const targetId = `source-only-${index}`;
        scenario.targets.set(targetId, {
          targetId, providerId: scenario.providerId, targetTypeId: "type", status: index % 2 ? "error" : "stopped",
          surfaces: [], name: targetId, nativeIdentity: { platform: "ios", nativeId: targetId, isVirtual: true },
        });
      }
      const scope = { sessionId: randomUUID(), viewId: `source-only-${hostName}` };
      const pin = { version: "unpublished-source-test", sourceSha };
      const runtime = async () => ({ sdk, pin });
      const host = createRuntimeCanvasHost({ scope, runtime, onError() {} });
      const messages = [];
      const bridge = hostName === "vscode" ? new HostBridge(undefined, scope.sessionId, scope.viewId, {
        async postMessage(message) { messages.push(message); return true; },
      }, { appendLine() {} }, undefined, host) : null;
      let dispatcher;
      t.after(async () => {
        await dispatcher?.dispose();
        bridge?.dispose();
        await bridge?.closed();
        await host.closeCanvas();
        scenario.targets.clear();
        scenario.targetCatalogSourceContract = true;
        if (previous === undefined) delete process.env.AILOHA_TEST_CONTEXT_STATE;
        else process.env.AILOHA_TEST_CONTEXT_STATE = previous;
        assert.equal(scenario.leases.size, 0);
      });
      if (bridge) {
        await bridge.handleMessage({ type: "ready" });
        assert.ok(messages.some((message) => message.type === "context"));
      } else await host.openCanvas();
      const start = scenario.calls.length;
      let response;
      if (bridge) {
        await bridge.handleMessage({ type: "api", id: "catalog", path: "/api/v1/catalog", method: "GET" });
        const reply = messages.find((message) => message.id === "catalog");
        assert.equal(reply.status, available ? 200 : 501);
        response = JSON.parse(new TextDecoder().decode(reply.body));
      } else {
        const reply = await host.request("/api/v1/catalog");
        assert.equal(reply.status, available ? 200 : 501);
        response = await reply.json();
      }
      if (available) {
        assert.equal(response.devices.length, 54);
        assert.equal(response.devices.filter((device) => device.isAvailable).length, 27);
      } else assert.equal(response.code, "capability_not_supported");
      const runCli = createVerifiedAilohaCli({ sdk, pin });
      const binding = await getAilohaContextStore({ scope, runCli }).binding({ allowCreate: false, allowReopen: false });
      dispatcher = await createAilohaMcpDispatcher({
        binding, createBackend: async () => ({
          invokeAction: (name, input, options) => host.invokeAction(name, input, options),
          async dispose() {},
        }),
      });
      const mcp = await dispatcher.handle({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "mobile_device_catalog", arguments: {} } });
      assert.equal(mcp.result.isError === true, !available);
      if (available) assert.equal(mcp.result.structuredContent.devices.length, 54);
      else assert.equal(JSON.parse(mcp.result.content[0].text).code, "capability_not_supported");
      const calls = scenario.calls.slice(start).filter((call) => call.path);
      assert.equal(calls.filter((call) => call.path === "/api/v1/target-catalog").length, available ? 2 : 0);
      assert.equal(calls.some((call) => /^\/api\/v1\/targets/.test(call.path)), false);
      assert.ok(calls.every((call) => call.method === "GET"));
    });
  }
}
