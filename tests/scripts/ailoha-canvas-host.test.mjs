import assert from "node:assert/strict";
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
      return {
        async ready() { return { backend: "ailoha" }; },
        async select(deviceId) { calls.push(["select", id, deviceId]); },
        async request(path) { return new Response(JSON.stringify({ path, backend: "ailoha" }), { headers: { "content-type": "application/json" } }); },
        async invokeAction(name) { return { name, generation: id }; },
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
  const closing = host.closeCanvas();
  const reopening = host.openCanvas();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter(([name]) => name === "create").length, 1);
  closeWait.resolve();
  await closing;
  const second = await reopening;
  assert.notEqual(first.url, second.url);
  assert.equal(calls.filter(([name]) => name === "create").length, 2);
  await host.closeCanvas();
});
