import {
  MAX_AILOHA_VIDEO_PAYLOAD_BYTES,
  parseAilohaVideoFrame,
} from "./ailoha-video-protocol.js";

export const AILOHA_VIDEO_SUBPROTOCOL = "ailoha.video.v1";
export const AILOHA_VIDEO_RECEIVER_LIMITS = Object.freeze({
  maxFrameBytes: 28 + MAX_AILOHA_VIDEO_PAYLOAD_BYTES,
  maxControlBytes: 64 * 1024,
  maxBufferedMessages: 32,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxInFlightFrames: 64,
});

const UINT32_MAX = 0xffffffff;
const REQUESTED_WINDOW = 8;
const COMMANDS = new Set(["requestKeyFrame", "pause", "resume", "cancel"]);
const ABORTED = Symbol("aborted");
const encoder = new TextEncoder();

function failure(code, message, cause, control) {
  const error = new Error(message, { cause });
  error.name = "AilohaVideoReceiverError";
  error.code = code;
  if (control) error.control = control;
  return error;
}

function captureContext(context) {
  if (
    !context
    || typeof context !== "object"
    || Object.keys(context).some((key) => key !== "videoSessionId" && key !== "ownerId")
  ) {
    throw new TypeError("context must contain only videoSessionId and ownerId.");
  }
  for (const key of ["videoSessionId", "ownerId"]) {
    if (
      typeof context[key] !== "string"
      || context[key].trim().length === 0
      || context[key].length > 256
    ) {
      throw new TypeError(`context.${key} must be a nonempty string of at most 256 characters.`);
    }
  }
  return Object.freeze({
    videoSessionId: context.videoSessionId,
    ownerId: context.ownerId,
  });
}

function parseControl(input) {
  const limit = AILOHA_VIDEO_RECEIVER_LIMITS.maxControlBytes;
  if (input.length > limit) throw failure("InvalidControl", `Video control exceeds ${limit} bytes.`);
  const bytes = encoder.encode(input).byteLength;
  if (bytes > limit) throw failure("InvalidControl", `Video control exceeds ${limit} bytes.`);
  let value;
  try {
    value = JSON.parse(input);
  } catch (cause) {
    throw failure("InvalidControl", "Video control must be valid JSON.", cause);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure("InvalidControl", "Video control must be a JSON object.");
  }
  return { control: validateControl(value), bytes };
}

function object(value, name, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure("InvalidControl", `${name} must be an object.`);
  }
  if (fields && Object.keys(value).some((key) => !fields.includes(key))) {
    throw failure("InvalidControl", `${name} contains an unsupported field.`);
  }
}

function text(value, name, nonempty = false) {
  if (typeof value !== "string" || (nonempty && value.length === 0)) {
    throw failure("InvalidControl", `${name} must be ${nonempty ? "a nonempty" : "a"} string.`);
  }
  return value;
}

function integer(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw failure("InvalidControl", `${name} must be an integer in ${minimum}..${maximum}.`);
  }
  return value;
}

function number(value, name, minimum = -Infinity, exclusive = false) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || (exclusive ? value <= minimum : value < minimum)
  ) {
    throw failure("InvalidControl", `${name} must be a finite number in its permitted range.`);
  }
  return value;
}

function choice(value, name, values) {
  if (!values.includes(value)) throw failure("InvalidControl", `${name} has an unsupported value.`);
  return value;
}

function uriReference(value, name) {
  text(value, name);
  if (/[\s\\\u0000-\u001f\u007f]/.test(value) || /%(?![0-9a-f]{2})/i.test(value)) {
    throw failure("InvalidControl", `${name} must be a URI reference.`);
  }
  try {
    new URL(value, "https://mobile-canvas.invalid/");
  } catch (cause) {
    throw failure("InvalidControl", `${name} must be a URI reference.`, cause);
  }
  return value;
}

function problemDetails(value) {
  object(value, "problem");
  const problem = {
    type: uriReference(value.type, "problem.type"),
    title: text(value.title, "problem.title"),
    status: integer(value.status, "problem.status", 100, 599),
  };
  for (const name of ["detail", "errorCode"]) {
    if (Object.hasOwn(value, name)) problem[name] = text(value[name], `problem.${name}`);
  }
  if (Object.hasOwn(value, "instance")) {
    problem.instance = uriReference(value.instance, "problem.instance");
  }
  if (Object.hasOwn(value, "x-ailoha-target-host")) {
    const source = value["x-ailoha-target-host"];
    object(source, "problem.x-ailoha-target-host");
    const target = { targetId: text(source.targetId, "problem targetId", true) };
    for (const name of ["surfaceId", "providerId"]) {
      if (Object.hasOwn(source, name)) target[name] = text(source[name], `problem ${name}`, true);
    }
    if (Object.hasOwn(source, "geometryRevision")) {
      target.geometryRevision = integer(source.geometryRevision, "problem geometryRevision", 0, UINT32_MAX);
    }
    problem["x-ailoha-target-host"] = Object.freeze(target);
  }
  return Object.freeze(problem);
}

function validateControl(value) {
  let control;
  switch (value.type) {
    case "ready":
      object(value, "ready", [
        "type", "videoSessionId", "codec", "geometryRevision", "resumeFromSequence", "maxInFlightFrames",
      ]);
      control = {
        type: "ready",
        videoSessionId: text(value.videoSessionId, "ready.videoSessionId", true),
        codec: choice(value.codec, "ready.codec", ["h264"]),
        geometryRevision: integer(value.geometryRevision, "ready.geometryRevision", 0, UINT32_MAX),
        resumeFromSequence: integer(value.resumeFromSequence, "ready.resumeFromSequence"),
        maxInFlightFrames: integer(
          value.maxInFlightFrames, "ready.maxInFlightFrames", 1, AILOHA_VIDEO_RECEIVER_LIMITS.maxInFlightFrames,
        ),
      };
      break;
    case "geometryChanged": {
      object(value, "geometryChanged", ["type", "geometryRevision", "bounds", "pixelDensity", "orientation"]);
      object(value.bounds, "geometryChanged.bounds", ["x", "y", "width", "height", "coordinate"]);
      const bounds = {
        x: number(value.bounds.x, "bounds.x"),
        y: number(value.bounds.y, "bounds.y"),
        width: number(value.bounds.width, "bounds.width", 0),
        height: number(value.bounds.height, "bounds.height", 0),
      };
      if (Object.hasOwn(value.bounds, "coordinate")) {
        bounds.coordinate = choice(value.bounds.coordinate, "bounds.coordinate", ["window", "screen"]);
      }
      control = {
        type: "geometryChanged",
        geometryRevision: integer(value.geometryRevision, "geometryChanged.geometryRevision", 0, UINT32_MAX),
        bounds: Object.freeze(bounds),
      };
      if (Object.hasOwn(value, "pixelDensity")) {
        control.pixelDensity = number(value.pixelDensity, "geometryChanged.pixelDensity", 0, true);
      }
      if (Object.hasOwn(value, "orientation")) {
        control.orientation = choice(value.orientation, "geometryChanged.orientation", ["portrait", "landscape", "unknown"]);
      }
      break;
    }
    case "backpressure":
      object(value, "backpressure", ["type", "maxInFlight", "recommendedFramesPerSecond", "dropBeforeSequence"]);
      control = {
        type: "backpressure",
        maxInFlight: integer(value.maxInFlight, "backpressure.maxInFlight", 1, AILOHA_VIDEO_RECEIVER_LIMITS.maxInFlightFrames),
      };
      for (const [name, minimum] of [["recommendedFramesPerSecond", 1], ["dropBeforeSequence", 0]]) {
        if (Object.hasOwn(value, name)) control[name] = integer(value[name], `backpressure.${name}`, minimum);
      }
      break;
    case "error":
      object(value, "error", ["type", "problem", "terminal", "sequence"]);
      if (typeof value.terminal !== "boolean") {
        throw failure("InvalidControl", "error.terminal must be a boolean.");
      }
      control = { type: "error", problem: problemDetails(value.problem), terminal: value.terminal };
      if (Object.hasOwn(value, "sequence")) control.sequence = integer(value.sequence, "error.sequence");
      break;
    case "cancelled":
      object(value, "cancelled", ["type", "reason"]);
      control = { type: "cancelled" };
      if (Object.hasOwn(value, "reason")) control.reason = text(value.reason, "cancelled.reason");
      break;
    default:
      throw failure("InvalidControl", "Unsupported server video control type.");
  }
  return Object.freeze(control);
}

function untilAborted(value, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      resolve(ABORTED);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function createAilohaVideoReceiver({ context, onFrame, onControl, onError }) {
  const captured = captureContext(context);
  const callbacks = { onFrame, onControl, onError };
  for (const [name, callback] of Object.entries(callbacks)) {
    if (typeof callback !== "function") throw new TypeError(`${name} must be a function.`);
  }

  let current = null;
  let disposed = false;
  let disposePromise;
  let lastAcknowledgedSequence = -1;
  let resumeFloor = 0;
  let observedGeometry = null;

  return Object.freeze({
    context: captured,
    get lastAcknowledgedSequence() {
      return lastAcknowledgedSequence;
    },
    attach(transport) {
      if (disposed) throw new Error("The video receiver is disposed.");
      if (!transport || typeof transport.send !== "function" || typeof transport.close !== "function") {
        throw new TypeError("transport must provide send and close callbacks.");
      }
      const capturedTransport = {
        protocol: transport.protocol,
        send: transport.send.bind(transport),
        close: transport.close.bind(transport),
      };
      const previous = current;
      const connection = createConnection({
        context: captured,
        transport: capturedTransport,
        callbacks,
        isCurrent: () => !disposed && current === connection,
        lastAcknowledged: () => lastAcknowledgedSequence,
        acknowledge: (sequence) => { lastAcknowledgedSequence = sequence; },
        minimumResume: () => resumeFloor,
        advanceResume: (sequence) => { resumeFloor = Math.max(resumeFloor, sequence); },
        readGeometry: () => observedGeometry,
        recordGeometry: (geometry) => { observedGeometry = geometry; },
      });
      current = connection;
      previous?.close();
      return connection;
    },
    dispose() {
      if (!disposed) {
        let resolve;
        let reject;
        disposePromise = new Promise((complete, fail) => {
          resolve = complete;
          reject = fail;
        });
        disposed = true;
        const previous = current;
        current = null;
        Promise.resolve(previous?.close() ?? true).then(resolve, reject);
      }
      return disposePromise;
    },
  });
}

function createConnection({
  context,
  transport,
  callbacks,
  isCurrent,
  lastAcknowledged,
  acknowledge,
  minimumResume,
  advanceResume,
  readGeometry,
  recordGeometry,
}) {
  const lifetime = new AbortController();
  const queue = [];
  const sends = [];
  let phase = "attached";
  let startPromise;
  let closePromise;
  let helloDispatched = false;
  let readyReceived = false;
  let pumping = false;
  let sending = false;
  let active = null;
  let activeSend = null;
  let bufferedMessages = 0;
  let bufferedBytes = 0;
  let bufferedFrames = 0;
  let maxInFlightFrames = REQUESTED_WINDOW;
  let wireGeometryRevision;
  let geometry = null;
  let needsKeyFrame = true;
  let presentationEpoch = 0;
  let nextSequence;
  let dropBeforeSequence = 0;

  const live = () => !lifetime.signal.aborted && isCurrent();
  const scope = (controller = lifetime, current = live, details = {}) => Object.freeze({
    context,
    signal: controller.signal,
    isCurrent: current,
    geometry,
    needsKeyFrame,
    ...details,
    commit(action) {
      if (typeof action !== "function") throw new TypeError("commit requires a synchronous callback.");
      if (!current() || details.canDecode === false) return false;
      const result = action();
      if (result && typeof result.then === "function") {
        throw new TypeError("commit callbacks must not return a promise.");
      }
      return true;
    },
  });
  const connectionScope = scope();

  function release(item, consumed) {
    if (!item.retained) return;
    item.retained = false;
    bufferedMessages -= 1;
    bufferedBytes -= item.bytes;
    if (item.binary) bufferedFrames -= 1;
    item.controller?.abort();
    item.frame = null;
    item.blob = null;
    item.control = null;
    item.resolve(consumed);
  }

  function close() {
    if (closePromise) return closePromise;
    closePromise = Promise.resolve().then(() => transport.close(connectionScope)).then(
      (result) => {
        if (result === false) {
          callbacks.onError(failure("TransportFailed", "Video transport close was declined."), connectionScope);
          return false;
        }
        return true;
      },
      (cause) => {
        callbacks.onError(failure("TransportFailed", "Video transport close failed.", cause), connectionScope);
        return false;
      },
    );
    phase = "closed";
    lifetime.abort();
    active?.controller?.abort();
    if (active) release(active, false);
    for (const item of queue.splice(0)) release(item, false);
    activeSend?.resolve(false);
    for (const item of sends.splice(0)) item.resolve(false);
    return closePromise;
  }

  function fail(error) {
    close();
    callbacks.onError(error, connectionScope);
    return false;
  }

  function send(control) {
    if (!live()) return Promise.resolve(false);
    if (sends.length + (activeSend ? 1 : 0) >= AILOHA_VIDEO_RECEIVER_LIMITS.maxBufferedMessages) {
      return Promise.resolve(fail(failure("QueueOverflow", "The bounded video send queue is full.")));
    }
    let resolve;
    const promise = new Promise((complete) => { resolve = complete; });
    sends.push({ text: JSON.stringify(control), type: control.type, resolve });
    if (!sending) {
      sending = true;
      queueMicrotask(pumpSends);
    }
    return promise;
  }

  async function pumpSends() {
    try {
      while (sends.length > 0 && live()) {
        const item = sends.shift();
        activeSend = item;
        try {
          if (item.type === "hello") helloDispatched = true;
          const result = await untilAborted(
            transport.send(item.text, connectionScope),
            lifetime.signal,
          );
          if (result === false) throw new Error("Video transport send was declined.");
          item.resolve(result !== ABORTED && live());
        } catch (cause) {
          if (live()) fail(failure("TransportFailed", "Video transport send failed.", cause));
          item.resolve(false);
        } finally {
          activeSend = null;
        }
      }
    } finally {
      sending = false;
    }
  }

  function reserve(bytes, binary) {
    const consumedInFlight = active?.retained && active.binary && active.consumed ? 1 : 0;
    if (
      bufferedMessages >= AILOHA_VIDEO_RECEIVER_LIMITS.maxBufferedMessages
      || bufferedBytes + bytes > AILOHA_VIDEO_RECEIVER_LIMITS.maxBufferedBytes
      || (binary && bufferedFrames - consumedInFlight >= maxInFlightFrames)
    ) {
      throw failure("QueueOverflow", "The bounded video receive queue is full.");
    }
    bufferedMessages += 1;
    bufferedBytes += bytes;
    if (binary) bufferedFrames += 1;
  }

  function enqueue(value, bytes, binary) {
    reserve(bytes, binary);
    if (value.frame) {
      value.frame = Object.freeze({ ...value.frame, payload: new Uint8Array(value.frame.payload) });
    }
    let resolve;
    const promise = new Promise((complete) => { resolve = complete; });
    queue.push({ ...value, bytes, binary, resolve, retained: true });
    if (!pumping) {
      pumping = true;
      queueMicrotask(pump);
    }
    return promise;
  }

  function acceptReady(control) {
    if (!helloDispatched || readyReceived || phase !== "awaiting-ready") {
      throw failure("NotReady", "Exactly one ready control must follow the dispatched hello.");
    }
    if (control.videoSessionId !== context.videoSessionId) {
      throw failure("SessionMismatch", "Video ready belongs to another session.");
    }
    if (control.resumeFromSequence < minimumResume()) {
      throw failure("SequenceMismatch", "The retained video session cannot rewind on reconnect.");
    }
    if (control.resumeFromSequence > UINT32_MAX) {
      throw failure("SequenceExhausted", "The video session has no remaining ALHV sequence; a new session is required.");
    }
    readyReceived = true;
    phase = "streaming";
    nextSequence = control.resumeFromSequence;
    dropBeforeSequence = nextSequence;
    advanceResume(nextSequence);
    maxInFlightFrames = control.maxInFlightFrames;
    wireGeometryRevision = control.geometryRevision;
    const observed = readGeometry();
    geometry = observed?.geometryRevision === wireGeometryRevision ? observed : null;
    recordGeometry(geometry);
    needsKeyFrame = true;
    presentationEpoch += 1;
  }

  function applyControl(control) {
    if (control.type === "geometryChanged") {
      if (control.geometryRevision < wireGeometryRevision) {
        throw failure("GeometryMismatch", "Video geometry cannot regress within a connection.");
      }
      wireGeometryRevision = control.geometryRevision;
      const { type, ...observed } = control;
      geometry = Object.freeze(observed);
      recordGeometry(geometry);
      presentationEpoch += 1;
    } else if (control.type === "backpressure") {
      maxInFlightFrames = control.maxInFlight;
      if (Object.hasOwn(control, "dropBeforeSequence")) {
        if (control.dropBeforeSequence < nextSequence) {
          throw failure("SequenceMismatch", "Video drop control cannot rewind the upcoming sequence.");
        }
        if (control.dropBeforeSequence > UINT32_MAX) {
          throw failure("SequenceExhausted", "Video drop control exceeds the ALHV sequence space.");
        }
        // Drain already received units first; this floor skips unsent gaps, not ACKs.
        nextSequence = control.dropBeforeSequence;
        dropBeforeSequence = nextSequence;
        advanceResume(nextSequence);
        needsKeyFrame = true;
        presentationEpoch += 1;
      }
      if (bufferedFrames > maxInFlightFrames) {
        throw failure("QueueOverflow", "Video frames exceed the authoritative backpressure window.");
      }
    }
  }

  async function pump() {
    try {
      if (!await startPromise || !live()) return;
      while (queue.length > 0 && live()) {
        const item = queue.shift();
        active = item;
        try {
          item.controller = new AbortController();
          const control = item.control;
          if (control) applyControl(control);
          const epoch = presentationEpoch;
          const messageCurrent = () => live()
            && !item.controller.signal.aborted
            && !item.consumed
            && epoch === presentationEpoch;
          if (control) {
            const delivery = scope(item.controller, messageCurrent);
            const result = await untilAborted(
              callbacks.onControl(control, delivery),
              item.controller.signal,
            );
            const consumed = result !== ABORTED && messageCurrent();
            if (consumed && control.type === "error") {
              callbacks.onError(failure("ServerError", control.problem.title, undefined, control), delivery);
            }
            item.consumed = consumed;
            release(item, consumed);
            continue;
          }

          if (item.blob) {
            const size = item.blob.size;
            let converted;
            try {
              converted = await untilAborted(item.blob.arrayBuffer(), item.controller.signal);
            } catch (cause) {
              throw failure("InvalidMessage", "Video Blob conversion failed.", cause);
            }
            if (converted === ABORTED || !messageCurrent()) {
              release(item, false);
              continue;
            }
            if (!(converted instanceof ArrayBuffer) || converted.byteLength !== size) {
              throw failure("InvalidMessage", "Video Blob conversion changed the message size.");
            }
            try {
              item.frame = Object.freeze(parseAilohaVideoFrame(converted));
            } catch (cause) {
              throw failure("InvalidMessage", "Invalid ALHV video frame.", cause);
            }
            item.blob = null;
          }
          const frame = item.frame;
          if (nextSequence > UINT32_MAX) {
            throw failure("SequenceExhausted", "The ALHV sequence space is exhausted; it cannot wrap.");
          }
          if (frame.sequence < dropBeforeSequence) {
            release(item, false);
            continue;
          }
          if (frame.sequence !== nextSequence || frame.sequence <= lastAcknowledged()) {
            throw failure("SequenceMismatch", "Video frames must advance in the ready/drop receive order.");
          }
          if (frame.geometryRevision !== wireGeometryRevision) {
            throw failure("GeometryMismatch", "Video frame geometry was not announced before the frame.");
          }
          nextSequence = frame.sequence + 1;
          advanceResume(nextSequence);
          const canDecode = !needsKeyFrame || frame.isCodecConfig || frame.isKeyFrame;
          const delivery = scope(item.controller, messageCurrent, {
            canDecode,
            canPresent: canDecode && (!frame.isCodecConfig || frame.isKeyFrame),
          });
          const result = await untilAborted(
            callbacks.onFrame(frame, delivery),
            item.controller.signal,
          );
          if (result === ABORTED || !messageCurrent()) {
            release(item, false);
            continue;
          }
          if (result !== true) {
            throw failure("ConsumerFailed", "The video frame callback must confirm consumption with true.");
          }
          item.consumed = true;
          if (frame.isKeyFrame) needsKeyFrame = false;
          if (await send({ type: "ack", sequence: frame.sequence })) {
            acknowledge(frame.sequence);
            release(item, true);
          } else {
            release(item, false);
          }
        } catch (cause) {
          if (live()) {
            const error = cause?.name === "AilohaVideoReceiverError"
              ? cause
              : failure("ConsumerFailed", "Video consumer callback failed.", cause);
            fail(error);
          }
          release(item, false);
        } finally {
          active = null;
        }
      }
    } finally {
      pumping = false;
    }
  }

  return Object.freeze({
    context,
    signal: lifetime.signal,
    get phase() {
      return phase;
    },
    start() {
      if (startPromise) return startPromise;
      startPromise = (async () => {
        if (!live()) return false;
        if (transport.protocol !== AILOHA_VIDEO_SUBPROTOCOL) {
          return fail(failure("ProtocolMismatch", "The negotiated video protocol must be ailoha.video.v1."));
        }
        phase = "awaiting-ready";
        try {
          return await send({
            type: "hello",
            videoSessionId: context.videoSessionId,
            lastAcknowledgedSequence: lastAcknowledged(),
            maxInFlightFrames: REQUESTED_WINDOW,
          });
        } catch (cause) {
          return live()
            ? fail(failure("TransportFailed", "Video hello send failed.", cause))
            : false;
        }
      })();
      return startPromise;
    },
    control(command) {
      if (!COMMANDS.has(command)) throw new TypeError("Unsupported video control command.");
      if (!live()) return Promise.resolve(false);
      if (!readyReceived) {
        return Promise.resolve(fail(failure("NotReady", "Video control commands require ready.")));
      }
      return send({ type: "control", command });
    },
    receive(input) {
      if (!live()) return Promise.resolve(false);
      try {
        if (typeof input === "string") {
          const { control, bytes } = parseControl(input);
          if (control.type === "cancelled" || (control.type === "error" && control.terminal)) {
            const error = control.type === "cancelled"
              ? failure("ServerCancelled", control.reason || "Video stream was cancelled.", undefined, control)
              : failure("ServerError", control.problem.title, undefined, control);
            return Promise.resolve(fail(error));
          }
          if (!helloDispatched || (control.type !== "ready" && control.type !== "error" && !readyReceived)) {
            throw failure("NotReady", "Video controls must follow hello and ready.");
          }
          if (control.type === "ready") acceptReady(control);
          return enqueue({ control }, bytes, false);
        }

        if (!readyReceived) {
          throw failure("NotReady", "Video frames require a successful hello and ready control.");
        }
        if (typeof Blob !== "undefined" && input instanceof Blob) {
          if (input.size > AILOHA_VIDEO_RECEIVER_LIMITS.maxFrameBytes) {
            throw failure("InvalidMessage", "Video Blob exceeds the ALHV frame size limit.");
          }
          return enqueue({ blob: input }, input.size, true);
        }
        const parsed = parseAilohaVideoFrame(input);
        advanceResume(parsed.sequence + 1);
        return enqueue({ frame: parsed }, 28 + parsed.payload.byteLength, true);
      } catch (cause) {
        const error = cause?.name === "AilohaVideoReceiverError"
          ? cause
          : failure("InvalidMessage", "Invalid video message.", cause);
        return Promise.resolve(fail(error));
      }
    },
    close,
  });
}
