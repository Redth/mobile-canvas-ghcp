import { createServer } from "node:http";

// Original consumer fixtures for the canonical wire; no native SDK or device is invoked.
export const catalogIds = Object.freeze({
  host: "catalog-host/opaque",
  iosProvider: "provider/ios opaque%2F",
  androidProvider: "provider/android opaque%2F",
  runtime: "shared/runtime:%2F opaque",
  type: "shared/type:%2F opaque",
  olderRuntime: "runtime/older",
  olderType: "type/older",
  template: "template/opaque%2F",
});

export function createCatalogModel({ templates = false, runtimeConstraints = true } = {}) {
  const lifecycle = {
    id: "target.lifecycle", version: 1,
    features: ["createTarget", "startTarget", "stopTarget", "rebootTarget", "listTargets", "getTarget", "getTargetCapabilities"],
  };
  const catalogFeatures = ["listProviderCatalogs", "listProviderRuntimes", "listProviderTargetTypes",
    ...(templates ? ["listProviderTemplates"] : [])];
  const providers = ["ios", "android"].map((platform) => ({
    providerId: catalogIds[`${platform}Provider`], name: `Owned ${platform} fixture`, version: "synthetic-only",
    state: "ready", capabilities: [{ id: "provider.catalog", version: 1, features: catalogFeatures }, lifecycle],
  }));
  const providerCatalogs = providers.map((provider, index) => {
    const platform = index === 0 ? "ios" : "android";
    const type = (id, name) => ({
      targetTypeId: id, providerId: provider.providerId, name,
      kind: platform === "ios" ? "simulator" : "emulator", platform, capabilities: [lifecycle],
    });
    const runtime = (id, supported, state = "available") => ({
      runtimeId: id, providerId: provider.providerId, name: `Owned ${platform} ${id}`, platform, version: "fixture",
      architecture: platform === "ios" ? "arm64" : "x86_64", state,
      metadata: {
        supportedArchitectures: [platform === "ios" ? "arm64" : "x86_64"],
        ...(runtimeConstraints ? { supportedDeviceTypeIds: supported } : {}),
      },
    });
    return {
      targetHostId: catalogIds.host, providerId: provider.providerId, advertisedOperations: catalogFeatures,
      catalogs: [{
        catalogId: "catalog/shared", providerId: provider.providerId, name: "Owned installed choices", kind: "runtime",
        metadata: { schemaVersion: "1.0", diagnostics: [{
          platform, available: true, ready: true, checks: [{ name: "SDK", status: "ok", message: "Synthetic SDK evidence", actions: [] }],
        }] },
      }],
      runtimes: [
        runtime(catalogIds.runtime, [catalogIds.type]),
        runtime(catalogIds.olderRuntime, [catalogIds.olderType]),
        runtime("runtime/unavailable", [catalogIds.type], "unavailable"),
      ],
      targetTypes: [type(catalogIds.type, `Owned ${platform} type`), type(catalogIds.olderType, "Owned older type")],
      templates: templates ? [{
        templateId: catalogIds.template, providerId: provider.providerId, targetTypeId: catalogIds.type,
        runtimeId: catalogIds.runtime, name: `Owned ${platform} template`, configuration: { fixtureSetting: true },
      }] : [],
    };
  });
  return {
    status: {
      hostId: catalogIds.host, profile: "ailoha.target-host/v1", version: "synthetic-only", state: "ready",
      capabilities: [lifecycle, { id: "host.operations", version: 1, features: ["getOperation", "cancelOperation", "listOperations"] }],
    },
    providers, providerCatalogs, devices: [],
  };
}

export async function startCatalogHost(t, { model = createCatalogModel(), beforeRead, beforePoll, beforeTarget } = {}) {
  const calls = [];
  const errors = [];
  const targets = new Map();
  const operations = new Map();
  const state = { model, calls, errors, targets, operations, acceptance: "normal", terminal: "succeeded", targetStatus: "running" };
  const problem = (status, detail) => ({
    type: "about:blank", title: "Owned synthetic failure", status, detail,
  });
  function reply(response, body, status = 200, location) {
    response.writeHead(status, {
      "Content-Type": status >= 400 ? "application/problem+json" : "application/json",
      ...(location ? { Location: location } : {}),
    });
    response.end(JSON.stringify(body));
  }
  const server = createServer(async (request, response) => {
    const call = { method: request.method, path: request.url };
    calls.push(call);
    try {
      if (request.url === "/api/v1/host/status") return reply(response, model.status);
      if (request.url === "/api/v1/providers") return reply(response, model.providers);
      const providerRoute = /^\/api\/v1\/providers\/([^/]+)\/(catalogs|runtimes|target-types|templates|diagnostics)$/.exec(request.url);
      if (providerRoute) {
        const providerId = decodeURIComponent(providerRoute[1]);
        const entry = model.providerCatalogs.find((candidate) => candidate.providerId === providerId);
        if (!entry) return reply(response, problem(404, "Unknown provider"), 404);
        const field = providerRoute[2] === "target-types" ? "targetTypes" : providerRoute[2];
        await beforeRead?.(field, providerId, state);
        return reply(response, entry[field]);
      }
      if (request.url === "/api/v1/targets" && request.method === "GET") return reply(response, [...targets.values()]);
      if (request.url === "/api/v1/targets" && request.method === "POST") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        call.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const input = call.body;
        const number = operations.size + 1;
        const targetId = `created/opaque-${number}%2F`;
        const provider = model.providerCatalogs.find((entry) => entry.providerId === input.providerId);
        const type = provider?.targetTypes.find((entry) => entry.targetTypeId === input.targetTypeId);
        const target = {
          targetId, providerId: input.providerId, targetTypeId: input.targetTypeId, name: input.name,
          ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
          ...(input.templateId ? { templateId: input.templateId } : {}),
          status: input.start === false ? "stopped" : state.targetStatus, surfaces: [],
          nativeIdentity: {
            platform: type.platform, nativeId: type.platform === "ios" ? `owned-udid-${number}` : `owned_avd_${number}`,
            ...(type.platform === "android" ? { serial: `emulator-${5600 + number}` } : {}),
            isVirtual: true,
          },
        };
        targets.set(targetId, target);
        const operationId = `creation/operation-${number}%2F`;
        const accepted = {
          operationId, kind: "createTarget", providerId: input.providerId, status: "queued", destructive: true,
          createdAt: "2026-10-10T03:00:00Z",
        };
        const operation = {
          ...accepted, targetId, status: state.terminal,
          result: { targetId }, startedAt: "2026-10-10T03:00:01Z",
          ...(state.terminal !== "running" ? { completedAt: "2026-10-10T03:00:02Z" } : {}),
          ...(state.terminal === "failed" ? {
            problem: problem(500, "Owned create+boot failed"),
            cleanupProblem: { ...problem(500, "Owned provider cleanup failed"), "x-ailoha-target-host": { targetId, providerId: input.providerId } },
          } : {}),
          ...(state.terminal === "cancelled" ? { cancelRequested: true } : {}),
        };
        operations.set(operationId, operation);
        const location = `/api/v1/operations/${encodeURIComponent(operationId)}`;
        if (state.acceptance === "unknown") {
          response.writeHead(202, { "Content-Type": "application/json" });
          response.end("{}");
          return;
        }
        if (state.acceptance === "cross-origin") return reply(response, accepted, 202, `http://127.0.0.1:1${location}`);
        if (state.acceptance === "mismatched-body") {
          return reply(response, { ...accepted, operationId: "foreign/operation", targetId: "foreign/target" }, 202, location);
        }
        if (state.acceptance === "wrong-provider-body") {
          return reply(response, { ...accepted, providerId: "foreign/provider", targetId: "foreign/target" }, 202, location);
        }
        if (state.acceptance === "lost-body") {
          response.writeHead(202, { "Content-Type": "application/json", Location: location });
          response.flushHeaders();
          response.write("{");
          setImmediate(() => response.destroy());
          return;
        }
        return reply(response, accepted, 202, location);
      }
      const operationRoute = /^\/api\/v1\/operations\/([^/]+)$/.exec(request.url);
      if (operationRoute) {
        const operation = operations.get(decodeURIComponent(operationRoute[1]));
        if (!operation) return reply(response, problem(404, "Unknown operation"), 404);
        await beforePoll?.(operation, state);
        if (request.method === "DELETE") {
          operation.cancelRequested = true;
          operation.status = "cancelling";
          return reply(response, operation, 202, request.url);
        }
        return reply(response, operation);
      }
      const targetRoute = /^\/api\/v1\/targets\/([^/]+)(?:\/capabilities)?$/.exec(request.url);
      if (targetRoute) {
        const target = targets.get(decodeURIComponent(targetRoute[1]));
        if (!target) return reply(response, problem(404, "Unknown target"), 404);
        if (request.url.endsWith("/capabilities")) {
          return reply(response, model.providers.find((provider) => provider.providerId === target.providerId)?.capabilities ?? []);
        }
        await beforeTarget?.(target, state);
        return reply(response, target);
      }
      return reply(response, problem(501, "No synthetic route or native fallback"), 501);
    } catch (error) {
      errors.push(error);
      if (!response.headersSent) reply(response, problem(500, error.message), 500);
      else response.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    state, server, origin: `http://127.0.0.1:${server.address().port}`,
    connection: {
      origin: `http://127.0.0.1:${server.address().port}`, hostId: model.status.hostId,
      profile: model.status.profile, controlCredential: "owned-synthetic-catalog-credential",
    },
  };
}
