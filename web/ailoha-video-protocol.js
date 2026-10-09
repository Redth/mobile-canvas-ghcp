/** Conservative default maximum size for one encoded access unit. */
export const MAX_AILOHA_VIDEO_PAYLOAD_BYTES = 8 * 1024 * 1024;

const HEADER_BYTES = 28;
const KEY_FRAME_FLAG = 0x01;
const CODEC_CONFIG_FLAG = 0x02;
const VALID_FLAGS = KEY_FRAME_FLAG | CODEC_CONFIG_FLAG;

/**
 * Parses one ALHV/1 frame. The returned payload is a zero-copy view into input;
 * callers must keep the source buffer alive and unchanged while using it.
 */
export function parseAilohaVideoFrame(
  input,
  { maxPayloadBytes = MAX_AILOHA_VIDEO_PAYLOAD_BYTES } = {},
) {
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
    throw new RangeError("maxPayloadBytes must be a positive safe integer.");
  }

  let bytes;
  if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    throw new TypeError("input must be an ArrayBuffer or Uint8Array.");
  }

  if (bytes.byteLength < HEADER_BYTES) {
    throw new RangeError(`Video frame header must be at least ${HEADER_BYTES} bytes.`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes[0] !== 0x41
    || bytes[1] !== 0x4c
    || bytes[2] !== 0x48
    || bytes[3] !== 0x56
  ) {
    throw new Error("Video frame has invalid magic.");
  }
  if (view.getUint8(4) !== 1) {
    throw new Error("Unsupported video frame version.");
  }

  const flags = view.getUint8(5);
  if ((flags & ~VALID_FLAGS) !== 0) {
    throw new Error("Video frame contains unknown flags.");
  }
  if (view.getUint16(6, false) !== 0) {
    throw new Error("Video frame reserved field must be zero.");
  }

  const payloadLength = view.getUint32(24, false);
  if (payloadLength === 0) {
    throw new RangeError("Video frame payload must not be empty.");
  }
  if (payloadLength > maxPayloadBytes) {
    throw new RangeError(`Video frame payload exceeds ${maxPayloadBytes} bytes.`);
  }
  if (bytes.byteLength !== HEADER_BYTES + payloadLength) {
    throw new RangeError("Video frame length does not match its payload length.");
  }

  return {
    sequence: view.getUint32(8, false),
    timestampMicroseconds: view.getBigUint64(12, false),
    geometryRevision: view.getUint32(20, false),
    isKeyFrame: (flags & KEY_FRAME_FLAG) !== 0,
    isCodecConfig: (flags & CODEC_CONFIG_FLAG) !== 0,
    payload: bytes.subarray(HEADER_BYTES),
  };
}
