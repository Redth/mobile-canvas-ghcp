import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { inspect } from "node:util";
import test from "node:test";
import {
  AilohaProtocolError,
  TARGET_HOST_PROFILE,
  connectTargetHost,
} from "../../lib/ailoha/index.mjs";

const credential = "synthetic-mobile-canvas-control_X/+==";
const hostId = "fixture-host:one/selected";
const providerId = "provider/android %2F+";
const targetId = "target:/\u8bbe\u5907 ?#%2F+";

function statusFixture() {
  return {
    profile: TARGET_HOST_PROFILE,
    hostId,
    version: "test-only",
    state: "ready",
    capabilities: [{ id: "surface.capture", version: 1, features: ["captureTargetScreenshot"] }],
  };
}

function providerFixture(state = "ready") {
  return {
    providerId,
    name: "Fixture provider",
    version: "test-only",
    state,
    capabilities: [],
    description: "A fake provider; no platform SDK required.",
  };
}

function surfaceFixture() {
  return {
    surfaceId: "display/main",
    kind: "display",
    bounds: { x: -10, y: 0, width: 200, height: 400 },
    geometryRevision: 0,
    capabilities: [
      { id: "surface.input", version: 1, features: ["tap.point", "text"] },
      { id: "surface.ui", version: 1, features: ["snapshot"] },
    ],
    name: "Fixture screen",
    pixelDensity: 2,
    orientation: "portrait",
  };
}

function targetFixture() {
  return {
    targetId,
    providerId,
    targetTypeId: "fixture-phone",
    status: "running",
    surfaces: [surfaceFixture()],
    runtimeId: "runtime/fixture",
    templateId: "template:fixture",
    name: "Fixture device",
    createdAt: null,
    updatedAt: "2026-10-09T11:23:10.047-04:00",
    labels: { "ailoha.native/id": "fixture_avd", "fixture/empty": "" },
    nativeIdentity: {
      platform: "android",
      nativeId: "fixture_avd",
      serial: "emulator-5566",
      provider: "emulator",
      modelIdentifier: "Fixture phone",
      osVersion: "fixture",
      isVirtual: true,
    },
  };
}

function problemFixture(status = 404) {
  return {
    type: "about:blank",
    title: "Fixture problem",
    status,
    detail: "The requested target is unavailable.",
    errorCode: "unsupported-capability",
    "x-ailoha-target-host": { targetId, geometryRevision: 3 },
    trace: { id: "fixture-trace", retryable: false },
  };
}

function json(response, value, status = 200, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": status === 200 ? "application/json" : "application/problem+json",
    "content-length": body.length,
    ...headers,
  });
  response.end(body);
}

async function host(t, handler, { status = statusFixture(), hostname = "127.0.0.1" } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      origin: request.headers.origin,
      authority: request.headers.host,
      acceptEncoding: request.headers["accept-encoding"],
    });
    if (request.url === "/api/v1/host/status") {
      if (typeof status === "function") status(request, response);
      else json(response, status);
      return;
    }
    if (handler) handler(request, response);
    else json(response, problemFixture(), 404);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, hostname, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const authority = hostname === "::1" ? `[::1]:${server.address().port}` : `${hostname}:${server.address().port}`;
  const origin = `http://${authority}`;
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  return {
    server,
    requests,
    origin,
    authority,
    connection: { origin, hostId, profile: TARGET_HOST_PROFILE, controlCredential: credential },
    async connect(options) {
      const client = await connectTargetHost(this.connection, options);
      t.after(() => client.dispose());
      return client;
    },
  };
}

function safeError(error, code, status) {
  assert.ok(error instanceof AilohaProtocolError);
  assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  for (const output of [error.message, error.stack, inspect(error), JSON.stringify(error)]) {
    assert.equal(output.includes(credential), false);
    assert.equal(output.includes(encodeURIComponent(credential)), false);
  }
  assert.equal(Object.hasOwn(error, "cause"), false);
  return true;
}

function rejects(promise, code, status) {
  return assert.rejects(promise, (error) => safeError(error, code, status));
}

test("authenticates and verifies status before exposing the fixed read API", async (t) => {
  const route = `/api/v1/targets/${encodeURIComponent(targetId)}`;
  const fixture = await host(t, (request, response) => {
    const results = {
      "/api/v1/providers": [providerFixture("unavailable"), { ...providerFixture(), providerId: "other" }],
      "/api/v1/targets": [targetFixture()],
      [route]: targetFixture(),
      [`${route}/capabilities`]: statusFixture().capabilities,
      [`${route}/surfaces`]: [surfaceFixture()],
    };
    assert.ok(Object.hasOwn(results, request.url), `unexpected route ${request.url}`);
    json(response, results[request.url]);
  });
  const client = await fixture.connect();
  assert.deepEqual(fixture.requests.map((request) => request.url), ["/api/v1/host/status"]);
  assert.deepEqual(await client.getHostStatus(), statusFixture());
  const providers = await client.listProviders();
  assert.equal(providers.length, 2);
  assert.equal(providers[0].state, "unavailable");
  assert.deepEqual(await client.listTargets(), [targetFixture()]);
  assert.deepEqual(await client.getTarget(targetId), targetFixture());
  assert.deepEqual(await client.getTargetCapabilities(targetId), statusFixture().capabilities);
  assert.deepEqual(await client.listTargetSurfaces(targetId), [surfaceFixture()]);
  for (const request of fixture.requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.authorization, `Bearer ${credential}`);
    assert.equal(request.origin, fixture.origin);
    assert.equal(request.authority, fixture.authority);
    assert.equal(request.acceptEncoding, "identity");
    assert.equal(request.url.includes(credential), false);
    assert.equal(request.url.includes(encodeURIComponent(credential)), false);
    assert.equal(request.url.includes("providers/"), false);
  }
  assert.equal(client.request, undefined);
  assert.equal(client.getJson, undefined);
  assert.equal(client.controlCredential, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(client)), {
    origin: fixture.origin, hostId, profile: TARGET_HOST_PROFILE,
  });
  assert.equal(inspect(client).includes(credential), false);
  assert.ok(Object.isFrozen(client.connection));
});

test("accepts literal IPv6 loopback with its own authority and Origin", async (t) => {
  const fixture = await host(t, (_request, response) => json(response, []), { hostname: "::1" });
  const client = await fixture.connect();
  assert.deepEqual(await client.listProviders(), []);
  assert.equal(fixture.requests[0].authority, fixture.authority);
  assert.equal(fixture.requests[0].origin, fixture.origin);
});

test("encodes opaque target IDs exactly once without filename restrictions", async (t) => {
  let selected;
  const fixture = await host(t, (request, response) => {
    assert.equal(request.url, `/api/v1/targets/${encodeURIComponent(selected)}`);
    json(response, { ...targetFixture(), targetId: selected });
  });
  const client = await fixture.connect();
  for (const id of [targetId, "a/b", "%2e%2e/%2F", "../another?x=#fragment", "c:\\device", "...", "space id"]) {
    selected = id;
    assert.equal((await client.getTarget(id)).targetId, id);
  }
});

test("encodes provenance filters and snapshots mutable caller options", async (t) => {
  const fixture = await host(t, (request, response) => {
    const url = new URL(request.url, fixture.origin);
    assert.equal(url.pathname, "/api/v1/targets");
    assert.equal(url.searchParams.get("providerId"), providerId);
    assert.equal(url.searchParams.get("status"), "running");
    json(response, [targetFixture()]);
  });
  const client = await fixture.connect();
  const options = { providerId, status: "running" };
  const pending = client.listTargets(options);
  options.providerId = "changed-provider";
  options.status = "stopped";
  assert.deepEqual(await pending, [targetFixture()]);
});

test("accepts valid empty inventories and preserves optional field omission", async (t) => {
  const minimal = {
    targetId, providerId, targetTypeId: "fixture", status: "stopped", surfaces: [],
  };
  const fixture = await host(t, (request, response) => {
    json(response, request.url.endsWith(encodeURIComponent(targetId)) ? minimal : []);
  });
  const client = await fixture.connect();
  assert.deepEqual(await client.listProviders(), []);
  assert.deepEqual(await client.listTargets(), []);
  assert.deepEqual(await client.getTargetCapabilities(targetId), []);
  assert.deepEqual(await client.listTargetSurfaces(targetId), []);
  assert.deepEqual(await client.getTarget(targetId), minimal);
});

test("keeps surface feature names distinct and honors uint32 geometry bounds", async (t) => {
  const surface = surfaceFixture();
  surface.geometryRevision = 0xffff_ffff;
  surface.bounds.coordinate = "screen";
  const fixture = await host(t, (_request, response) => json(response, [surface]));
  const client = await fixture.connect();
  const result = await client.listTargetSurfaces(targetId);
  assert.deepEqual(result[0].capabilities[0].features, ["tap.point", "text"]);
  assert.equal(result[0].geometryRevision, 0xffff_ffff);
  assert.equal(result[0].bounds.coordinate, "screen");
});

test("preserves versioned capability descriptors without inventing collection uniqueness rules", async (t) => {
  const capabilities = [
    { id: "surface.capture", version: 1, features: ["captureTargetScreenshot"] },
    { id: "surface.capture", version: 2 },
  ];
  const fixture = await host(t, (_request, response) => json(response, capabilities), {
    status: { ...statusFixture(), capabilities },
  });
  const client = await fixture.connect();
  assert.deepEqual((await client.getHostStatus()).capabilities, capabilities);
  assert.deepEqual(await client.getTargetCapabilities(targetId), capabilities);
});

test("rejects unsafe origins and connections before sending any request", async (t) => {
  const fixture = await host(t);
  for (const origin of [
    "https://127.0.0.1:1234", "http://localhost:1234", "http://127.1:1234",
    "http://127.0.0.2:1234", "http://2130706433:1234", "http://example.com:1234",
    "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:65536",
    "http://127.0.0.1:01234", `${fixture.origin}/`, `${fixture.origin}/api/v1`,
    `${fixture.origin}?token=${credential}`, `${fixture.origin}#fragment`,
    `http://user:${credential}@127.0.0.1:1234`, "http://[::ffff:127.0.0.1]:1234",
  ]) {
    await rejects(connectTargetHost({ ...fixture.connection, origin }), "invalid_connection");
  }
  for (const change of [
    { hostId: "." }, { hostId: ".." }, { hostId: "" }, { hostId: credential },
    { controlCredential: "" }, { controlCredential: "bad\nheader" },
    { controlCredential: "contains space" }, { controlCredential: "\u00e9" },
    { controlCredential: "x".repeat(4097) }, { origin: undefined }, { url: fixture.origin },
  ]) {
    await rejects(connectTargetHost({ ...fixture.connection, ...change }), "invalid_connection");
  }
  await rejects(connectTargetHost({ ...fixture.connection, profile: "other/v1" }), "incompatible_profile");
  await rejects(connectTargetHost(null), "invalid_connection");
  await rejects(connectTargetHost(), "invalid_connection");
  await rejects(connectTargetHost([fixture.connection]), "invalid_connection");
  await rejects(connectTargetHost([fixture.connection, fixture.connection]), "invalid_connection");
  assert.equal(fixture.requests.length, 0);
});

test("captures the selected connection rather than retaining mutable caller configuration", async (t) => {
  const destination = await host(t);
  const fixture = await host(t, (_request, response) => json(response, []));
  const connection = { ...fixture.connection };
  const client = await connectTargetHost(connection);
  t.after(() => client.dispose());
  connection.origin = destination.origin;
  connection.hostId = "changed-host";
  connection.controlCredential = "changed-credential";
  assert.deepEqual(await client.listTargets(), []);
  assert.deepEqual(await client.getHostStatus(), statusFixture());
  assert.equal(destination.requests.length, 0);
  assert.ok(fixture.requests.every((request) => request.authorization === `Bearer ${credential}`));
});

test("reads a host-side connection credential once when capturing its identity", async (t) => {
  const fixture = await host(t, (_request, response) => json(response, []));
  let reads = 0;
  const connection = {
    ...fixture.connection,
    get controlCredential() {
      reads += 1;
      return reads === 1 ? credential : "rotated-credential";
    },
  };
  const client = await connectTargetHost(connection);
  t.after(() => client.dispose());
  assert.deepEqual(await client.listProviders(), []);
  assert.equal(reads, 1);
  assert.ok(fixture.requests.every((request) => request.authorization === `Bearer ${credential}`));
});

test("rejects stale host identity, wrong profile and malformed authenticated status", async (t) => {
  for (const [status, code] of [
    [{ ...statusFixture(), hostId: "different-host" }, "host_identity_mismatch"],
    [{ ...statusFixture(), profile: "other/v1" }, "incompatible_profile"],
    [{ ...statusFixture(), state: "booted" }, "invalid_response"],
    [{ ...statusFixture(), capabilities: {} }, "invalid_response"],
    [{ ...statusFixture(), version: "" }, "invalid_response"],
    [{ hostId }, "invalid_response"],
  ]) {
    const fixture = await host(t, undefined, { status });
    await rejects(fixture.connect(), code, 200);
    assert.deepEqual(fixture.requests.map((request) => request.url), ["/api/v1/host/status"]);
  }
});

test("rejects invalid read options and secret identifiers without touching the host", async (t) => {
  const fixture = await host(t);
  const client = await fixture.connect();
  for (const id of ["", ".", "..", "\n", "\ud800", null, 42, credential, encodeURIComponent(credential)]) {
    await rejects(client.getTarget(id), "invalid_identifier");
    await rejects(client.getTargetCapabilities(id), "invalid_identifier");
    await rejects(client.listTargetSurfaces(id), "invalid_identifier");
  }
  for (const options of [
    null, [], { origin: "http://example.com:1234" }, { path: "/api/v1/host/actions/stop" },
    { headers: { Authorization: credential } }, { signal: {} }, { signal: null },
  ]) {
    await rejects(client.listProviders(options), "invalid_options");
  }
  await rejects(client.listTargets({ status: "booted" }), "invalid_options");
  await rejects(client.listTargets({ providerId: ".." }), "invalid_identifier");
  for (const options of [
    { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 60_001 },
    { timeoutMs: null }, { maxResponseBytes: 0 }, { maxResponseBytes: 8 * 1024 * 1024 + 1 },
    { maxResponseBytes: null }, { maxResponseBytes: 1.5 }, { signal: {} }, { fetch: () => {} },
  ]) {
    await rejects(connectTargetHost(fixture.connection, options), "invalid_options");
  }
  assert.equal(fixture.requests.length, 1);
});

test("rejects wrong envelopes, required fields, duplicate identities and invalid resource values", async (t) => {
  const cases = [
    ["listProviders", { providers: [] }],
    ["listTargets", { targets: [] }],
    ["getTargetCapabilities", { capabilities: [] }],
    ["listTargetSurfaces", { surfaces: [] }],
    ["getTarget", { target: targetFixture() }],
    ["listProviders", [{ ...providerFixture(), name: "" }]],
    ["listProviders", [{ ...providerFixture(), state: "running" }]],
    ["listProviders", [providerFixture(), providerFixture()]],
    ["listTargets", [{ ...targetFixture(), status: "booted" }]],
    ["listTargets", [{ ...targetFixture(), nativeIdentity: { platform: "android" } }]],
    ["listTargets", [{ ...targetFixture(), labels: { bad: 1 } }]],
    ["listTargets", [{ ...targetFixture(), updatedAt: "yesterday" }]],
    ["listTargets", [{ ...targetFixture(), updatedAt: "2026-02-30T00:00:00Z" }]],
    ["listTargets", [{ ...targetFixture(), updatedAt: "2026-01-01T24:00:00Z" }]],
    ["listTargets", [{ ...targetFixture(), createdAt: 0 }]],
    ["listTargets", [{ ...targetFixture(), extra: true }]],
    ["listTargets", [targetFixture(), targetFixture()]],
    ["getTargetCapabilities", [{ id: "surface.capture", version: 0 }]],
    ["getTargetCapabilities", [{ id: "surface.capture", version: 1.5 }]],
    ["getTargetCapabilities", [{ id: "surface.capture", version: 1, features: ["same", "same"] }]],
    ["getTargetCapabilities", [{ id: "surface.capture", version: 1, features: [1] }]],
    ["listTargetSurfaces", [{ ...surfaceFixture(), bounds: { x: 0, y: 0, width: -1, height: 1 } }]],
    ["listTargetSurfaces", [{ ...surfaceFixture(), bounds: { x: 0, y: 0, width: 1 } }]],
    ["listTargetSurfaces", [{ ...surfaceFixture(), geometryRevision: -1 }]],
    ["listTargetSurfaces", [{ ...surfaceFixture(), geometryRevision: 0x1_0000_0000 }]],
    ["listTargetSurfaces", [{ ...surfaceFixture(), geometryRevision: 1.5 }]],
    ["listTargetSurfaces", [{ ...surfaceFixture(), pixelDensity: 0 }]],
    ["listTargetSurfaces", [{ ...surfaceFixture(), bounds: { ...surfaceFixture().bounds, coordinate: "logical" } }]],
  ];
  let body;
  const fixture = await host(t, (_request, response) => json(response, body));
  const client = await fixture.connect();
  for (const [method, value] of cases) {
    body = value;
    const options = ["listProviders", "listTargets"].includes(method) ? [] : [targetId];
    await rejects(client[method](...options), "invalid_response", 200);
  }
  body = { ...targetFixture(), targetId: "different-target" };
  await rejects(client.getTarget(targetId), "target_identity_mismatch", 200);
  body = [targetFixture()];
  await rejects(client.listTargets({ providerId: "other-provider" }), "invalid_response", 200);
});

test("preserves sanitized Problem Details, contexts and unknown extensions", async (t) => {
  const problem = {
    ...problemFixture(409),
    instance: `/requests/${encodeURIComponent(credential)}`,
    detail: `Bearer ${credential}; encoded ${encodeURIComponent(credential)}`,
    authorization: `Bearer ${credential}`,
    controlCredential: credential,
    unknown: { secret: credential, public: [1, true, null, { note: "preserved" }] },
  };
  const fixture = await host(t, (_request, response) => json(response, problem, 409));
  const client = await fixture.connect();
  await assert.rejects(client.getTarget(targetId), (error) => {
    safeError(error, "http_error", 409);
    assert.equal(error.problem.errorCode, "unsupported-capability");
    assert.equal(error.problem.detail, "Bearer [REDACTED]; encoded [REDACTED]");
    assert.equal(error.problem.instance, "/requests/[REDACTED]");
    assert.equal(error.problem.controlCredential, "[REDACTED]");
    assert.equal(error.problem.authorization, "[REDACTED]");
    assert.deepEqual(error.problem["x-ailoha-target-host"], problem["x-ailoha-target-host"]);
    assert.deepEqual(error.problem.trace, problem.trace);
    assert.deepEqual(error.problem.unknown.public, problem.unknown.public);
    assert.ok(Object.isFrozen(error.problem));
    assert.ok(Object.isFrozen(error.problem.unknown.public));
    return true;
  });
});

test("returns auth and unsupported failures explicitly without retry or fallback", async (t) => {
  let status = 401;
  const fixture = await host(t, (_request, response) => json(
    response, problemFixture(status), status, { "www-authenticate": "Bearer" },
  ));
  const client = await fixture.connect();
  for (const code of [401, 403, 404, 500, 501]) {
    status = code;
    await rejects(client.listTargets(), "http_error", code);
  }
  assert.equal(fixture.requests.length, 6);
  assert.ok(fixture.requests.every((request) => request.url.startsWith("/api/v1/")));
});

test("refuses redirects before reading or contacting any destination", async (t) => {
  const destination = await host(t, (_request, response) => json(response, []));
  let location = `${destination.origin}/capture-credential`;
  const fixture = await host(t, (_request, response) => {
    response.writeHead(302, { location });
    response.end();
  });
  const client = await fixture.connect();
  for (const url of [`${destination.origin}/capture-credential`, "/api/v1/providers",
    `http://example.com/${credential}`]) {
    location = url;
    await rejects(client.listProviders(), "redirect_rejected", 302);
  }
  assert.equal(destination.requests.length, 0);
});

test("also refuses redirects during the authenticated connection handshake", async (t) => {
  const destination = await host(t);
  const fixture = await host(t, undefined, {
    status: (_request, response) => {
      response.writeHead(307, { location: `${destination.origin}/api/v1/host/status` });
      response.end();
    },
  });
  await rejects(fixture.connect(), "redirect_rejected", 307);
  assert.equal(destination.requests.length, 0);
});

test("rejects secret-bearing public resource values and fields instead of returning altered identities", async (t) => {
  let body;
  const fixture = await host(t, (_request, response) => json(response, body));
  const client = await fixture.connect();
  for (const value of [
    [{ ...providerFixture(), name: credential }],
    [{ ...providerFixture(), description: encodeURIComponent(credential) }],
    [{ ...providerFixture(), description: encodeURIComponent(credential).replace("%2F", "%2f") }],
    [{ ...providerFixture(), controlCredential: credential }],
    [{ ...providerFixture(), description: "public", credentials: "unrelated-private-data" }],
  ]) {
    body = value;
    await rejects(client.listProviders(), "credential_exposure", 200);
  }
  body = [{ ...targetFixture(), labels: { [credential]: "hidden in key" } }];
  await rejects(client.listTargets(), "credential_exposure", 200);
});

test("redacts mixed-case percent-encoded credentials in Problem Details without changing unrelated URIs", async (t) => {
  const encoded = encodeURIComponent(credential).replace("%2F", "%2f");
  const problem = { ...problemFixture(500), detail: encoded, documentation: "/help/%2funchanged" };
  const fixture = await host(t, (_request, response) => json(response, problem, 500));
  const client = await fixture.connect();
  await assert.rejects(client.listTargets(), (error) => {
    safeError(error, "http_error", 500);
    assert.equal(error.problem.detail, "[REDACTED]");
    assert.equal(error.problem.documentation, "/help/%2funchanged");
    return true;
  });
});

test("bounds response bytes exactly for declared and chunked bodies", async (t) => {
  const limit = 512;
  let count = limit;
  let chunked = false;
  const fixture = await host(t, (_request, response) => {
    const provider = { ...providerFixture(), description: "" };
    provider.description = "x".repeat(count - Buffer.byteLength(JSON.stringify([provider])));
    const body = JSON.stringify([provider]);
    assert.equal(Buffer.byteLength(body), count);
    response.writeHead(200, {
      "content-type": "application/json",
      ...(chunked ? {} : { "content-length": count }),
    });
    response.write(body.slice(0, 200));
    response.end(body.slice(200));
  });
  const client = await fixture.connect({ maxResponseBytes: limit });
  for (const mode of [false, true]) {
    chunked = mode;
    count = limit;
    assert.equal((await client.listProviders()).length, 1);
    count = limit + 1;
    await rejects(client.listProviders(), "response_too_large", 200);
  }
});

test("applies the same response bound to Problem Details and the handshake", async (t) => {
  const fixture = await host(t, (_request, response) => {
    json(response, { ...problemFixture(500), detail: credential.repeat(100) }, 500);
  });
  const client = await fixture.connect({ maxResponseBytes: 512 });
  await rejects(client.listTargets(), "response_too_large", 500);
  await rejects(fixture.connect({ maxResponseBytes: 1 }), "response_too_large", 200);
});

test("rejects invalid JSON, UTF-8, media types, encodings and unexpected success codes", async (t) => {
  let plan;
  const fixture = await host(t, (_request, response) => {
    response.writeHead(plan.status ?? 200, {
      "content-type": plan.type ?? "application/json", ...plan.headers,
    });
    response.end(plan.body);
  });
  const client = await fixture.connect();
  for (const value of [
    { body: "" }, { body: "{" }, { body: "null" }, { body: "{}" },
    { body: Buffer.from([0x22, 0xc3, 0x28, 0x22]) },
    { body: "[]", type: "text/html" },
    { body: "[]", headers: { "content-encoding": "gzip" } },
    { body: "[]", status: 202 },
    { body: "[]", status: 204 },
    { body: JSON.stringify({ ...problemFixture(500), status: 404 }), status: 500, type: "application/problem+json" },
    { body: JSON.stringify({ title: "broken" }), status: 500, type: "application/problem+json" },
    { body: "not JSON", status: 500, type: "application/problem+json" },
    { body: JSON.stringify(problemFixture(500)), status: 500, type: "application/json" },
  ]) {
    plan = value;
    await rejects(client.listProviders(), "invalid_response", plan.status ?? 200);
  }
});

test("enforces a whole-request timeout while a response keeps streaming", async (t) => {
  const fixture = await host(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("[");
    const interval = setInterval(() => response.write(" "), 5);
    response.once("close", () => clearInterval(interval));
  });
  const client = await fixture.connect({ timeoutMs: 80 });
  await rejects(client.listProviders(), "timeout");
});

test("bounds response headers and extensible nested response data", async (t) => {
  let mode = "headers";
  const fixture = await host(t, (_request, response) => {
    if (mode === "headers") {
      json(response, [], 200, { "x-oversized": "x".repeat(16 * 1024) });
      return;
    }
    let extension = "leaf";
    for (let depth = 0; depth < 65; depth += 1) extension = { child: extension };
    if (mode === "problem") {
      json(response, { ...problemFixture(500), extension }, 500);
    } else {
      const surface = surfaceFixture();
      surface.bounds.extension = extension;
      json(response, [surface]);
    }
  });
  const client = await fixture.connect();
  await rejects(client.listTargets(), "transport_error");
  mode = "problem";
  await rejects(client.listTargets(), "invalid_response", 500);
  mode = "surface";
  await rejects(client.listTargetSurfaces(targetId), "invalid_response", 200);
});

test("allows optional feature omission, Unicode native identities and valid calendar dates", async (t) => {
  const target = targetFixture();
  target.createdAt = "2024-02-29T00:00:00Z";
  target.nativeIdentity.nativeId = "\ud83d\ude00".repeat(256);
  target.surfaces[0].capabilities = [{ id: "surface.ui", version: 1 }];
  const fixture = await host(t, (_request, response) => json(response, target));
  const client = await fixture.connect();
  assert.deepEqual(await client.getTarget(targetId), target);
});

test("cancels and times out an unresponsive handshake without exposing a client", async (t) => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const fixture = await host(t, undefined, { status: () => started() });
  const controller = new AbortController();
  const pending = fixture.connect({ signal: controller.signal });
  await ready;
  controller.abort(credential);
  await rejects(pending, "cancelled");
  await rejects(fixture.connect({ timeoutMs: 80 }), "timeout");
});

test("cancels before connection, before a read, and during a streamed body without leaking reasons", async (t) => {
  let bodyStarted;
  const bodyReady = new Promise((resolve) => { bodyStarted = resolve; });
  const fixture = await host(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("[");
    bodyStarted();
  });
  const before = new AbortController();
  before.abort(new Error(credential));
  await rejects(fixture.connect({ signal: before.signal }), "cancelled");
  assert.equal(fixture.requests.length, 0);
  const client = await fixture.connect();
  await rejects(client.listTargets({ signal: before.signal }), "cancelled");
  assert.equal(fixture.requests.length, 1);
  const during = new AbortController();
  const pending = client.listProviders({ signal: during.signal });
  await bodyReady;
  during.abort({ privateReason: credential });
  await rejects(pending, "cancelled");
});

test("bounds concurrent reads and disposal cancels all without stopping the external host", async (t) => {
  const fixture = await host(t, () => {});
  const client = await fixture.connect({ timeoutMs: 1000 });
  const pending = Array.from({ length: 8 }, () => rejects(client.listProviders(), "client_disposed"));
  await rejects(client.listProviders(), "request_limit");
  client.dispose();
  client.dispose();
  await Promise.all(pending);
  await rejects(client.listTargets(), "client_disposed");
  const replacement = await fixture.connect();
  assert.deepEqual(await replacement.getHostStatus(), statusFixture());
  assert.equal(fixture.requests.some((request) => request.method !== "GET"), false);
});

test("surfaces connection refusal and truncated streams as sanitized transport errors", async (t) => {
  const fixture = await host(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-length": 1000 });
    response.write("[");
    response.flushHeaders();
    setImmediate(() => response.destroy());
  });
  const client = await fixture.connect();
  await rejects(client.listProviders(), "transport_error");
  const closed = await host(t);
  const connection = closed.connection;
  await new Promise((resolve) => closed.server.close(resolve));
  await rejects(connectTargetHost(connection), "transport_error");
});

test("does not forward credentials through HTTP proxy environment settings", async (t) => {
  const proxy = await host(t);
  const fixture = await host(t, (_request, response) => json(response, []));
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NODE_USE_ENV_PROXY"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = name === "NODE_USE_ENV_PROXY" ? "1" : proxy.origin;
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const client = await fixture.connect();
  assert.deepEqual(await client.listTargets(), []);
  assert.equal(proxy.requests.length, 0);
});

test("both product host import patterns return only resource DTOs across their renderer boundary", async (t) => {
  const vscodePath = new URL("../../vscode/dist/lib/ailoha/index.mjs", import.meta.url);
  const modules = [
    { name: "GitHub canvas", connectTargetHost },
    { name: "VS Code extension host", ...(await import(vscodePath.href)) },
  ];
  for (const module of modules) {
    const fixture = await host(t, (_request, response) => json(response, [targetFixture()]));
    const client = await module.connectTargetHost(fixture.connection);
    t.after(() => client.dispose());
    const action = { handler: () => client.listTargets() };
    const rendererMessages = [];
    const sink = { postMessage: (message) => rendererMessages.push(structuredClone(message)) };
    const result = await action.handler();
    sink.postMessage({ type: "inventory", targets: result });
    assert.deepEqual(rendererMessages, [{ type: "inventory", targets: [targetFixture()] }], module.name);
    assert.equal(JSON.stringify(rendererMessages).includes(credential), false);
    assert.equal(JSON.stringify(client).includes(credential), false);
  }
  for (const relative of ["index.mjs", "index.d.mts", "errors.mjs", "protocol.mjs"]) {
    assert.deepEqual(
      await readFile(new URL(`../../lib/ailoha/${relative}`, import.meta.url)),
      await readFile(new URL(`../../vscode/dist/lib/ailoha/${relative}`, import.meta.url)),
    );
  }
});
