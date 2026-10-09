import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AILOHA_VIDEO_RECEIVER_LIMITS,
  AILOHA_VIDEO_SUBPROTOCOL,
  createAilohaVideoReceiver,
} from "../../web/ailoha-video-receiver.js";
import { MAX_AILOHA_VIDEO_PAYLOAD_BYTES } from "../../web/ailoha-video-protocol.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function makeFrame({
  sequence = 0,
  timestampMicroseconds = 0x0102030405060708n,
  geometryRevision = 1,
  flags = 1,
  payload = new Uint8Array([0, 0, 1, 0x65]),
} = {}) {
  const packet = new Uint8Array(28 + payload.length);
  packet.set([0x41, 0x4c, 0x48, 0x56, 1, flags]);
  const view = new DataView(packet.buffer);
  view.setUint32(8, sequence, false);
  view.setBigUint64(12, timestampMicroseconds, false);
  view.setUint32(20, geometryRevision, false);
  view.setUint32(24, payload.length, false);
  packet.set(payload, 28);
  return packet;
}

function harness(options = {}) {
  const sent = [];
  const closed = [];
  const frames = [];
  const controls = [];
  const errors = [];
  const receiver = (options.createReceiver ?? createAilohaVideoReceiver)({
    context: options.context ?? {
      videoSessionId: "video-session",
      ownerId: "view-owner",
    },
    onFrame: options.onFrame ?? ((frame, delivery) => {
      delivery.commit(() => frames.push(frame));
      return true;
    }),
    onControl: options.onControl ?? ((control) => controls.push(control)),
    onError: (error, delivery) => errors.push({ error, delivery }),
  });
  const transport = {
    protocol: Object.hasOwn(options, "protocol") ? options.protocol : AILOHA_VIDEO_SUBPROTOCOL,
    send: options.send ?? ((text) => sent.push(JSON.parse(text))),
    close: options.close ?? (() => closed.push(true)),
  };
  const connection = receiver.attach(transport);
  return { receiver, connection, transport, sent, closed, frames, controls, errors };
}

function ready(overrides = {}) {
  return {
    type: "ready",
    videoSessionId: "video-session",
    codec: "h264",
    geometryRevision: 1,
    resumeFromSequence: 0,
    maxInFlightFrames: 8,
    ...overrides,
  };
}

function geometryChanged(overrides = {}) {
  return {
    type: "geometryChanged",
    geometryRevision: 1,
    bounds: { x: -10, y: 20, width: 390, height: 844, coordinate: "window" },
    pixelDensity: 3,
    orientation: "portrait",
    ...overrides,
  };
}

function serverError(overrides = {}) {
  return {
    type: "error",
    problem: {
      type: "urn:devflow:error:unsupported",
      title: "Rejected control",
      status: 400,
      detail: "Synthetic diagnostic",
      instance: "/video/session",
      errorCode: "unsupported",
      "x-ailoha-target-host": {
        targetId: "target",
        surfaceId: "surface",
        providerId: "provider",
        geometryRevision: 1,
      },
    },
    terminal: false,
    ...overrides,
  };
}

function receiveControl(state, control) {
  return state.connection.receive(JSON.stringify(control));
}

async function streaming(options = {}, readyOverrides = {}) {
  const state = harness(options);
  assert.equal(await state.connection.start(), true);
  assert.equal(await receiveControl(state, ready({
    videoSessionId: state.receiver.context.videoSessionId,
    ...readyOverrides,
  })), true);
  return state;
}

function delayedBlob(packet) {
  const started = deferred();
  const conversion = deferred();
  const blob = new Blob([packet]);
  blob.arrayBuffer = () => {
    started.resolve();
    return conversion.promise;
  };
  return {
    blob,
    started: started.promise,
    resolve: (value = packet.slice().buffer) => conversion.resolve(value),
    reject: conversion.reject,
  };
}

function acknowledgements(sent) {
  return sent.filter((control) => control.type === "ack").map((control) => control.sequence);
}

test("captures only an immutable non-secret video session and owner projection", async () => {
  const context = { videoSessionId: "session-one", ownerId: "owner-one" };
  const { receiver, connection } = harness({ context });
  context.videoSessionId = "session-two";
  context.ownerId = "owner-two";
  assert.deepEqual(receiver.context, {
    videoSessionId: "session-one",
    ownerId: "owner-one",
  });
  assert.equal(Object.isFrozen(receiver.context), true);
  assert.equal(connection.context, receiver.context);
  await receiver.dispose();
});

test("captures context fields once before validating the selected owner/session", async (t) => {
  const reads = { videoSessionId: 0, ownerId: 0 };
  const context = {
    get videoSessionId() {
      reads.videoSessionId += 1;
      return reads.videoSessionId === 1 ? "video-session" : "different-session";
    },
    get ownerId() {
      reads.ownerId += 1;
      return reads.ownerId === 1 ? "view-owner" : "different-owner";
    },
  };
  const state = harness({ context });
  t.after(() => state.receiver.dispose());
  assert.deepEqual(state.receiver.context, { videoSessionId: "video-session", ownerId: "view-owner" });
  assert.deepEqual(reads, { videoSessionId: 1, ownerId: 1 });
  assert.equal(await state.connection.start(), true);
  assert.equal(state.sent[0].videoSessionId, "video-session");
  assert.equal(await receiveControl(state, ready()), true);
});

test("rejects invalid context and callback configuration before attaching", () => {
  const callbacks = { onFrame() {}, onControl() {}, onError() {} };
  for (const context of [
    null,
    {},
    { videoSessionId: "", ownerId: "owner" },
    { videoSessionId: "session", ownerId: " " },
    { videoSessionId: 1, ownerId: "owner" },
    { videoSessionId: "x".repeat(257), ownerId: "owner" },
    { videoSessionId: "session", ownerId: "owner", credential: "not-allowed" },
  ]) {
    assert.throws(
      () => createAilohaVideoReceiver({ context, ...callbacks }),
      /context|videoSessionId|ownerId/,
    );
  }
  for (const name of ["onFrame", "onControl", "onError"]) {
    assert.throws(
      () => createAilohaVideoReceiver({
        context: { videoSessionId: "session", ownerId: "owner" },
        ...callbacks,
        [name]: null,
      }),
      new RegExp(name),
    );
  }
});

test("requires the exact negotiated subprotocol before sending anything", async () => {
  for (const protocol of ["", "ailoha.video.v2", "ailoha.video.v1,other", null]) {
    const state = harness({ protocol });
    assert.equal(await state.connection.start(), false);
    assert.equal(state.sent.length, 0);
    assert.equal(state.closed.length, 1);
    assert.equal(state.errors[0].error.code, "ProtocolMismatch");
    assert.equal(state.errors[0].delivery.context, state.receiver.context);
    assert.equal(state.connection.signal.aborted, true);
  }
});

test("does not accept binary frames before the hello or ready boundary", async () => {
  for (const started of [false, true]) {
    const state = harness();
    if (started) assert.equal(await state.connection.start(), true);
    assert.equal(await state.connection.receive(makeFrame()), false);
    assert.equal(state.frames.length, 0);
    assert.equal(state.closed.length, 1);
    assert.equal(state.errors[0].error.code, "NotReady");
    assert.equal(state.receiver.lastAcknowledgedSequence, -1);
    assert.equal(state.sent.length, started ? 1 : 0);
  }
});

test("close and dispose are idempotent and release only the attached connection", async () => {
  const state = harness();
  assert.equal(await state.connection.close(), true);
  assert.equal(await state.connection.close(), true);
  assert.equal(await state.receiver.dispose(), true);
  assert.equal(await state.receiver.dispose(), true);
  assert.equal(state.closed.length, 1);
  assert.equal(state.errors.length, 0);
  assert.equal(state.connection.signal.aborted, true);
  assert.equal(await state.connection.receive(makeFrame()), false);
  assert.throws(() => state.receiver.attach(state.transport), /disposed/);
});

test("an invalid replacement transport cannot disturb the current attachment", async () => {
  const state = harness();
  for (const transport of [null, {}, { send() {}, close: null }]) {
    assert.throws(() => state.receiver.attach(transport), /transport|send|close/);
    assert.equal(state.connection.signal.aborted, false);
    assert.equal(state.closed.length, 0);
  }
  await state.receiver.dispose();
});

test("captures transport callbacks and the negotiated protocol at attachment time", async () => {
  const state = harness({ protocol: "wrong-protocol" });
  state.transport.protocol = AILOHA_VIDEO_SUBPROTOCOL;
  state.transport.close = () => { throw new Error("replacement close must not be used"); };
  assert.equal(await state.connection.start(), false);
  await state.connection.close();
  assert.equal(state.closed.length, 1);
  assert.equal(state.errors.length, 1);
  assert.equal(state.errors[0].error.code, "ProtocolMismatch");
});

test("captures transport fields once before validating and binding callbacks", async (t) => {
  const state = harness();
  t.after(() => state.receiver.dispose());
  const reads = { protocol: 0, send: 0, close: 0 };
  const sentBy = [];
  const closedBy = [];
  const transport = {
    get protocol() {
      reads.protocol += 1;
      return AILOHA_VIDEO_SUBPROTOCOL;
    },
    get send() {
      const version = ++reads.send;
      return function () {
        assert.equal(this, transport);
        sentBy.push(version);
      };
    },
    get close() {
      const version = ++reads.close;
      return function () {
        assert.equal(this, transport);
        closedBy.push(version);
      };
    },
  };
  const connection = state.receiver.attach(transport);
  assert.deepEqual(reads, { protocol: 1, send: 1, close: 1 });
  assert.equal(await connection.start(), true);
  assert.equal(await connection.receive(JSON.stringify(ready())), true);
  assert.equal(await connection.control("pause"), true);
  assert.equal(await connection.close(), true);
  assert.deepEqual(sentBy, [1, 1]);
  assert.deepEqual(closedBy, [1]);
});

test("reentrant abort callbacks cannot close a connection twice", async () => {
  const state = harness();
  state.connection.signal.addEventListener("abort", () => state.connection.close());
  await state.connection.close();
  assert.equal(state.closed.length, 1);
});

test("reentrant replacement cannot overwrite a newer attachment", async () => {
  const state = harness();
  const closed = [];
  const transport = (name) => ({
    protocol: AILOHA_VIDEO_SUBPROTOCOL,
    send() {},
    close() { closed.push(name); },
  });
  let newest;
  state.connection.signal.addEventListener("abort", () => {
    newest = state.receiver.attach(transport("newest"));
  });
  const superseded = state.receiver.attach(transport("superseded"));
  assert.equal(state.connection.signal.aborted, true);
  assert.equal(superseded.signal.aborted, true);
  assert.equal(newest.signal.aborted, false);
  await state.receiver.dispose();
  assert.deepEqual(closed, ["superseded", "newest"]);
  assert.equal(state.closed.length, 1);
});

test("malformed JSON and non-object controls fail explicitly and release the stream", async () => {
  for (const input of ["{", "null", "[]", '"ready"', "1", "true"]) {
    const state = harness();
    assert.equal(await state.connection.receive(input), false);
    await state.connection.close();
    assert.equal(state.errors[0].error.code, "InvalidControl");
    assert.equal(state.closed.length, 1);
    assert.equal(state.controls.length, 0);
    assert.equal(state.frames.length, 0);
  }
});

test("control limits bound UTF-8 bytes, not just JavaScript string length", async () => {
  for (const input of [
    " ".repeat(AILOHA_VIDEO_RECEIVER_LIMITS.maxControlBytes + 1),
    `"${"\u00e9".repeat(AILOHA_VIDEO_RECEIVER_LIMITS.maxControlBytes / 2)}"`,
  ]) {
    const state = harness();
    assert.equal(await state.connection.receive(input), false);
    assert.equal(state.errors[0].error.code, "InvalidControl");
    assert.match(state.errors[0].error.message, /exceeds 65536 bytes/);
    await state.receiver.dispose();
  }
});

test("close failures are explicit, terminal, and never retried", async () => {
  for (const close of [
    () => { throw new Error("close failed"); },
    () => Promise.reject(new Error("close failed")),
    () => false,
    () => Promise.resolve(false),
  ]) {
    const state = harness({ close });
    assert.equal(await state.connection.close(), false);
    assert.equal(await state.connection.close(), false);
    assert.equal(state.errors.length, 1);
    assert.equal(state.errors[0].error.code, "TransportFailed");
    assert.match(
      state.errors[0].error.cause?.message ?? state.errors[0].error.message,
      /close failed|close was declined/,
    );
    assert.equal(state.connection.signal.aborted, true);
    assert.equal(state.sent.length, 0);
  }
});

test("dispose shares pending transport cleanup without retaining a usable attachment", async () => {
  const closing = deferred();
  let closes = 0;
  const state = harness({
    close: () => {
      closes += 1;
      return closing.promise;
    },
  });
  const disposed = state.receiver.dispose();
  assert.equal(state.receiver.dispose(), disposed);
  assert.equal(state.connection.signal.aborted, true);
  assert.throws(() => state.receiver.attach(state.transport), /disposed/);
  await Promise.resolve();
  assert.equal(closes, 1);
  closing.resolve();
  assert.equal(await disposed, true);
});

test("shared receiver source has no credential, device, or network dependencies", () => {
  const source = readFileSync(new URL("../../web/ailoha-video-receiver.js", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /\bfrom\s+["']node:|require\s*\(|\bprocess\b|\bBuffer\b|\bWebSocket\b|\bfetch\s*\(/,
  );
  assert.match(source, /from "\.\/ailoha-video-protocol\.js"/);
  assert.equal(AILOHA_VIDEO_RECEIVER_LIMITS.maxFrameBytes, 28 + MAX_AILOHA_VIDEO_PAYLOAD_BYTES);
});

test("sends one exact hello and treats hello completion as distinct from ready", async () => {
  const state = harness();
  const started = state.connection.start();
  assert.equal(state.connection.start(), started);
  assert.equal(await started, true);
  assert.equal(state.connection.phase, "awaiting-ready");
  assert.deepEqual(state.sent, [{
    type: "hello",
    videoSessionId: "video-session",
    lastAcknowledgedSequence: -1,
    maxInFlightFrames: 8,
  }]);
  assert.equal(await receiveControl(state, ready()), true);
  assert.equal(state.connection.phase, "streaming");
  assert.deepEqual(state.controls, [ready()]);
  assert.equal(Object.isFrozen(state.controls[0]), true);
  assert.equal(state.receiver.lastAcknowledgedSequence, -1);
  await state.receiver.dispose();
});

test("rejects a ready message before hello has actually been dispatched", async () => {
  const state = harness();
  const started = state.connection.start();
  assert.equal(await receiveControl(state, ready()), false);
  assert.equal(await started, false);
  assert.equal(state.errors[0].error.code, "NotReady");
  assert.equal(state.sent.length, 0);
  await state.receiver.dispose();
});

test("validates ready identity, codec, required fields, and supported window capacity", async () => {
  const invalid = [
    ["SessionMismatch", ready({ videoSessionId: "another-session" })],
    ["InvalidControl", ready({ codec: "vp8" })],
    ["InvalidControl", ready({ bounds: { x: 0, y: 0, width: 1, height: 1 } })],
    ...["videoSessionId", "codec", "geometryRevision", "resumeFromSequence", "maxInFlightFrames"]
      .map((name) => ["InvalidControl", ready({ [name]: undefined })]),
    ...[-1, 0.5, null, 0x100000000]
      .map((geometryRevision) => ["InvalidControl", ready({ geometryRevision })]),
    ...[-1, 0.5, null, Number.MAX_SAFE_INTEGER + 1]
      .map((resumeFromSequence) => ["InvalidControl", ready({ resumeFromSequence })]),
    ...[0, -1, 1.5, null, 65]
      .map((maxInFlightFrames) => ["InvalidControl", ready({ maxInFlightFrames })]),
  ];
  for (const [code, control] of invalid) {
    const state = harness();
    await state.connection.start();
    assert.equal(await receiveControl(state, control), false);
    assert.equal(state.errors[0].error.code, code);
    assert.equal(state.controls.length, 0);
    assert.deepEqual(acknowledgements(state.sent), []);
    await state.receiver.dispose();
    assert.equal(state.closed.length, 1);
  }
  const state = await streaming();
  assert.equal(await receiveControl(state, ready()), false);
  assert.equal(state.errors[0].error.code, "NotReady");
  await state.receiver.dispose();
});

test("accepts the exact control byte bound and rejects bound plus one", async () => {
  for (const excess of [0, 1]) {
    const state = harness();
    await state.connection.start();
    const prefix = JSON.stringify(ready());
    const input = prefix + " ".repeat(AILOHA_VIDEO_RECEIVER_LIMITS.maxControlBytes - prefix.length + excess);
    assert.equal(await state.connection.receive(input), excess === 0);
    assert.equal(state.errors.length, excess);
    if (excess) assert.equal(state.errors[0].error.code, "InvalidControl");
    await state.receiver.dispose();
  }
});

test("preserves maximum unsigned fields and owns payload bytes from a borrowed subview", async () => {
  const state = await streaming({}, {
    geometryRevision: 0xffffffff,
    resumeFromSequence: 0xffffffff,
  });
  const packet = makeFrame({
    sequence: 0xffffffff,
    timestampMicroseconds: 0xffffffffffffffffn,
    geometryRevision: 0xffffffff,
    flags: 3,
  });
  const surrounding = new Uint8Array(packet.length + 8).fill(0xff);
  surrounding.set(packet, 4);
  const received = state.connection.receive(surrounding.subarray(4, 4 + packet.length));
  surrounding.fill(0);
  assert.equal(await received, true);
  const frame = state.frames[0];
  assert.equal(frame.sequence, 0xffffffff);
  assert.equal(frame.timestampMicroseconds, 0xffffffffffffffffn);
  assert.equal(frame.geometryRevision, 0xffffffff);
  assert.equal(frame.isKeyFrame, true);
  assert.equal(frame.isCodecConfig, true);
  assert.equal(Object.isFrozen(frame), true);
  assert.notEqual(frame.payload.buffer, surrounding.buffer);
  assert.deepEqual([...frame.payload], [0, 0, 1, 0x65]);
  assert.deepEqual(acknowledgements(state.sent), [0xffffffff]);
  await state.receiver.dispose();
});

test("copies Node Buffer subviews instead of inheriting their aliasing slice behavior", async () => {
  const state = await streaming();
  const packet = makeFrame();
  const backing = Buffer.alloc(packet.length + 100);
  backing.set(packet, 50);
  const input = backing.subarray(50, 50 + packet.length);
  const received = state.connection.receive(input);
  backing.fill(0);
  assert.equal(await received, true);
  const payload = state.frames[0].payload;
  assert.equal(payload.constructor, Uint8Array);
  assert.notEqual(payload.buffer, backing.buffer);
  assert.equal(payload.buffer.byteLength, 4);
  assert.deepEqual([...payload], [0, 0, 1, 0x65]);
  assert.deepEqual(acknowledgements(state.sent), [0]);
  await state.receiver.dispose();
});

test("consumes and ACKs distinct config/no-picture units in a window of one", async () => {
  const consumed = [];
  const state = await streaming({
    onFrame(frame, delivery) {
      consumed.push({
        sequence: frame.sequence,
        timestamp: frame.timestampMicroseconds,
        config: frame.isCodecConfig,
        canDecode: delivery.canDecode,
        canPresent: delivery.canPresent,
        needsKeyFrame: delivery.needsKeyFrame,
      });
      return true;
    },
  }, { resumeFromSequence: 7, maxInFlightFrames: 1 });
  const timestampMicroseconds = 0xfedcba9876543210n;
  assert.equal(await state.connection.receive(makeFrame({
    sequence: 7, flags: 2, timestampMicroseconds,
  })), true);
  assert.deepEqual(acknowledgements(state.sent), [7]);
  assert.equal(await state.connection.receive(makeFrame({
    sequence: 8, flags: 1, timestampMicroseconds,
  }).buffer), true);
  assert.equal(await state.connection.receive(makeFrame({ sequence: 9, flags: 0 })), true);
  assert.deepEqual(consumed, [
    { sequence: 7, timestamp: timestampMicroseconds, config: true, canDecode: true, canPresent: false, needsKeyFrame: true },
    { sequence: 8, timestamp: timestampMicroseconds, config: false, canDecode: true, canPresent: true, needsKeyFrame: true },
    { sequence: 9, timestamp: 0x0102030405060708n, config: false, canDecode: true, canPresent: true, needsKeyFrame: false },
  ]);
  assert.deepEqual(acknowledgements(state.sent), [7, 8, 9]);
  await state.receiver.dispose();
});

test("serializes asynchronous consumption and ACKs only after positive completion", { timeout: 2000 }, async () => {
  const firstStarted = deferred();
  const secondStarted = deferred();
  const firstConsumed = deferred();
  const secondConsumed = deferred();
  const calls = [];
  const state = await streaming({
    async onFrame(frame, delivery) {
      calls.push(["start", frame.sequence]);
      (frame.sequence === 0 ? firstStarted : secondStarted).resolve();
      await (frame.sequence === 0 ? firstConsumed : secondConsumed).promise;
      delivery.commit(() => calls.push(["consume", frame.sequence]));
      return true;
    },
  }, { maxInFlightFrames: 2 });
  const first = state.connection.receive(makeFrame());
  const second = state.connection.receive(makeFrame({ sequence: 1 }));
  await firstStarted.promise;
  assert.deepEqual(calls, [["start", 0]]);
  assert.deepEqual(acknowledgements(state.sent), []);
  assert.equal(state.receiver.lastAcknowledgedSequence, -1);
  firstConsumed.resolve();
  assert.equal(await first, true);
  await secondStarted.promise;
  assert.deepEqual(acknowledgements(state.sent), [0]);
  assert.deepEqual(calls, [["start", 0], ["consume", 0], ["start", 1]]);
  secondConsumed.resolve();
  assert.equal(await second, true);
  assert.deepEqual(acknowledgements(state.sent), [0, 1]);
  assert.equal(state.receiver.lastAcknowledgedSequence, 1);
  await state.receiver.dispose();
});

test("keeps ACKs and commands serialized while an asynchronous ACK send is pending", { timeout: 2000 }, async () => {
  const ackStarted = deferred();
  const ackSent = deferred();
  const sent = [];
  const consumed = [];
  const state = await streaming({
    onFrame(frame) { consumed.push(frame.sequence); return true; },
    send(text) {
      const control = JSON.parse(text);
      sent.push(control);
      if (control.type === "ack" && control.sequence === 0) {
        ackStarted.resolve();
        return ackSent.promise;
      }
    },
  }, { maxInFlightFrames: 1 });
  const first = state.connection.receive(makeFrame());
  await ackStarted.promise;
  const second = state.connection.receive(makeFrame({ sequence: 1 }));
  const command = state.connection.control("pause");
  assert.deepEqual(consumed, [0]);
  assert.equal(state.receiver.lastAcknowledgedSequence, -1);
  assert.equal(state.errors.length, 0);
  ackSent.resolve();
  assert.equal(await first, true);
  assert.equal(await command, true);
  assert.equal(await second, true);
  assert.deepEqual(consumed, [0, 1]);
  assert.deepEqual(sent.slice(1), [
    { type: "ack", sequence: 0 },
    { type: "control", command: "pause" },
    { type: "ack", sequence: 1 },
  ]);
  await state.receiver.dispose();
});

test("drains received units before a drop discontinuity and never ACKs the watermark", { timeout: 2000 }, async () => {
  const started = deferred();
  const consumed = deferred();
  const calls = [];
  const state = await streaming({
    onControl(control) { calls.push(["control", control.type]); },
    async onFrame(frame, delivery) {
      if (frame.sequence === 0) {
        started.resolve();
        await consumed.promise;
      }
      const committed = delivery.commit(() => calls.push(["decode", frame.sequence]));
      calls.push(["consume", frame.sequence, delivery.canDecode, delivery.canPresent, committed]);
      return true;
    },
  });
  const receipts = [
    state.connection.receive(makeFrame()),
    state.connection.receive(makeFrame({ sequence: 1, flags: 0 })),
    receiveControl(state, { type: "backpressure", maxInFlight: 8, dropBeforeSequence: 10 }),
    state.connection.receive(makeFrame({ sequence: 10, flags: 2 })),
    state.connection.receive(makeFrame({ sequence: 11, flags: 0 })),
    state.connection.receive(makeFrame({ sequence: 12, flags: 1 })),
    state.connection.receive(makeFrame({ sequence: 13, flags: 0 })),
  ];
  await started.promise;
  assert.deepEqual(acknowledgements(state.sent), []);
  assert.deepEqual(calls, [["control", "ready"]]);
  consumed.resolve();
  assert.deepEqual(await Promise.all(receipts), Array(receipts.length).fill(true));
  assert.deepEqual(acknowledgements(state.sent), [0, 1, 10, 11, 12, 13]);
  assert.deepEqual(calls.filter((call) => call[0] === "consume"), [
    ["consume", 0, true, true, true],
    ["consume", 1, true, true, true],
    ["consume", 10, true, false, true],
    ["consume", 11, false, false, false],
    ["consume", 12, true, true, true],
    ["consume", 13, true, true, true],
  ]);
  assert.ok(calls.findIndex((call) => call[0] === "control" && call[1] === "backpressure")
    > calls.findIndex((call) => call[0] === "consume" && call[1] === 1));
  await state.receiver.dispose();
});

test("drop/config and keyframe requests do not authorize dependent pictures", async () => {
  const observed = [];
  const state = await streaming({
    onFrame(frame, delivery) {
      observed.push([frame.sequence, delivery.canDecode, delivery.canPresent]);
      return true;
    },
  }, { maxInFlightFrames: 1 });
  assert.equal(await receiveControl(state, {
    type: "backpressure", maxInFlight: 1, dropBeforeSequence: 10, recommendedFramesPerSecond: 30,
  }), true);
  assert.equal(state.receiver.lastAcknowledgedSequence, -1);
  assert.deepEqual(acknowledgements(state.sent), []);
  assert.equal(await state.connection.receive(makeFrame({ sequence: 2 })), false);
  assert.equal(await state.connection.control("requestKeyFrame"), true);
  assert.equal(await state.connection.receive(makeFrame({ sequence: 10, flags: 2 })), true);
  assert.equal(await state.connection.receive(makeFrame({ sequence: 11, flags: 0 })), true);
  assert.equal(await state.connection.receive(makeFrame({ sequence: 12, flags: 3 })), true);
  assert.equal(await state.connection.receive(makeFrame({ sequence: 13, flags: 0 })), true);
  assert.deepEqual(observed, [
    [10, true, false], [11, false, false], [12, true, true], [13, true, true],
  ]);
  assert.deepEqual(acknowledgements(state.sent), [10, 11, 12, 13]);
  await state.receiver.dispose();
});

test("rejects unannounced gaps and duplicate frames without sending their ACK", async () => {
  const ahead = await streaming({}, { resumeFromSequence: 5 });
  assert.equal(await ahead.connection.receive(makeFrame({ sequence: 6 })), false);
  assert.equal(ahead.errors[0].error.code, "SequenceMismatch");
  assert.equal(ahead.frames.length, 0);
  assert.deepEqual(acknowledgements(ahead.sent), []);
  await ahead.receiver.dispose();

  const duplicate = await streaming({}, { resumeFromSequence: 5 });
  assert.equal(await duplicate.connection.receive(makeFrame({ sequence: 4 })), false);
  assert.equal(duplicate.errors.length, 0);
  assert.equal(await duplicate.connection.receive(makeFrame({ sequence: 5 })), true);
  assert.equal(await duplicate.connection.receive(makeFrame({ sequence: 5 })), false);
  assert.equal(duplicate.errors[0].error.code, "SequenceMismatch");
  assert.deepEqual(acknowledgements(duplicate.sent), [5]);
  await duplicate.receiver.dispose();
});

test("the authoritative ready window can differ from the requested default", { timeout: 2000 }, async () => {
  const gate = deferred();
  const started = deferred();
  const state = await streaming({
    async onFrame(frame) {
      if (frame.sequence === 0) { started.resolve(); await gate.promise; }
      return true;
    },
  }, { maxInFlightFrames: 64 });
  const receipts = Array.from({ length: 9 }, (_, sequence) => state.connection.receive(makeFrame({ sequence })));
  await started.promise;
  assert.equal(state.sent[0].maxInFlightFrames, 8);
  assert.equal(state.errors.length, 0);
  gate.resolve();
  assert.deepEqual(await Promise.all(receipts), Array(9).fill(true));
  assert.deepEqual(acknowledgements(state.sent), Array.from({ length: 9 }, (_, index) => index));
  await state.receiver.dispose();
});

test("the negotiated frame limit includes active asynchronous consumption", { timeout: 2000 }, async () => {
  const gate = deferred();
  const started = deferred();
  const state = await streaming({
    async onFrame() { started.resolve(); await gate.promise; return true; },
  }, { maxInFlightFrames: 2 });
  const first = state.connection.receive(makeFrame());
  const second = state.connection.receive(makeFrame({ sequence: 1 }));
  await started.promise;
  assert.equal(state.errors.length, 0);
  assert.equal(await state.connection.receive(makeFrame({ sequence: 2 })), false);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(state.errors[0].error.code, "QueueOverflow");
  assert.deepEqual(acknowledgements(state.sent), []);
  gate.resolve();
  await state.receiver.dispose();
});

test("the message-count bound includes active control callbacks", { timeout: 2000 }, async () => {
  const gate = deferred();
  const started = deferred();
  const state = harness({
    onControl() { started.resolve(); return gate.promise; },
  });
  await state.connection.start();
  const receipts = [receiveControl(state, ready())];
  await started.promise;
  for (let index = 1; index < AILOHA_VIDEO_RECEIVER_LIMITS.maxBufferedMessages; index += 1) {
    receipts.push(receiveControl(state, { type: "backpressure", maxInFlight: 8 }));
  }
  assert.equal(state.errors.length, 0);
  assert.equal(await receiveControl(state, { type: "backpressure", maxInFlight: 8 }), false);
  assert.deepEqual(await Promise.all(receipts), Array(receipts.length).fill(false));
  assert.equal(state.errors[0].error.code, "QueueOverflow");
  gate.resolve();
  await state.receiver.dispose();
});

test("accepts the exact aggregate byte bound and rejects bound plus one", { timeout: 2000 }, async () => {
  for (const excess of [0, 1]) {
    const gate = deferred();
    const started = deferred();
    const state = await streaming({
      async onFrame(frame) {
        if (frame.sequence === 0) { started.resolve(); await gate.promise; }
        return true;
      },
    }, { maxInFlightFrames: 64 });
    const half = AILOHA_VIDEO_RECEIVER_LIMITS.maxBufferedBytes / 2;
    const first = state.connection.receive(makeFrame({ payload: new Uint8Array(half - 28) }));
    await started.promise;
    const second = state.connection.receive(makeFrame({
      sequence: 1, payload: new Uint8Array(half - 28 + excess),
    }));
    if (excess) {
      assert.equal(await second, false);
      assert.equal(await first, false);
      assert.equal(state.errors[0].error.code, "QueueOverflow");
      assert.deepEqual(acknowledgements(state.sent), []);
    } else {
      assert.equal(state.errors.length, 0);
    }
    gate.resolve();
    if (!excess) assert.deepEqual(await Promise.all([first, second]), [true, true]);
    await state.receiver.dispose();
  }
});

test("uses the unchanged parser default payload limit and rejects malformed frames", async () => {
  const valid = await streaming();
  assert.equal(await valid.connection.receive(makeFrame({
    payload: new Uint8Array(MAX_AILOHA_VIDEO_PAYLOAD_BYTES),
  })), true);
  await valid.receiver.dispose();
  for (const input of [
    makeFrame({ payload: new Uint8Array(MAX_AILOHA_VIDEO_PAYLOAD_BYTES + 1) }),
    new Uint8Array(27),
    new DataView(new ArrayBuffer(28)),
    null,
    (() => { const frame = makeFrame(); frame[4] = 2; return frame; })(),
  ]) {
    const state = await streaming();
    assert.equal(await state.connection.receive(input), false);
    assert.equal(state.errors[0].error.code, "InvalidMessage");
    assert.deepEqual(acknowledgements(state.sent), []);
    await state.receiver.dispose();
  }
});

test("announces geometry only after old-revision consumption and blocks late presentation", { timeout: 2000 }, async () => {
  const started = deferred();
  const consumed = deferred();
  const events = [];
  const deliveries = [];
  const state = await streaming({
    onControl(control, delivery) {
      if (control.type === "geometryChanged") {
        delivery.commit(() => events.push(["geometry", control.geometryRevision]));
      }
    },
    async onFrame(frame, delivery) {
      deliveries.push(delivery);
      if (frame.sequence === 0) { started.resolve(); await consumed.promise; }
      delivery.commit(() => events.push(["paint", frame.geometryRevision]));
      return true;
    },
  });
  await receiveControl(state, geometryChanged());
  const first = state.connection.receive(makeFrame());
  await started.promise;
  const changed = receiveControl(state, geometryChanged({
    geometryRevision: 2,
    bounds: { x: 0, y: 0, width: 844, height: 390, coordinate: "screen" },
    orientation: "landscape",
  }));
  const second = state.connection.receive(makeFrame({ sequence: 1, geometryRevision: 2 }));
  assert.deepEqual(events, [["geometry", 1]]);
  assert.equal(deliveries[0].geometry.geometryRevision, 1);
  consumed.resolve();
  assert.deepEqual(await Promise.all([first, changed, second]), [true, true, true]);
  assert.deepEqual(events, [["geometry", 1], ["paint", 1], ["geometry", 2], ["paint", 2]]);
  assert.equal(deliveries[0].geometry.bounds.width, 390);
  assert.equal(deliveries[1].geometry.bounds.width, 844);
  assert.equal(Object.isFrozen(deliveries[0].geometry), true);
  assert.equal(Object.isFrozen(deliveries[0].geometry.bounds), true);
  assert.equal(deliveries[0].commit(() => events.push(["late-paint", 1])), false);
  assert.equal(deliveries[0].signal.aborted, true);
  assert.deepEqual(acknowledgements(state.sent), [0, 1]);
  await state.receiver.dispose();
});

test("reconnect uses authoritative floors and reuses geometry only at a matching revision", async () => {
  const readyGeometry = [];
  const state = await streaming({
    onControl(control, delivery) {
      if (control.type === "ready") readyGeometry.push(delivery.geometry);
    },
  });
  assert.deepEqual(readyGeometry, [null]);
  await receiveControl(state, geometryChanged());
  assert.equal(await state.connection.receive(makeFrame()), true);
  const reconnectSent = [];
  const reconnect = state.receiver.attach({
    protocol: AILOHA_VIDEO_SUBPROTOCOL,
    send: (text) => reconnectSent.push(JSON.parse(text)),
    close() {},
  });
  assert.equal(state.connection.signal.aborted, true);
  assert.equal(await reconnect.start(), true);
  assert.equal(reconnectSent[0].lastAcknowledgedSequence, 0);
  assert.equal(await reconnect.receive(JSON.stringify(ready({ resumeFromSequence: 10 }))), true);
  assert.equal(readyGeometry[1].geometryRevision, 1);
  assert.equal(readyGeometry[1].bounds.width, 390);
  assert.equal(await reconnect.receive(makeFrame({ sequence: 1 })), false);
  assert.deepEqual(acknowledgements(reconnectSent), []);
  assert.equal(await reconnect.receive(makeFrame({ sequence: 10 })), true);
  assert.deepEqual(acknowledgements(reconnectSent), [10]);

  const changed = state.receiver.attach({
    protocol: AILOHA_VIDEO_SUBPROTOCOL,
    send() {},
    close() {},
  });
  await changed.start();
  assert.equal(await changed.receive(JSON.stringify(ready({
    resumeFromSequence: 20, geometryRevision: 2,
  }))), true);
  assert.equal(readyGeometry[2], null);
  assert.equal(state.errors.length, 0);
  await state.receiver.dispose();
});

test("a retained session cannot rewind past received but unconsumed queued units", { timeout: 2000 }, async () => {
  const gate = deferred();
  const started = deferred();
  const state = await streaming({
    async onFrame() { started.resolve(); await gate.promise; return true; },
  });
  const first = state.connection.receive(makeFrame());
  const second = state.connection.receive(makeFrame({ sequence: 1 }));
  await started.promise;
  const replacement = state.receiver.attach({
    protocol: AILOHA_VIDEO_SUBPROTOCOL, send() {}, close() {},
  });
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  await replacement.start();
  assert.equal(await replacement.receive(JSON.stringify(ready({ resumeFromSequence: 1 }))), false);
  assert.equal(state.errors[0].error.code, "SequenceMismatch");
  assert.equal(state.receiver.lastAcknowledgedSequence, -1);
  gate.resolve();
  await state.receiver.dispose();
});

test("Blob conversion, geometry, and binary consumption preserve arrival order", { timeout: 2000 }, async () => {
  const events = [];
  const state = await streaming({
    onControl(control) { events.push(control.type); },
    onFrame(frame) { events.push(`frame-${frame.sequence}-${frame.geometryRevision}`); return true; },
  });
  const first = delayedBlob(makeFrame());
  const second = delayedBlob(makeFrame({ sequence: 1, geometryRevision: 2 }));
  const firstReceipt = state.connection.receive(first.blob);
  const changed = receiveControl(state, geometryChanged({ geometryRevision: 2 }));
  const secondReceipt = state.connection.receive(second.blob);
  await first.started;
  assert.deepEqual(events, ["ready"]);
  first.resolve();
  assert.equal(await firstReceipt, true);
  assert.equal(await changed, true);
  await second.started;
  assert.deepEqual(events, ["ready", "frame-0-1", "geometryChanged"]);
  second.resolve();
  assert.equal(await secondReceipt, true);
  assert.deepEqual(events, ["ready", "frame-0-1", "geometryChanged", "frame-1-2"]);
  assert.deepEqual(acknowledgements(state.sent), [0, 1]);
  await state.receiver.dispose();
});

test("close cancels pending Blob conversion and ignores its late result", { timeout: 2000 }, async () => {
  const state = await streaming();
  const binary = delayedBlob(makeFrame());
  const result = state.connection.receive(binary.blob);
  await binary.started;
  await state.connection.close();
  assert.equal(await result, false);
  binary.reject(new Error("late conversion failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.frames.length, 0);
  assert.equal(state.errors.length, 0);
  assert.deepEqual(acknowledgements(state.sent), []);
  await state.receiver.dispose();
});

test("Blob conversion failures, size changes, and oversized messages fail explicitly", { timeout: 2000 }, async () => {
  for (const result of ["reject", "wrong-size", "wrong-type"]) {
    const state = await streaming();
    const binary = delayedBlob(makeFrame());
    const receipt = state.connection.receive(binary.blob);
    await binary.started;
    if (result === "reject") binary.reject(new Error("conversion failed"));
    else binary.resolve(result === "wrong-size" ? new ArrayBuffer(1) : new Uint8Array(32));
    assert.equal(await receipt, false);
    assert.equal(state.errors[0].error.code, "InvalidMessage");
    assert.deepEqual(acknowledgements(state.sent), []);
    await state.receiver.dispose();
  }
  const state = await streaming();
  const binary = new Blob([new Uint8Array(AILOHA_VIDEO_RECEIVER_LIMITS.maxFrameBytes + 1)]);
  let converted = false;
  binary.arrayBuffer = () => { converted = true; return Promise.resolve(new ArrayBuffer(0)); };
  assert.equal(await state.connection.receive(binary), false);
  assert.equal(converted, false);
  assert.equal(state.errors[0].error.code, "InvalidMessage");
  await state.receiver.dispose();
});

test("validates geometry, backpressure, terminal flags, and optional control fields", async () => {
  const invalid = [
    {},
    { type: "paused" },
    { type: "resumed" },
    { type: "terminal" },
    { type: "hello" },
    { type: "ack", sequence: 0 },
    { type: "geometryChanged", geometryRevision: 1 },
    geometryChanged({ geometryRevision: -1 }),
    geometryChanged({ bounds: { x: 0, y: 0, width: -1, height: 0 } }),
    geometryChanged({ bounds: { x: null, y: 0, width: 0, height: 0 } }),
    geometryChanged({ bounds: { x: 0, y: 0, width: 0, height: 0, coordinate: "client" } }),
    geometryChanged({ bounds: { x: 0, y: 0, width: 0, height: 0, extra: true } }),
    geometryChanged({ pixelDensity: 0 }),
    geometryChanged({ pixelDensity: null }),
    geometryChanged({ orientation: "upside-down" }),
    { type: "backpressure", maxInFlightFrames: 8 },
    { type: "backpressure", maxInFlight: 0 },
    { type: "backpressure", maxInFlight: 65 },
    { type: "backpressure", maxInFlight: 8, recommendedFramesPerSecond: 0 },
    { type: "backpressure", maxInFlight: 8, dropBeforeSequence: -1 },
    { type: "backpressure", maxInFlight: 8, dropBeforeSequence: 0.5 },
    serverError({ terminal: undefined }),
    serverError({ terminal: "false" }),
    serverError({ sequence: -1 }),
    { type: "cancelled", reason: null },
    { type: "cancelled", terminal: true },
  ];
  for (const control of invalid) {
    const state = await streaming();
    assert.equal(await receiveControl(state, control), false, JSON.stringify(control));
    assert.equal(state.errors[0].error.code, "InvalidControl");
    assert.equal(state.connection.signal.aborted, true);
    await state.receiver.dispose();
  }
  const state = await streaming();
  const nonfinite = '{"type":"geometryChanged","geometryRevision":1,"bounds":{"x":1e400,"y":0,"width":1,"height":1}}';
  assert.equal(await state.connection.receive(nonfinite), false);
  assert.equal(state.errors[0].error.code, "InvalidControl");
  await state.receiver.dispose();
});

test("allows zero-sized bounds and omitted geometry metadata without inventing fields", async () => {
  const delivered = [];
  const state = await streaming({
    onControl(control, delivery) { delivered.push([control, delivery.geometry]); },
  });
  const control = geometryChanged({
    bounds: { x: -0.5, y: 1.25, width: 0, height: 0 },
    pixelDensity: undefined,
    orientation: undefined,
  });
  assert.equal(await receiveControl(state, control), true);
  const [actual, geometry] = delivered[1];
  assert.deepEqual(actual.bounds, { x: -0.5, y: 1.25, width: 0, height: 0 });
  assert.equal(Object.hasOwn(actual, "pixelDensity"), false);
  assert.equal(Object.hasOwn(actual, "orientation"), false);
  assert.equal(geometry.geometryRevision, 1);
  assert.equal(Object.hasOwn(geometry.bounds, "coordinate"), false);
  await state.receiver.dispose();
});

test("rejects regressed geometry, mismatched frame revisions, and regressed drop floors", async () => {
  for (const failureCase of ["regressed-geometry", "unannounced-frame", "old-frame", "regressed-drop"]) {
    const state = await streaming();
    let result;
    if (failureCase === "regressed-drop") {
      await state.connection.receive(makeFrame());
      result = receiveControl(state, { type: "backpressure", maxInFlight: 8, dropBeforeSequence: 0 });
    } else if (failureCase === "regressed-geometry") {
      await receiveControl(state, geometryChanged({ geometryRevision: 2 }));
      result = receiveControl(state, geometryChanged({ geometryRevision: 1 }));
    } else {
      if (failureCase === "old-frame") await receiveControl(state, geometryChanged({ geometryRevision: 2 }));
      result = state.connection.receive(makeFrame({ geometryRevision: failureCase === "old-frame" ? 1 : 2 }));
    }
    assert.equal(await result, false);
    assert.equal(state.errors[0].error.code, failureCase === "regressed-drop" ? "SequenceMismatch" : "GeometryMismatch");
    await state.receiver.dispose();
  }
});

test("nonterminal server errors preserve channel, ACK, geometry, and keyframe state", async () => {
  const scopes = [];
  const state = await streaming({
    onFrame(frame, delivery) { scopes.push(delivery); return true; },
  });
  await receiveControl(state, geometryChanged());
  await state.connection.receive(makeFrame());
  const error = serverError({ sequence: 12345 });
  assert.equal(await receiveControl(state, error), true);
  assert.equal(state.connection.signal.aborted, false);
  assert.equal(state.connection.phase, "streaming");
  assert.equal(state.receiver.lastAcknowledgedSequence, 0);
  assert.equal(state.errors[0].error.code, "ServerError");
  assert.equal(state.errors[0].error.control.terminal, false);
  assert.equal(await state.connection.receive(makeFrame({ sequence: 1, flags: 0 })), true);
  assert.equal(scopes[1].geometry.geometryRevision, 1);
  assert.equal(scopes[1].needsKeyFrame, false);
  assert.equal(scopes[1].canDecode, true);
  assert.deepEqual(acknowledgements(state.sent), [0, 1]);
  await state.receiver.dispose();
});

test("sanitizes permitted ProblemDetails extensions and preserves immutable diagnostics", async () => {
  const state = await streaming();
  const error = serverError();
  error.problem.ignored = { value: "not-forwarded" };
  error.problem["x-ailoha-target-host"].ignored = "not-forwarded";
  assert.equal(await receiveControl(state, error), true);
  const problem = state.errors[0].error.control.problem;
  assert.equal(problem.type, "urn:devflow:error:unsupported");
  assert.equal(problem.status, 400);
  assert.equal(problem.instance, "/video/session");
  assert.equal(problem.errorCode, "unsupported");
  assert.equal(problem["x-ailoha-target-host"].targetId, "target");
  assert.equal(Object.hasOwn(problem, "ignored"), false);
  assert.equal(Object.hasOwn(problem["x-ailoha-target-host"], "ignored"), false);
  assert.equal(Object.isFrozen(problem), true);
  assert.equal(Object.isFrozen(problem["x-ailoha-target-host"]), true);
  await state.receiver.dispose();
});

test("rejects malformed ProblemDetails instead of turning them into ordinary diagnostics", async () => {
  for (const problem of [
    null,
    {},
    { type: "bad uri", title: "bad", status: 400 },
    { type: "%xx", title: "bad", status: 400 },
    { type: "about:blank", title: null, status: 400 },
    { type: "about:blank", title: "bad", status: 99 },
    { type: "about:blank", title: "bad", status: 600 },
    { type: "about:blank", title: "bad", status: 400.5 },
    { type: "about:blank", title: "bad", status: 400, detail: null },
    { type: "about:blank", title: "bad", status: 400, instance: "bad uri" },
    { type: "about:blank", title: "bad", status: 400, errorCode: false },
    { type: "about:blank", title: "bad", status: 400, "x-ailoha-target-host": {} },
    { type: "about:blank", title: "bad", status: 400, "x-ailoha-target-host": { targetId: "target", geometryRevision: -1 } },
  ]) {
    const state = await streaming();
    assert.equal(await receiveControl(state, serverError({ problem })), false);
    assert.equal(state.errors[0].error.code, "InvalidControl");
    await state.receiver.dispose();
  }
  const state = await streaming();
  assert.equal(await receiveControl(state, serverError({
    problem: { type: "../relative-error", title: "", status: 599 },
  })), true);
  await state.receiver.dispose();
});

test("terminal server errors and cancelled controls immediately retire pending consumption", { timeout: 2000 }, async () => {
  for (const control of [
    serverError({ terminal: true }),
    { type: "cancelled", reason: "client-requested" },
    { type: "cancelled" },
  ]) {
    const gate = deferred();
    const started = deferred();
    const painted = [];
    const state = await streaming({
      async onFrame(frame, delivery) {
        started.resolve();
        await gate.promise;
        delivery.commit(() => painted.push(frame.sequence));
        return true;
      },
    });
    const first = state.connection.receive(makeFrame());
    const second = state.connection.receive(makeFrame({ sequence: 1 }));
    await started.promise;
    assert.equal(await receiveControl(state, control), false);
    assert.deepEqual(await Promise.all([first, second]), [false, false]);
    assert.equal(state.errors[0].error.code, control.type === "error" ? "ServerError" : "ServerCancelled");
    assert.equal(state.errors[0].delivery.context, state.receiver.context);
    assert.equal(state.errors[0].delivery.signal, state.connection.signal);
    assert.equal(state.connection.signal.aborted, true);
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(painted, []);
    assert.deepEqual(acknowledgements(state.sent), []);
    await state.receiver.dispose();
    assert.equal(state.closed.length, 1);
  }
});

test("consumer exceptions, rejection, and missing positive confirmation stop without ACK", async () => {
  for (const onFrame of [
    () => { throw new Error("consumer failed"); },
    () => Promise.reject(new Error("consumer failed")),
    () => false,
    () => undefined,
    () => "consumed",
    (_frame, delivery) => { delivery.commit(() => Promise.resolve()); return true; },
  ]) {
    const state = await streaming({ onFrame });
    assert.equal(await state.connection.receive(makeFrame()), false);
    assert.equal(state.errors[0].error.code, "ConsumerFailed");
    assert.deepEqual(acknowledgements(state.sent), []);
    await state.receiver.dispose();
    assert.equal(state.closed.length, 1);
  }
  const state = await streaming({
    onControl(control) {
      if (control.type === "geometryChanged") throw new Error("geometry consumer failed");
    },
  });
  assert.equal(await receiveControl(state, geometryChanged()), false);
  assert.equal(state.errors[0].error.code, "ConsumerFailed");
  await state.receiver.dispose();
});

test("close releases unresolved consumers and queues before their callbacks finish", { timeout: 2000 }, async () => {
  const gate = deferred();
  const started = deferred();
  const painted = [];
  let delivery;
  const state = await streaming({
    async onFrame(frame, scope) {
      delivery = scope;
      started.resolve();
      await gate.promise;
      scope.commit(() => painted.push(frame.sequence));
      return true;
    },
  });
  const first = state.connection.receive(makeFrame());
  const second = state.connection.receive(makeFrame({ sequence: 1 }));
  await started.promise;
  await state.connection.close();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(delivery.signal.aborted, true);
  assert.equal(delivery.isCurrent(), false);
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(painted, []);
  assert.equal(state.errors.length, 0);
  assert.deepEqual(acknowledgements(state.sent), []);
  await state.receiver.dispose();
});

test("old consumption callbacks cannot paint, report failure, or ACK into a replacement", { timeout: 2000 }, async () => {
  const gate = deferred();
  const started = deferred();
  const painted = [];
  const state = await streaming({
    async onFrame(frame, delivery) {
      if (frame.sequence === 0) {
        started.resolve();
        await gate.promise;
        delivery.commit(() => painted.push(0));
        throw new Error("late old consumer failure");
      }
      delivery.commit(() => painted.push(frame.sequence));
      return true;
    },
  });
  const old = state.connection.receive(makeFrame());
  await started.promise;
  const sent = [];
  const replacement = state.receiver.attach({
    protocol: AILOHA_VIDEO_SUBPROTOCOL,
    send: (text) => sent.push(JSON.parse(text)),
    close() {},
  });
  assert.equal(await old, false);
  await replacement.start();
  assert.equal(sent[0].lastAcknowledgedSequence, -1);
  assert.equal(await replacement.receive(JSON.stringify(ready({ resumeFromSequence: 5 }))), true);
  assert.equal(await replacement.receive(makeFrame({ sequence: 5 })), true);
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(painted, [5]);
  assert.deepEqual(acknowledgements(state.sent), []);
  assert.deepEqual(acknowledgements(sent), [5]);
  assert.equal(state.receiver.lastAcknowledgedSequence, 5);
  assert.equal(state.errors.length, 0);
  await state.receiver.dispose();
});

test("late old send completion cannot emit an ACK or overwrite a replacement cursor", { timeout: 2000 }, async () => {
  const gate = deferred();
  const started = deferred();
  const oldSent = [];
  const state = await streaming({
    async send(text, delivery) {
      const control = JSON.parse(text);
      if (control.type === "ack") { started.resolve(); await gate.promise; }
      delivery.commit(() => oldSent.push(control));
    },
  });
  const old = state.connection.receive(makeFrame());
  await started.promise;
  const sent = [];
  const replacement = state.receiver.attach({
    protocol: AILOHA_VIDEO_SUBPROTOCOL,
    send: (text) => sent.push(JSON.parse(text)),
    close() {},
  });
  assert.equal(await old, false);
  await replacement.start();
  await replacement.receive(JSON.stringify(ready({ resumeFromSequence: 5 })));
  assert.equal(await replacement.receive(makeFrame({ sequence: 5 })), true);
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(acknowledgements(oldSent), []);
  assert.deepEqual(acknowledgements(sent), [5]);
  assert.equal(state.receiver.lastAcknowledgedSequence, 5);
  assert.equal(state.errors.length, 0);
  await state.receiver.dispose();
});

test("sends only supported client controls and does not invent command barriers or replies", async () => {
  const state = await streaming();
  for (const command of ["requestKeyFrame", "pause", "resume", "cancel"]) {
    assert.equal(await state.connection.control(command), true);
    assert.equal(state.connection.phase, "streaming");
  }
  assert.deepEqual(state.sent.slice(1), [
    { type: "control", command: "requestKeyFrame" },
    { type: "control", command: "pause" },
    { type: "control", command: "resume" },
    { type: "control", command: "cancel" },
  ]);
  for (const command of ["Pause", "keyframe", "terminal", null, { command: "pause" }]) {
    assert.throws(() => state.connection.control(command), /Unsupported video control command/);
  }
  assert.equal(state.connection.signal.aborted, false);
  assert.equal(await receiveControl(state, { type: "cancelled", reason: "client-requested" }), false);
  await state.receiver.dispose();
  assert.equal(state.closed.length, 1);

  const unready = harness();
  await unready.connection.start();
  assert.equal(await unready.connection.control("pause"), false);
  assert.equal(unready.errors[0].error.code, "NotReady");
  await unready.receiver.dispose();
});

test("plain close requires no cancelled JSON and sends no stop/delete/device operation", async () => {
  const state = await streaming();
  assert.equal(await state.connection.close(), true);
  assert.equal(await state.connection.control("cancel"), false);
  assert.deepEqual(state.sent, [{
    type: "hello", videoSessionId: "video-session", lastAcknowledgedSequence: -1, maxInFlightFrames: 8,
  }]);
  assert.equal(state.errors.length, 0);
  assert.equal(state.closed.length, 1);
  await state.receiver.dispose();
});

test("outgoing command work is bounded and released on overflow", { timeout: 2000 }, async () => {
  const gate = deferred();
  const started = deferred();
  const sent = [];
  const state = await streaming({
    send(text) {
      const control = JSON.parse(text);
      sent.push(control);
      if (control.type === "control") { started.resolve(); return gate.promise; }
    },
  });
  const pending = [state.connection.control("pause")];
  await started.promise;
  for (let index = 1; index < AILOHA_VIDEO_RECEIVER_LIMITS.maxBufferedMessages; index += 1) {
    pending.push(state.connection.control("requestKeyFrame"));
  }
  assert.equal(state.errors.length, 0);
  assert.equal(await state.connection.control("resume"), false);
  assert.deepEqual(await Promise.all(pending), Array(pending.length).fill(false));
  assert.equal(state.errors[0].error.code, "QueueOverflow");
  gate.resolve();
  await state.receiver.dispose();
  assert.deepEqual(sent.map((control) => control.type), ["hello", "control"]);
});

test("transport send failures are explicit and never advance the ACK cursor", async () => {
  for (const send of [
    () => { throw new Error("hello send failed"); },
    () => Promise.reject(new Error("hello send failed")),
    () => false,
    () => Promise.resolve(false),
  ]) {
    const state = harness({ send });
    assert.equal(await state.connection.start(), false);
    assert.equal(state.errors[0].error.code, "TransportFailed");
    assert.equal(state.receiver.lastAcknowledgedSequence, -1);
    await state.receiver.dispose();
    assert.equal(state.closed.length, 1);
  }
  const state = await streaming({
    send(text) {
      if (JSON.parse(text).type === "ack") throw new Error("ACK send failed");
    },
  });
  const first = state.connection.receive(makeFrame());
  const second = state.connection.receive(makeFrame({ sequence: 1 }));
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(state.errors[0].error.code, "TransportFailed");
  assert.equal(state.receiver.lastAcknowledgedSequence, -1);
  assert.equal(state.frames.length, 1);
  await state.receiver.dispose();

  for (const type of ["ack", "control"]) {
    const declined = await streaming({
      send(text) { return JSON.parse(text).type === type ? false : undefined; },
    });
    const result = type === "ack"
      ? declined.connection.receive(makeFrame())
      : declined.connection.control("requestKeyFrame");
    assert.equal(await result, false);
    assert.equal(declined.errors[0].error.code, "TransportFailed");
    assert.equal(declined.receiver.lastAcknowledgedSequence, -1);
    await declined.receiver.dispose();
  }
});

test("close aborts a pending hello send without reporting its late rejection", { timeout: 2000 }, async () => {
  const gate = deferred();
  const dispatched = deferred();
  const state = harness({
    send() { dispatched.resolve(); return gate.promise; },
  });
  const started = state.connection.start();
  await dispatched.promise;
  await state.connection.close();
  assert.equal(await started, false);
  gate.reject(new Error("late send failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.errors.length, 0);
  assert.equal(state.receiver.lastAcknowledgedSequence, -1);
  await state.receiver.dispose();
});

test("close aborts pending control application and its late guarded mutation", { timeout: 2000 }, async () => {
  const gate = deferred();
  const started = deferred();
  const applied = [];
  const state = harness({
    async onControl(control, delivery) {
      if (control.type === "ready") {
        started.resolve();
        await gate.promise;
      }
      delivery.commit(() => applied.push(control.type));
    },
  });
  await state.connection.start();
  const readyReceipt = receiveControl(state, ready());
  const frame = state.connection.receive(makeFrame());
  await started.promise;
  await state.connection.close();
  assert.deepEqual(await Promise.all([readyReceipt, frame]), [false, false]);
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, []);
  assert.deepEqual(acknowledgements(state.sent), []);
  await state.receiver.dispose();
});

test("dispose is idempotent even when a consumer calls it reentrantly on abort", async () => {
  const state = harness();
  let reentrant;
  state.connection.signal.addEventListener("abort", () => { reentrant = state.receiver.dispose(); });
  const disposed = state.receiver.dispose();
  assert.equal(disposed, reentrant);
  assert.equal(await disposed, true);
  assert.equal(state.closed.length, 1);
});

test("uint32 exhaustion is explicit and never becomes wrap or resynchronization", async () => {
  const state = await streaming({}, { resumeFromSequence: 0xffffffff });
  assert.equal(await state.connection.receive(makeFrame({ sequence: 0xffffffff })), true);
  assert.equal(await state.connection.receive(makeFrame({ sequence: 0 })), false);
  assert.equal(state.errors[0].error.code, "SequenceExhausted");
  assert.deepEqual(acknowledgements(state.sent), [0xffffffff]);
  await state.receiver.dispose();
  for (const resumeFromSequence of [0x100000000, Number.MAX_SAFE_INTEGER]) {
    const exhausted = harness();
    await exhausted.connection.start();
    assert.equal(await receiveControl(exhausted, ready({ resumeFromSequence })), false);
    assert.equal(exhausted.errors[0].error.code, "SequenceExhausted");
    assert.equal(exhausted.controls.length, 0);
    await exhausted.receiver.dispose();
  }
  const dropped = await streaming();
  assert.equal(await receiveControl(dropped, {
    type: "backpressure", maxInFlight: 8, dropBeforeSequence: 0x100000000,
  }), false);
  assert.equal(dropped.errors[0].error.code, "SequenceExhausted");
  await dropped.receiver.dispose();
});

test("an exhausted ready floor cannot rewind to zero on a later attachment", async (t) => {
  const state = harness();
  t.after(() => state.receiver.dispose());
  assert.equal(await state.connection.start(), true);
  assert.equal(await receiveControl(state, ready({ resumeFromSequence: 0x100000000 })), false);
  assert.equal(state.errors.at(-1).error.code, "SequenceExhausted");
  const wrapped = state.receiver.attach(state.transport);
  assert.equal(await wrapped.start(), true);
  assert.equal(await wrapped.receive(JSON.stringify(ready({ resumeFromSequence: 0 }))), false);
  assert.equal(wrapped.signal.aborted, true);
  assert.equal(state.errors.at(-1).error.code, "SequenceMismatch");
  assert.deepEqual(acknowledgements(state.sent), []);
  assert.equal(state.receiver.lastAcknowledgedSequence, -1);
  assert.equal(state.frames.length, 0);
});

test("terminal exhaustion need not drain the maximum sequence or acknowledge it", { timeout: 2000 }, async () => {
  const started = deferred();
  const gate = deferred();
  const state = await streaming({
    async onFrame() { started.resolve(); await gate.promise; return true; },
  }, { resumeFromSequence: 0xffffffff });
  const last = state.connection.receive(makeFrame({ sequence: 0xffffffff }));
  await started.promise;
  assert.equal(await receiveControl(state, serverError({
    terminal: true,
    problem: {
      type: "urn:devflow:error:internal-error",
      title: "Stream failed",
      status: 500,
      detail: "The ALHV sequence space is exhausted.",
    },
  })), false);
  assert.equal(await last, false);
  assert.deepEqual(acknowledgements(state.sent), []);
  gate.resolve();
  await state.receiver.dispose();
});

test("backpressure updates the local window without resetting consumed state when no drop is present", { timeout: 2000 }, async () => {
  const gate = deferred();
  const started = deferred();
  const state = await streaming({
    async onFrame(frame, delivery) {
      if (frame.sequence === 1) {
        assert.equal(delivery.needsKeyFrame, false);
        started.resolve();
        await gate.promise;
      }
      return true;
    },
  });
  await state.connection.receive(makeFrame());
  assert.equal(await receiveControl(state, { type: "backpressure", maxInFlight: 1 }), true);
  assert.equal(state.receiver.lastAcknowledgedSequence, 0);
  const pending = state.connection.receive(makeFrame({ sequence: 1, flags: 0 }));
  await started.promise;
  assert.equal(await state.connection.receive(makeFrame({ sequence: 2, flags: 0 })), false);
  assert.equal(await pending, false);
  assert.equal(state.errors[0].error.code, "QueueOverflow");
  gate.resolve();
  await state.receiver.dispose();
});

for (const [style, preparedRoot] of [
  ["github-canvas", new URL("../../.build/copilot-plugin-thin/mobile-canvas/", import.meta.url)],
  ["vscode-webview", new URL("../../vscode/dist/", import.meta.url)],
]) {
  test(`${style} prepared receiver consumes, ACKs, controls, and retires its own generation`, {
    timeout: 2000,
  }, async (t) => {
    for (const relative of ["ailoha-video-protocol.js", "ailoha-video-receiver.js"]) {
      assert.deepEqual(
        readFileSync(new URL(`../../web/${relative}`, import.meta.url)),
        readFileSync(new URL(`web/${relative}`, preparedRoot)),
        `${style}: ${relative}`,
      );
    }
    const module = await import(new URL("web/ailoha-video-receiver.js", preparedRoot).href);
    assert.equal(module.AILOHA_VIDEO_SUBPROTOCOL, AILOHA_VIDEO_SUBPROTOCOL);
    assert.deepEqual(module.AILOHA_VIDEO_RECEIVER_LIMITS, AILOHA_VIDEO_RECEIVER_LIMITS);
    const consumed = [];
    const retired = [];
    const latePaint = [];
    const lateCommit = [];
    const gate = deferred();
    const pendingStarted = deferred();
    const state = await streaming({
      createReceiver: module.createAilohaVideoReceiver,
      context: { videoSessionId: "video-session", ownerId: style },
      async onFrame(frame, delivery) {
        assert.equal(delivery.context.ownerId, style);
        assert.equal(Object.isFrozen(delivery.context), true);
        if (frame.sequence === 22) {
          pendingStarted.resolve(delivery);
          await gate.promise;
          lateCommit.push(delivery.commit(() => latePaint.push(frame.sequence)));
        } else if (delivery.canDecode) {
          assert.equal(delivery.commit(() => consumed.push([
            frame.sequence, delivery.context, delivery.canPresent,
            delivery.geometry?.geometryRevision ?? null, frame.timestampMicroseconds,
          ])), true);
        } else {
          assert.equal(delivery.commit(() => latePaint.push(frame.sequence)), false);
          retired.push(frame.sequence);
        }
        return true;
      },
    }, { resumeFromSequence: 8, maxInFlightFrames: 1 });
    t.after(() => state.receiver.dispose());
    const events = new EventTarget();
    let receipt;
    events.addEventListener("message", (event) => {
      if (style === "vscode-webview") {
        if (event.data.type !== "socket-message" || event.data.id !== "owned-channel") {
          receipt = Promise.resolve(false);
          return;
        }
        receipt = state.connection.receive(event.data.data);
      } else {
        receipt = state.connection.receive(event.data);
      }
    });
    const deliver = (data, id = "owned-channel") => {
      events.dispatchEvent(new MessageEvent("message", {
        data: style === "vscode-webview" ? { type: "socket-message", id, data } : data,
      }));
      return receipt;
    };
    if (style === "vscode-webview") {
      assert.equal(await deliver(makeFrame({ sequence: 999 }), "another-channel"), false);
      assert.equal(state.errors.length, 0);
    }
    assert.equal(await deliver(JSON.stringify(geometryChanged())), true);
    assert.equal(await deliver(makeFrame({ sequence: 8, flags: 2 }).buffer), true);
    assert.equal(await deliver(makeFrame({ sequence: 9 })), true);
    assert.deepEqual(consumed, [
      [8, state.receiver.context, false, 1, 0x0102030405060708n],
      [9, state.receiver.context, true, 1, 0x0102030405060708n],
    ]);
    assert.deepEqual(acknowledgements(state.sent), [8, 9]);
    for (const command of ["requestKeyFrame", "pause", "resume"]) {
      assert.equal(await state.connection.control(command), true);
    }
    assert.deepEqual(state.sent.filter(({ type }) => type === "control"), [
      { type: "control", command: "requestKeyFrame" },
      { type: "control", command: "pause" },
      { type: "control", command: "resume" },
    ]);
    assert.equal(await deliver(JSON.stringify(serverError())), true);
    assert.equal(state.connection.signal.aborted, false);
    assert.equal(state.receiver.lastAcknowledgedSequence, 9);
    assert.equal(await deliver(JSON.stringify({
      type: "backpressure", maxInFlight: 1, dropBeforeSequence: 18,
    })), true);
    assert.deepEqual(acknowledgements(state.sent), [8, 9]);
    assert.equal(await deliver(JSON.stringify(geometryChanged({ geometryRevision: 2 }))), true);
    assert.equal(await deliver(makeFrame({ sequence: 18, flags: 2, geometryRevision: 2 })), true);
    assert.equal(await deliver(makeFrame({ sequence: 19, flags: 0, geometryRevision: 2 })), true);
    assert.deepEqual(retired, [19]);
    assert.equal(await deliver(makeFrame({ sequence: 20, geometryRevision: 2 })), true);
    assert.equal(await deliver(makeFrame({ sequence: 21, flags: 0, geometryRevision: 2 })), true);
    assert.deepEqual(acknowledgements(state.sent), [8, 9, 18, 19, 20, 21]);
    const pending = deliver(makeFrame({ sequence: 22, flags: 0, geometryRevision: 2 }));
    const oldScope = await pendingStarted.promise;
    const replacementSent = [];
    const replacementClosed = [];
    const replacement = state.receiver.attach({
      protocol: module.AILOHA_VIDEO_SUBPROTOCOL,
      send(text, delivery) {
        assert.equal(delivery.context, state.receiver.context);
        return delivery.commit(() => replacementSent.push(JSON.parse(text)));
      },
      close() {
        replacementClosed.push(true);
        return true;
      },
    });
    assert.equal(await pending, false);
    assert.equal(oldScope.signal.aborted, true);
    assert.equal(await replacement.start(), true);
    assert.equal(replacementSent[0].lastAcknowledgedSequence, 21);
    assert.equal(await replacement.receive(JSON.stringify(ready({
      geometryRevision: 3, resumeFromSequence: 23, maxInFlightFrames: 1,
    }))), true);
    assert.equal(await replacement.receive(makeFrame({ sequence: 23, geometryRevision: 3 })), true);
    assert.equal(consumed.at(-1)[3], null);
    assert.equal(await deliver(makeFrame({ sequence: 23, geometryRevision: 3 })), false);
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(lateCommit, [false]);
    assert.deepEqual(latePaint, []);
    assert.deepEqual(acknowledgements(state.sent), [8, 9, 18, 19, 20, 21]);
    assert.deepEqual(acknowledgements(replacementSent), [23]);
    assert.equal(state.receiver.lastAcknowledgedSequence, 23);
    assert.equal(await replacement.control("cancel"), true);
    assert.deepEqual(replacementSent.at(-1), { type: "control", command: "cancel" });
    assert.equal(await replacement.receive('{"type":"cancelled","reason":"client-requested"}'), false);
    assert.equal(replacement.signal.aborted, true);
    assert.equal(await replacement.close(), true);
    assert.deepEqual(replacementClosed, [true]);
    assert.equal(state.errors.at(-1).error.code, "ServerCancelled");
    assert.deepEqual(Object.keys(state.receiver.context).sort(), ["ownerId", "videoSessionId"]);
    assert.ok([...state.sent, ...replacementSent].every((control) =>
      !Object.hasOwn(control, "afterSequence") && !Object.hasOwn(control, "authorization")
      && !Object.hasOwn(control, "controlCredential")));
    const exhaustionSent = [];
    const exhaustionTransport = {
      protocol: module.AILOHA_VIDEO_SUBPROTOCOL,
      send(text, delivery) {
        return delivery.commit(() => exhaustionSent.push(JSON.parse(text)));
      },
      close() { return true; },
    };
    const exhausted = state.receiver.attach(exhaustionTransport);
    assert.equal(await exhausted.start(), true);
    assert.equal(await exhausted.receive(JSON.stringify(ready({
      geometryRevision: 3, resumeFromSequence: 0x100000000,
    }))), false);
    assert.equal(state.errors.at(-1).error.code, "SequenceExhausted");
    const rewound = state.receiver.attach(exhaustionTransport);
    assert.equal(await rewound.start(), true);
    assert.equal(await rewound.receive(JSON.stringify(ready({
      geometryRevision: 3, resumeFromSequence: 24,
    }))), false);
    assert.equal(state.errors.at(-1).error.code, "SequenceMismatch");
    assert.deepEqual(acknowledgements(exhaustionSent), []);
    assert.equal(state.receiver.lastAcknowledgedSequence, 23);
    await state.receiver.dispose();
    assert.equal(state.closed.length, 1);
  });
}
