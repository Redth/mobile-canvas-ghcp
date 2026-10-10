import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { productModule } from "../ailoha-test-module.mjs";
const { createAilohaCanvasHost } = await import(productModule("lib/ailoha/canvas-host.mjs"));

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function fixture(options = {}) {
  const calls = [];
  let generation = 0;
  const host = createAilohaCanvasHost({
    scope: { sessionId: "unique-session", viewId: "unique-view" },
    createBackend: async ({ scope }) => {
      const id = ++generation;
      calls.push(["create", id, scope]);
      if (options.startWait) await options.startWait.promise;
      return {
        connectionRef: Object.freeze({
          serviceId: `service-${id}`, pid: 12345,
          startedAt: "2026-10-09T23:00:00Z", processStartedAt: "2026-10-09T22:59:59Z",
        }),
        async ready() { return { backend: "ailoha" }; },
        async select(deviceId) { calls.push(["select", id, deviceId]); },
        async request(path, requestOptions) {
          calls.push(["request", id, path, requestOptions]);
          if (/\/ui(?:\/|$|\?)/.test(path) && options.uiResponse) {
            return options.uiResponse(path, requestOptions);
          }
          if (options.request) return options.request(path, requestOptions);
          return new Response(JSON.stringify(
            path.endsWith("/ui") || path.endsWith("/ui/find") || path.endsWith("/ui/tap")
              ? { code: "ui_contract_unavailable" }
              : { path, backend: "ailoha" },
          ), {
            status: /\/ui(?:\/|$)/.test(path) ? 501 : 200,
            headers: { "content-type": "application/json" },
          });
        },
        async invokeAction(name) { calls.push(["action", id, name]); return { name, generation: id }; },
        async closeVideos() { calls.push(["video-retire", id]); },
        async openVideo(deviceId, onMessage) {
          calls.push(["video", id, deviceId]);
          onMessage('{"type":"ready","videoSessionId":"fixture"}');
          return {
            context: { ownerId: `owner-${id}`, videoSessionId: "fixture" },
            geometry: { geometryRevision: 7, bounds: { x: 0, y: 0, width: 48, height: 32 } },
            protocol: "ailoha.video.v1",
            async send(text) { calls.push(["send", id, text]); },
            async close() { calls.push(["video-close", id]); },
          };
        },
        async dispose() { calls.push(["dispose", id]); if (options.closeWait) await options.closeWait.promise; },
      };
    },
  });
  return { host, calls };
}

async function bootstrap(host) {
  const result = await host.openCanvas();
  const url = new URL(result.url);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const response = await fetch(new URL("/api/v1/auth/bootstrap", url), {
    method: "POST", headers: { "content-type": "application/json", Origin: url.origin },
    body: JSON.stringify({
      secret: fragment.get("bootstrap"), sessionId: fragment.get("sessionId"), instanceId: fragment.get("instanceId"),
    }),
  });
  assert.equal(response.status, 204);
  return { url, result, cookie: response.headers.get("set-cookie").split(";", 1)[0] };
}

test("the real loopback panel serves the shared renderer but gates API by unique view grant", async (t) => {
  const { host } = fixture();
  t.after(() => host.closeCanvas());
  const { url, cookie, result } = await bootstrap(host);
  assert.match(cookie, new RegExp(`^${result.cookieName}=`));
  const asset = await fetch(new URL("/device-canvas.js", url));
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /createAilohaVideoPlayer/);
  assert.equal((await fetch(new URL("/api/v1/catalog", url))).status, 401);
  const response = await fetch(new URL("/api/v1/catalog", url), { headers: { Cookie: cookie } });
  assert.equal((await response.json()).backend, "ailoha");
  assert.equal((await fetch(new URL("/api/v1/catalog", url), { headers: { Cookie: cookie, Origin: "http://127.0.0.1:1" } })).status, 403);
});

test("registered GitHub canvas forwards reveal and gates legacy System UI paths in its owned API", async (t) => {
  const { host } = fixture();
  t.after(() => host.closeCanvas());
  const { url, cookie } = await bootstrap(host);
  for (const [path, method] of [
    ["/api/v1/devices/one/reveal", "POST"],
    ["/api/v1/devices/one/ui", "GET"],
    ["/api/v1/devices/one/ui/find", "POST"],
    ["/api/v1/devices/one/ui/tap", "POST"],
  ]) {
    const response = await fetch(new URL(path, url), {
      method, headers: { Cookie: cookie, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    assert.equal(response.status, path.endsWith("/reveal") ? 200 : 501);
    const body = await response.json();
    assert.equal(path.endsWith("/reveal") ? body.path : body.code,
      path.endsWith("/reveal") ? path : "ui_contract_unavailable");
  }
});

test("registered GitHub canvas passes source-approved System UI result shapes through its authenticated API", async (t) => {
  const calls = [];
  const { host } = fixture({
    uiResponse(path, request) {
      calls.push([path, request]);
      const body = path.endsWith("/ui?raw=true")
        ? { schemaVersion: "1.0", deviceId: "one", platform: "ios", root: null, elementCount: 0, raw: "native" }
        : path.endsWith("/ui/find")
          ? { schemaVersion: "1.0", deviceId: "one", matches: [], total: 0 }
          : { schemaVersion: "1.0", success: true, deviceId: "one", match: {
            element: { label: "Save", frame: { x: 1, y: 2, width: 4, height: 6 } },
            path: "1/0", centerX: 3, centerY: 5,
          }, total: 2 };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    },
  });
  t.after(() => host.closeCanvas());
  const { url, cookie } = await bootstrap(host);
  for (const [path, method, expected] of [
    ["/api/v1/devices/one/ui?raw=true", "GET", "native"],
    ["/api/v1/devices/one/ui/find", "POST", 0],
    ["/api/v1/devices/one/ui/tap", "POST", "1/0"],
  ]) {
    const response = await fetch(new URL(path, url), {
      method, headers: { Cookie: cookie, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      ...(method === "POST" ? { body: '{"text":"Save"}' } : {}),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(path.endsWith("/ui?raw=true") ? body.raw
      : path.endsWith("/ui/find") ? body.total : body.match.path, expected);
  }
  assert.equal(calls.length, 3);
  assert.equal(calls[2][1].method, "POST");
});

test("early official socket messages are delivered only after the non-secret owned descriptor", async (t) => {
  const { host, calls } = fixture();
  t.after(() => host.closeCanvas());
  const { url, cookie } = await bootstrap(host);
  const websocketUrl = new URL("/ws/video?deviceId=opaque", url);
  websocketUrl.protocol = "ws:";
  const socket = new WebSocket(websocketUrl, "ailoha.video.v1", { headers: { Cookie: cookie } });
  t.after(() => socket.terminate());
  const messages = [];
  await new Promise((resolve, reject) => {
    socket.on("error", reject);
    socket.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
      if (messages.length === 2) resolve();
    });
  });
  assert.equal(socket.protocol, "ailoha.video.v1");
  assert.equal(messages[0].type, "mobile-canvas-video");
  assert.deepEqual(Object.keys(messages[0].context).sort(), ["ownerId", "videoSessionId"]);
  assert.equal(messages[1].type, "ready");
  socket.send('{"type":"hello","videoSessionId":"fixture"}');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.some(([name]) => name === "send"), true);
  socket.close();
});

test("asynchronous close serializes a reopened owner and never tears down its replacement", async () => {
  const closeWait = deferred();
  const { host, calls } = fixture({ closeWait });
  const first = await host.openCanvas();
  const firstOwner = host.connectionRef;
  assert.equal(firstOwner.serviceId, "service-1");
  assert.equal(JSON.stringify(first).includes("connectionRef"), false);
  assert.equal(JSON.stringify(host).includes("connectionRef"), false);
  const closing = host.closeCanvas();
  const reopening = host.openCanvas();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter(([name]) => name === "create").length, 1);
  closeWait.resolve();
  await closing;
  const second = await reopening;
  assert.equal(host.connectionRef.serviceId, "service-2");
  assert.notEqual(host.connectionRef, firstOwner);
  assert.equal(firstOwner.serviceId, "service-1");
  assert.notEqual(first.url, second.url);
  assert.equal(calls.filter(([name]) => name === "create").length, 2);
  await host.closeCanvas();
  assert.equal(host.connectionRef, undefined);
});

test("caller cancellation while a cold canvas owner is opening does not abandon initialization or dispatch its action", async (t) => {
  const startWait = deferred();
  const { host, calls } = fixture({ startWait });
  t.after(() => host.closeCanvas());
  const opening = host.openCanvas();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter(([kind]) => kind === "create").length, 1);
  const controller = new AbortController();
  const cancelled = host.invokeAction("create_device", {}, { signal: controller.signal }).then(
    (value) => ({ status: "fulfilled", value }), (error) => ({ status: "rejected", error }));
  controller.abort();
  startWait.resolve();
  await opening;
  assert.equal((await cancelled).error.code, "cancelled");
  assert.equal(calls.some(([kind]) => kind === "action"), false);
  assert.equal(calls.some(([kind]) => kind === "dispose"), false);
  assert.equal((await host.invokeAction("create_device", {})).generation, 1);
});

test("HTTP body completion is not cancellation and a disconnected held backend request cannot affect a normal peer request", async (t) => {
  const entered = deferred();
  const release = deferred();
  let cancelledSignal;
  const mutations = [];
  const { host } = fixture({ request: async (path, options) => {
    if (path.endsWith("/held")) {
      cancelledSignal = options.signal;
      entered.resolve();
      await release.promise;
    }
    if (options.signal.aborted) return new Response('{"code":"cancelled"}', { status: 409 });
    mutations.push(options.body);
    return new Response('{"success":true}', { headers: { "content-type": "application/json" } });
  } });
  t.after(() => { release.resolve(); return host.closeCanvas(); });
  const { url, cookie } = await bootstrap(host);
  const controller = new AbortController();
  const cancelled = fetch(new URL("/api/v1/held", url), {
    method: "POST", headers: { Cookie: cookie }, body: '{"held":true}', signal: controller.signal,
  }).then((value) => ({ value }), (error) => ({ error }));
  await entered.promise;
  const normal = await fetch(new URL("/api/v1/normal", url), {
    method: "POST", headers: { Cookie: cookie }, body: '{"normal":true}',
  });
  assert.equal((await normal.json()).success, true);
  controller.abort();
  assert.ok((await cancelled).error);
  const deadline = Date.now() + 5000;
  while (!cancelledSignal.aborted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cancelledSignal.aborted, true);
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(mutations, ['{"normal":true}']);
  const next = await fetch(new URL("/api/v1/next", url), { method: "POST", headers: { Cookie: cookie }, body: "{}" });
  assert.equal((await next.json()).success, true);
});

test("a caller disconnect while the request body is incomplete never starts backend work or retires its lease", async (t) => {
  const { host, calls } = fixture();
  t.after(() => host.closeCanvas());
  const { url, cookie } = await bootstrap(host);
  const request = httpRequest(new URL("/api/v1/devices", url), {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
  });
  const closed = new Promise((resolve) => request.once("close", resolve));
  const errors = [];
  request.on("error", (error) => errors.push(error.code));
  request.write('{"name":', () => request.destroy());
  await closed;
  assert.equal(errors.every((code) => ["ECONNRESET", "ERR_STREAM_DESTROYED"].includes(code)), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.some(([kind]) => kind === "request"), false);
  assert.equal(calls.some(([kind]) => kind === "dispose"), false);
  const next = await fetch(new URL("/api/v1/catalog", url), { headers: { Cookie: cookie } });
  assert.equal(next.status, 200);
});
