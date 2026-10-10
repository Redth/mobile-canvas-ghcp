import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
import { catalogIds, createCatalogModel, startCatalogHost } from "./fixtures/ailoha-catalog-creation.mjs";

const { AilohaMobileBackend, mobileErrorResult } = await import(productModule("lib/ailoha/mobile-backend.mjs"));
const { connectTargetHost, AilohaProtocolError } = await import(productModule("lib/ailoha/index.mjs"));
const { projectMobileCatalog, captureCreateInput, resolveCreateChoice } = await import(productModule("lib/ailoha/mobile-catalog.mjs"));
const { catalogChoiceId, readCatalogChoiceId } = await import(productModule("lib/ailoha/mobile-projection.mjs"));
const { createAilohaContextStore } = await import(productModule("lib/ailoha/context-adapter.mjs"));
const { createAilohaMcpDispatcher } = await import(productModule("lib/ailoha/mcp-host.mjs"));
const { submitOperationReceipt, waitForOperationReceipt } =
  await import(productModule("lib/ailoha/operation-receipts.mjs"));
const { creatablePlatforms, createOptions } = await import(productModule("web/create-device-options.js"));

const project = (model) => projectMobileCatalog({ hostId: model.status.hostId, ...model });
const posts = (state) => state.calls.filter((call) => call.method === "POST");
const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
};
function inputFor(catalog, platform = "ios", name = "Owned creation", template = false) {
  const providerId = catalogIds[`${platform}Provider`];
  return {
    platform, name,
    runtimeId: catalog.runtimes.find((runtime) => runtime.catalogSelection.providerId === providerId
      && (template ? runtime.catalogSelection.templateId === catalogIds.template
        : runtime.catalogSelection.runtimeId === catalogIds.runtime && !runtime.catalogSelection.templateId)).id,
    deviceTypeId: catalog.deviceTypes.find((type) => type.catalogSelection.providerId === providerId
      && type.targetTypeId === catalogIds.type).id,
  };
}

async function fixture(t, options = {}) {
  const host = await startCatalogHost(t, options);
  const { state } = host;
  const scope = { sessionId: randomUUID(), viewId: "creation-view" };
  const events = [];
  let document = {
    schema: "ailoha.execution-context/v1", version: 1, contextRef: `ctx-${randomUUID()}`,
    scope, scopeEpoch: "original-epoch", revision: "1", state: "open",
    owner: { processId: process.pid, processStartedAt: "2026-10-10T03:00:00Z" },
    selection: null, observed: null,
  };
  const contextCommands = [];
  const store = createAilohaContextStore({
    scope, ownerProcessId: process.pid, contextRef: document.contextRef, scopeEpoch: document.scopeEpoch,
    async runCli(args) {
      contextCommands.push(args);
      if (args[1] === "select") {
        const input = JSON.parse(args[args.indexOf("--request-json") + 1]);
        if (input.expected.scopeEpoch !== document.scopeEpoch || input.expected.revision !== document.revision) {
          return JSON.stringify({ ok: false, context: null, error: { code: "RevisionConflict", current: document } });
        }
        document = { ...document, revision: String(BigInt(document.revision) + 1n), selection: input.selection };
      } else if (args[1] === "open") {
        document = { ...document, state: "open", scopeEpoch: "reopened-epoch", revision: "0", selection: null };
      }
      return JSON.stringify({ ok: true, context: document, error: null });
    },
  });
  const operationState = new Map();
  const backends = [];
  const connectionRef = {
    schema: "ailoha.target-host.connection/v1", serviceId: "owned-creation-service", pid: 12345,
    startedAt: "2026-10-10T03:00:00Z", processStartedAt: "2026-10-10T02:59:59Z",
  };
  async function makeBackend(ownerConnectionRef = connectionRef) {
    const client = await connectTargetHost(host.connection);
    const wait = client.waitForOperation.bind(client);
    client.waitForOperation = (id, options) => wait(id, { ...options, timeoutMs: state.waitMs ?? 1000, pollIntervalMs: 1 });
    const backend = new AilohaMobileBackend({
      scope, client, selectionStore: store, operationState, onEvent: (event) => events.push(event),
      owner: {
        hostId: host.connection.hostId, connectionRef: ownerConnectionRef,
        registerCleanup: () => () => {}, release: async () => {},
      },
    });
    backends.push(backend);
    return { backend, client };
  }
  t.after(async () => { for (const backend of backends) await backend.dispose(); });
  const current = await makeBackend();
  return {
    ...host, ...current, scope, store, operationState, events, contextCommands, makeBackend,
    get document() { return document; },
    changeSelection() {
      document = { ...document, revision: String(BigInt(document.revision) + 1n),
        selection: { targetHostId: host.connection.hostId, targetId: "external/explicit-choice", surfaceId: null } };
    },
    retire() { document = { ...document, state: "detached", revision: String(BigInt(document.revision) + 1n), selection: null }; },
  };
}

async function entrypoint(state, kind, selectCreated = false) {
  if (kind === "direct") return (input, options) => state.backend.create(input, { selectCreated, ...options });
  if (kind === "action") return (input, options) => state.backend.invokeAction("create_device", input, options);
  if (kind === "api") return async (input, options) => {
    const response = await state.backend.request("/api/v1/devices", { method: "POST", body: JSON.stringify(input), ...options });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message), result);
    return result;
  };
  const dispatcher = await createAilohaMcpDispatcher({
    version: "synthetic-only", selectCreated,
    binding: {
      contextRef: state.document.contextRef, scopeEpoch: state.document.scopeEpoch, scope: state.scope, ownerProcessId: process.pid,
    },
    createBackend: async () => state.backend,
  });
  return async (input, options) => {
    const reply = await dispatcher.handle({
      jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: "mobile_device_create", arguments: input },
    }, options);
    if (reply.result.isError) {
      const error = JSON.parse(reply.result.content[0].text);
      throw Object.assign(new Error(error.message), error);
    }
    assert.deepEqual(JSON.parse(reply.result.content[0].text), reply.result.structuredContent);
    return reply.result.structuredContent;
  };
}

test("parent regression: caller cancellation during catalog preparation cannot submit creation", async (t) => {
  const state = await fixture(t);
  const input = inputFor(await state.backend.catalog());
  const listProviders = state.client.listProviders.bind(state.client);
  const entered = deferred();
  const release = deferred();
  state.client.listProviders = async (...args) => {
    entered.resolve();
    await release.promise;
    return listProviders(...args);
  };
  const controller = new AbortController();
  const result = state.backend.invokeAction("create_device", input, { signal: controller.signal }).then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
  await Promise.race([entered.promise, result]);
  controller.abort();
  release.resolve();
  const outcome = await result;

  assert.equal(posts(state.state).length, 0,
    "A caller-cancelled creation must not POST after its asynchronous catalog preparation.");
  assert.equal(outcome.status, "rejected");
});

for (const kind of ["direct", "action", "api", "mcp", "vscode-mcp"]) {
  test(`${kind} an already cancelled create caller performs no preparation or mutation IO`, async (t) => {
    const state = await fixture(t);
    const create = await entrypoint(state, kind, kind === "vscode-mcp");
    const input = inputFor(await state.backend.catalog());
    const controller = new AbortController();
    controller.abort();
    const reads = state.state.calls.length;
    const contextReads = state.contextCommands.length;
    await assert.rejects(create(input, { signal: controller.signal }), { code: "cancelled" });
    assert.equal(state.state.calls.length, reads);
    assert.equal(state.contextCommands.length, contextReads);
    assert.equal(posts(state.state).length, 0);
    assert.equal(state.operationState.size, 0);
  });

  test(`${kind} cancellation during preparation cannot dispatch or select after the held read settles`, async (t) => {
    const state = await fixture(t);
    const create = await entrypoint(state, kind, kind === "vscode-mcp");
    const input = inputFor(await state.backend.catalog());
    const entered = deferred();
    const release = deferred();
    const listProviders = state.client.listProviders.bind(state.client);
    state.client.listProviders = async (...args) => {
      entered.resolve();
      await release.promise;
      return listProviders(...args);
    };
    const controller = new AbortController();
    const result = create(input, { signal: controller.signal }).then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", error }),
    );
    await Promise.race([entered.promise, result]);
    controller.abort();
    release.resolve();
    const outcome = await result;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.error.code, "cancelled");
    assert.equal(posts(state.state).length, 0);
    assert.equal(state.operationState.size, 0);
    assert.equal(state.document.selection, null);
  });

  test(`${kind} cancelling one same-key preparation caller does not cancel another active caller`, async (t) => {
    const state = await fixture(t);
    const create = await entrypoint(state, kind, kind === "vscode-mcp");
    const input = inputFor(await state.backend.catalog());
    const entered = deferred();
    const release = deferred();
    const listProviders = state.client.listProviders.bind(state.client);
    state.client.listProviders = async (...args) => {
      entered.resolve();
      await release.promise;
      return listProviders(...args);
    };
    const controller = new AbortController();
    const cancelled = create(input, { signal: controller.signal }).then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", error }),
    );
    await Promise.race([entered.promise, cancelled]);
    const active = create(input);
    controller.abort();
    release.resolve();
    const rejected = await cancelled;
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.error.code, "cancelled");
    assert.equal((await active).state, "booted");
    assert.equal(posts(state.state).length, 1);
    assert.equal(state.operationState.size, 0);
  });
}

test("read-only complete catalog uses reversible host/provider IDs, exact constraints and genuine diagnostics", async (t) => {
  const state = await fixture(t);
  const catalog = await state.backend.catalog();
  assert.equal(catalog.catalogCompleteness, "complete");
  assert.deepEqual(creatablePlatforms(catalog), ["ios", "android"]);
  assert.equal(new Set(catalog.runtimes.map((runtime) => runtime.id)).size, catalog.runtimes.length);
  assert.equal(new Set(catalog.deviceTypes.map((type) => type.id)).size, catalog.deviceTypes.length);
  for (const platform of ["ios", "android"]) {
    const input = inputFor(catalog, platform);
    assert.deepEqual(readCatalogChoiceId(input.runtimeId), {
      targetHostId: catalogIds.host, providerId: catalogIds[`${platform}Provider`], runtimeId: catalogIds.runtime,
    });
    assert.deepEqual(createOptions(catalog, platform, input.runtimeId).deviceTypes.map((type) => type.id), [input.deviceTypeId]);
    assert.equal(catalog.diagnostics.find((entry) => entry.platform === platform).checks[0].message, "Synthetic SDK evidence");
  }
  const providerPaths = state.state.calls.filter((call) => call.path.includes("/providers/")).map((call) => call.path);
  for (const providerId of [catalogIds.iosProvider, catalogIds.androidProvider]) {
    for (const suffix of ["catalogs", "runtimes", "target-types"]) {
      assert.ok(providerPaths.includes(`/api/v1/providers/${encodeURIComponent(providerId)}/${suffix}`));
    }
  }
  assert.equal(posts(state.state).length, 0);
  assert.equal(state.contextCommands.some((args) => args[1] === "select"), false);
});

test("template projections preserve authoritative pairing/configuration without guessing a runtime/type cross-product", () => {
  const model = createCatalogModel({ templates: true, runtimeConstraints: false });
  const catalog = project(model);
  for (const platform of ["ios", "android"]) {
    const input = inputFor(catalog, platform, "Owned template", true);
    const choice = resolveCreateChoice(catalog, captureCreateInput(input));
    assert.deepEqual(choice.request, {
      providerId: catalogIds[`${platform}Provider`], targetTypeId: catalogIds.type, runtimeId: catalogIds.runtime,
      templateId: catalogIds.template, name: input.name, start: true,
    });
    const options = createOptions(catalog, platform);
    assert.equal(options.runtimes.length, 1);
    assert.equal(options.runtimes[0].catalogSelection.templateId, catalogIds.template);
    assert.equal(catalog.providerCatalogs.find((entry) => entry.providerId === catalogIds[`${platform}Provider`])
      .templates[0].configuration.fixtureSetting, true);
  }
});

test("a runtime-less advertised template remains an explicit template choice, not a fabricated runtime ID", async (t) => {
  const model = createCatalogModel({ templates: true, runtimeConstraints: false });
  delete model.providerCatalogs[0].templates[0].runtimeId;
  const state = await fixture(t, { model });
  const catalog = await state.backend.catalog();
  const input = inputFor(catalog, "ios", "Owned template only", true);
  const created = await state.backend.create(input);
  assert.equal(created.acceptedOperation.status, "succeeded");
  assert.equal(posts(state.state)[0].body.templateId, catalogIds.template);
  assert.equal(Object.hasOwn(posts(state.state)[0].body, "runtimeId"), false);
  assert.equal(Object.hasOwn(posts(state.state)[0].body, "configuration"), false);
});

test("missing compatibility/state/configuration evidence never enables unsupported creation", () => {
  for (const change of [
    (model) => { for (const entry of model.providerCatalogs) for (const runtime of entry.runtimes) delete runtime.metadata.supportedDeviceTypeIds; },
    (model) => { for (const entry of model.providerCatalogs) for (const runtime of entry.runtimes) delete runtime.state; },
    (model) => { for (const provider of model.providers) provider.capabilities.find((cap) => cap.id === "target.lifecycle").features = []; },
    (model) => { model.status.capabilities = []; },
    (model) => { for (const entry of model.providerCatalogs) for (const type of entry.targetTypes) type.configSchema = { type: "object", required: ["disk"] }; },
    (model) => { for (const entry of model.providerCatalogs) for (const type of entry.targetTypes) type.kind = "physical-device"; },
    (model) => { for (const entry of model.providerCatalogs) for (const type of entry.targetTypes) delete type.platform; },
  ]) {
    const model = createCatalogModel();
    change(model);
    const catalog = project(model);
    assert.equal(catalog.creationSupport.supported, false);
    assert.deepEqual(creatablePlatforms(catalog), []);
    assert.ok(catalog.providerCatalogs.length > 0);
    assert.throws(() => resolveCreateChoice(catalog, inputFor(catalog)), /capability|unavailable|match/);
  }
});

test("explicit empty native compatibility retains legacy all-types semantics within the same authoritative platform/provider", () => {
  const model = createCatalogModel();
  model.providerCatalogs[0].runtimes[0].metadata.supportedDeviceTypeIds = [];
  const catalog = project(model);
  const input = inputFor(catalog);
  assert.equal(createOptions(catalog, "ios", input.runtimeId).deviceTypes.length, 2);
  assert.equal(createOptions(catalog, "ios", input.runtimeId).deviceTypes.every((type) =>
    type.catalogSelection.providerId === catalogIds.iosProvider), true);
});

test("partial catalogs and unavailable-platform metadata are explicit and cannot become a first-provider fallback", () => {
  const model = createCatalogModel();
  for (const provider of model.providers) provider.capabilities.find((cap) => cap.id === "provider.catalog").features = ["listProviderCatalogs", "listProviderRuntimes"];
  for (const entry of model.providerCatalogs) {
    entry.advertisedOperations = ["listProviderCatalogs", "listProviderRuntimes"];
    entry.targetTypes = [];
    for (const runtime of entry.runtimes) delete runtime.metadata.supportedDeviceTypeIds;
  }
  model.providers[0].state = "unavailable";
  model.providerCatalogs[0].catalogs[0].metadata.diagnostics[0] = {
    platform: "ios", available: false, ready: false, checks: [{ name: "Xcode", status: "error", message: "Owned missing SDK diagnostic", actions: [] }],
  };
  const catalog = project(model);
  assert.equal(catalog.catalogCompleteness, "partial");
  assert.equal(catalog.creationSupport.supported, false);
  assert.equal(catalog.diagnostics.find((entry) => entry.platform === "ios").available, false);
  assert.equal(catalog.diagnostics.find((entry) => entry.platform === "ios").checks[0].message, "Owned missing SDK diagnostic");
});

test("native diagnostic guidance is retained without enabling unwired operating-system settings controls", () => {
  const model = createCatalogModel();
  const diagnostic = model.providerCatalogs[0].catalogs[0].metadata.diagnostics[0];
  diagnostic.checks[0].actions = [{
    type: "open-system-settings", target: "screen-recording", label: "Open Screen Recording",
  }];
  const catalog = project(model);
  assert.deepEqual(catalog.diagnostics.find((entry) => entry.platform === "ios").checks[0].actions, []);
  assert.match(catalog.diagnostics.find((entry) => entry.platform === "ios").checks[1].message, /guidance only/);
  assert.equal(catalog.providerCatalogs[0].catalogs[0].metadata.diagnostics[0].checks[0].actions.length, 1);
});

test("newer canonical unavailable diagnostics remain visible and cannot be hidden by cached native catalog readiness", async (t) => {
  const model = createCatalogModel();
  model.providers[0].capabilities.push({ id: "provider.administration", version: 1, features: ["getProviderDiagnostics"] });
  model.providerCatalogs[0].diagnostics = {
    providerId: catalogIds.iosProvider, state: "unavailable", checkedAt: "2026-10-10T03:01:00Z",
    checks: [{ name: "SDK", status: "fail", detail: "Owned newer unavailable SDK diagnostic" }],
  };
  const state = await fixture(t, { model });
  const catalog = await state.backend.catalog();
  assert.deepEqual(creatablePlatforms(catalog), ["android"]);
  assert.equal(catalog.diagnostics.some((entry) => entry.platform === "ios" && !entry.available
    && entry.checks[0].message === "Owned newer unavailable SDK diagnostic"), true);
  await assert.rejects(state.backend.create(inputFor(catalog)), { code: "runtime_unavailable" });
  assert.equal(posts(state.state).length, 0);
  assert.ok(state.state.calls.some((call) => call.path === `/api/v1/providers/${encodeURIComponent(catalogIds.iosProvider)}/diagnostics`));
});

test("duplicate/dangling/cross-provider catalog identities and contradictory template constraints are rejected", () => {
  for (const change of [
    (model) => { model.providerCatalogs[0].runtimes.push(model.providerCatalogs[0].runtimes[0]); },
    (model) => { model.providerCatalogs[0].targetTypes.push(model.providerCatalogs[0].targetTypes[0]); },
    (model) => { model.providers.push(model.providers[0]); },
    (model) => { model.providerCatalogs[0].runtimes[0].providerId = catalogIds.androidProvider; },
    (model) => { model.providerCatalogs[0].runtimes[0].metadata.supportedDeviceTypeIds = ["missing/opaque-type"]; },
    (model) => { model.providerCatalogs[0].templates[0].targetTypeId = "missing/type"; },
    (model) => { model.providerCatalogs[0].templates[0].runtimeId = catalogIds.olderRuntime; },
    (model) => { model.providerCatalogs[0].targetTypes[0].platform = "android"; },
    (model) => { model.providerCatalogs[0].runtimes[0].metadata.supportedArchitectures = ["x64"]; },
  ]) {
    const model = createCatalogModel({ templates: true });
    change(model);
    assert.throws(() => project(model));
  }
});

test("compatibility ID decoding rejects coercible kinds and alternate encodings, not just missing IDs", () => {
  for (const kind of [["runtime"], "__proto__", {}, null]) {
    const value = `ailoha-catalog-v1:${encodeURIComponent(JSON.stringify([catalogIds.host, catalogIds.iosProvider, kind, catalogIds.runtime]))}`;
    assert.throws(() => readCatalogChoiceId(value), { code: "invalid_catalog_choice" });
  }
  const id = catalogChoiceId("runtime", { targetHostId: catalogIds.host, providerId: catalogIds.iosProvider, runtimeId: catalogIds.runtime });
  assert.throws(() => readCatalogChoiceId(id.replace("%5B", "%5b")), { code: "invalid_catalog_choice" });
});

test("advertised provider reads retain strict response/owner/schema validation and never quietly return empty catalogs", async (t) => {
  const model = createCatalogModel({ templates: true });
  const { connection, state } = await startCatalogHost(t, { model });
  const client = await connectTargetHost(connection);
  t.after(() => client.dispose());
  const providerId = catalogIds.iosProvider;
  assert.equal((await client.listProviderTemplates(providerId))[0].templateId, catalogIds.template);
  for (const [field, method] of [
    ["catalogs", "listProviderCatalogs"], ["runtimes", "listProviderRuntimes"],
    ["targetTypes", "listProviderTargetTypes"], ["templates", "listProviderTemplates"],
  ]) {
    const saved = model.providerCatalogs[0][field];
    model.providerCatalogs[0][field] = [{ ...saved[0], providerId: catalogIds.androidProvider }];
    await assert.rejects(client[method](providerId), { code: "provider_identity_mismatch" });
    model.providerCatalogs[0][field] = [{ ...saved[0], unexpected: true }];
    await assert.rejects(client[method](providerId), { code: "invalid_response" });
    model.providerCatalogs[0][field] = saved;
    await assert.rejects(client[method](".."), { code: "invalid_identifier" });
  }
  assert.equal(posts(state).length, 0);
});

for (const kind of ["action", "api", "mcp", "vscode-mcp"]) {
  for (const platform of ["ios", "android"]) {
    test(`${kind} ${platform} creates+boots once with exact IDs and the original selection semantics`, async (t) => {
      const state = await fixture(t);
      const create = await entrypoint(state, kind, kind === "vscode-mcp");
      const input = inputFor(await state.backend.catalog(), platform);
      const created = await create(input);
      assert.equal(created.state, "booted");
      assert.equal(created.nativeId, platform === "ios" ? "owned-udid-1" : "owned_avd_1");
      assert.notEqual(created.nativeId, created.id);
      assert.equal(created.runtimeId, input.runtimeId);
      assert.equal(created.deviceTypeId, input.deviceTypeId);
      if (platform === "ios") assert.equal(created.udid, created.nativeId);
      else assert.equal(created.serial, "emulator-5601");
      assert.equal(created.selectionApplied, kind !== "mcp");
      assert.equal(state.document.selection?.targetId ?? null, kind === "mcp" ? null : created.id);
      assert.equal(posts(state.state).length, 1);
      assert.deepEqual(posts(state.state)[0], {
        method: "POST", path: "/api/v1/targets", body: {
          providerId: catalogIds[`${platform}Provider`], targetTypeId: catalogIds.type,
          runtimeId: catalogIds.runtime, name: input.name, start: true,
        },
      });
      assert.equal(created.acceptedOperation.kind, "createTarget");
      assert.equal(created.acceptedOperation.destructive, true);
      assert.equal(state.operationState.size, 0);
      assert.deepEqual(state.state.errors, []);
    });
  }
}

for (const kind of ["action", "api", "mcp", "vscode-mcp"]) {
  test(`${kind} a genuinely truncated HTTP 202 recovers only through its accepted operation Location`, async (t) => {
    const state = await fixture(t);
    state.state.acceptance = "lost-body";
    const create = await entrypoint(state, kind, kind === "vscode-mcp");
    const created = await create(inputFor(await state.backend.catalog()));
    assert.equal(created.state, "booted");
    assert.equal(posts(state.state).length, 1);
    assert.ok(state.state.calls.some((call) => call.method === "GET" && call.path.startsWith("/api/v1/operations/")));
  });
}

test("invalid accepted bodies cannot poison the validated Location receipt or relabel its created target", async (t) => {
  for (const acceptance of ["mismatched-body", "wrong-provider-body"]) {
    const state = await fixture(t);
    state.state.acceptance = acceptance;
    const created = await state.backend.create(inputFor(await state.backend.catalog()));
    assert.equal(created.id, "created/opaque-1%2F");
    assert.equal(created.nativeId, "owned-udid-1");
    assert.equal(created.acceptedOperation.operationId, "creation/operation-1%2F");
    assert.equal(posts(state.state).length, 1);
  }
});

test("invalid/mixed/opaque native inputs, extra fields and unsupported platform choices cause zero POSTs", async (t) => {
  const state = await fixture(t);
  const catalog = await state.backend.catalog();
  const input = inputFor(catalog);
  for (const invalid of [
    { ...input, runtimeId: catalogIds.runtime },
    { ...input, deviceTypeId: catalogIds.type },
    { ...input, deviceTypeId: inputFor(catalog, "android").deviceTypeId },
    { ...input, platform: "android" },
    { ...input, platform: null },
    { ...input, start: false },
    { ...input, configuration: { fixture: true } },
    { ...input, labels: {} },
    { ...input, name: " " },
    { ...input, runtimeId: catalogChoiceId("runtime", { targetHostId: "different/host", providerId: catalogIds.iosProvider, runtimeId: catalogIds.runtime }) },
  ]) await assert.rejects(state.backend.invokeAction("create_device", invalid));
  const olderType = catalog.deviceTypes.find((type) => type.catalogSelection.providerId === catalogIds.iosProvider
    && type.targetTypeId === catalogIds.olderType);
  await assert.rejects(state.backend.create({ ...input, deviceTypeId: olderType.id }), { code: "incompatible_catalog_choice" });
  assert.equal(posts(state.state).length, 0);
});

test("ios remains the default and an Android choice needs the explicit platform on every compatibility entrypoint", async (t) => {
  for (const kind of ["action", "api", "mcp"]) {
    const state = await fixture(t);
    const create = await entrypoint(state, kind);
    const input = inputFor(await state.backend.catalog(), "android");
    delete input.platform;
    await assert.rejects(create(input), { code: "incompatible_catalog_choice" });
    assert.equal(posts(state.state).length, 0);
  }
});

test("existing API/MCP platform values remain case-insensitive without changing the ios default", async (t) => {
  for (const kind of ["api", "mcp"]) {
    const state = await fixture(t);
    const create = await entrypoint(state, kind);
    const input = inputFor(await state.backend.catalog(), "android");
    input.platform = "ANDROID";
    assert.equal((await create(input)).platform, "android");
    assert.equal(posts(state.state).length, 1);
  }
});

for (const acceptance of ["unknown", "cross-origin"]) {
  test(`${acceptance} accepted creation remains unknown and is never replayed by retry`, async (t) => {
    const state = await fixture(t);
    state.state.acceptance = acceptance;
    const input = inputFor(await state.backend.catalog());
    await assert.rejects(state.backend.create(input));
    await assert.rejects(state.backend.create(input), { code: "creation_outcome_uncertain" });
    assert.equal(posts(state.state).length, 1);
    assert.equal(state.state.calls.some((call) => call.path.startsWith("/api/v1/operations/")), false);
    assert.equal(state.operationState.size, 1);
    assert.equal(state.document.selection, null);
  });
}

for (const kind of ["action", "api", "mcp"]) {
  for (const [name, code, status] of [
    ["HTTP 408", "http_error", 408],
    ["HTTP 499", "http_error", 499],
    ["disposed client", "client_disposed", undefined],
  ]) {
    test(`${kind} creation retains the original ${name} receipt without replacement IO or replay`, async (t) => {
      const state = await fixture(t);
      const create = await entrypoint(state, kind);
      const input = inputFor(await state.backend.catalog());
      const submit = state.client.createTarget.bind(state.client);
      let submissions = 0;
      state.state.submissionStatus = status;
      state.client.createTarget = async (...args) => {
        submissions += 1;
        if (code === "client_disposed") throw new AilohaProtocolError(code);
        return submit(...args);
      };
      await assert.rejects(create(input), { code });
      const receipt = [...state.operationState.values()][0];
      assert.ok(receipt);
      assert.equal(receipt.uncertain, true);
      state.state.submissionStatus = undefined;
      state.client.createTarget = async (...args) => { submissions += 1; return submit(...args); };
      const reads = state.state.calls.length;
      const contextReads = state.contextCommands.length;
      await assert.rejects(create(input), { code: "creation_outcome_uncertain" });
      assert.equal([...state.operationState.values()][0], receipt);
      assert.equal(submissions, 1);
      assert.equal(posts(state.state).length, status === undefined ? 0 : 1);
      assert.equal(state.state.calls.length, reads);
      assert.equal(state.contextCommands.length, contextReads);
      assert.equal(state.document.selection, null);
    });
  }
}

test("a definitive HTTP403 creation rejection is safely retryable through all compatibility entrypoints", async (t) => {
  for (const kind of ["action", "api", "mcp"]) {
    const state = await fixture(t);
    const create = await entrypoint(state, kind);
    const input = inputFor(await state.backend.catalog());
    state.state.submissionStatus = 403;
    await assert.rejects(create(input), { code: "http_error", status: 403 });
    assert.equal(state.operationState.size, 0);
    state.state.submissionStatus = undefined;
    const created = await create(input);
    assert.equal(created.nativeIdentity.nativeId, "owned-udid-1");
    assert.equal(created.state, "booted");
    assert.equal(posts(state.state).length, 2);
    assert.equal(posts(state.state).every((call) => call.path === "/api/v1/targets" && call.body.start === true), true);
    assert.equal(state.operationState.size, 0);
  }
});

test("accepted timeout resumes GET/poll; known terminal failure/cancellation cannot replay creation or boot", async (t) => {
  for (const status of ["running", "failed", "cancelled"]) {
    const state = await fixture(t);
    state.state.terminal = status;
    state.state.waitMs = 10;
    const input = inputFor(await state.backend.catalog());
    let failure;
    await assert.rejects(state.backend.create(input), (error) => {
      failure = mobileErrorResult(error);
      assert.equal(failure.operationId, "creation/operation-1%2F");
      assert.equal(failure.createdTargetId, "created/opaque-1%2F");
      assert.equal(failure.operation.status, status);
      if (status === "failed") assert.equal(failure.operation.cleanupProblem.detail, "Owned provider cleanup failed");
      return true;
    });
    if (status === "running") {
      state.state.operations.values().next().value.status = "succeeded";
      const created = await state.backend.create(input);
      assert.equal(created.state, "booted");
    } else await assert.rejects(state.backend.create(input), { code: failure.code });
    assert.equal(posts(state.state).length, 1);
    assert.equal(state.state.calls.some((call) => call.method === "DELETE"), false);
    assert.equal(state.document.selection, null);
  }
});

test("canonical cancellation is a request until a terminal result and never authorizes client rollback", async (t) => {
  const state = await fixture(t);
  state.state.terminal = "running";
  state.state.waitMs = 10;
  const input = inputFor(await state.backend.catalog());
  await assert.rejects(state.backend.create(input), { code: "timeout" });
  const operationId = state.state.operations.keys().next().value;
  const cancelled = await state.client.cancelOperation(operationId);
  assert.equal(cancelled.status, "cancelling");
  assert.equal(cancelled.cancelRequested, true);
  state.state.operations.get(operationId).status = "succeeded";
  assert.equal((await state.backend.create(input)).state, "booted");
  assert.equal(posts(state.state).length, 1);
  assert.equal(state.state.calls.filter((call) => call.method === "DELETE").length, 1);
  assert.equal(state.state.calls.find((call) => call.method === "DELETE").path, `/api/v1/operations/${encodeURIComponent(operationId)}`);
});

test("output/boot/native identity confirmation failures keep the receipt and cannot become another creation", async (t) => {
  for (const mutate of [
    (target) => { target.targetTypeId = catalogIds.olderType; },
    (target) => { target.runtimeId = catalogIds.olderRuntime; },
    (target) => { target.status = "stopped"; },
    (target) => { delete target.nativeIdentity; },
    (target) => { target.nativeIdentity.platform = "android"; },
    (target) => { target.name = "Ignored requested name"; },
  ]) {
    let original;
    const state = await fixture(t, { beforeTarget(target) {
      if (!original) { original = structuredClone(target); mutate(target); }
    } });
    const input = inputFor(await state.backend.catalog());
    await assert.rejects(state.backend.create(input), (error) => {
      assert.equal(error.operationId, "creation/operation-1%2F");
      assert.equal(error.createdTargetId, "created/opaque-1%2F");
      return true;
    });
    Object.assign(state.state.targets.get(original.targetId), original);
    assert.equal((await state.backend.create(input)).state, "booted");
    assert.equal(posts(state.state).length, 1);
  }
});

test("wrong completion kind/provider/target correlation retains accepted intent without presenting success", async (t) => {
  for (const mutate of [
    (operation) => { operation.kind = "startTarget"; },
    (operation) => { operation.providerId = catalogIds.androidProvider; },
    (operation) => { operation.result.targetId = "different/target"; },
  ]) {
    const state = await fixture(t, { beforePoll: (operation) => mutate(operation) });
    const input = inputFor(await state.backend.catalog());
    await assert.rejects(state.backend.create(input), { code: "operation_owner_mismatch" });
    await assert.rejects(state.backend.create(input), { code: "operation_owner_mismatch" });
    assert.equal(posts(state.state).length, 1);
    assert.equal(state.document.selection, null);
  }
});

test("a foreign failed operation cannot evict or terminal-cache the original creation receipt", async (t) => {
  let corrupt = true;
  const state = await fixture(t, { beforePoll: (operation) => {
    if (corrupt) {
      operation.operationId = "foreign/operation";
      operation.status = "failed";
      operation.kind = "createTarget";
    }
  } });
  const input = inputFor(await state.backend.catalog());
  await assert.rejects(state.backend.create(input), (error) => {
    assert.equal(error.code, "operation_identity_mismatch");
    assert.equal(Object.hasOwn(error, "createdTargetId"), false);
    return true;
  });
  corrupt = false;
  const operation = state.state.operations.values().next().value;
  operation.operationId = "creation/operation-1%2F";
  operation.status = "succeeded";
  assert.equal((await state.backend.create(input)).state, "booted");
  assert.equal(posts(state.state).length, 1);
});

test("external context change during catalog reads rejects the undispatched immutable intent", async (t) => {
  const entered = deferred();
  const release = deferred();
  let holding = false;
  const state = await fixture(t, { beforeRead: async (field) => {
    if (holding && field === "runtimes") { entered.resolve(); await release.promise; }
  } });
  const input = inputFor(await state.backend.catalog());
  holding = true;
  const pending = state.backend.invokeAction("create_device", input);
  await entered.promise;
  state.changeSelection();
  release.resolve();
  await assert.rejects(pending, { code: "context_snapshot_superseded" });
  assert.equal(posts(state.state).length, 0);
});

test("user-changed selection after acceptance remains selected; input and returned context stay captured", async (t) => {
  const entered = deferred();
  const release = deferred();
  const state = await fixture(t, { beforePoll: async () => { entered.resolve(); await release.promise; } });
  const input = inputFor(await state.backend.catalog());
  const pending = state.backend.invokeAction("create_device", input);
  await entered.promise;
  input.name = "Late mutation must not be sent";
  state.changeSelection();
  release.resolve();
  const created = await pending;
  assert.equal(created.name, "Owned creation");
  assert.equal(created.selectionApplied, false);
  assert.equal(created.invocation.executionContext.revision, "1");
  assert.equal(state.document.selection.targetId, "external/explicit-choice");
  assert.equal(state.events.length, 0);
  assert.equal(posts(state.state).length, 1);
});

test("accepted creation resumes under a replacement owner after hide without replaying POST or losing original context", async (t) => {
  const entered = deferred();
  const release = deferred();
  const state = await fixture(t, { beforePoll: async () => { entered.resolve(); await release.promise; } });
  const input = inputFor(await state.backend.catalog());
  const pending = state.backend.invokeAction("create_device", input);
  const rejected = assert.rejects(pending, { code: "cancelled" });
  await entered.promise;
  await state.backend.dispose();
  await rejected;
  const replacement = await state.makeBackend();
  release.resolve();
  const created = await replacement.backend.invokeAction("create_device", input);
  assert.equal(created.state, "booted");
  assert.equal(created.invocation.executionContext.scopeEpoch, "original-epoch");
  assert.equal(posts(state.state).length, 1);
  assert.equal(state.document.selection.targetId, created.id);
});

test("creation captures the official frozen incarnation privately without putting it in public success or errors", async (t) => {
  const state = await fixture(t);
  state.state.terminal = "running";
  state.state.waitMs = 10;
  const input = inputFor(await state.backend.catalog());
  let failure;
  await assert.rejects(state.backend.create(input), (error) => { failure = mobileErrorResult(error); return true; });
  const receipt = state.operationState.values().next().value;
  assert.equal(receipt.invocation.connectionRef, state.backend.connectionRef);
  assert.equal(Object.isFrozen(receipt.invocation.connectionRef), true);
  assert.equal(Object.getOwnPropertyDescriptor(receipt.invocation, "connectionRef").enumerable, false);
  assert.equal(JSON.stringify(failure).includes("connectionRef"), false);
  assert.equal(JSON.stringify(failure).includes(state.backend.connectionRef.serviceId), false);
  state.state.operations.values().next().value.status = "succeeded";
  const created = await state.backend.create(input);
  assert.equal(Object.hasOwn(created.invocation, "connectionRef"), false);
  assert.equal(JSON.stringify(created).includes(state.backend.connectionRef.serviceId), false);
  assert.equal(posts(state.state).length, 1);
});

for (const changed of [
  { serviceId: "replacement-creation-service" }, { pid: 54321 },
  { startedAt: "2026-10-10T03:00:01Z" }, { processStartedAt: "2026-10-10T03:00:00Z" },
]) {
  for (const outcome of ["unknown", "pending", "completed"]) {
    test(`${Object.keys(changed)[0]} replacement cannot continue an ${outcome} creation receipt before any GET/POST`, async (t) => {
      const state = await fixture(t);
      const input = inputFor(await state.backend.catalog());
      if (outcome === "unknown") state.state.acceptance = "unknown";
      if (outcome === "pending") { state.state.terminal = "running"; state.state.waitMs = 10; }
      if (outcome === "completed") state.state.targetStatus = "stopped";
      await assert.rejects(state.backend.create(input));
      const receipt = state.operationState.values().next().value;
      const capturedIncarnation = state.backend.connectionRef;
      if (outcome === "pending") state.state.operations.values().next().value.status = "succeeded";
      if (outcome === "completed") {
        assert.equal(receipt.completed.status, "succeeded");
        state.state.targets.values().next().value.status = "running";
      }
      await state.backend.dispose();
      const replacement = await state.makeBackend({ ...capturedIncarnation, ...changed });
      const before = state.state.calls.length;
      const contextReads = state.contextCommands.length;
      await assert.rejects(replacement.backend.create(input), { code: "runtime_incarnation_changed" });
      assert.equal(state.state.calls.length, before);
      assert.equal(state.contextCommands.length, contextReads);
      assert.equal(state.operationState.values().next().value, receipt);
      assert.equal(state.operationState.size, 1);
      assert.equal(receipt.invocation.connectionRef, capturedIncarnation);
      assert.equal(posts(state.state).length, 1);
      assert.equal(state.state.calls.some((call) => call.method === "DELETE" || /\/actions\/start$/.test(call.path)), false);
    });
  }
}

for (const outcome of ["unknown", "pending", "completed"]) {
  test(`a replacement discovery host cannot rekey an ${outcome} intent encoded in the original catalog choices`, async (t) => {
    const state = await fixture(t);
    const input = inputFor(await state.backend.catalog());
    if (outcome === "unknown") state.state.acceptance = "unknown";
    if (outcome === "pending") { state.state.terminal = "running"; state.state.waitMs = 10; }
    if (outcome === "completed") state.state.targetStatus = "stopped";
    await assert.rejects(state.backend.create(input));
    const key = state.operationState.keys().next().value;
    const receipt = state.operationState.get(key);
    const original = state.backend.connectionRef;
    await state.backend.dispose();
    state.connection.hostId = "replacement-discovery-host";
    state.state.model.status.hostId = state.connection.hostId;
    const replacement = await state.makeBackend({ ...original, serviceId: "replacement-service" });
    const before = state.state.calls.length;
    const reads = state.contextCommands.length;
    await assert.rejects(replacement.backend.create(input), { code: "runtime_incarnation_changed" });
    assert.equal(state.state.calls.length, before);
    assert.equal(state.contextCommands.length, reads);
    assert.equal(state.operationState.size, 1);
    assert.equal(state.operationState.get(key), receipt);
    assert.equal(posts(state.state).length, 1);
  });
}

test("a concurrent replacement cannot join the original owner's accepted creation or change its eventual result", async (t) => {
  const entered = deferred();
  const release = deferred();
  const state = await fixture(t, { beforePoll: async () => { entered.resolve(); await release.promise; } });
  const input = inputFor(await state.backend.catalog());
  const original = state.backend.create(input);
  await entered.promise;
  const receipt = state.operationState.values().next().value;
  const originalConnectionRef = state.backend.connectionRef;
  const replacement = await state.makeBackend({ ...originalConnectionRef, pid: 54321 });
  const before = state.state.calls.length;
  await assert.rejects(replacement.backend.create(input), { code: "runtime_incarnation_changed" });
  assert.equal(state.state.calls.length, before);
  release.resolve();
  const created = await original;
  assert.equal(created.state, "booted");
  assert.equal(receipt.invocation.connectionRef, originalConnectionRef);
  assert.equal(posts(state.state).length, 1);
});

test("replacement owners do not mistake a local generation reset for a changed canonical view selection", async (t) => {
  const state = await fixture(t);
  state.state.targets.set("existing/ios", {
    targetId: "existing/ios", providerId: catalogIds.iosProvider, targetTypeId: catalogIds.type,
    runtimeId: catalogIds.runtime, name: "Owned initial selection", status: "running", surfaces: [],
    nativeIdentity: { platform: "ios", nativeId: "owned-initial-udid", isVirtual: true },
  });
  await state.backend.select("existing/ios");
  state.state.terminal = "running";
  state.state.waitMs = 10;
  const input = inputFor(await state.backend.catalog());
  await assert.rejects(state.backend.invokeAction("create_device", input), { code: "timeout" });
  await state.backend.dispose();
  const replacement = await state.makeBackend();
  state.state.operations.values().next().value.status = "succeeded";
  const created = await replacement.backend.invokeAction("create_device", input);
  assert.equal(created.selectionApplied, true);
  assert.equal(created.invocation.selectionGeneration, 1);
  assert.equal(created.invocation.executionContext.revision, "2");
  assert.equal(state.document.selection.targetId, created.id);
  assert.equal(posts(state.state).length, 1);
});

test("a reopened epoch can finish its old accepted creation but cannot inherit the old selection write", async (t) => {
  const state = await fixture(t);
  state.state.terminal = "running";
  state.state.waitMs = 10;
  const input = inputFor(await state.backend.catalog());
  await assert.rejects(state.backend.invokeAction("create_device", input), { code: "timeout" });
  state.retire();
  await state.store.readSnapshot();
  await state.store.binding();
  const replacement = await state.makeBackend();
  state.state.operations.values().next().value.status = "succeeded";
  const created = await replacement.backend.invokeAction("create_device", input);
  assert.equal(created.selectionApplied, false);
  assert.equal(created.invocation.executionContext.scopeEpoch, "original-epoch");
  assert.equal(state.document.scopeEpoch, "reopened-epoch");
  assert.equal(state.document.selection, null);
  assert.equal(posts(state.state).length, 1);
});

test("same-key concurrent action/API/MCP requests share one bounded accepted creation", async (t) => {
  const state = await fixture(t);
  const input = inputFor(await state.backend.catalog());
  const action = await entrypoint(state, "action");
  const api = await entrypoint(state, "api");
  const mcp = await entrypoint(state, "mcp");
  const results = await Promise.all([action(input), api(input), mcp(input), action(input), api(input), mcp(input)]);
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal(posts(state.state).length, 1);
  assert.equal(state.contextCommands.filter((args) => args[1] === "select").length, 1);
  assert.equal(state.operationState.size, 0);
});

test("pool admission is rechecked after asynchronous catalog validation and cannot evict newer receipts", async (t) => {
  const entered = deferred();
  const release = deferred();
  let holding = false;
  const state = await fixture(t, { beforeRead: async (field) => {
    if (holding && field === "runtimes") { entered.resolve(); await release.promise; }
  } });
  const input = inputFor(await state.backend.catalog());
  holding = true;
  const pending = state.backend.create(input);
  await entered.promise;
  for (let index = 0; index < 64; index += 1) state.operationState.set(`newer-${index}`, { owned: index });
  release.resolve();
  await assert.rejects(pending, { code: "operation_receipt_limit" });
  assert.equal(state.operationState.size, 64);
  assert.equal(posts(state.state).length, 0);
  const rejected = deferred();
  const key = "late-definitive";
  const map = new Map();
  const receipt = submitOperationReceipt({
    state: map, key, invocation: {}, requireCurrent() {},
    submit: async () => { await rejected.promise; throw new AilohaProtocolError("http_error", { status: 400 }); },
  });
  const newer = { newer: true };
  map.set(key, newer);
  rejected.resolve();
  await assert.rejects(receipt.submitted, { code: "http_error" });
  assert.equal(map.get(key), newer);
});

test("shared submission receipts retain original ownership for HTTP 408/499 and disposed-client uncertainty", async () => {
  for (const [code, status] of [["http_error", 408], ["http_error", 499],
    ["client_disposed", undefined], ["client_disposed", 403], ["invalid_options", 408]]) {
    const state = new Map();
    const invocation = Object.freeze({ targetId: "original", providerId: "original-provider" });
    let submissions = 0;
    const original = submitOperationReceipt({
      state, key: "captured", kind: "installTargetApp", invocation, requireCurrent() {},
      async submit() {
        submissions += 1;
        throw new AilohaProtocolError(code, { status });
      },
    });
    await assert.rejects(original.submitted, { code });
    assert.equal(state.get("captured"), original);
    assert.equal(original.invocation, invocation);
    assert.equal(original.uncertain, true);
    const resumed = submitOperationReceipt({
      state, key: "captured", kind: "installTargetApp", invocation: { targetId: "replacement" },
      requireCurrent() { throw Error("The original receipt must win before a fresh owner is checked."); },
      submit() { submissions += 1; throw Error("Must not repeat the captured POST."); },
    });
    assert.equal(resumed, original);
    await assert.rejects(waitForOperationReceipt({
      state, key: "captured", receipt: resumed,
      client: { async waitForOperation() { throw Error("No accepted ID exists for GET."); } },
      outcome: "app_install",
    }), { code: "app_install_outcome_uncertain" });
    assert.equal(submissions, 1);
  }
  const state = new Map();
  const rejected = submitOperationReceipt({
    state, key: "definitive", invocation: {}, requireCurrent() {},
    async submit() { throw new AilohaProtocolError("http_error", { status: 403 }); },
  });
  await assert.rejects(rejected.submitted, { status: 403 });
  assert.equal(state.has("definitive"), false);
});

test("64 staggered creation submissions remain admissible while waiting for acceptance", async (t) => {
  const state = await fixture(t);
  const input = inputFor(await state.backend.catalog());
  const submit = state.client.createTarget.bind(state.client);
  const gates = [];
  const pending = [];
  let entered;
  state.client.createTarget = async (...args) => {
    const gate = deferred();
    gates.push(gate);
    entered.resolve();
    await gate.promise;
    return submit(...args);
  };
  for (let index = 0; index < 64; index += 1) {
    entered = deferred();
    const creation = state.backend.create({ ...input, name: `Bounded creation ${index}` });
    pending.push(creation);
    await Promise.race([entered.promise, creation]);
    assert.equal(state.operationState.size, index + 1);
  }
  const reads = state.state.calls.length;
  await assert.rejects(state.backend.create({ ...input, name: "Outside the bound" }), { code: "operation_receipt_limit" });
  assert.equal(gates.length, 64);
  assert.equal(state.state.calls.length, reads);
  for (let index = 0; index < gates.length; index += 1) {
    gates[index].resolve();
    assert.equal((await pending[index]).state, "booted");
  }
  assert.equal(posts(state.state).length, 64);
  assert.equal(state.operationState.size, 0);
});

for (const kind of ["action", "api", "mcp", "vscode-mcp"]) {
  test(`${kind} error envelopes retain unknown/timeout/boot failure receipts with exact single-POST semantics`, async (t) => {
    for (const outcome of ["unknown", "timeout", "boot-failed", "cancelled"]) {
      const state = await fixture(t);
      const create = await entrypoint(state, kind, kind === "vscode-mcp");
      const input = inputFor(await state.backend.catalog());
      if (outcome === "unknown") state.state.acceptance = "unknown";
      if (outcome === "timeout") { state.state.terminal = "running"; state.state.waitMs = 10; }
      if (outcome === "boot-failed") { state.state.terminal = "failed"; state.state.targetStatus = "stopped"; }
      if (outcome === "cancelled") state.state.terminal = "cancelled";
      await assert.rejects(create(input), (error) => {
        if (outcome !== "unknown") {
          assert.equal(error.operationId, "creation/operation-1%2F");
          assert.equal(error.createdTargetId, "created/opaque-1%2F");
          assert.ok(error.operation);
        }
        return true;
      });
      if (outcome === "timeout") {
        state.state.operations.values().next().value.status = "succeeded";
        assert.equal((await create(input)).state, "booted");
      } else await assert.rejects(create(input));
      assert.equal(posts(state.state).length, 1);
      assert.equal(state.state.calls.some((call) => call.method === "DELETE" || /\/actions\/start$/.test(call.path)), false);
    }
  });
}

for (const kind of ["direct", "action", "api", "mcp", "vscode-mcp"]) {
  test(`${kind} a cancelled accepted caller retains its original operation and does not apply a late selection`, async (t) => {
    const entered = deferred();
    const release = deferred();
    const state = await fixture(t, { beforePoll: async () => { entered.resolve(); await release.promise; } });
    t.after(() => release.resolve());
    const create = await entrypoint(state, kind, kind === "vscode-mcp");
    const input = inputFor(await state.backend.catalog());
    const controller = new AbortController();
    const result = create(input, { signal: controller.signal }).then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", error }),
    );
    await Promise.race([entered.promise, result]);
    const receipt = [...state.operationState.values()][0];
    const confirming = receipt.confirming;
    assert.equal(receipt.operationId, "creation/operation-1%2F");
    controller.abort();
    const cancelled = await result;
    assert.equal(cancelled.status, "rejected");
    assert.equal(cancelled.error.code, "cancelled");
    assert.equal(cancelled.error.operationId, receipt.operationId);
    assert.equal(state.operationState.values().next().value, receipt);
    release.resolve();
    await confirming;
    assert.equal(state.document.selection, null);
    assert.equal(state.operationState.values().next().value, receipt);
    const recovered = await create(input);
    assert.equal(recovered.acceptedOperation.operationId, receipt.operationId);
    assert.equal(recovered.state, "booted");
    assert.equal(posts(state.state).length, 1);
    assert.equal(state.state.calls.filter((call) => call.path.startsWith("/api/v1/operations/")).length, 1);
    assert.equal(state.operationState.size, 0);
  });

  test(`${kind} cancelling one accepted caller cannot retire another caller's shared confirmation`, async (t) => {
    const entered = deferred();
    const release = deferred();
    const state = await fixture(t, { beforePoll: async () => { entered.resolve(); await release.promise; } });
    t.after(() => release.resolve());
    const create = await entrypoint(state, kind, kind === "vscode-mcp");
    const input = inputFor(await state.backend.catalog());
    const controller = new AbortController();
    const cancelled = create(input, { signal: controller.signal }).then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", error }),
    );
    await Promise.race([entered.promise, cancelled]);
    const receipt = state.operationState.values().next().value;
    const confirming = receipt.confirming;
    const active = create(input);
    controller.abort();
    release.resolve();
    const outcome = await cancelled;
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.error.code, "cancelled");
    const completed = await active;
    assert.equal(completed.acceptedOperation.operationId, receipt.operationId);
    assert.equal(confirming, receipt.confirming);
    assert.equal(posts(state.state).length, 1);
    assert.equal(state.state.calls.filter((call) => call.path.startsWith("/api/v1/operations/")).length, 1);
    assert.equal(state.operationState.size, 0);
  });

  for (const outcome of ["accepted", "unknown"]) {
    test(`${kind} cancelled submission keeps a late ${outcome} receipt without submitting a fresh intent`, async (t) => {
      const state = await fixture(t);
      const create = await entrypoint(state, kind, kind === "vscode-mcp");
      const input = inputFor(await state.backend.catalog());
      const entered = deferred();
      const release = deferred();
      t.after(() => release.resolve());
      const submit = state.client.createTarget.bind(state.client);
      state.client.createTarget = async (...args) => {
        const accepted = await submit(...args);
        entered.resolve();
        await release.promise;
        if (outcome === "unknown") throw new AilohaProtocolError("transport_error");
        return accepted;
      };
      const controller = new AbortController();
      const result = create(input, { signal: controller.signal }).then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      );
      await Promise.race([entered.promise, result]);
      const receipt = state.operationState.values().next().value;
      controller.abort();
      const cancelled = await result;
      assert.equal(cancelled.status, "rejected");
      assert.equal(cancelled.error.code, "cancelled");
      assert.equal(state.operationState.values().next().value, receipt);
      release.resolve();
      if (outcome === "unknown") {
        await assert.rejects(receipt.submitted, { code: "transport_error" });
        await assert.rejects(create(input), { code: "creation_outcome_uncertain" });
        assert.equal(state.operationState.values().next().value, receipt);
      } else {
        await receipt.submitted;
        const recovered = await create(input);
        assert.equal(recovered.acceptedOperation.operationId, receipt.operationId);
        assert.equal(state.operationState.size, 0);
      }
      assert.equal(posts(state.state).length, 1);
      assert.equal(state.state.calls.some((call) => call.method === "DELETE" || /\/actions\/start$/.test(call.path)), false);
    });
  }
}

test("an abandoned preparation cannot dispatch or evict a new same-key accepted intent", async (t) => {
  const state = await fixture(t);
  const input = inputFor(await state.backend.catalog());
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const providers = state.client.listProviders.bind(state.client);
  let held = true;
  state.client.listProviders = async (...args) => {
    if (held) { held = false; entered.resolve(); await release.promise; }
    return providers(...args);
  };
  const controller = new AbortController();
  const cancelled = state.backend.create(input, { signal: controller.signal }).then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
  await Promise.race([entered.promise, cancelled]);
  controller.abort();
  const rejected = await cancelled;
  assert.equal(rejected.error.code, "cancelled");
  state.state.terminal = "running";
  state.state.waitMs = 10;
  await assert.rejects(state.backend.create(input), { code: "timeout" });
  const receipt = state.operationState.values().next().value;
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.operationState.values().next().value, receipt);
  assert.equal(posts(state.state).length, 1);
  state.state.operations.values().next().value.status = "succeeded";
  assert.equal((await state.backend.create(input)).acceptedOperation.operationId, receipt.operationId);
  assert.equal(posts(state.state).length, 1);
});

test("64 cancelled preparations release admission without creating devices or poisoning a fresh intent", async (t) => {
  const state = await fixture(t);
  const input = inputFor(await state.backend.catalog());
  const release = deferred();
  t.after(() => release.resolve());
  const providers = state.client.listProviders.bind(state.client);
  let entered;
  state.client.listProviders = async (...args) => {
    const result = await providers(...args);
    entered.resolve();
    await release.promise;
    return result;
  };
  const controllers = [];
  const pending = [];
  for (let index = 0; index < 64; index += 1) {
    const controller = new AbortController();
    controllers.push(controller);
    entered = deferred();
    const result = state.backend.create({ ...input, name: `Cancelled ${index}` }, { signal: controller.signal }).then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", error }),
    );
    pending.push(result);
    await Promise.race([entered.promise, result]);
  }
  await assert.rejects(state.backend.create({ ...input, name: "Unadmitted 65" }), { code: "operation_receipt_limit" });
  for (const controller of controllers) controller.abort();
  release.resolve();
  for (const result of await Promise.all(pending)) {
    assert.equal(result.status, "rejected");
    assert.equal(result.error.code, "cancelled");
  }
  assert.equal(posts(state.state).length, 0);
  assert.equal(state.operationState.size, 0);
  state.client.listProviders = providers;
  assert.equal((await state.backend.create({ ...input, name: "Cancelled 0" })).state, "booted");
  assert.equal(posts(state.state).length, 1);
});

for (const kind of ["direct", "action", "api", "mcp", "vscode-mcp"]) {
  test(`${kind} cancellation with actual HTTP202 headers keeps the accepted Location for GET-only recovery`, async (t) => {
    const entered = deferred();
    const release = deferred();
    const state = await fixture(t, { beforeAcceptedBody: async () => { entered.resolve(); await release.promise; } });
    t.after(() => release.resolve());
    const create = await entrypoint(state, kind, kind === "vscode-mcp");
    const input = inputFor(await state.backend.catalog());
    const controller = new AbortController();
    const result = create(input, { signal: controller.signal }).then(
      (value) => ({ status: "fulfilled", value }), (error) => ({ status: "rejected", error }));
    await Promise.race([entered.promise, result]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const receipt = state.operationState.values().next().value;
    controller.abort();
    assert.equal((await result).error.code, "cancelled");
    await receipt.submitted;
    assert.equal(receipt.operationId, "creation/operation-1%2F");
    assert.equal(receipt.uncertain, false);
    release.resolve();
    assert.equal((await create(input)).acceptedOperation.operationId, receipt.operationId);
    assert.equal(posts(state.state).length, 1);
  });
}

test("a cancelled independently prepared same-incarnation caller cannot abort the original owner's shared submission", async (t) => {
  const state = await fixture(t);
  const input = inputFor(await state.backend.catalog());
  const second = await state.makeBackend();
  const firstEntered = deferred();
  const secondEntered = deferred();
  const firstRead = deferred();
  const secondRead = deferred();
  const submitted = deferred();
  const submission = deferred();
  t.after(() => { firstRead.resolve(); secondRead.resolve(); submission.resolve(); });
  const firstProviders = state.client.listProviders.bind(state.client);
  state.client.listProviders = async (...args) => { firstEntered.resolve(); await firstRead.promise; return firstProviders(...args); };
  const secondProviders = second.client.listProviders.bind(second.client);
  second.client.listProviders = async (...args) => { secondEntered.resolve(); await secondRead.promise; return secondProviders(...args); };
  const submit = state.client.createTarget.bind(state.client);
  let originalSignal;
  state.client.createTarget = async (request, options) => {
    originalSignal = options.signal;
    submitted.resolve();
    await submission.promise;
    return submit(request, options);
  };
  const original = state.backend.create(input).then(
    (value) => ({ status: "fulfilled", value }), (error) => ({ status: "rejected", error }));
  await firstEntered.promise;
  const controller = new AbortController();
  const cancelled = second.backend.create(input, { signal: controller.signal }).then(
    (value) => ({ status: "fulfilled", value }), (error) => ({ status: "rejected", error }));
  await secondEntered.promise;
  firstRead.resolve();
  await submitted.promise;
  const receipt = state.operationState.values().next().value;
  const joined = deferred();
  const get = state.operationState.get.bind(state.operationState);
  state.operationState.get = (key) => {
    const value = get(key);
    if (value === receipt) joined.resolve();
    return value;
  };
  secondRead.resolve();
  await joined.promise;
  controller.abort();
  assert.equal((await cancelled).error.code, "cancelled");
  assert.equal(originalSignal.aborted, false);
  submission.resolve();
  const completed = await original;
  assert.equal(completed.status, "fulfilled");
  assert.equal(completed.value.state, "booted");
  assert.equal(posts(state.state).length, 1);
  assert.equal(state.operationState.size, 0);
});
