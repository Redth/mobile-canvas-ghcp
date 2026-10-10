import { MAX_AILOHA_VIDEO_PAYLOAD_BYTES } from "./ailoha-video-protocol.js";
import { createAilohaVideoReceiver } from "./ailoha-video-receiver.js";

export const AILOHA_VIDEO_PLAYER_LIMITS = Object.freeze({
  maxConfigurationBytes: 64 * 1024,
  maxNalsPerAccessUnit: 128,
  maxDecodeQueueSize: 8,
  maxPendingPictures: 8,
  maxPendingBytes: 16 * 1024 * 1024,
  idleFlushMs: 250,
  maxFrameDimension: 8192,
  maxDecodedPixels: 16 * 1024 * 1024,
  decodeTimeoutMs: 5000,
});

function playerError(code, message) {
  const error = new Error(message);
  error.name = "AilohaVideoPlayerError";
  error.code = code;
  return error;
}

function configurationFrom(payload) {
  const starts = [];
  for (let index = 0; index < payload.length - 2; index += 1) {
    if (payload[index] === 0 && payload[index + 1] === 0
      && (payload[index + 2] === 1 || (payload[index + 2] === 0 && payload[index + 3] === 1))) {
      const prefix = payload[index + 2] === 1 ? 3 : 4;
      starts.push({ index, prefix });
      index += prefix - 1;
      if (starts.length > AILOHA_VIDEO_PLAYER_LIMITS.maxNalsPerAccessUnit) {
        throw playerError("InvalidAccessUnit", "H.264 access unit contains too many NAL units.");
      }
    }
  }
  if (starts.length === 0 || starts[0].index !== 0) {
    throw playerError("InvalidAccessUnit", "ALHV H.264 payload must be a complete Annex B access unit.");
  }
  const configuration = [];
  let codec;
  let hasPicture = false;
  let hasKeyPicture = false;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1]?.index ?? payload.length;
    const header = start.index + start.prefix;
    if (header >= end || (payload[header] & 0x80) !== 0) {
      throw playerError("InvalidAccessUnit", "H.264 access unit contains an invalid NAL header.");
    }
    const type = payload[header] & 0x1f;
    hasPicture ||= type === 1 || type === 5;
    hasKeyPicture ||= type === 5;
    if (type === 7 || type === 8) configuration.push({ type, bytes: payload.subarray(start.index, end) });
    if (type === 7) {
      if (header + 3 >= end) throw playerError("InvalidConfiguration", "H.264 SPS is truncated.");
      codec = `avc1.${[payload[header + 1], payload[header + 2], payload[header + 3]]
        .map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return { configuration, codec, hasPicture, hasKeyPicture };
}

function concatenate(parts, limit) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  if (length > limit) throw playerError("PayloadLimit", "H.264 data exceeds the player's bounded storage.");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

export function createAilohaVideoPlayer({
  context,
  present,
  onGeometry,
  onError,
  observedGeometry = null,
  isCurrent = () => true,
  VideoDecoder: Decoder = globalThis.VideoDecoder,
  EncodedVideoChunk: Chunk = globalThis.EncodedVideoChunk,
  decodeTimeoutMs = AILOHA_VIDEO_PLAYER_LIMITS.decodeTimeoutMs,
}) {
  for (const callback of [present, onGeometry, onError, isCurrent]) {
    if (typeof callback !== "function") throw new TypeError("Video player callbacks must be functions.");
  }
  if (typeof Decoder !== "function" || typeof Chunk !== "function") {
    throw playerError("WebCodecsUnavailable", "Ailoha live display requires H.264 WebCodecs support.");
  }
  if (!Number.isSafeInteger(decodeTimeoutMs) || decodeTimeoutMs < 1 || decodeTimeoutMs > 30_000) {
    throw new RangeError("decodeTimeoutMs must be an integer in 1..30000.");
  }
  const initialGeometry = observedGeometry ? Object.freeze({
    ...observedGeometry,
    bounds: Object.freeze({ ...observedGeometry.bounds }),
  }) : null;
  let decoder = null;
  let decoderEpoch = 0;
  let connection = null;
  const pending = new Map();
  let pendingBytes = 0;
  let flushTimer = null;
  let flushing = false;
  let codec = null;
  let configuration = new Uint8Array();
  const configurationByType = new Map();
  let needsKeyFrame = true;
  let requestedKeyFrame = false;
  let timelineOrigin = null;
  let geometry = null;
  let disposed = false;

  function retire(item) {
    if (!pending.delete(item.key)) return;
    pendingBytes -= item.bytes;
    clearTimeout(item.timer);
    item.scope.signal.removeEventListener("abort", item.abort);
    item.scope.release();
    if (pending.size === 0) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function resetDecoder(clearConfiguration = false) {
    decoderEpoch += 1;
    clearTimeout(flushTimer);
    flushTimer = null;
    flushing = false;
    for (const item of [...pending.values()]) retire(item);
    const old = decoder;
    decoder = null;
    if (old && old.state !== "closed") old.close();
    needsKeyFrame = true;
    requestedKeyFrame = false;
    timelineOrigin = null;
    if (clearConfiguration) {
      configuration = new Uint8Array();
      configurationByType.clear();
      codec = null;
    }
  }

  function live(scope) {
    return !disposed && isCurrent() && scope.isCurrent() && !scope.signal.aborted;
  }

  async function requestKeyFrame() {
    if (requestedKeyFrame || !connection) return;
    requestedKeyFrame = true;
    await connection.control("requestKeyFrame");
  }

  function failPlayer(error) {
    resetDecoder();
    onError(error);
    void connection?.close();
  }

  function output(frame, epoch) {
    const item = pending.get(`${epoch}:${frame.timestamp}`);
    try {
      if (epoch !== decoderEpoch) return;
      if (!item || item.sequence !== frame.timestamp) {
        failPlayer(playerError("OutputMismatch", "Decoded output does not match its captured access-unit sequence and generation."));
        return;
      }
      if (!Number.isInteger(frame.codedWidth) || !Number.isInteger(frame.codedHeight)
        || frame.codedWidth < 1 || frame.codedHeight < 1
        || frame.codedWidth > AILOHA_VIDEO_PLAYER_LIMITS.maxFrameDimension
        || frame.codedHeight > AILOHA_VIDEO_PLAYER_LIMITS.maxFrameDimension
        || frame.codedWidth * frame.codedHeight > AILOHA_VIDEO_PLAYER_LIMITS.maxDecodedPixels) {
        failPlayer(playerError("DecodedFrameLimit", "Decoded video output exceeds its bounded dimensions."));
        return;
      }
      if (live(item.scope) && item.metadata.geometry && item.scope.canPresent) {
        let presented;
        const committed = item.scope.commit(() => {
          presented = present(frame, item.metadata);
        });
        if (committed && presented !== true) {
          failPlayer(playerError("PresentationFailed", "Video presentation must synchronously confirm consumption."));
          return;
        }
      }
    } catch {
      failPlayer(playerError("PresentationFailed", "Captured video presentation failed."));
    } finally {
      if (item) retire(item);
      frame.close();
    }
  }

  function armIdleFlush() {
    clearTimeout(flushTimer);
    if (pending.size === 0 || flushing) return;
    const captured = decoder;
    const epoch = decoderEpoch;
    flushTimer = setTimeout(() => {
      if (captured !== decoder || epoch !== decoderEpoch || pending.size === 0) return;
      flushing = true;
      needsKeyFrame = true;
      // Flush drains pictures retained for H.264 reordering; the next chunk must be a key.
      let draining;
      try { draining = captured.flush(); }
      catch {
        if (captured === decoder && epoch === decoderEpoch) {
          failPlayer(playerError("DecodeFlushFailed", "WebCodecs could not drain the captured decoder."));
        }
        return;
      }
      Promise.resolve(draining).then(
        () => {
          if (captured !== decoder || epoch !== decoderEpoch) return;
          flushing = false;
          void requestKeyFrame();
        },
        () => {
          if (captured === decoder && epoch === decoderEpoch) {
            failPlayer(playerError("DecodeFlushFailed", "WebCodecs could not drain the captured decoder."));
          }
        },
      );
    }, AILOHA_VIDEO_PLAYER_LIMITS.idleFlushMs);
  }

  async function configure(scope) {
    if (decoder?.state === "configured") return true;
    if (!codec || !configurationByType.has(7) || !configurationByType.has(8)) {
      throw playerError("ConfigurationUnavailable", "Ailoha has not supplied the required H.264 SPS and PPS configuration.");
    }
    const config = { codec, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" };
    if (typeof Decoder.isConfigSupported === "function") {
      const support = await new Promise((resolve, reject) => {
        const abort = () => { cleanup(); resolve(null); };
        const cleanup = () => {
          clearTimeout(timer);
          scope.signal.removeEventListener("abort", abort);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(playerError("ConfigurationTimeout", "WebCodecs configuration exceeded its bounded deadline."));
        }, decodeTimeoutMs);
        scope.signal.addEventListener("abort", abort, { once: true });
        try {
          Promise.resolve(Decoder.isConfigSupported(config)).then(
            (value) => { cleanup(); resolve(value); },
            () => { cleanup(); reject(playerError("ConfigurationFailed", "WebCodecs configuration failed.")); },
          );
        } catch {
          cleanup();
          reject(playerError("ConfigurationFailed", "WebCodecs configuration failed."));
        }
      });
      if (!live(scope)) return false;
      if (!support?.supported) throw playerError("CodecUnsupported", `WebCodecs does not support ${codec}.`);
    }
    return scope.commit(() => {
      const epoch = ++decoderEpoch;
      decoder = new Decoder({
        output: (frame) => output(frame, epoch),
        error: () => {
          if (epoch !== decoderEpoch) return;
          failPlayer(playerError("DecodeFailed", "WebCodecs could not decode the captured H.264 access unit."));
        },
      });
      decoder.configure(config);
    });
  }

  async function consume(frame, scope) {
    if (!live(scope)) return true;
    if (!scope.canDecode) {
      await requestKeyFrame();
      return true;
    }
    const parsed = configurationFrom(frame.payload);
    if (frame.isKeyFrame && !parsed.hasKeyPicture) {
      throw playerError("InvalidAccessUnit", "A key ALHV unit must contain an H.264 key picture.");
    }
    if (parsed.configuration.length > 0) {
      const groups = new Map(configurationByType);
      for (const type of [7, 8]) {
        const units = parsed.configuration.filter((unit) => unit.type === type).map((unit) => unit.bytes);
        if (units.length) groups.set(type, concatenate(units, AILOHA_VIDEO_PLAYER_LIMITS.maxConfigurationBytes));
      }
      const cached = concatenate([7, 8].map((type) => groups.get(type)).filter(Boolean),
        AILOHA_VIDEO_PLAYER_LIMITS.maxConfigurationBytes);
      const changed = cached.length !== configuration.length || cached.some((byte, index) => byte !== configuration[index]);
      scope.commit(() => {
        if (changed || (parsed.codec && parsed.codec !== codec)) resetDecoder();
        configurationByType.clear();
        for (const [type, bytes] of groups) configurationByType.set(type, bytes);
        configuration = cached;
        codec = parsed.codec ?? codec;
      });
    }
    // Configuration units occupy the host window even though they produce no VideoFrame.
    if (!scope.canPresent || !parsed.hasPicture) return true;
    if (flushing || (needsKeyFrame && !frame.isKeyFrame)) {
      await requestKeyFrame();
      return true;
    }
    if (!await configure(scope) || !live(scope)) return true;
    const payload = frame.isKeyFrame
      ? concatenate([configuration, frame.payload],
        MAX_AILOHA_VIDEO_PAYLOAD_BYTES + AILOHA_VIDEO_PLAYER_LIMITS.maxConfigurationBytes)
      : frame.payload;
    if (decoder.decodeQueueSize >= AILOHA_VIDEO_PLAYER_LIMITS.maxDecodeQueueSize
      || pending.size >= AILOHA_VIDEO_PLAYER_LIMITS.maxPendingPictures
      || pendingBytes + payload.byteLength > AILOHA_VIDEO_PLAYER_LIMITS.maxPendingBytes) {
      resetDecoder();
      await requestKeyFrame();
      return true;
    }
    timelineOrigin ??= frame.timestampMicroseconds;
    const relative = frame.timestampMicroseconds - timelineOrigin;
    if (relative < -BigInt(Number.MAX_SAFE_INTEGER) || relative > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw playerError("TimestampRange", "The captured video timeline exceeds WebCodecs' lossless timestamp range.");
    }
    const metadata = Object.freeze({
      context: scope.context,
      sequence: frame.sequence,
      timestampMicroseconds: frame.timestampMicroseconds,
      decoderClockMicroseconds: Number(relative),
      geometryRevision: frame.geometryRevision,
      geometry: geometry?.geometryRevision === frame.geometryRevision ? geometry : null,
    });
    const retained = scope.retainPresentation();
    const epoch = decoderEpoch;
    const item = {
      key: `${epoch}:${frame.sequence}`, sequence: frame.sequence,
      scope: retained, metadata, bytes: payload.byteLength,
      abort() { if (pending.has(item.key)) resetDecoder(); },
    };
    item.timer = setTimeout(() => {
      failPlayer(playerError("DecodeTimeout", "A captured decoder output exceeded its bounded lifetime."));
    }, decodeTimeoutMs);
    pending.set(item.key, item);
    pendingBytes += item.bytes;
    retained.signal.addEventListener("abort", item.abort, { once: true });
    try {
      if (!scope.commit(() => {
        // WebCodecs timestamps identify units here; the lossless source clock remains in metadata.
        decoder.decode(new Chunk({ type: frame.isKeyFrame ? "key" : "delta", timestamp: frame.sequence, data: payload }));
        if (epoch === decoderEpoch) {
          needsKeyFrame = false;
          requestedKeyFrame = false;
        }
      })) retire(item);
    } catch {
      resetDecoder();
      throw playerError("DecodeFailed", "WebCodecs rejected the captured H.264 access unit.");
    }
    armIdleFlush();
    return true;
  }

  const receiver = createAilohaVideoReceiver({
    context,
    onFrame: consume,
    onControl(control, scope) {
      if (!live(scope)) return;
      if (control.type === "ready") {
        resetDecoder();
        geometry = initialGeometry?.geometryRevision === control.geometryRevision ? initialGeometry : null;
      } else if (control.type === "geometryChanged") {
        resetDecoder();
        geometry = scope.geometry;
      } else if (control.type === "backpressure" && Object.hasOwn(control, "dropBeforeSequence")) {
        resetDecoder();
      }
      if (control.type === "ready" || control.type === "geometryChanged") {
        scope.commit(() => {
          const result = onGeometry(geometry);
          if (result && typeof result.then === "function") {
            throw playerError("AsyncGeometryCallback", "Geometry presentation must be synchronous and owner-guarded.");
          }
        });
      }
    },
    onError(error) {
      resetDecoder();
      onError(error);
    },
  });

  return Object.freeze({
    context: receiver.context,
    get lastAcknowledgedSequence() { return receiver.lastAcknowledgedSequence; },
    attach(transport) {
      if (disposed) throw new Error("The video player is disposed.");
      resetDecoder(true);
      connection = receiver.attach(transport);
      const attached = connection;
      attached.signal.addEventListener("abort", () => {
        if (connection === attached) resetDecoder();
      }, { once: true });
      return attached;
    },
    control(command) { return connection?.control(command) ?? Promise.resolve(false); },
    async dispose() {
      if (disposed) return;
      disposed = true;
      resetDecoder(true);
      await receiver.dispose();
    },
  });
}
