import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MAX_AILOHA_VIDEO_PAYLOAD_BYTES,
  parseAilohaVideoFrame,
} from "../../web/ailoha-video-protocol.js";

const HEADER_BYTES = 28;
const protocolPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "web",
  "ailoha-video-protocol.js",
);

function makePacket({
  sequence = 0x12345678,
  timestampMicroseconds = 0x0102030405060708n,
  geometryRevision = 0x90abcdef,
  flags = 0,
  payload = [0, 0, 1, 0x65],
} = {}) {
  const packet = new Uint8Array(HEADER_BYTES + payload.length);
  packet.set([0x41, 0x4c, 0x48, 0x56, 1, flags], 0);
  const view = new DataView(packet.buffer);
  view.setUint32(8, sequence, false);
  view.setBigUint64(12, timestampMicroseconds, false);
  view.setUint32(20, geometryRevision, false);
  view.setUint32(24, payload.length, false);
  packet.set(payload, HEADER_BYTES);
  return packet;
}

test("parses flags and asymmetric big-endian fields", () => {
  for (const [flags, isKeyFrame, isCodecConfig] of [
    [0, false, false],
    [1, true, false],
    [2, false, true],
    [3, true, true],
  ]) {
    const frame = parseAilohaVideoFrame(makePacket({ flags }));
    assert.equal(frame.sequence, 0x12345678);
    assert.equal(frame.timestampMicroseconds, 0x0102030405060708n);
    assert.equal(frame.geometryRevision, 0x90abcdef);
    assert.equal(frame.isKeyFrame, isKeyFrame);
    assert.equal(frame.isCodecConfig, isCodecConfig);
    assert.deepEqual([...frame.payload], [0, 0, 1, 0x65]);
  }
});

test("preserves uint32 maxima and uint64 timestamps above Number precision", () => {
  const frame = parseAilohaVideoFrame(makePacket({
    sequence: 0xffffffff,
    timestampMicroseconds: 0xffffffffffffffffn,
    geometryRevision: 0xffffffff,
  }));
  assert.equal(frame.sequence, 0xffffffff);
  assert.equal(frame.timestampMicroseconds, 0xffffffffffffffffn);
  assert.equal(frame.geometryRevision, 0xffffffff);
  assert.equal(frame.timestampMicroseconds > BigInt(Number.MAX_SAFE_INTEGER), true);
});

test("accepts ArrayBuffer, Buffer, and typed-array subviews with exact offsets", () => {
  const packet = makePacket();
  assert.equal(parseAilohaVideoFrame(packet.buffer).sequence, 0x12345678);
  assert.equal(parseAilohaVideoFrame(Buffer.from(packet)).sequence, 0x12345678);

  const surrounding = new Uint8Array(packet.length + 8).fill(0xff);
  surrounding.set(packet, 4);
  const subview = surrounding.subarray(4, 4 + packet.length);
  assert.equal(parseAilohaVideoFrame(subview).sequence, 0x12345678);
});

test("returns a zero-copy payload view without mutating the packet", () => {
  const packet = makePacket();
  const before = packet.slice();
  const frame = parseAilohaVideoFrame(packet);

  assert.equal(frame.payload.buffer, packet.buffer);
  assert.equal(frame.payload.byteOffset, packet.byteOffset + HEADER_BYTES);
  assert.deepEqual(packet, before);
  frame.payload[0] = 0x7f;
  assert.equal(packet[HEADER_BYTES], 0x7f);
});

test("accepts a payload exactly at the configured bound and rejects bound plus one", () => {
  const frame = parseAilohaVideoFrame(makePacket({ payload: [1, 2, 3] }), {
    maxPayloadBytes: 3,
  });
  assert.equal(frame.payload.byteLength, 3);
  assert.throws(
    () => parseAilohaVideoFrame(makePacket({ payload: [1, 2, 3, 4] }), {
      maxPayloadBytes: 3,
    }),
    /exceeds 3 bytes/,
  );
});

test("uses a documented finite default payload bound", () => {
  assert.equal(MAX_AILOHA_VIDEO_PAYLOAD_BYTES, 8 * 1024 * 1024);
  const oversized = makePacket({ payload: [1] });
  new DataView(oversized.buffer).setUint32(
    24,
    MAX_AILOHA_VIDEO_PAYLOAD_BYTES + 1,
    false,
  );
  assert.throws(() => parseAilohaVideoFrame(oversized), /exceeds 8388608 bytes/);
  assert.throws(
    () => parseAilohaVideoFrame(makePacket({ payload: [1] }), {
      maxPayloadBytes: 0,
    }),
    /positive safe integer/,
  );
  for (const maxPayloadBytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    assert.throws(
      () => parseAilohaVideoFrame(makePacket({ payload: [1] }), { maxPayloadBytes }),
      /positive safe integer/,
    );
  }
  assert.throws(
    () => parseAilohaVideoFrame(makePacket({ payload: [1] }), null),
    TypeError,
  );
});

test("rejects unsupported inputs and short headers", () => {
  for (const input of [null, undefined, "video", new DataView(new ArrayBuffer(28))]) {
    assert.throws(() => parseAilohaVideoFrame(input), /input must be/);
  }
  assert.throws(() => parseAilohaVideoFrame(new Uint8Array(HEADER_BYTES - 1)), /header/);
});

test("rejects invalid magic, version, flags, and reserved bytes", () => {
  for (const [offset, value, message] of [
    [0, 0, /magic/],
    [4, 2, /version/],
    [5, 4, /unknown flags/],
    [6, 1, /reserved/],
  ]) {
    const packet = makePacket();
    packet[offset] = value;
    assert.throws(() => parseAilohaVideoFrame(packet), message);
  }
});

test("rejects empty, oversized, truncated, and trailing payloads", () => {
  const empty = makePacket({ payload: [] });
  assert.throws(() => parseAilohaVideoFrame(empty), /must not be empty/);

  const oversized = makePacket({ payload: [1, 2] });
  new DataView(oversized.buffer).setUint32(24, 3, false);
  assert.throws(() => parseAilohaVideoFrame(oversized), /length does not match/);

  const truncated = makePacket({ payload: [1, 2] }).subarray(0, HEADER_BYTES + 1);
  assert.throws(() => parseAilohaVideoFrame(truncated), /length does not match/);

  const trailing = new Uint8Array(makePacket({ payload: [1] }).length + 1);
  trailing.set(makePacket({ payload: [1] }));
  assert.throws(() => parseAilohaVideoFrame(trailing), /length does not match/);
});

test("shared source is a browser-safe ES module", () => {
  const source = readFileSync(protocolPath, "utf8");
  assert.doesNotMatch(source, /\bfrom\s+["']node:|require\s*\(|\bprocess\b|\bBuffer\b/);
});
