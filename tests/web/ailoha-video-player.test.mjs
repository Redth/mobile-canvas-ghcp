import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
const { createAilohaVideoPlayer } = await import(productModule("web/ailoha-video-player.js"));

const config = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e, 0, 0, 0, 1, 0x68, 0xaa]);
const key = new Uint8Array([0, 0, 1, 0x65, 0xaa]);
const delta = new Uint8Array([0, 0, 1, 0x41, 0xaa]);

function packet(sequence, flags, payload, revision = 1, timestamp = 0x0102030405060708n) {
  const bytes = new Uint8Array(28 + payload.length);
  bytes.set([0x41, 0x4c, 0x48, 0x56, 1, flags]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, sequence);
  view.setBigUint64(12, timestamp);
  view.setUint32(20, revision);
  view.setUint32(24, payload.length);
  bytes.set(payload, 28);
  return bytes;
}

function harness(options = {}) {
  const decoders = [];
  const outputs = [];
  const sent = [];
  const errors = [];
  const geometries = [];
  let current = true;
  class FakeDecoder {
    static async isConfigSupported() { return { supported: true }; }
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.state = "unconfigured";
      this.decodeQueueSize = 0;
      this.chunks = [];
      this.delivered = new Set();
      decoders.push(this);
    }
    configure(config) { this.configuration = config; this.state = "configured"; }
    decode(chunk) {
      this.chunks.push(chunk);
      if (options.automaticOutput !== false) queueMicrotask(() => this.output(chunk.timestamp));
    }
    output(timestamp) {
      this.delivered.add(timestamp);
      const frame = { timestamp, codedWidth: 96, codedHeight: 64, closed: false, close() { this.closed = true; } };
      outputs.push(frame);
      this.callbacks.output(frame);
    }
    async flush() {
      for (const chunk of this.chunks) {
        if (!this.delivered.has(chunk.timestamp)) this.output(chunk.timestamp);
      }
    }
    close() { this.state = "closed"; }
  }
  class FakeChunk {
    constructor(options) { Object.assign(this, options); }
  }
  const presented = [];
  const player = createAilohaVideoPlayer({
    context: { videoSessionId: "video", ownerId: "captured-owner" },
    VideoDecoder: FakeDecoder,
    EncodedVideoChunk: FakeChunk,
    isCurrent: () => current,
    observedGeometry: options.observedGeometry,
    decodeTimeoutMs: options.decodeTimeoutMs ?? 5000,
    present: options.present ?? ((frame, metadata) => { presented.push(metadata); return true; }),
    onGeometry: (geometry) => geometries.push(geometry),
    onError: (error) => errors.push(error),
  });
  const transport = {
    protocol: "ailoha.video.v1",
    send: (text) => sent.push(JSON.parse(text)),
    close() {},
  };
  const connection = player.attach(transport);
  return {
    player, connection, transport, decoders, outputs, sent, errors, geometries, presented,
    retire() { current = false; },
    ack() { return sent.filter((message) => message.type === "ack").map((message) => message.sequence); },
  };
}

async function start(state, floor = 0, revision = 1) {
  await state.connection.start();
  await state.connection.receive(JSON.stringify({
    type: "ready", videoSessionId: "video", codec: "h264",
    geometryRevision: revision, resumeFromSequence: floor, maxInFlightFrames: 1,
  }));
}

async function geometry(state, revision = 1) {
  await state.connection.receive(JSON.stringify({
    type: "geometryChanged", geometryRevision: revision,
    bounds: { x: -10, y: 20, width: 390, height: 844 }, pixelDensity: 3,
  }));
}

test("window-one configuration is cached/ACKed before decoding an equal-PTS key picture", async (t) => {
  const state = harness();
  t.after(() => state.player.dispose());
  await start(state);
  await geometry(state);
  assert.equal(await state.connection.receive(packet(0, 2, config)), true);
  assert.deepEqual(state.ack(), [0]);
  assert.equal(state.decoders.length, 0);
  assert.equal(await state.connection.receive(packet(1, 1, key)), true);
  assert.deepEqual(state.ack(), [0, 1]);
  assert.equal(state.decoders[0].configuration.codec, "avc1.42e01e");
  assert.deepEqual(state.decoders[0].chunks[0].data, new Uint8Array([...config, ...key]));
  assert.equal(state.presented[0].sequence, 1);
  assert.equal(state.presented[0].timestampMicroseconds, 0x0102030405060708n);
  assert.equal(state.outputs.every((frame) => frame.closed), true);
});

test("separate SPS and PPS units are retained together for every Annex B key chunk", async (t) => {
  const state = harness();
  t.after(() => state.player.dispose());
  await start(state);
  await geometry(state);
  await state.connection.receive(packet(0, 2, config.subarray(0, 8)));
  await state.connection.receive(packet(1, 2, config.subarray(8)));
  await state.connection.receive(packet(2, 1, key));
  await state.connection.receive(packet(3, 1, key));
  assert.deepEqual(state.ack(), [0, 1, 2, 3]);
  assert.deepEqual(state.decoders[0].chunks[0].data, new Uint8Array([...config, ...key]));
  assert.deepEqual(state.decoders[0].chunks[1].data, new Uint8Array([...config, ...key]));
});

test("drop followed by configuration does not authorize decoding dependent pictures", async (t) => {
  const state = harness();
  t.after(() => state.player.dispose());
  await start(state);
  await geometry(state);
  await state.connection.receive(packet(0, 2, config));
  await state.connection.receive(packet(1, 1, key));
  await state.connection.receive(JSON.stringify({ type: "backpressure", maxInFlight: 1, dropBeforeSequence: 5 }));
  await state.connection.receive(packet(5, 2, config));
  await state.connection.receive(packet(6, 0, delta));
  assert.equal(state.decoders[0].chunks.length, 1);
  assert.deepEqual(state.ack(), [0, 1, 5, 6]);
  await state.connection.receive(packet(7, 1, key));
  assert.equal(state.decoders.length, 2);
  assert.equal(state.presented.length, 2);
});

test("accepted decoder handoff ACKs once, while late output cannot paint a new attachment", async (t) => {
  const state = harness({ automaticOutput: false });
  t.after(() => state.player.dispose());
  await start(state);
  await geometry(state);
  await state.connection.receive(packet(0, 2, config));
  const picture = state.connection.receive(packet(1, 1, key));
  await new Promise((resolve) => setImmediate(resolve));
  const old = state.decoders[0];
  const replacement = state.player.attach(state.transport);
  assert.equal(await picture, true);
  old.output(1);
  assert.equal(state.outputs[0].closed, true);
  assert.equal(state.presented.length, 0);
  assert.deepEqual(state.ack(), [0, 1]);
  await replacement.start();
  await replacement.receive(JSON.stringify({
    type: "ready", videoSessionId: "video", codec: "h264",
    geometryRevision: 2, resumeFromSequence: 2, maxInFlightFrames: 1,
  }));
  assert.equal(state.geometries.at(-1), null);
});

test("captured logical geometry stays with each output, not encoded size or a later revision", async (t) => {
  const state = harness();
  t.after(() => state.player.dispose());
  await start(state);
  await geometry(state);
  await state.connection.receive(packet(0, 3, new Uint8Array([...config, ...key])));
  await geometry(state, 2);
  await state.connection.receive(packet(1, 1, key, 2));
  assert.equal(state.presented[0].geometryRevision, 1);
  assert.equal(state.presented[0].geometry.bounds.x, -10);
  assert.equal(state.presented[1].geometryRevision, 2);
});

test("only matching observed geometry may seed a ready with no bounds", async (t) => {
  const observedGeometry = { geometryRevision: 1, bounds: { x: 0, y: 0, width: 390, height: 844 } };
  const state = harness({ observedGeometry });
  t.after(() => state.player.dispose());
  await start(state);
  assert.deepEqual(state.geometries[0], observedGeometry);
  const next = state.player.attach(state.transport);
  await next.start();
  await next.receive(JSON.stringify({
    type: "ready", videoSessionId: "video", codec: "h264",
    geometryRevision: 2, resumeFromSequence: 0, maxInFlightFrames: 1,
  }));
  assert.equal(state.geometries.at(-1), null);
});

test("decode output lifetime is bounded after a valid handoff ACK, without rewind or fallback", async (t) => {
  const state = harness({ automaticOutput: false, decodeTimeoutMs: 10 });
  t.after(() => state.player.dispose());
  await start(state);
  await geometry(state);
  await state.connection.receive(packet(0, 2, config));
  assert.equal(await state.connection.receive(packet(1, 1, key)), true);
  assert.deepEqual(state.ack(), [0, 1]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.errors[0].code, "DecodeTimeout");
  assert.equal(state.decoders[0].state, "closed");
});

test("a declined presentation after handoff closes explicitly without manufacturing another ACK", async (t) => {
  const state = harness({ automaticOutput: false, present: () => false });
  t.after(() => state.player.dispose());
  await start(state);
  await geometry(state);
  await state.connection.receive(packet(0, 2, config));
  assert.equal(await state.connection.receive(packet(1, 1, key)), true);
  state.decoders[0].output(1);
  assert.deepEqual(state.ack(), [0, 1]);
  assert.equal(state.outputs[0].closed, true);
  assert.equal(state.errors[0].code, "PresentationFailed");
});

test("equal picture PTS and reordered outputs retain distinct sequence/generation owners", async (t) => {
  const state = harness({ automaticOutput: false });
  t.after(() => state.player.dispose());
  await start(state);
  await geometry(state);
  await state.connection.receive(packet(0, 2, config));
  await state.connection.receive(packet(1, 1, key));
  await state.connection.receive(packet(2, 0, delta));
  assert.deepEqual(state.ack(), [0, 1, 2]);
  state.decoders[0].output(2);
  state.decoders[0].output(1);
  assert.deepEqual(state.presented.map((item) => item.sequence), [2, 1]);
  assert.equal(state.presented[0].timestampMicroseconds, state.presented[1].timestampMicroseconds);
});

test("window-one never waits for a reordered picture; idle drain requests a new key", async (t) => {
  const state = harness({ automaticOutput: false });
  t.after(() => state.player.dispose());
  await start(state);
  await geometry(state);
  await state.connection.receive(packet(0, 2, config));
  await state.connection.receive(packet(1, 1, key));
  await state.connection.receive(packet(2, 0, delta));
  await state.connection.receive(packet(3, 0, delta));
  assert.deepEqual(state.ack(), [0, 1, 2, 3]);
  assert.equal(state.presented.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.equal(state.presented.length, 3);
  assert.equal(state.sent.filter((message) => message.command === "requestKeyFrame").length, 1);
  await state.connection.receive(packet(4, 0, delta));
  assert.equal(state.decoders[0].chunks.length, 3);
});

test("pending picture limits safely retire the decoder and recover only at a new key", async (t) => {
  const state = harness({ automaticOutput: false });
  t.after(() => state.player.dispose());
  await start(state);
  await geometry(state);
  await state.connection.receive(packet(0, 2, config));
  for (let sequence = 1; sequence <= 10; sequence += 1) {
    await state.connection.receive(packet(sequence, sequence === 1 ? 1 : 0, sequence === 1 ? key : delta));
  }
  assert.equal(state.decoders[0].state, "closed");
  assert.equal(state.decoders[0].chunks.length, 8);
  assert.deepEqual(state.ack(), Array.from({ length: 11 }, (_, index) => index));
  await state.connection.receive(packet(11, 1, key));
  assert.equal(state.decoders.length, 2);
});

test("a later geometry notification retires already-ACKed old decoder owners", async (t) => {
  const state = harness({ automaticOutput: false });
  t.after(() => state.player.dispose());
  await start(state);
  await geometry(state);
  await state.connection.receive(packet(0, 2, config));
  await state.connection.receive(packet(1, 1, key));
  const old = state.decoders[0];
  await geometry(state, 2);
  old.output(1);
  assert.equal(state.presented.length, 0);
  assert.equal(state.outputs[0].closed, true);
  assert.deepEqual(state.ack(), [0, 1]);
});

test("frames without authoritative bounds are safely retired without coordinate presentation", async (t) => {
  const state = harness();
  t.after(() => state.player.dispose());
  await start(state);
  await state.connection.receive(packet(0, 2, config));
  assert.equal(await state.connection.receive(packet(1, 1, key)), true);
  assert.equal(state.presented.length, 0);
  assert.deepEqual(state.ack(), [0, 1]);
});
