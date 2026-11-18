import { MobileAilohaError } from "./mobile-projection.mjs";

// Holding a continuous input socket open claims the target's pointer arbiter, which refuses discrete
// taps and gestures from every other client. The panel keeps one only while the pointer is over the
// device (warming refreshes it) and for a short tail after a gesture so back-to-back gestures reuse it.
export const LIVE_INPUT_LINGER_MS = 2_500;
export const LIVE_INPUT_READY_TIMEOUT_MS = 15_000;
export const LIVE_INPUT_ACK_TIMEOUT_MS = 15_000;
export const LIVE_INPUT_SUBPROTOCOL = "ailoha.input.v1";

const ACTION_TYPES = new Set(["pointerDown", "pointerMove", "pointerUp"]);

function failure(code, message, status = 502) {
  return new MobileAilohaError(code, message, status);
}

function decode(data) {
  if (typeof data === "string") return JSON.parse(data);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
}

function problemFailure(message) {
  const status = message.problem?.status;
  if (status === 409 && /geometry/i.test(`${message.problem?.title} ${message.problem?.detail}`)) {
    return failure("stale_geometry", "The device geometry changed under the live touch. Release and try again.", 409);
  }
  if (status === 409) {
    return failure("live_input_busy", "The device input is in use by another live input owner.", 409);
  }
  return failure("live_input_rejected", "Ailoha rejected the live touch input.", Number.isInteger(status) && status >= 400 ? status : 502);
}

/**
 * Owns one Ailoha continuous input socket for a single captured surface geometry. Every batch is
 * acknowledged before its promise settles, and any refusal, geometry change or disconnect retires
 * the whole channel: the host releases held pointers when the socket ends, so a retired channel can
 * never leave a finger pressed on the device.
 */
export async function openLiveInputChannel(transport, path, {
  geometryRevision,
  readyTimeoutMs = LIVE_INPUT_READY_TIMEOUT_MS,
  ackTimeoutMs = LIVE_INPUT_ACK_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(geometryRevision) || geometryRevision < 0) {
    throw new TypeError("A live input channel requires the captured geometry revision.");
  }
  const pending = new Map();
  let state = "opening";
  let error = null;
  let socket = null;
  let nextSequence = 0;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});

  let socketClosing = null;
  const closeSocket = () => socketClosing ??= socket ? socket.close() : Promise.resolve();

  function retire(reason) {
    if (state === "failed" || state === "closed") return;
    state = "failed";
    error = reason;
    readyReject(reason);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pending.clear();
    if (socket) void closeSocket().catch(() => {});
  }

  function receive(data) {
    let message;
    try { message = decode(data); }
    catch {
      retire(failure("invalid_live_input_response", "Ailoha returned an invalid live input message."));
      return;
    }
    switch (message?.type) {
      case "ready":
        if (state !== "opening") {
          retire(failure("invalid_live_input_response", "Ailoha repeated the live input ready message."));
        } else if (message.geometryRevision !== geometryRevision) {
          retire(failure("stale_geometry", "The device geometry changed before live touch could start.", 409));
        } else if (message.resumeFromSequence !== 0) {
          retire(failure("invalid_live_input_response", "A fresh live input channel must start at sequence 0."));
        } else {
          state = "ready";
          readyResolve();
        }
        return;
      case "ack": {
        const entry = pending.get(message.acknowledgedSequence);
        if (!entry) {
          retire(failure("invalid_live_input_response", "Ailoha acknowledged an unknown live input batch."));
          return;
        }
        pending.delete(message.acknowledgedSequence);
        clearTimeout(entry.timer);
        entry.resolve();
        return;
      }
      case "error":
        retire(problemFailure(message));
        return;
      case "geometryChanged":
        retire(failure("stale_geometry", "The device geometry changed under the live touch. Release and try again.", 409));
        return;
      case "pointersReleased":
        retire(failure("live_input_released", "Ailoha released the live touch before it ended.", 409));
        return;
      case "cancelled":
        retire(failure("live_input_cancelled", "The live touch was cancelled.", 409));
        return;
      default:
        retire(failure("invalid_live_input_response", "Ailoha returned an unknown live input message."));
    }
  }

  socket = await transport.websocket(path, {
    onMessage: (data) => receive(data),
    onError: () => retire(failure("live_input_failed", "The live touch channel failed.")),
    onClose: () => retire(failure("live_input_disconnected", "The live touch channel closed.")),
  });
  const timer = setTimeout(() => retire(failure("live_input_timeout", "Ailoha did not accept live touch in time.", 504)), readyTimeoutMs);
  try {
    socket.send(JSON.stringify({ type: "hello", nextSequence: 0, lastAcknowledgedSequence: -1, geometryRevision }));
    await ready;
  } catch (cause) {
    retire(cause instanceof MobileAilohaError ? cause : failure("live_input_failed", "The live touch channel could not start."));
    await closeSocket().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }

  return Object.freeze({
    geometryRevision,
    get open() { return state === "ready"; },
    get error() { return error; },
    send(actions) {
      if (state !== "ready") return Promise.reject(error ?? failure("live_input_closed", "The live touch channel is closed.", 409));
      if (!Array.isArray(actions) || actions.length === 0
        || actions.some((action) => !ACTION_TYPES.has(action?.type))) {
        return Promise.reject(new TypeError("Live input batches carry pointer down, move or up actions."));
      }
      const sequence = nextSequence++;
      return new Promise((resolve, reject) => {
        const entry = {
          resolve, reject,
          timer: setTimeout(() => retire(failure("live_input_timeout", "Ailoha did not acknowledge live touch in time.", 504)), ackTimeoutMs),
        };
        pending.set(sequence, entry);
        try {
          socket.send(JSON.stringify({ type: "input", sequence, geometryRevision, actions }));
        } catch {
          retire(failure("live_input_failed", "The live touch could not be sent."));
        }
      });
    },
    async close() {
      if (state === "closed") return;
      const closing = failure("live_input_closed", "The live touch channel is closed.", 409);
      retire(closing);
      state = "closed";
      await closeSocket();
    },
  });
}
