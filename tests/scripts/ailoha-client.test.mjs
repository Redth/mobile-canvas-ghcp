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
const operationId = "operation:/\u8bbe\u5907 ?#%2F+!'()*";

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

function operationFixture(status = "queued", fields = {}) {
  return {
    operationId,
    kind: "startTarget",
    status,
    destructive: false,
    createdAt: "2026-10-09T16:41:31.013Z",
    targetId,
    providerId,
    ...fields,
  };
}

function json(response, value, status = 200, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": status >= 200 && status < 300 ? "application/json" : "application/problem+json",
    "content-length": body.length,
    ...headers,
  });
  response.end(body);
}

function accepted(response, value = operationFixture(), headers = {}) {
  json(response, value, 202, {
    location: `/api/v1/operations/${encodeURIComponent(value.operationId)}`,
    "retry-after": "1",
    ...headers,
  });
}

function receiveBody(request, callback) {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.once("end", () => callback(Buffer.concat(chunks).toString("utf8")));
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
      contentType: request.headers["content-type"],
      contentLength: request.headers["content-length"],
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

function safeError(error, code, status, ErrorType = AilohaProtocolError) {
  assert.ok(error instanceof ErrorType);
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

test("creates through the selected provider with exact fields and omitted/false/true start", async (t) => {
  const bodies = [];
  const fixture = await host(t, (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/v1/targets");
    assert.equal(request.headers["content-type"], "application/json");
    receiveBody(request, (body) => {
      assert.equal(Buffer.byteLength(body), Number(request.headers["content-length"]));
      bodies.push(JSON.parse(body));
      accepted(response, operationFixture("queued", { kind: "createTarget", destructive: true }));
    });
  });
  const client = await fixture.connect();
  const request = {
    providerId, targetTypeId: "phone/type ?#%2F+", runtimeId: "runtime:/opaque",
    templateId: "template:/opaque", name: "", labels: { empty: "", purpose: "fixture" },
    configuration: { nested: { number: 1, enabled: false }, items: [null, "value"] },
  };
  const pending = client.createTarget(request);
  request.configuration.nested.enabled = true;
  assert.equal((await pending).status, "queued");
  assert.equal((await client.createTarget({ providerId, targetTypeId: "fixture", start: false })).destructive, true);
  assert.equal((await client.createTarget({ providerId, targetTypeId: "fixture", start: true })).kind, "createTarget");
  assert.equal(Object.hasOwn(bodies[0], "start"), false);
  assert.deepEqual(bodies[0], {
    ...request, configuration: { nested: { number: 1, enabled: false }, items: [null, "value"] },
  });
  assert.deepEqual(bodies[1], { providerId, targetTypeId: "fixture", start: false });
  assert.deepEqual(bodies[2], { providerId, targetTypeId: "fixture", start: true });
  assert.equal(fixture.requests.length, 4);
  for (const entry of fixture.requests) {
    assert.equal(entry.authorization, `Bearer ${credential}`);
    assert.equal(entry.origin, fixture.origin);
    assert.equal(entry.authority, fixture.authority);
    assert.equal(entry.acceptEncoding, "identity");
  }
});

test("submits lifecycle verbs and optional bodies without parsing opaque target IDs", async (t) => {
  const observed = [];
  const selectedId = "provider/native-prefix:/../ ?#%2F+";
  const fixture = await host(t, (request, response) => {
    assert.equal(request.method, "POST");
    const action = request.url.slice(request.url.lastIndexOf("/") + 1);
    assert.equal(request.url, `/api/v1/targets/${encodeURIComponent(selectedId)}/actions/${action}`);
    receiveBody(request, (body) => {
      observed.push({ action, body });
      const input = body ? JSON.parse(body) : undefined;
      accepted(response, operationFixture("running", {
        targetId: selectedId, kind: `${action}Target`, destructive: action === "reset",
        ...(input?.requestId === undefined ? {} : { requestId: input.requestId }),
      }));
    });
  });
  const client = await fixture.connect();
  assert.equal((await client.startTarget(selectedId)).status, "running");
  await client.stopTarget(selectedId, { request: {} });
  await client.rebootTarget(selectedId, {
    request: { reason: "", options: { force: false }, requestId: "request:/opaque ?#" },
  });
  await client.resetTarget(selectedId, { confirmed: true, request: { reason: "fixture" } });
  assert.deepEqual(observed, [
    { action: "start", body: "" },
    { action: "stop", body: "{}" },
    { action: "reboot", body: JSON.stringify({ reason: "", options: { force: false }, requestId: "request:/opaque ?#" }) },
    { action: "reset", body: JSON.stringify({ reason: "fixture" }) },
  ]);
  assert.equal(observed.some(({ body }) => body.includes("confirmed")), false);
});

test("requires an own literal true confirmation for reset/delete before any network IO", async (t) => {
  const fixture = await host(t, (request, response) => {
    receiveBody(request, (body) => {
      assert.equal(body, "");
      accepted(response, operationFixture("queued", {
        kind: request.method === "DELETE" ? "deleteTarget" : "resetTarget", destructive: true,
      }));
    });
  });
  const client = await fixture.connect();
  for (const options of [
    undefined, {}, { confirmed: false }, { confirmed: 1 }, { confirmed: "true" },
    { confirmed: null }, Object.create({ confirmed: true }),
  ]) {
    await rejects(client.resetTarget(targetId, options), "confirmation_required");
    await rejects(client.deleteTarget(targetId, options), "confirmation_required");
  }
  for (const options of [null, [], { confirmation: true }, { confirmed: true, consent: true }]) {
    await rejects(client.resetTarget(targetId, options), "invalid_options");
    await rejects(client.deleteTarget(targetId, options), "invalid_options");
  }
  await rejects(client.resetTarget(targetId, { request: { confirmed: true } }), "confirmation_required");
  await rejects(client.deleteTarget(targetId, { confirmed: true, request: {} }), "invalid_options");
  assert.equal(fixture.requests.length, 1);
  assert.equal((await client.resetTarget(targetId, { confirmed: true })).destructive, true);
  assert.equal((await client.deleteTarget(targetId, { confirmed: true })).kind, "deleteTarget");
  assert.deepEqual(fixture.requests.slice(1).map(({ method, url }) => ({ method, url })), [
    { method: "POST", url: `/api/v1/targets/${encodeURIComponent(targetId)}/actions/reset` },
    { method: "DELETE", url: `/api/v1/targets/${encodeURIComponent(targetId)}` },
  ]);
});

test("rejects malformed, non-JSON, secret-bearing and oversized mutation input before IO", async (t) => {
  const fixture = await host(t);
  const client = await fixture.connect();
  const base = { providerId, targetTypeId: "fixture" };
  const cyclic = {};
  cyclic.self = cyclic;
  let nested = {};
  for (let depth = 0; depth < 65; depth += 1) nested = { child: nested };
  let accessorReads = 0;
  const accessor = { get value() { accessorReads += 1; return credential; } };
  for (const value of [
    null, [], {}, { ...base, providerId: "." }, { ...base, targetTypeId: "" },
    { ...base, runtimeId: ".." }, { ...base, templateId: 1 }, { ...base, name: false },
    { ...base, start: null }, { ...base, start: 0 }, { ...base, start: undefined },
    { ...base, labels: { count: 1 } }, { ...base, configuration: [] },
    { ...base, configuration: { invalid: Infinity } },
    { ...base, configuration: { invalid: 1n } },
    { ...base, configuration: { invalid: undefined } },
    { ...base, configuration: { invalid: () => "not JSON" } },
    { ...base, configuration: { invalid: new Date() } },
    { ...base, configuration: { invalid: Array(1) } },
    { ...base, configuration: { invalid: Object.assign(Array(1), { extra: "value" }) } },
    { ...base, configuration: accessor },
    { ...base, configuration: cyclic }, { ...base, configuration: nested },
    Object.defineProperty({ ...base }, "start", { value: false }),
    { ...base, unknown: true }, { ...base, confirmed: true },
  ]) {
    await rejects(client.createTarget(value), "invalid_request");
  }
  assert.equal(accessorReads, 0);
  for (const value of [
    { ...base, name: credential }, { ...base, providerId: encodeURIComponent(credential) },
    { ...base, labels: { authorization: "private" } },
    { ...base, configuration: { nested: { value: credential } } },
  ]) {
    await rejects(client.createTarget(value), "credential_exposure");
  }
  for (const request of [
    null, [], { reason: 1 }, { options: [] }, { requestId: "." }, { confirmed: true },
    { options: { invalid: NaN } },
  ]) {
    await rejects(client.startTarget(targetId, { request }), "invalid_request");
  }
  await rejects(client.stopTarget(targetId, { request: { reason: credential } }), "credential_exposure");
  await rejects(client.startTarget(targetId, { request: { reason: "x".repeat(64 * 1024) } }), "request_too_large");
  await rejects(client.createTarget({ ...base, name: "x".repeat(64 * 1024) }), "request_too_large");
  assert.equal(fixture.requests.length, 1);
});

test("bounds exact serialized request bytes including UTF-8 and JSON escaping", async (t) => {
  const bodies = [];
  const fixture = await host(t, (request, response) => {
    receiveBody(request, (body) => {
      bodies.push(Buffer.byteLength(body));
      assert.equal(Number(request.headers["content-length"]), bodies.at(-1));
      accepted(response, operationFixture("queued", { kind: "createTarget", destructive: true }));
    });
  });
  const client = await fixture.connect();
  const request = { providerId, targetTypeId: "fixture", name: "" };
  const remaining = 64 * 1024 - Buffer.byteLength(JSON.stringify(request));
  await client.createTarget({ ...request, name: "x".repeat(remaining) });
  await rejects(client.createTarget({ ...request, name: "x".repeat(remaining + 1) }), "request_too_large");
  await rejects(client.createTarget({ ...request, name: "\u00e9".repeat(remaining) }), "request_too_large");
  await rejects(client.createTarget({ ...request, name: "\"".repeat(remaining) }), "request_too_large");
  assert.deepEqual(bodies, [64 * 1024]);
});

test("rejects invalid mutation options and identifiers without contacting the host", async (t) => {
  const fixture = await host(t);
  const client = await fixture.connect();
  for (const id of ["", ".", "..", "\n", "\ud800", null, 1, credential, encodeURIComponent(credential)]) {
    await rejects(client.startTarget(id), "invalid_identifier");
    await rejects(client.stopTarget(id), "invalid_identifier");
    await rejects(client.rebootTarget(id), "invalid_identifier");
    await rejects(client.resetTarget(id, { confirmed: true }), "invalid_identifier");
    await rejects(client.deleteTarget(id, { confirmed: true }), "invalid_identifier");
    await rejects(client.getOperation(id), "invalid_identifier");
    await rejects(client.cancelOperation(id), "invalid_identifier");
    await rejects(client.waitForOperation(id), "invalid_identifier");
  }
  for (const options of [null, [], { signal: {} }, { headers: {} }, { origin: "http://example.com" }]) {
    await rejects(client.createTarget({ providerId, targetTypeId: "fixture" }, options), "invalid_options");
    await rejects(client.startTarget(targetId, options), "invalid_options");
    await rejects(client.cancelOperation(operationId, options), "invalid_options");
    await rejects(client.getOperation(operationId, options), "invalid_options");
    await rejects(client.listOperations(options), "invalid_options");
    await rejects(client.waitForOperation(operationId, options), "invalid_options");
  }
  for (const options of [
    { timeoutMs: null }, { timeoutMs: 0 }, { timeoutMs: 60_001 }, { timeoutMs: Infinity },
    { pollIntervalMs: null }, { pollIntervalMs: 0 }, { pollIntervalMs: 1.5 }, { pollIntervalMs: 60_001 },
  ]) {
    await rejects(client.waitForOperation(operationId, options), "invalid_options");
  }
  await rejects(client.listOperations({ status: "accepted" }), "invalid_options");
  await rejects(client.listOperations({ targetId: ".." }), "invalid_identifier");
  assert.equal(fixture.requests.length, 1);
});

test("validates accepted operation and same-origin Location identity without following it", async (t) => {
  const destination = await host(t);
  let body = operationFixture();
  let location;
  const fixture = await host(t, (_request, response) => {
    if (location === undefined) json(response, body, 202, { "retry-after": "1" });
    else accepted(response, body, { location });
  });
  const client = await fixture.connect();
  const encoded = encodeURIComponent(operationId).replace(/[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  for (const path of [
    `/api/v1/operations/${encodeURIComponent(operationId)}`,
    `/api/v1/operations/${encoded}`,
    `${fixture.origin}/api/v1/operations/${encoded}`,
  ]) {
    location = path;
    assert.equal((await client.startTarget(targetId)).operationId, operationId);
  }
  for (const path of [
    undefined, "", "/api/v1/operations/other", `${destination.origin}/api/v1/operations/${encoded}`,
    `//127.0.0.1:${destination.server.address().port}/api/v1/operations/${encoded}`,
    `/api/v1/operations/${encoded}?next=1`, `/api/v1/operations/${encoded}#fragment`,
    "/api/v1/operations/%zz", "/api/v1/operations/..", "/api/v1/operations/native/id",
    `/api/v1/operations/${encodeURIComponent(credential)}`,
  ]) {
    location = path;
    await rejects(client.startTarget(targetId), "operation_identity_mismatch", 202);
  }
  location = `/api/v1/operations/${encoded}`;
  for (const fields of [
    { operationId: "wrong-operation" }, { kind: "stopTarget" }, { destructive: true },
    { targetId: "wrong-target" },
  ]) {
    body = operationFixture("queued", fields);
    await assert.rejects(client.startTarget(targetId), (error) => {
      safeError(error, "operation_identity_mismatch", 202);
      assert.ok(error.operationId);
      assert.equal(error.operation.operationId, body.operationId);
      return true;
    });
  }
  body = operationFixture("queued", { kind: "createTarget", destructive: true, providerId: "other" });
  await rejects(client.createTarget({ providerId, targetTypeId: "fixture" }), "operation_identity_mismatch", 202);
  body = operationFixture("queued", { requestId: "wrong-request" });
  await rejects(client.startTarget(targetId, { request: { requestId: "requested" } }), "operation_identity_mismatch", 202);
  assert.equal(destination.requests.length, 0);
});

test("preserves optional operation omission and permits already terminal accepted bodies", async (t) => {
  let body = {
    operationId, kind: "startTarget", status: "queued", destructive: false,
    createdAt: "2026-10-09T16:41:31Z",
  };
  const fixture = await host(t, (_request, response) => accepted(response, body));
  const client = await fixture.connect();
  assert.deepEqual(await client.startTarget(targetId), body);
  assert.equal(Object.hasOwn(body, "cancelRequested"), false);
  for (const status of ["succeeded", "failed", "cancelled"]) {
    body = { ...body, status };
    assert.equal((await client.startTarget(targetId)).status, status);
  }
  assert.equal(fixture.requests.filter(({ method }) => method === "GET").length, 1);
});

test("reads and filters operation arrays while preserving extensible kinds and all DTO fields", async (t) => {
  const descriptor = operationFixture("running", {
    kind: "provider.custom-operation/v2", requestId: "request/one", progress: 0.5,
    startedAt: "2026-10-09T16:42:00Z", completedAt: "2026-10-09T16:43:00+00:00",
    result: { nested: { preserved: [false, null, 1] }, targetId },
    artifactIds: ["artifact/one", "artifact/one"], cancelRequested: false,
    cancellationProblem: problemFixture(501), cleanupProblem: problemFixture(500),
  });
  let empty = false;
  const fixture = await host(t, (request, response) => {
    const url = new URL(request.url, fixture.origin);
    assert.equal(request.method, "GET");
    if (url.pathname === "/api/v1/operations") {
      assert.equal(url.searchParams.get("targetId"), targetId);
      assert.equal(url.searchParams.get("status"), "running");
      json(response, empty ? [] : [descriptor]);
    } else {
      assert.equal(request.url, `/api/v1/operations/${encodeURIComponent(operationId)}`);
      json(response, descriptor);
    }
  });
  const client = await fixture.connect();
  const options = { targetId, status: "running" };
  const pending = client.listOperations(options);
  options.targetId = "changed";
  options.status = "failed";
  assert.deepEqual(await pending, [descriptor]);
  assert.deepEqual(await client.getOperation(operationId), descriptor);
  empty = true;
  assert.deepEqual(await client.listOperations({ targetId, status: "running" }), []);
});

test("encodes operation IDs exactly once for reads, cancellation, and explicit waits", async (t) => {
  let selected;
  const fixture = await host(t, (request, response) => {
    assert.equal(request.url, `/api/v1/operations/${encodeURIComponent(selected)}`);
    const descriptor = operationFixture(request.method === "DELETE" ? "cancelling" : "succeeded", {
      operationId: selected, cancelRequested: true,
    });
    if (request.method === "DELETE") accepted(response, descriptor);
    else {
      assert.equal(request.method, "GET");
      json(response, descriptor);
    }
  });
  const client = await fixture.connect();
  for (const id of [operationId, "a/b", "%2e%2e/%2F", "../another?x=#fragment", "c:\\operation", "...", "space id"]) {
    selected = id;
    assert.equal((await client.getOperation(id)).operationId, id);
    assert.equal((await client.cancelOperation(id)).operationId, id);
    assert.equal((await client.waitForOperation(id)).operationId, id);
  }
});

test("enforces exact depth 64/65 across requests, operation results, and nested problems", async (t) => {
  const nest = (depth) => {
    let value = "leaf";
    for (let level = 0; level < depth; level += 1) value = { child: value };
    return value;
  };
  let descriptor = operationFixture();
  const fixture = await host(t, (request, response) => {
    if (request.method === "POST") {
      accepted(response, operationFixture("queued", { kind: "createTarget", destructive: true }));
    } else {
      json(response, request.url === "/api/v1/operations" ? [descriptor] : descriptor);
    }
  });
  const client = await fixture.connect();
  const create = { providerId, targetTypeId: "fixture", start: false };
  assert.equal((await client.createTarget({ ...create, configuration: { nested: nest(62) } })).status, "queued");
  const before = fixture.requests.length;
  await rejects(client.createTarget({ ...create, configuration: { nested: nest(63) } }), "invalid_request");
  assert.equal(fixture.requests.length, before);
  for (const key of ["result", "problem", "cancellationProblem", "cleanupProblem"]) {
    const fields = key === "result" ? {} : problemFixture(500);
    descriptor = operationFixture("running", { [key]: { ...fields, nested: nest(62) } });
    assert.equal((await client.getOperation(operationId)).status, "running");
    await rejects(client.listOperations(), "invalid_response", 200);
    descriptor = operationFixture("running", { [key]: { ...fields, nested: nest(61) } });
    assert.equal((await client.listOperations()).length, 1);
    descriptor = operationFixture("running", { [key]: { ...fields, nested: nest(63) } });
    await rejects(client.getOperation(operationId), "invalid_response", 200);
  }
});

test("rejects malformed operations, list envelopes, duplicate IDs, and mismatched filters", async (t) => {
  let body;
  const fixture = await host(t, (_request, response) => json(response, body));
  const client = await fixture.connect();
  for (const value of [
    null, [], {}, { operation: operationFixture() },
    { ...operationFixture(), operationId: "." }, { ...operationFixture(), kind: "" },
    { ...operationFixture(), status: "accepted" }, { ...operationFixture(), destructive: 1 },
    { ...operationFixture(), createdAt: "2026-02-30T00:00:00Z" },
    { ...operationFixture(), startedAt: null }, { ...operationFixture(), completedAt: false },
    { ...operationFixture(), progress: -0.1 }, { ...operationFixture(), progress: 1.1 },
    { ...operationFixture(), result: [] }, { ...operationFixture(), artifactIds: ["."] },
    { ...operationFixture(), cancelRequested: "true" }, { ...operationFixture(), unknown: true },
    { ...operationFixture(), problem: { status: 500 } },
    { ...operationFixture(), cancellationProblem: { ...problemFixture(500), status: 0 } },
    { ...operationFixture(), cleanupProblem: null },
  ]) {
    body = value;
    await rejects(client.getOperation(operationId), "invalid_response", 200);
  }
  for (const value of [
    { operations: [] }, [operationFixture(), operationFixture()],
    [operationFixture("running", { targetId: "other-target" })],
    [operationFixture("failed")],
  ]) {
    body = value;
    await rejects(client.listOperations({ targetId, status: "running" }), "invalid_response", 200);
  }
  body = operationFixture("queued", { operationId: "wrong" });
  await assert.rejects(client.getOperation(operationId), (error) => {
    safeError(error, "operation_identity_mismatch", 200);
    assert.equal(error.operationId, operationId);
    return true;
  });
  for (const progress of [0, 1]) {
    body = operationFixture("running", { progress });
    assert.equal((await client.getOperation(operationId)).progress, progress);
  }
});

test("mutation failures retain sanitized Problem Details, auth, and unsupported evidence without fallback", async (t) => {
  let status = 401;
  const problem = (code) => ({
    ...problemFixture(code),
    type: "urn:devflow:error:unsupported-capability",
    detail: `${credential}; ${encodeURIComponent(credential)}`,
    authorization: `Bearer ${credential}`, controlCredential: credential,
    extension: { value: credential, stable: false },
  });
  const fixture = await host(t, (_request, response) => json(response, problem(status), status));
  const client = await fixture.connect();
  const calls = [
    () => client.createTarget({ providerId, targetTypeId: "fixture" }),
    () => client.startTarget(targetId),
    () => client.stopTarget(targetId),
    () => client.rebootTarget(targetId),
    () => client.resetTarget(targetId, { confirmed: true }),
    () => client.deleteTarget(targetId, { confirmed: true }),
    () => client.cancelOperation(operationId),
  ];
  for (const code of [401, 403, 404, 409, 500, 501]) {
    status = code;
    for (const call of calls) {
      await assert.rejects(call(), (error) => {
        safeError(error, "http_error", code);
        assert.equal(error.problem.detail, "[REDACTED]; [REDACTED]");
        assert.equal(error.problem.authorization, "[REDACTED]");
        assert.equal(error.problem.controlCredential, "[REDACTED]");
        assert.deepEqual(error.problem.extension, { value: "[REDACTED]", stable: false });
        assert.equal(error.problem.errorCode, "unsupported-capability");
        assert.equal(error.problem.type, "urn:devflow:error:unsupported-capability");
        assert.equal(Object.isFrozen(error.problem.extension), true);
        return true;
      });
    }
  }
  assert.equal(fixture.requests.length, 1 + calls.length * 6);
  assert.ok(fixture.requests.every(({ url }) => url.startsWith("/api/v1/")));
  assert.ok(fixture.requests.every(({ authorization, origin, authority }) =>
    authorization === `Bearer ${credential}` && origin === fixture.origin && authority === fixture.authority));
});

test("redacts nested operation problems but refuses protected result or identity fields", async (t) => {
  let descriptor = operationFixture("failed", {
    problem: { ...problemFixture(500), detail: credential, authorization: credential },
    cancellationProblem: { ...problemFixture(501), detail: encodeURIComponent(credential) },
    cleanupProblem: { ...problemFixture(500), nested: { controlCredential: credential } },
  });
  const fixture = await host(t, (request, response) => {
    if (request.method === "POST") accepted(response, descriptor);
    else json(response, request.url === "/api/v1/operations" ? [descriptor] : descriptor);
  });
  const client = await fixture.connect();
  const result = await client.startTarget(targetId);
  assert.equal(result.status, "failed");
  assert.equal(result.problem.detail, "[REDACTED]");
  assert.equal(result.problem.authorization, "[REDACTED]");
  assert.equal(result.cancellationProblem.detail, "[REDACTED]");
  assert.equal(result.cleanupProblem.nested.controlCredential, "[REDACTED]");
  assert.deepEqual(await client.getOperation(operationId), result);
  assert.deepEqual(await client.listOperations(), [result]);
  for (const fields of [
    { result: { value: credential } }, { result: { authorization: "not-public" } },
    { providerId: credential }, { kind: encodeURIComponent(credential) },
  ]) {
    descriptor = operationFixture("queued", fields);
    await rejects(client.startTarget(targetId), "credential_exposure", 202);
    await rejects(client.getOperation(operationId), "credential_exposure", 200);
  }
});

test("requests cancellation with DELETE and no body, without claiming final cancellation", async (t) => {
  let descriptor = operationFixture("running", {
    cancelRequested: true,
    cancellationProblem: { ...problemFixture(501), detail: "Provider cancellation delivery failed." },
  });
  const fixture = await host(t, (request, response) => {
    assert.equal(request.url, `/api/v1/operations/${encodeURIComponent(operationId)}`);
    assert.equal(request.method, "DELETE");
    assert.equal(request.headers["content-type"], undefined);
    receiveBody(request, (body) => {
      assert.equal(body, "");
      accepted(response, descriptor);
    });
  });
  const client = await fixture.connect();
  assert.deepEqual(await client.cancelOperation(operationId), descriptor);
  descriptor = operationFixture("cancelling", { cancelRequested: true });
  assert.deepEqual(await client.cancelOperation(operationId), descriptor);
  descriptor = operationFixture("cancelled", { cancelRequested: true });
  assert.equal((await client.cancelOperation(operationId)).status, "cancelled");
});

test("waits through queued/running/cancelling and resolves only authoritative succeeded", async (t) => {
  const states = ["queued", "running", "cancelling", "succeeded"];
  let polls = 0;
  const fixture = await host(t, (request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, `/api/v1/operations/${encodeURIComponent(operationId)}`);
    json(response, operationFixture(states[polls++], {
      cancelRequested: true,
      cancellationProblem: problemFixture(501),
      cleanupProblem: problemFixture(500),
      result: { targetId },
    }));
  });
  const client = await fixture.connect();
  const result = await client.waitForOperation(operationId, { timeoutMs: 1000, pollIntervalMs: 1 });
  assert.equal(result.status, "succeeded");
  assert.equal(result.cancelRequested, true);
  assert.equal(result.cancellationProblem.status, 501);
  assert.equal(result.cleanupProblem.status, 500);
  assert.equal(result.operationId, operationId);
  assert.equal(polls, 4);
  assert.equal(fixture.requests.length, 5);
});

test("terminal failed/cancelled waits reject with operation identity and primary Problem Details", async (t) => {
  let status = "failed";
  const primary = { ...problemFixture(500), detail: `${credential}; terminal failure` };
  const fixture = await host(t, (_request, response) => json(response, operationFixture(status, {
    problem: primary,
    cancellationProblem: { ...problemFixture(501), detail: "secondary cancellation" },
    cleanupProblem: { ...problemFixture(500), detail: "secondary cleanup" },
  })));
  const client = await fixture.connect();
  for (const terminal of ["failed", "cancelled"]) {
    status = terminal;
    await assert.rejects(client.waitForOperation(operationId), (error) => {
      safeError(error, terminal === "failed" ? "operation_failed" : "operation_cancelled");
      assert.equal(error.operationId, operationId);
      assert.equal(error.operation.status, terminal);
      assert.equal(error.problem.detail, "[REDACTED]; terminal failure");
      assert.equal(error.operation.cancellationProblem.detail, "secondary cancellation");
      assert.equal(error.operation.cleanupProblem.detail, "secondary cleanup");
      assert.equal(error.toJSON().operationId, operationId);
      return true;
    });
  }
});

test("nonterminal wait timeout preserves the accepted operation and never cancels or replays it", async (t) => {
  const descriptor = operationFixture("cancelling", {
    cancelRequested: true,
    cancellationProblem: { ...problemFixture(501), detail: credential },
  });
  const fixture = await host(t, (request, response) => {
    if (request.method === "POST") accepted(response, descriptor);
    else json(response, descriptor);
  });
  const client = await fixture.connect();
  const acceptedOperation = await client.startTarget(targetId);
  await assert.rejects(client.waitForOperation(acceptedOperation.operationId, {
    timeoutMs: 80, pollIntervalMs: 60_000,
  }), (error) => {
    safeError(error, "timeout");
    assert.equal(error.operationId, acceptedOperation.operationId);
    assert.equal(error.operation.status, "cancelling");
    assert.equal(error.operation.cancelRequested, true);
    assert.equal(error.operation.cancellationProblem.detail, "[REDACTED]");
    assert.equal(error.problem, undefined);
    return true;
  });
  const count = fixture.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(fixture.requests.length, count);
  assert.equal(count, 3);
  assert.equal(fixture.requests.filter(({ method }) => method === "POST").length, 1);
  assert.equal(fixture.requests.some(({ method }) => method === "DELETE"), false);
});

test("wait deadline includes stalled polls and preserves ID when no operation body arrives", async (t) => {
  const fixture = await host(t, () => {});
  const client = await fixture.connect({ timeoutMs: 1000 });
  await assert.rejects(client.waitForOperation(operationId, { timeoutMs: 80, pollIntervalMs: 1 }), (error) => {
    safeError(error, "timeout");
    assert.equal(error.operationId, operationId);
    assert.equal(error.operation, undefined);
    return true;
  });
  assert.equal(fixture.requests.length, 2);
});

test("wait read failures preserve operation ID and sanitized HTTP Problem Details", async (t) => {
  const fixture = await host(t, (_request, response) => {
    json(response, { ...problemFixture(404), detail: credential }, 404);
  });
  const client = await fixture.connect();
  await assert.rejects(client.waitForOperation(operationId), (error) => {
    safeError(error, "http_error", 404);
    assert.equal(error.operationId, operationId);
    assert.equal(error.problem.detail, "[REDACTED]");
    return true;
  });
  assert.equal(fixture.requests.length, 2);
});

test("cancels waits while polling or idle without cancelling the external operation", async (t) => {
  const queued = operationFixture();
  let streamed;
  const streamReady = new Promise((resolve) => { streamed = resolve; });
  let mode = "idle";
  const fixture = await host(t, (_request, response) => {
    if (mode === "idle") json(response, queued);
    else {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      streamed();
    }
  });
  const client = await fixture.connect();
  const before = new AbortController();
  before.abort(credential);
  await rejects(client.waitForOperation(operationId, { signal: before.signal }), "cancelled");
  assert.equal(fixture.requests.length, 1);
  const idle = new AbortController();
  const pending = client.waitForOperation(operationId, { signal: idle.signal, pollIntervalMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  idle.abort(new Error(credential));
  await assert.rejects(pending, (error) => {
    safeError(error, "cancelled");
    assert.equal(error.operationId, operationId);
    assert.equal(error.operation?.status, "queued");
    return true;
  });
  mode = "stream";
  const controller = new AbortController();
  const during = client.waitForOperation(operationId, { signal: controller.signal });
  await streamReady;
  controller.abort({ privateReason: credential });
  await rejects(during, "cancelled");
  assert.equal(fixture.requests.some(({ method }) => method !== "GET"), false);
});

test("wait reservations bound combined request concurrency and release slots on disposal", async (t) => {
  const fixture = await host(t, (request, response) => {
    if (request.url.startsWith("/api/v1/operations")) json(response, operationFixture());
  });
  const client = await fixture.connect();
  const waits = Array.from({ length: 4 }, () => rejects(
    client.waitForOperation(operationId, { pollIntervalMs: 60_000 }), "client_disposed",
  ));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const writes = Array.from({ length: 4 }, () => rejects(client.startTarget(targetId), "client_disposed"));
  await rejects(client.listTargets(), "request_limit");
  await rejects(client.waitForOperation(operationId), "request_limit");
  await rejects(client.cancelOperation(operationId), "request_limit");
  client.dispose();
  client.dispose();
  await Promise.all([...waits, ...writes]);
  for (const method of ["getOperation", "cancelOperation", "waitForOperation"]) {
    await rejects(client[method](operationId), "client_disposed");
    await rejects(client[method](credential), "client_disposed");
  }
  const replacement = await fixture.connect();
  assert.equal((await replacement.getOperation(operationId)).operationId, operationId);
  assert.equal(fixture.requests.some(({ method }) => method === "DELETE"), false);
});

test("aborted and timed-out uncertain mutations are never replayed or routed to legacy", async (t) => {
  const before = new AbortController();
  before.abort(credential);
  let received;
  const ready = new Promise((resolve) => { received = resolve; });
  const fixture = await host(t, (_request, _response) => received());
  const client = await fixture.connect({ timeoutMs: 80 });
  await rejects(client.startTarget(targetId, { signal: before.signal }), "cancelled");
  await rejects(client.deleteTarget(targetId, { confirmed: true, signal: before.signal }), "cancelled");
  await rejects(client.createTarget({ providerId, targetTypeId: "fixture" }, { signal: before.signal }), "cancelled");
  assert.equal(fixture.requests.length, 1);
  const controller = new AbortController();
  const pending = client.startTarget(targetId, { signal: controller.signal });
  await ready;
  controller.abort(credential);
  await rejects(pending, "cancelled");
  await rejects(client.startTarget(targetId), "timeout");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(fixture.requests.length, 3);
  assert.ok(fixture.requests.slice(1).every(({ method, url }) =>
    method === "POST" && url === `/api/v1/targets/${encodeURIComponent(targetId)}/actions/start`));
});

test("retains accepted Location identity when a mutation body times out or truncates", async (t) => {
  let mode = "timeout";
  const fixture = await host(t, (_request, response) => {
    response.writeHead(202, {
      "content-type": "application/json",
      location: `/api/v1/operations/${encodeURIComponent(operationId)}`,
      "retry-after": "1",
      ...(mode === "truncate" ? { "content-length": 1000 } : {}),
    });
    response.write("{");
    if (mode === "truncate") setImmediate(() => response.destroy());
    else {
      const timer = setInterval(() => response.write(" "), 5);
      response.once("close", () => clearInterval(timer));
    }
  });
  const client = await fixture.connect({ timeoutMs: 80 });
  for (const plan of ["timeout", "truncate"]) {
    mode = plan;
    await assert.rejects(client.startTarget(targetId), (error) => {
      safeError(error, plan === "timeout" ? "timeout" : "transport_error");
      assert.equal(error.operationId, operationId);
      assert.equal(error.operation, undefined);
      return true;
    });
  }
  assert.equal(fixture.requests.length, 3);
});

test("does not replay a received creation when the connection drops before acceptance", async (t) => {
  let creations = 0;
  const fixture = await host(t, (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/v1/targets");
    receiveBody(request, (body) => {
      assert.deepEqual(JSON.parse(body), { providerId, targetTypeId: "fixture", start: false });
      creations += 1;
      response.destroy();
    });
  });
  const client = await fixture.connect();
  await assert.rejects(client.createTarget({ providerId, targetTypeId: "fixture", start: false }), (error) => {
    safeError(error, "transport_error");
    assert.equal(error.operationId, undefined);
    assert.equal(error.operation, undefined);
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(creations, 1);
  assert.equal(fixture.requests.length, 2);
});

test("bounds operation/mutation bodies, headers, nesting, media types and success statuses", async (t) => {
  let mode = "valid";
  let descriptor = operationFixture();
  let declared = true;
  const fixture = await host(t, (request, response) => {
    const status = request.method === "GET" ? 200 : 202;
    const headers = {
      "content-type": mode === "type" ? "text/html" : "application/json",
      ...(status === 202 ? { location: `/api/v1/operations/${encodeURIComponent(operationId)}` } : {}),
      ...(mode === "headers" ? { "x-extra": "x".repeat(16 * 1024) } : {}),
      ...(mode === "encoding" ? { "content-encoding": "gzip" } : {}),
    };
    const body = JSON.stringify(descriptor);
    response.writeHead(mode === "status" ? (status === 202 ? 200 : 202) : status, {
      ...headers, ...(declared ? { "content-length": Buffer.byteLength(body) } : {}),
    });
    response.write(body.slice(0, 200));
    response.end(body.slice(200));
  });
  const client = await fixture.connect({ maxResponseBytes: 1024 });
  for (const chunked of [false, true]) {
    declared = !chunked;
    descriptor = operationFixture("queued", { result: { padding: "" } });
    const size = 1024 - Buffer.byteLength(JSON.stringify(descriptor));
    descriptor.result.padding = "x".repeat(size);
    assert.equal((await client.startTarget(targetId)).operationId, operationId);
    assert.equal((await client.getOperation(operationId)).operationId, operationId);
    descriptor.result.padding += "x";
    await rejects(client.startTarget(targetId), "response_too_large", 202);
    await rejects(client.getOperation(operationId), "response_too_large", 200);
  }
  descriptor = operationFixture();
  for (const plan of ["headers", "type", "encoding", "status"]) {
    mode = plan;
    await rejects(client.startTarget(targetId), plan === "headers" ? "transport_error" : "invalid_response",
      plan === "headers" ? undefined : plan === "status" ? 200 : 202);
    await rejects(client.getOperation(operationId), plan === "headers" ? "transport_error" : "invalid_response",
      plan === "headers" ? undefined : plan === "status" ? 202 : 200);
  }
  mode = "valid";
  let nested = "leaf";
  for (let depth = 0; depth < 65; depth += 1) nested = [nested];
  descriptor = operationFixture("queued", { result: { nested } });
  await rejects(client.startTarget(targetId), "invalid_response", 202);
  await rejects(client.getOperation(operationId), "invalid_response", 200);
  descriptor = operationFixture("failed", { problem: { ...problemFixture(500), nested } });
  await rejects(client.startTarget(targetId), "invalid_response", 202);
  await rejects(client.getOperation(operationId), "invalid_response", 200);
});

test("refuses mutator redirects without transmitting a credential to the destination", async (t) => {
  const destination = await host(t);
  const fixture = await host(t, (_request, response) => {
    response.writeHead(307, { location: `${destination.origin}/receive/${encodeURIComponent(credential)}` });
    response.end();
  });
  const client = await fixture.connect();
  await rejects(client.startTarget(targetId), "redirect_rejected", 307);
  await rejects(client.cancelOperation(operationId), "redirect_rejected", 307);
  await rejects(client.createTarget({ providerId, targetTypeId: "fixture" }), "redirect_rejected", 307);
  assert.equal(fixture.requests.length, 4);
  assert.equal(destination.requests.length, 0);
});

test("both prepared product hosts ship exact client bytes and safe read/lifecycle/operation roundtrips", async (t) => {
  const hosts = [
    {
      name: "GitHub canvas plugin",
      root: new URL("../../.build/copilot-plugin-thin/mobile-canvas/", import.meta.url),
    },
    {
      name: "VS Code extension host",
      root: new URL("../../vscode/dist/", import.meta.url),
    },
  ];
  for (const prepared of hosts) {
    for (const relative of ["index.mjs", "index.d.mts", "errors.mjs", "protocol.mjs"]) {
      assert.deepEqual(
        await readFile(new URL(`../../lib/ailoha/${relative}`, import.meta.url)),
        await readFile(new URL(`lib/ailoha/${relative}`, prepared.root)),
        `${prepared.name}: ${relative}`,
      );
    }
    const module = await import(new URL("lib/ailoha/index.mjs", prepared.root).href);
    assert.equal(module.TARGET_HOST_PROFILE, TARGET_HOST_PROFILE);
    const target = targetFixture();
    target.surfaces[0].bounds.extension = { unit: "logical", display: "fixture/main" };
    const route = `/api/v1/targets/${encodeURIComponent(targetId)}`;
    const missingId = "missing:/target ?#%2F+";
    const operationRoute = `/api/v1/operations/${encodeURIComponent(operationId)}`;
    let operationStatus = "succeeded";
    const problem = {
      ...problemFixture(),
      detail: `${credential}; encoded ${encodeURIComponent(credential)}`,
    };
    const fixture = await host(t, (request, response) => {
      if (request.url.startsWith(`/api/v1/targets/${encodeURIComponent(missingId)}`)) {
        const status = request.method === "GET" ? 404 : 501;
        json(response, { ...problem, status }, status);
        return;
      }
      if (request.method === "POST" && request.url === "/api/v1/targets") {
        receiveBody(request, (body) => {
          assert.deepEqual(JSON.parse(body), { providerId, targetTypeId: "fixture-phone", start: false });
          accepted(response, operationFixture("queued", { kind: "createTarget", destructive: true }));
        });
        return;
      }
      if (request.method === "POST" && request.url.startsWith(`${route}/actions/`)) {
        receiveBody(request, (body) => {
          const action = request.url.slice(request.url.lastIndexOf("/") + 1);
          const requestBody = body ? JSON.parse(body) : {};
          assert.equal(Object.hasOwn(requestBody, "confirmed"), false);
          accepted(response, operationFixture("queued", {
            kind: `${action}Target`, destructive: action === "reset",
            ...(requestBody.requestId === undefined ? {} : { requestId: requestBody.requestId }),
          }));
        });
        return;
      }
      if (request.method === "DELETE" && request.url === route) {
        receiveBody(request, (body) => {
          assert.equal(body, "");
          accepted(response, operationFixture("queued", { kind: "deleteTarget", destructive: true }));
        });
        return;
      }
      if (request.url === operationRoute) {
        if (request.method === "DELETE") {
          receiveBody(request, (body) => {
            assert.equal(body, "");
            accepted(response, operationFixture("cancelling", {
              cancelRequested: true, cancellationProblem: { ...problem, status: 501 },
            }));
          });
        } else {
          assert.equal(request.method, "GET");
          json(response, operationFixture(operationStatus, {
            cancelRequested: true,
            ...(operationStatus === "failed" ? { problem: { ...problem, status: 500 } } : {}),
          }));
        }
        return;
      }
      if (request.url.startsWith("/api/v1/operations")) {
        const url = new URL(request.url, fixture.origin);
        assert.equal(request.method, "GET");
        assert.equal(url.pathname, "/api/v1/operations");
        assert.equal(url.searchParams.get("targetId"), targetId);
        assert.equal(url.searchParams.get("status"), "running");
        json(response, [operationFixture("running")]);
        return;
      }
      const results = {
        "/api/v1/providers": [providerFixture("unavailable")],
        "/api/v1/targets": [target],
        [route]: target,
        [`${route}/capabilities`]: statusFixture().capabilities,
        [`${route}/surfaces`]: target.surfaces,
      };
      assert.ok(Object.hasOwn(results, request.url), `unexpected route ${request.url}`);
      json(response, results[request.url]);
    });
    const client = await module.connectTargetHost(fixture.connection);
    t.after(() => client.dispose());
    assert.deepEqual(fixture.requests.map((request) => request.url), ["/api/v1/host/status"]);
    assert.deepEqual(await client.getHostStatus(), statusFixture());
    assert.deepEqual(await client.listProviders(), [providerFixture("unavailable")]);
    assert.deepEqual(await client.getTarget(targetId), target);
    assert.deepEqual(await client.getTargetCapabilities(targetId), statusFixture().capabilities);
    assert.deepEqual(await client.listTargetSurfaces(targetId), target.surfaces);
    const action = { handler: () => client.listTargets() };
    const rendererMessages = [];
    const sink = { postMessage: (message) => rendererMessages.push(structuredClone(message)) };
    const result = await action.handler();
    sink.postMessage({ type: "inventory", targets: result });
    assert.deepEqual(rendererMessages, [{ type: "inventory", targets: [target] }], prepared.name);
    assert.equal(JSON.stringify(rendererMessages).includes(credential), false);
    assert.equal(JSON.stringify(client).includes(credential), false);
    await assert.rejects(client.getTarget(missingId), (error) => {
      safeError(error, "http_error", 404, module.AilohaProtocolError);
      assert.equal(error.problem.detail, "[REDACTED]; encoded [REDACTED]");
      assert.deepEqual(error.problem["x-ailoha-target-host"], problem["x-ailoha-target-host"]);
      assert.deepEqual(error.problem.trace, problem.trace);
      sink.postMessage({ type: "error", error: error.toJSON() });
      return true;
    });
    assert.equal(JSON.stringify(rendererMessages).includes(credential), false);
    assert.equal(JSON.stringify(rendererMessages).includes(encodeURIComponent(credential)), false);
    for (const request of fixture.requests) {
      assert.equal(request.method, "GET");
      assert.equal(request.authorization, `Bearer ${credential}`);
      assert.equal(request.origin, fixture.origin);
      assert.equal(request.authority, fixture.authority);
      assert.equal(request.url.includes(credential), false);
      assert.equal(request.url.includes(encodeURIComponent(credential)), false);
    }
    const beforeConfirmation = fixture.requests.length;
    for (const method of ["resetTarget", "deleteTarget"]) {
      await assert.rejects(client[method](targetId), (error) =>
        safeError(error, "confirmation_required", undefined, module.AilohaProtocolError));
    }
    assert.equal(fixture.requests.length, beforeConfirmation);
    const created = await client.createTarget({ providerId, targetTypeId: "fixture-phone", start: false });
    assert.equal(created.status, "queued");
    assert.equal(created.kind, "createTarget");
    await client.startTarget(targetId, { request: { requestId: "prepared/request" } });
    await client.stopTarget(targetId);
    await client.rebootTarget(targetId, { request: {} });
    await client.resetTarget(targetId, { confirmed: true, request: { reason: "fixture reset" } });
    await client.deleteTarget(targetId, { confirmed: true });
    assert.deepEqual(await client.listOperations({ targetId, status: "running" }), [operationFixture("running")]);
    assert.equal((await client.getOperation(operationId)).status, "succeeded");
    const cancellation = await client.cancelOperation(operationId);
    assert.equal(cancellation.status, "cancelling");
    assert.equal(cancellation.cancelRequested, true);
    assert.equal(cancellation.cancellationProblem.detail, "[REDACTED]; encoded [REDACTED]");
    const completed = await client.waitForOperation(operationId, { timeoutMs: 1000, pollIntervalMs: 1 });
    assert.equal(completed.status, "succeeded");
    sink.postMessage({ type: "operations", submitted: created, cancellation, completed });
    operationStatus = "failed";
    await assert.rejects(client.waitForOperation(operationId), (error) => {
      safeError(error, "operation_failed", undefined, module.AilohaProtocolError);
      assert.equal(error.operationId, operationId);
      assert.equal(error.operation.status, "failed");
      assert.equal(error.problem.detail, "[REDACTED]; encoded [REDACTED]");
      sink.postMessage({ type: "error", error: error.toJSON() });
      return true;
    });
    operationStatus = "cancelled";
    await assert.rejects(client.waitForOperation(operationId), (error) => {
      safeError(error, "operation_cancelled", undefined, module.AilohaProtocolError);
      assert.equal(error.operation.status, "cancelled");
      return true;
    });
    await assert.rejects(client.startTarget(missingId), (error) => {
      safeError(error, "http_error", 501, module.AilohaProtocolError);
      assert.equal(error.problem.errorCode, "unsupported-capability");
      assert.equal(error.problem.detail, "[REDACTED]; encoded [REDACTED]");
      return true;
    });
    assert.equal(JSON.stringify(rendererMessages).includes(credential), false);
    assert.equal(JSON.stringify(rendererMessages).includes(encodeURIComponent(credential)), false);
    for (const request of fixture.requests) {
      assert.equal(request.authorization, `Bearer ${credential}`);
      assert.equal(request.origin, fixture.origin);
      assert.equal(request.authority, fixture.authority);
    }
    client.dispose();
    await assert.rejects(client.listTargets(), (error) =>
      safeError(error, "client_disposed", undefined, module.AilohaProtocolError));
  }
});
