import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
const { createAilohaMediaAdapter } = await import(productModule("lib/ailoha/media-adapter.mjs"));

const invocation = {
  targetHostId: "host", targetId: "opaque/target", surfaceId: "opaque/surface", providerId: "provider",
  geometry: { geometryRevision: 7, pointWidth: 390, pointHeight: 844 },
};
const path = "/api/v1/targets/opaque%2Ftarget/surfaces/opaque%2Fsurface";
const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const video = {
  videoSessionId: "opaque/video", targetId: invocation.targetId, surfaceId: invocation.surfaceId,
  codec: "h264", state: "ready", createdAt: "2026-10-09T23:00:00Z",
  websocketUrl: "/ws/v1/targets/opaque%2Ftarget/surfaces/opaque%2Fsurface/video/opaque%2Fvideo",
};
const artifact = {
  artifactId: "opaque/artifact", kind: "screenshot", status: "ready", contentType: "image/png",
  createdAt: "2026-10-09T23:00:00Z", size: image.length, sha256: createHash("sha256").update(image).digest("hex"),
  targetId: invocation.targetId, surfaceId: invocation.surfaceId,
};
const operation = {
  operationId: "stop-video-opaque/video", kind: "stopLiveVideoSession", status: "succeeded",
  destructive: false, createdAt: "2026-10-09T23:00:00Z", startedAt: "2026-10-09T23:00:01Z",
};
const response = (body, status = 200, location = null) =>
  ({ status, location, contentType: "application/json", retryAfterMs: null, body });

function fixture(overrides = {}) {
  const calls = [];
  const transport = {
    async response(url, options) {
      calls.push({ url, options });
      if (url.endsWith("/screenshots")) return response(artifact, 201, "/api/v1/artifacts/opaque%2Fartifact");
      if (options?.method === "DELETE") return response(operation, 202, "/api/v1/operations/stop-video-opaque%2Fvideo");
      if (url.endsWith("/video/sessions")) return response(video, 201, `${path}/video/sessions/opaque%2Fvideo`);
      if (url.includes("/video/sessions/")) return response(video);
      return response({ success: true, "x-ailoha-target-host": { targetId: invocation.targetId, surfaceId: invocation.surfaceId, geometryRevision: 7 } });
    },
    async bytes(url) { calls.push({ url }); return { status: 200, contentType: "image/png", bytes: image }; },
    async websocket(url, listeners) {
      calls.push({ url, listeners });
      listeners.onMessage(new TextEncoder().encode('{"type":"ready"}'), false);
      listeners.onMessage(new Uint8Array([1, 2, 3]), true);
      return { send(text) { calls.push({ send: text }); }, async close() { calls.push({ close: true }); } };
    },
    ...overrides,
  };
  const client = {
    async waitForOperation(id) { calls.push({ wait: id }); return operation; },
  };
  return { calls, transport, client, adapter: createAilohaMediaAdapter({ transport, client }) };
}

test("PNG capture uses exact POST201 artifact and bounded authenticated content with owner/digest checks", async () => {
  const { adapter, calls } = fixture();
  assert.deepEqual(await adapter.screenshot(invocation), image);
  assert.equal(calls[0].url, `${path}/screenshots`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { format: "png", scale: "native" });
  assert.equal(calls[1].url, "/api/v1/artifacts/opaque%2Fartifact/content");
  const bad = fixture({
    async response() { return response({ ...artifact, targetId: "other" }, 201, "/api/v1/artifacts/opaque%2Fartifact"); },
  });
  await assert.rejects(bad.adapter.screenshot(invocation), { code: "invalid_media_response" });
  const digest = fixture({
    async bytes() { return { status: 200, contentType: "image/png", bytes: new Uint8Array([...image, 2]) }; },
  });
  await assert.rejects(digest.adapter.screenshot(invocation), { code: "invalid_media_response" });
});

test("tap uses observed revision; long press and swipe preserve requested seconds as bounded pauses/moves", async () => {
  const { adapter, calls } = fixture();
  await adapter.tap(invocation, { x: 10, y: 20, duration: 0 });
  assert.equal(calls[0].url, `${path}/input/actions/tap`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { x: 10, y: 20, geometryRevision: 7 });
  await adapter.tap(invocation, { x: 10, y: 20, duration: 21.3 });
  const held = JSON.parse(calls[1].options.body);
  assert.equal(held.actions.filter((action) => action.type === "pause").reduce((sum, action) => sum + action.duration, 0), 21300);
  assert.equal(held.actions.every((action) => action.type !== "pause" || action.duration <= 10000), true);
  await adapter.swipe(invocation, { startX: 0, startY: 20, endX: 100, endY: 200, duration: 0.35 });
  const swipe = JSON.parse(calls[2].options.body);
  assert.equal(swipe.actions.filter((action) => action.type === "pause").reduce((sum, action) => sum + action.duration, 0), 350);
  assert.ok(swipe.actions.filter((action) => action.type === "pointerMove").length > 1);
  assert.deepEqual(swipe.actions.at(-1), { type: "pointerUp", x: 100, y: 200, button: 0 });
  assert.equal(swipe.actions.every((action) => !Object.hasOwn(action, "pointerId")), true);
  assert.equal(swipe.actions.length <= 512, true);
});

test("input success false and mismatched geometry are explicit operational failures", async () => {
  const rejected = fixture({ async response() { return response({ success: false }); } });
  await assert.rejects(rejected.adapter.tap(invocation, { x: 1, y: 2, duration: 0 }), { code: "input_operation_failed" });
  const stale = fixture({ async response() { return response({
    success: true, "x-ailoha-target-host": { targetId: invocation.targetId, surfaceId: invocation.surfaceId, geometryRevision: 8 },
  }); } });
  await assert.rejects(stale.adapter.tap(invocation, { x: 1, y: 2, duration: 0 }), { code: "invalid_media_response" });
});

test("video preserves omitted rate/profile defaults and registers acquired identity before other IO", async () => {
  const { adapter, calls } = fixture();
  let acquired;
  const descriptor = await adapter.createVideo(invocation, (value) => {
    acquired = value;
    assert.equal(calls.length, 1);
  });
  assert.equal(calls[0].options.body, undefined);
  assert.equal(acquired.videoSessionId, video.videoSessionId);
  const messages = [];
  const socket = await adapter.attachVideo(invocation, descriptor, { onMessage: (data) => messages.push(data), onError() {} });
  assert.equal(calls[1].url, `${path}/video/sessions/opaque%2Fvideo`);
  assert.equal(calls[2].url, video.websocketUrl);
  assert.deepEqual(messages, ['{"type":"ready"}', new Uint8Array([1, 2, 3])]);
  socket.send('{"type":"hello"}');
  await socket.close();
  await adapter.deleteVideo(invocation, descriptor);
  assert.equal(calls.at(-1).wait, operation.operationId);
});

test("a lost201 with validated Location registers owned cleanup without a second create", async () => {
  let posts = 0;
  const { adapter } = fixture({
    async response() {
      posts += 1;
      const error = new Error("sanitized");
      error.name = "TargetHostTransportError";
      error.response = { status: 201, location: `${path}/video/sessions/opaque%2Fvideo` };
      throw error;
    },
  });
  let acquired;
  await assert.rejects(adapter.createVideo(invocation, (value) => { acquired = value; }));
  assert.equal(acquired.videoSessionId, video.videoSessionId);
  assert.equal(posts, 1);
});

test("descriptor absolute origins and mismatched media status never become browser socket selectors", async () => {
  const bad = fixture({
    async response() { return response({ ...video, websocketUrl: "ws://127.0.0.1:1234/private" }, 201, `${path}/video/sessions/opaque%2Fvideo`); },
  });
  await assert.rejects(bad.adapter.createVideo(invocation), { code: "invalid_media_response" });
  const status = fixture({ async response() { return response(video, 202); } });
  await assert.rejects(status.adapter.createVideo(invocation), { code: "invalid_media_response" });
});

test("support needs exact operation and surface feature evidence, not capability names or versions alone", () => {
  const { adapter } = fixture();
  const surface = { capabilities: [{ id: "surface.input", version: 1, features: ["tap.point", "long-press.point", "gesture", "swipe.point"] }] };
  const capabilities = [
    { id: "surface.capture", version: 1, features: ["captureTargetScreenshot", "createLiveVideoSession", "getLiveVideoSession", "stopLiveVideoSession"] },
    { id: "surface.input", version: 1, features: ["tapTargetElement", "performTargetGesture"] },
  ];
  assert.equal(Object.values(adapter.supported(capabilities, surface)).every((value) => value === true), true);
  const unsupported = adapter.supported(capabilities.map((capability) => ({ ...capability, version: 2 })), surface);
  assert.equal(Object.values(unsupported).every((value) => value === false), true);
  assert.equal(adapter.supported(capabilities, { capabilities: [] }).tap, false);
});

test("accepted video recovery keeps slash/dot/percent opaque IDs independent of filesystem paths", async () => {
  const invocation = {
    targetId: "nested/../opaque", surfaceId: "literal%2F..%2F", geometry: { geometryRevision: 7 },
  };
  const collection = `/api/v1/targets/${encodeURIComponent(invocation.targetId)}/surfaces/${encodeURIComponent(invocation.surfaceId)}/video/sessions`;
  const videoSessionId = "video/../literal%2F";
  const { adapter } = fixture({
    async response() {
      const error = new Error("sanitized");
      error.name = "TargetHostTransportError";
      error.response = { status: 201, location: `${collection}/${encodeURIComponent(videoSessionId)}` };
      throw error;
    },
  });
  let captured;
  await assert.rejects(adapter.createVideo(invocation, (value) => { captured = value; }));
  assert.equal(captured.targetId, invocation.targetId);
  assert.equal(captured.surfaceId, invocation.surfaceId);
  assert.equal(captured.videoSessionId, videoSessionId);
  assert.equal(captured.resourcePath, `${collection}/${encodeURIComponent(videoSessionId)}`);
});

test("lost202 video cleanup recovers by its accepted operation and never repeats DELETE", async () => {
    let deletes = 0;
    const state = fixture({
      async response() {
        deletes += 1;
        const error = new Error("synthetic truncated body");
        error.name = "TargetHostTransportError";
        error.response = { status: 202, location: `/api/v1/operations/${encodeURIComponent(operation.operationId)}` };
        throw error;
      },
    });
    const descriptor = { ...video, resourcePath: `${path}/video/sessions/opaque%2Fvideo` };
    assert.equal((await state.adapter.deleteVideo(invocation, descriptor)).operationId, operation.operationId);
    await state.adapter.deleteVideo(invocation, descriptor);
    assert.equal(deletes, 1);
    assert.deepEqual(state.calls.filter((call) => call.wait).map((call) => call.wait), [operation.operationId]);
  });

  test("failed accepted cleanup resumes only captured GET/poll on retry, including timeout evidence", async () => {
    let deletes = 0;
    let polls = 0;
    const state = fixture({
      async response() {
        deletes += 1;
        const error = new Error("synthetic deadline");
        error.name = "TargetHostTransportError";
        error.code = "RequestTimeout";
        error.response = { status: 202, location: `/api/v1/operations/${encodeURIComponent(operation.operationId)}` };
        throw error;
      },
    });
    state.client.waitForOperation = async (operationId) => {
      assert.equal(operationId, operation.operationId);
      if (++polls === 1) throw new Error("synthetic poll timeout");
      return operation;
    };
    const descriptor = Object.freeze({ ...video, resourcePath: `${path}/video/sessions/opaque%2Fvideo` });
    await assert.rejects(state.adapter.deleteVideo(invocation, descriptor));
    assert.equal((await state.adapter.deleteVideo(invocation, descriptor)).status, "succeeded");
    assert.equal(deletes, 1);
    assert.equal(polls, 2);
    await assert.rejects(state.adapter.deleteVideo({ ...invocation, targetId: "another" }, descriptor), { code: "invalid_media_response" });
    assert.equal(polls, 2);
  });

  test("mismatched accepted body cannot overwrite valid cleanup Location evidence", async () => {
    let deletes = 0;
    const state = fixture({
      async response() {
        deletes += 1;
        return response({ ...operation, operationId: "wrong-body-id" }, 202,
          `/api/v1/operations/${encodeURIComponent(operation.operationId)}`);
      },
    });
    const descriptor = { ...video, resourcePath: `${path}/video/sessions/opaque%2Fvideo` };
    await assert.rejects(state.adapter.deleteVideo(invocation, descriptor), {
      code: "operation_identity_mismatch", operationId: operation.operationId,
    });
    await state.adapter.deleteVideo(invocation, descriptor);
    assert.equal(deletes, 1);
    assert.equal(state.calls.at(-1).wait, operation.operationId);
  });

  test("missing cleanup recovery evidence does not turn404 or another DELETE into success", async () => {
    let deletes = 0;
    const state = fixture({
      async response() { deletes += 1; throw new Error("synthetic lost response with no metadata"); },
    });
    const descriptor = { ...video, resourcePath: `${path}/video/sessions/opaque%2Fvideo` };
    await assert.rejects(state.adapter.deleteVideo(invocation, descriptor));
    await assert.rejects(state.adapter.deleteVideo(invocation, descriptor), { code: "video_delete_uncertain" });
    assert.equal(deletes, 1);
  });
