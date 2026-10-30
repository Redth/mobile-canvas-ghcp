import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
const { connectTargetHostTransport, AilohaProtocolError } = await import(productModule("lib/ailoha/index.mjs"));
const { targetCatalogSnapshot } = await import(productModule("lib/ailoha/protocol.mjs"));

const feature = { id: "target.catalog", version: 1, features: ["getTargetCatalogSnapshot"] };
const provider = (id = "provider", state = "ready") => ({
  providerId: id, name: "Source-only provider", version: "unpublished-test-contract", state, capabilities: [feature],
});
const target = (id, providerId = "provider", status = "stopped") => ({
  targetId: id, providerId, targetTypeId: "type", status, surfaces: [],
});
const observation = (id, providerId = "provider") => ({
  target: target(id, providerId), capabilities: [{ id: "target.lifecycle", version: 1, features: ["startTarget"] }],
});
const snapshot = () => ({
  schema: "ailoha.target-catalog/v1", capturedAt: "2026-10-30T20:06:34+00:00",
  providers: [{ provider: provider(), targets: Array.from({ length: 54 }, (_, index) => observation(`target-${index}`)) }],
});
const response = (body) => ({ status: 200, contentType: "application/json", location: null, retryAfterMs: null, body });

async function fixture(t, options = {}) {
  const calls = [];
  const status = {
    hostId: "owned-host", profile: "ailoha.target-host/v1", version: "source-only-new-engine-contract",
    state: "ready", capabilities: [feature],
  };
  const transport = {
    async response(path, request) {
      calls.push({ path, request });
      if (path === "/api/v1/host/status") return response(options.host ?? status);
      if (path === "/api/v1/providers") return response(options.providers ?? [provider()]);
      if (path.startsWith("/api/v1/target-catalog")) {
        return options.read ? options.read(path, request) : response(options.snapshot ?? snapshot());
      }
      throw new Error("Per-target/list fallback must never be attempted.");
    },
  };
  const client = await connectTargetHostTransport(transport, { hostId: "owned-host" });
  t.after(() => client.dispose());
  return { client, calls, status };
}

test("source-only 54-target catalog validates one observation response without individual target/capability reads", async (t) => {
  const { client, calls } = await fixture(t);
  const value = await client.getTargetCatalogSnapshot();
  assert.equal(value.providers[0].targets.length, 54);
  assert.equal(value.providers[0].targets[0].target.status, "stopped");
  assert.deepEqual(value.providers[0].targets[0].capabilities[0].features, ["startTarget"]);
  assert.equal(calls.filter((call) => call.path === "/api/v1/target-catalog").length, 1);
  assert.equal(calls.some((call) => /^\/api\/v1\/targets/.test(call.path)), false);
  assert.ok(calls.every((call) => call.request.method === "GET"));
  await client.getTargetCatalogSnapshot();
  assert.equal(calls.filter((call) => call.path === "/api/v1/target-catalog").length, 2);
});

for (const missing of ["host", "provider", "unavailable-provider", "future-host-version"]) {
  test(`catalog negotiation rejects ${missing} capability without old fanout or new-route guessing`, async (t) => {
    const peers = [provider("provider", missing === "unavailable-provider" ? "unavailable" : "ready")];
    if (missing.includes("provider")) peers[0].capabilities = [];
    const host = { hostId: "owned-host", profile: "ailoha.target-host/v1", version: "old-peer",
      state: "ready", capabilities: missing === "host" ? [] : [{ ...feature, version: 2 }] };
    const { client, calls } = await fixture(t, { providers: peers,
      ...(["host", "future-host-version"].includes(missing) ? { host } : {}) });
    await assert.rejects(client.getTargetCatalogSnapshot(), { code: "capability_not_supported", status: 501 });
    assert.equal(calls.some((call) => call.path.startsWith("/api/v1/target-catalog")
      || call.path.startsWith("/api/v1/targets")), false);
  });
}

test("provider filter is exact, encoded, and permits advertised unavailable empty observations", async (t) => {
  const id = "unavailable/provider ?%";
  const peer = provider(id, "unavailable");
  const value = { ...snapshot(), providers: [{ provider: peer, targets: [] }] };
  const { client, calls } = await fixture(t, { providers: [provider(), peer], snapshot: value });
  assert.deepEqual(await client.getTargetCatalogSnapshot({ providerId: id }), value);
  assert.equal(calls.at(-1).path, `/api/v1/target-catalog?${new URLSearchParams({ providerId: id })}`);
  await assert.rejects(client.getTargetCatalogSnapshot({ providerId: "unknown" }), { status: 404 });
  await assert.rejects(client.getTargetCatalogSnapshot({ providerId: ".." }), { code: "invalid_identifier" });
  await assert.rejects(client.getTargetCatalogSnapshot({ token: "not-authority" }), { code: "invalid_options" });
});

for (const [name, mutate] of [
  ["unknown schema", (value) => { value.schema = "ailoha.target-catalog/v2"; }],
  ["null timestamp", (value) => { value.capturedAt = null; }],
  ["non-UTC timestamp", (value) => { value.capturedAt = "2026-10-30T20:06:34+01:00"; }],
  ["extra private field", (value) => { value.connectionRef = {}; }],
  ["extra provider field", (value) => { value.providers[0].owner = {}; }],
  ["extra target observation field", (value) => { value.providers[0].targets[0].receipt = {}; }],
  ["duplicate provider", (value) => { value.providers.push(structuredClone(value.providers[0])); }],
  ["duplicate target", (value) => { value.providers[0].targets.push(value.providers[0].targets[0]); }],
  ["foreign target provider", (value) => { value.providers[0].targets[0].target.providerId = "other"; }],
  ["unavailable provider with targets", (value) => { value.providers[0].provider.state = "unavailable"; }],
  ["disabled provider with targets", (value) => { value.providers[0].provider.state = "disabled"; }],
  ["malformed target capabilities", (value) => { value.providers[0].targets[0].capabilities = [{ id: "target.lifecycle", version: "1" }]; }],
]) {
  test(`snapshot refuses ${name} instead of adopting partial/empty inventory`, async (t) => {
    const value = snapshot();
    mutate(value);
    const { client } = await fixture(t, { snapshot: value });
    await assert.rejects(client.getTargetCatalogSnapshot(), { code: "invalid_response" });
  });
}

test("snapshot rejects cross-provider duplicate target identities and missing or unexpected provider sets", async (t) => {
  const value = snapshot();
  value.providers.push({ provider: provider("second"), targets: [observation("target-0", "second")] });
  assert.throws(() => targetCatalogSnapshot(value), { code: "invalid_response" });
  const { client } = await fixture(t, { snapshot: { ...snapshot(), providers: [] } });
  await assert.rejects(client.getTargetCatalogSnapshot(), { code: "provider_identity_mismatch" });
});

test("snapshot provider/target counts accept exact bounds and refuse excess without truncation", () => {
  const value = {
    ...snapshot(), providers: Array.from({ length: 128 }, (_, index) => ({ provider: provider(`provider-${index}`), targets: [] })),
  };
  targetCatalogSnapshot(value);
  value.providers.push({ provider: provider("extra"), targets: [] });
  assert.throws(() => targetCatalogSnapshot(value), { code: "invalid_response" });
  const targets = snapshot();
  targets.providers[0].targets = Array.from({ length: 4096 }, (_, index) => observation(`bounded-${index}`));
  targetCatalogSnapshot(targets);
  targets.providers.push({ provider: provider("second"), targets: [observation("extra", "second")] });
  assert.throws(() => targetCatalogSnapshot(targets), { code: "invalid_response" });
});

test("one provider failure and caller cancellation fail the entire read without fallback, mutation or owner substitution", async (t) => {
  const failed = await fixture(t, { read() { throw new AilohaProtocolError("http_error", { status: 503 }); } });
  await assert.rejects(failed.client.getTargetCatalogSnapshot(), { status: 503 });
  let observed;
  const cancelled = await fixture(t, { read(_path, request) {
    observed = request.signal;
    return new Promise((_, reject) => request.signal.addEventListener("abort",
      () => reject(new AilohaProtocolError("cancelled")), { once: true }));
  } });
  const caller = new AbortController();
  const work = cancelled.client.getTargetCatalogSnapshot({ signal: caller.signal });
  const rejected = assert.rejects(work, { code: "cancelled" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(observed);
  caller.abort();
  await rejected;
  for (const { calls } of [failed, cancelled]) {
    assert.ok(calls.every((call) => call.request.method === "GET"));
    assert.equal(calls.some((call) => /^\/api\/v1\/targets/.test(call.path)), false);
  }
});
