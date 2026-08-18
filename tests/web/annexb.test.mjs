import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AnnexBParser,
  codecFromParameterSet,
  concatBytes,
  findStartCodes,
  IDLE_NAL_FLUSH_MS,
  nalPrefixLength,
  nalUnitType,
} from "../../web/annexb.js";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const mobile = readFileSync(join(webRoot, "device-canvas.js"), "utf8");
const windows = readFileSync(join(webRoot, "windows", "windows-canvas.js"), "utf8");

const LONG_START = [0, 0, 0, 1];
const SHORT_START = [0, 0, 1];

function nal(start, header, ...payload) {
  return new Uint8Array([...start, header, ...payload]);
}

/** An SPS carrying High profile (0x64), no constraints, level 3.1 (0x1f). */
const sps = nal(LONG_START, 0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9);
const pps = nal(LONG_START, 0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0);
const idr = nal(LONG_START, 0x65, 0x88, 0x84, 0x00, 0x10);
const delta = nal(SHORT_START, 0x41, 0x9a, 0x24, 0x6c, 0x40);

/** A parser whose idle flush is driven by the test rather than by the event loop. */
function createParser(overrides = {}) {
  const timers = [];
  const parser = new AnnexBParser({
    onAccessUnit: () => {},
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => {},
    ...overrides,
  });
  return { parser, fireIdle: () => timers.pop()?.() };
}

test("concatBytes joins chunks in order", () => {
  const joined = concatBytes([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])]);
  assert.deepEqual([...joined], [1, 2, 3]);
});

test("start codes are found in both the three and four byte forms", () => {
  const stream = concatBytes([sps, delta]);
  assert.deepEqual(findStartCodes(stream), [0, sps.length]);
  assert.equal(nalPrefixLength(sps), 4);
  assert.equal(nalPrefixLength(delta), 3);
});

test("NAL unit types are read past whichever start code was used", () => {
  assert.equal(nalUnitType(sps), 7);
  assert.equal(nalUnitType(pps), 8);
  assert.equal(nalUnitType(idr), 5);
  assert.equal(nalUnitType(delta), 1);
});

test("the codec string comes from the sequence parameter set", () => {
  assert.equal(codecFromParameterSet(sps), "avc1.64001f");
  assert.equal(codecFromParameterSet(nal(LONG_START, 0x67)), null);
});

test("parameter sets are prepended to the slice that follows them", () => {
  const units = [];
  const codecs = [];
  const { parser } = createParser({
    onAccessUnit: (unit) => units.push(unit),
    onCodec: (codec) => codecs.push(codec),
  });

  parser.push(concatBytes([sps, pps, idr, delta]));

  assert.deepEqual(codecs, ["avc1.64001f"]);
  assert.equal(units.length, 1, "the trailing NAL waits for the next one to prove it ended");
  assert.equal(units[0].type, "key");
  assert.deepEqual([...units[0].data], [...concatBytes([sps, pps, idr])]);
});

test("a gap in the stream flushes the trailing unit and reports the producer idle", () => {
  const units = [];
  let idleCount = 0;
  const { parser, fireIdle } = createParser({
    onAccessUnit: (unit) => units.push(unit),
    onIdle: () => { idleCount += 1; },
  });

  parser.push(concatBytes([sps, pps, idr, delta]));
  assert.equal(units.length, 1);

  fireIdle();
  assert.equal(units.length, 2);
  assert.equal(units[1].type, "delta");
  assert.deepEqual([...units[1].data], [...delta]);
  assert.equal(idleCount, 1);
});

test("split chunks are reassembled across pushes", () => {
  const units = [];
  const { parser, fireIdle } = createParser({ onAccessUnit: (unit) => units.push(unit) });
  const stream = concatBytes([sps, pps, idr]);

  parser.push(stream.slice(0, 3));
  parser.push(stream.slice(3, 11));
  parser.push(stream.slice(11));
  fireIdle();

  assert.equal(units.length, 1);
  assert.deepEqual([...units[0].data], [...stream]);
});

test("dispose drops buffered bytes so a restarted stream cannot inherit them", () => {
  const units = [];
  const { parser, fireIdle } = createParser({ onAccessUnit: (unit) => units.push(unit) });
  parser.push(concatBytes([sps, pps, idr]));
  parser.dispose();
  fireIdle();
  assert.deepEqual(units, []);
});

test("the idle flush interval is shared rather than redefined per product", () => {
  assert.equal(IDLE_NAL_FLUSH_MS, 120);
  assert.doesNotMatch(mobile, /IDLE_NAL_FLUSH_MS = /);
});

test("the mobile canvas decodes through the shared parser without losing its own behaviour", () => {
  assert.match(mobile, /import \{ AnnexBParser, concatBytes, IDLE_NAL_FLUSH_MS \} from "\.\/annexb\.js"/);
  assert.match(mobile, /new AnnexBParser\(\{/);
  // The idb reorder workaround and the emulator drain are mobile-specific and must survive.
  assert.match(mobile, /optimizeForLatency: this\.source !== "idb"/);
  assert.match(mobile, /shouldDrainIdleDecoder\(this\.source\)/);
  assert.match(mobile, /decoder\.flush\(\)/);
  // Framing itself is no longer duplicated in the product module.
  assert.doesNotMatch(mobile, /^function findStartCodes/m);
  assert.doesNotMatch(mobile, /^\s*handleNal\(nal\) \{/m);
});

test("the Windows canvas decodes through the same shared parser", () => {
  assert.match(windows, /import \{ AnnexBParser \} from "\.\.\/annexb\.js"/);
  assert.match(windows, /new AnnexBParser\(\{/);
  assert.match(windows, /avc: \{ format: "annexb" \}/);
  assert.doesNotMatch(windows, /function findStartCodes/);
});
