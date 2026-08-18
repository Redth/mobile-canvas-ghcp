/**
 * Annex-B H.264 framing, shared by every canvas that decodes a live stream.
 *
 * Both the Mobile and Windows hosts send the same thing over their video socket: raw Annex-B bytes
 * with no container, arriving in whatever sizes the socket happened to deliver. Turning that back
 * into access units is identical work in both products, so it lives here rather than being copied
 * per surface and drifting.
 *
 * This module deliberately knows nothing about WebCodecs, canvases, or the DOM. It reports NAL
 * boundaries and lets the caller decide what a decoder is, which is what makes it testable in Node
 * and reusable by a host that has no VideoDecoder at all.
 */

/** How long a gap in the byte stream means "the producer is done for now". */
export const IDLE_NAL_FLUSH_MS = 120;

export function concatBytes(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Offsets of every Annex-B start code in a buffer. Both the three-byte and four-byte forms are
 * recognised, because encoders mix them: parameter sets conventionally use the long form and slices
 * the short one.
 */
export function findStartCodes(bytes) {
  const starts = [];
  for (let index = 0; index < bytes.length - 3; index++) {
    if (bytes[index] === 0 && bytes[index + 1] === 0 &&
        (bytes[index + 2] === 1 || (bytes[index + 2] === 0 && bytes[index + 3] === 1))) {
      starts.push(index);
      index += bytes[index + 2] === 1 ? 2 : 3;
    }
  }
  return starts;
}

/** Length of the start code that opens a NAL unit: 3 for 00 00 01, 4 for 00 00 00 01. */
export function nalPrefixLength(nal) {
  return nal[2] === 1 ? 3 : 4;
}

/** The five-bit NAL unit type: 1 is a non-IDR slice, 5 an IDR slice, 7 an SPS, 8 a PPS. */
export function nalUnitType(nal) {
  return nal[nalPrefixLength(nal)] & 0x1f;
}

/**
 * The `avc1.PPCCLL` codec string carried by a sequence parameter set. WebCodecs needs the profile,
 * constraint flags, and level before it will configure, and the stream itself is the only place
 * they are stated.
 */
export function codecFromParameterSet(nal) {
  const prefixLength = nalPrefixLength(nal);
  if (nal.length < prefixLength + 4) return null;
  return `avc1.${[nal[prefixLength + 1], nal[prefixLength + 2], nal[prefixLength + 3]]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * The first Exp-Golomb value in every slice header is `first_mb_in_slice`. A value of zero starts a
 * new picture; a non-zero value is another slice of the current picture. Media Foundation commonly
 * emits several slices per frame, so treating every VCL NAL as a frame produces partial green
 * macroblock pictures in WebCodecs.
 */
export function firstMacroblockInSlice(nal) {
  const type = nalUnitType(nal);
  if (type !== 1 && type !== 5) return null;
  const prefixLength = nalPrefixLength(nal);
  const rbsp = new Uint8Array(16);
  let rbspLength = 0;
  let zeroRun = 0;
  for (let index = prefixLength + 1; index < nal.length && rbspLength < rbsp.length; index++) {
    const byte = nal[index];
    if (zeroRun >= 2 && byte === 3) {
      zeroRun = 0;
      continue;
    }
    rbsp[rbspLength++] = byte;
    zeroRun = byte === 0 ? zeroRun + 1 : 0;
  }
  let bit = 0;
  const readBit = () => {
    if (bit >= rbspLength * 8) return null;
    const value = (rbsp[bit >> 3] >> (7 - (bit & 7))) & 1;
    bit += 1;
    return value;
  };
  let leadingZeros = 0;
  while (readBit() === 0) {
    leadingZeros += 1;
    if (leadingZeros > 30) return null;
  }
  let suffix = 0;
  for (let index = 0; index < leadingZeros; index++) {
    const value = readBit();
    if (value === null) return null;
    suffix = (suffix * 2) + value;
  }
  return (2 ** leadingZeros) - 1 + suffix;
}

/**
 * Reassembles a socket's byte chunks into access units.
 *
 * A NAL unit ends where the next one begins, so the trailing slice always has to wait for more
 * bytes to prove it is complete. That is fine while frames keep arriving and fatal when they stop,
 * so a gap in the stream flushes whatever is buffered and reports that the producer went idle.
 * Parameter sets are held back and prepended to the next slice, because a decoder wants one access
 * unit rather than a stream of fragments.
 *
 * Callbacks:
 * - `onCodec(codec)` fires when a sequence parameter set names the profile and level.
 * - `onAccessUnit({ type, data })` fires per decodable unit; `type` is `"key"` or `"delta"`.
 * - `onIdle()` fires after an idle flush, so a caller whose decoder buffers frames can drain it.
 */
export class AnnexBParser {
  constructor({
    onAccessUnit,
    onCodec = () => {},
    onIdle = () => {},
    idleFlushMs = IDLE_NAL_FLUSH_MS,
    setTimeout: setTimer = (...args) => globalThis.setTimeout(...args),
    clearTimeout: clearTimer = (...args) => globalThis.clearTimeout(...args),
  } = {}) {
    if (typeof onAccessUnit !== "function") {
      throw new TypeError("An Annex-B parser needs somewhere to send access units.");
    }
    this.onAccessUnit = onAccessUnit;
    this.onCodec = onCodec;
    this.onIdle = onIdle;
    this.idleFlushMs = idleFlushMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.buffer = new Uint8Array();
    this.prefix = [];
    this.accessUnit = [];
    this.accessUnitType = null;
    this.idleTimer = null;
  }

  push(bytes) {
    this.buffer = concatBytes([this.buffer, bytes]);
    const starts = findStartCodes(this.buffer);
    if (starts.length >= 2) {
      for (let index = 0; index < starts.length - 1; index++) {
        this.handleNal(this.buffer.slice(starts[index], starts[index + 1]));
      }
      this.buffer = this.buffer.slice(starts.at(-1));
    }
    this.emitBeforePendingNal();
    this.armIdleFlush();
  }

  armIdleFlush() {
    this.clearTimer(this.idleTimer);
    this.idleTimer = this.setTimer(() => this.flush(), this.idleFlushMs);
  }

  flush() {
    this.clearTimer(this.idleTimer);
    this.idleTimer = null;
    // Anything shorter than a start code plus a header byte cannot be decoded, and re-buffering it
    // is harmless because the next push concatenates onto it.
    if (this.buffer.length >= 5) {
      const nal = this.buffer;
      this.buffer = new Uint8Array();
      this.handleNal(nal);
    }
    this.emitAccessUnit();
    this.onIdle();
  }

  dispose() {
    this.clearTimer(this.idleTimer);
    this.idleTimer = null;
    this.buffer = new Uint8Array();
    this.prefix = [];
    this.accessUnit = [];
    this.accessUnitType = null;
  }

  handleNal(nal) {
    const type = nalUnitType(nal);
    if (type === 7) {
      const codec = codecFromParameterSet(nal);
      if (codec) this.onCodec(codec);
    }

    if (type === 1 || type === 5) {
      const firstMacroblock = firstMacroblockInSlice(nal);
      if (this.accessUnit.length > 0 && (firstMacroblock === 0 || firstMacroblock === null)) {
        this.emitAccessUnit();
      }
      if (this.accessUnit.length === 0) {
        this.accessUnit.push(...this.prefix);
        this.prefix = [];
      }
      this.accessUnit.push(nal);
      if (type === 5) this.accessUnitType = "key";
      else this.accessUnitType ??= "delta";
    } else {
      if (this.accessUnit.length > 0) this.emitAccessUnit();
      this.prefix.push(nal);
    }
  }

  /**
   * The trailing NAL waits in `buffer` until a later start code proves where it ends, but its header
   * is already enough to prove where the previous picture ends. Peeking here avoids adding a full
   * extra frame of latency to continuous streams that do not emit access-unit delimiters.
   */
  emitBeforePendingNal() {
    if (this.accessUnit.length === 0 || this.buffer.length < 5) return;
    const type = nalUnitType(this.buffer);
    if (type !== 1 && type !== 5) {
      this.emitAccessUnit();
      return;
    }
    if (firstMacroblockInSlice(this.buffer) === 0) this.emitAccessUnit();
  }

  emitAccessUnit() {
    if (this.accessUnit.length === 0) return;
    const data = concatBytes(this.accessUnit);
    const type = this.accessUnitType ?? "delta";
    this.accessUnit = [];
    this.accessUnitType = null;
    if (data.length > 0) {
      this.onAccessUnit({ type, data });
    }
  }
}
