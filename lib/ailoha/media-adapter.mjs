import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { AilohaProtocolError, assertPublicResource } from "./errors.mjs";
import { hasOperation, MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";
import { artifact as validateArtifact, isOpaqueId, operation as validateOperation, videoSession as validateVideo } from "./protocol.mjs";

function requireCondition(condition, message) {
  if (!condition) throw new MobileAilohaError("invalid_media_response", message, 502);
}

function segment(value) {
  if (!isOpaqueId(value)) throw new MobileAilohaError("invalid_identifier", "A media resource requires an opaque identifier.", 400);
  return encodeURIComponent(value);
}

function surfacePath(invocation) {
  return `/api/v1/targets/${segment(invocation.targetId)}/surfaces/${segment(invocation.surfaceId)}`;
}

function sameResourceLocation(location, expected) {
  if (typeof location !== "string" || /[\\?#\s]/.test(location)) return false;
  const left = location.split("/");
  const right = expected.split("/");
  if (left.length !== right.length || !location.startsWith("/api/v1/")) return false;
  try { return left.every((entry, index) => decodeURIComponent(entry) === decodeURIComponent(right[index])); }
  catch { return false; }
}

function resourceDescriptor(invocation, location) {
  if (typeof location !== "string" || !location.startsWith("/api/v1/") || /[\\?#\s]/.test(location)) return null;
  let segments;
  try { segments = location.split("/").map((part) => decodeURIComponent(part)); }
  catch { return null; }
  const expected = ["", "api", "v1", "targets", invocation.targetId, "surfaces", invocation.surfaceId, "video", "sessions"];
  if (segments.length !== 10 || !expected.every((part, index) => segments[index] === part)) return null;
  const videoSessionId = segments[9];
  if (!isOpaqueId(videoSessionId)) return null;
  return publicSnapshot({
    videoSessionId,
    targetId: invocation.targetId,
    surfaceId: invocation.surfaceId,
    resourcePath: `${surfacePath(invocation)}/video/sessions/${segment(videoSessionId)}`,
    websocketPath: `/ws/v1/targets/${segment(invocation.targetId)}/surfaces/${segment(invocation.surfaceId)}/video/${segment(videoSessionId)}`,
  });
}

function acceptedOperationId(location) {
  const prefix = "/api/v1/operations/";
  if (typeof location !== "string" || !location.startsWith(prefix)
    || /[\\/?#\s]/.test(location.slice(prefix.length))) return null;
  let id;
  try { id = decodeURIComponent(location.slice(prefix.length)); }
  catch { return null; }
  return isOpaqueId(id) ? id : null;
}

function responseBody(response, status) {
  requireCondition(response.status === status && response.contentType?.split(";", 1)[0] === "application/json",
    "Ailoha returned an unexpected media status or content type.");
  assertPublicResource(response.body, []);
  return response.body;
}

function actionSuccess(response, invocation) {
  const body = responseBody(response, 200);
  requireCondition(typeof body.success === "boolean", "Ailoha input did not return a target-action response.");
  if (body.success !== true) {
    const error = new MobileAilohaError("input_operation_failed", "The captured Ailoha input operation failed.", 502);
    throw error;
  }
  const context = body["x-ailoha-target-host"];
  requireCondition(context?.targetId === invocation.targetId && context.surfaceId === invocation.surfaceId,
    "Ailoha input response belongs to another target or surface.");
  if (context.geometryRevision !== undefined) {
    requireCondition(context.geometryRevision === invocation.geometry.geometryRevision,
      "Ailoha input response belongs to another geometry revision.");
  }
}

function gesture(invocation, input, swipe) {
  const milliseconds = Math.round(input.duration * 1000);
  const actions = [];
  const startX = swipe ? input.startX : input.x;
  const startY = swipe ? input.startY : input.y;
  actions.push({ type: "pointerDown", x: startX, y: startY, button: 0 });
  const steps = swipe ? Math.max(1, Math.min(120, Math.ceil(milliseconds / 16))) : Math.max(1, Math.ceil(milliseconds / 10_000));
  let elapsed = 0;
  for (let step = 1; step <= steps; step += 1) {
    const deadline = Math.round(milliseconds * step / steps);
    const pause = deadline - elapsed;
    if (pause > 0) actions.push({ type: "pause", duration: pause });
    elapsed = deadline;
    if (swipe) actions.push({
      type: "pointerMove",
      x: input.startX + (input.endX - input.startX) * step / steps,
      y: input.startY + (input.endY - input.startY) * step / steps,
      button: 0,
    });
  }
  actions.push({
    type: "pointerUp",
    x: swipe ? input.endX : input.x,
    y: swipe ? input.endY : input.y,
    button: 0,
  });
  return { geometryRevision: invocation.geometry.geometryRevision, actions };
}

export function createAilohaMediaAdapter({ transport, client, signal }) {
  const active = (options = {}) => ({ signal, timeoutMs: 30_000, ...options });
  const deletions = new WeakMap();
  return Object.freeze({
    supported(capabilities, surface) {
      const supports = (id, feature) => hasOperation(capabilities, feature, id);
      const surfaceSupports = (id, feature) => hasOperation(surface.capabilities, feature, id);
      const gestureSupported = supports("surface.input", "performTargetGesture")
        && surfaceSupports("surface.input", "gesture");
      return {
        screenshot: supports("surface.capture", "captureTargetScreenshot"),
        liveStream: ["createLiveVideoSession", "getLiveVideoSession", "stopLiveVideoSession"]
          .every((feature) => supports("surface.capture", feature)),
        tap: supports("surface.input", "tapTargetElement") && surfaceSupports("surface.input", "tap.point"),
        longPress: gestureSupported && surfaceSupports("surface.input", "long-press.point"),
        swipe: gestureSupported && surfaceSupports("surface.input", "swipe.point"),
        scroll: gestureSupported && surfaceSupports("surface.input", "swipe.point"),
      };
    },

    async screenshot(invocation) {
      const response = await transport.response(`${surfacePath(invocation)}/screenshots`, active({
        method: "POST", body: JSON.stringify({ format: "png", scale: "native" }),
      }));
      const artifact = responseBody(response, 201);
      validateArtifact(artifact);
      requireCondition(isOpaqueId(artifact.artifactId) && artifact.kind === "screenshot"
        && artifact.status === "ready" && artifact.contentType === "image/png"
        && typeof artifact.createdAt === "string" && Number.isFinite(Date.parse(artifact.createdAt)),
      "Ailoha did not return a ready PNG screenshot artifact.");
      if (artifact.targetId !== undefined) requireCondition(artifact.targetId === invocation.targetId, "Screenshot target ownership mismatch.");
      if (artifact.surfaceId !== undefined) requireCondition(artifact.surfaceId === invocation.surfaceId, "Screenshot surface ownership mismatch.");
      const contentPath = `/api/v1/artifacts/${segment(artifact.artifactId)}`;
      requireCondition(sameResourceLocation(response.location, contentPath), "Screenshot artifact Location mismatch.");
      const image = await transport.bytes(`${contentPath}/content`, active());
      requireCondition(image.status === 200 && image.contentType === "image/png" && image.bytes instanceof Uint8Array
        && image.bytes.byteLength <= 8 * 1024 * 1024, "Ailoha screenshot content is not a bounded PNG.");
      if (artifact.size !== undefined) {
        requireCondition(Number.isSafeInteger(artifact.size) && artifact.size >= 0 && artifact.size === image.bytes.byteLength,
          "Screenshot artifact size mismatch.");
      }
      if (artifact.sha256 !== undefined) {
        requireCondition(typeof artifact.sha256 === "string" && /^[A-Fa-f0-9]{64}$/.test(artifact.sha256)
          && createHash("sha256").update(image.bytes).digest("hex") === artifact.sha256.toLowerCase(),
        "Screenshot artifact digest mismatch.");
      }
      return new Uint8Array(image.bytes);
    },

    async tap(invocation, input) {
      const held = input.duration > 0;
      const path = `${surfacePath(invocation)}/input/actions/${held ? "gesture" : "tap"}`;
      const body = held ? gesture(invocation, input, false)
        : { x: input.x, y: input.y, geometryRevision: invocation.geometry.geometryRevision };
      actionSuccess(await transport.response(path, active({ method: "POST", body: JSON.stringify(body) })), invocation);
    },

    async swipe(invocation, input) {
      const body = gesture(invocation, input, true);
      actionSuccess(await transport.response(`${surfacePath(invocation)}/input/actions/gesture`,
        active({ method: "POST", body: JSON.stringify(body) })), invocation);
    },

    async createVideo(invocation, onCreated) {
      const collection = `${surfacePath(invocation)}/video/sessions`;
      let response;
      try { response = await transport.response(collection, active({ method: "POST" })); }
      catch (error) {
        if (error?.name === "TargetHostTransportError" && error.response?.status === 201) {
          const descriptor = resourceDescriptor(invocation, error.response.location);
          if (descriptor) onCreated?.(descriptor);
        }
        throw error;
      }
      const known = response.status === 201 ? resourceDescriptor(invocation, response.location) : null;
      if (known) onCreated?.(known);
      const session = responseBody(response, 201);
      validateVideo(session);
      requireCondition(isOpaqueId(session.videoSessionId) && session.targetId === invocation.targetId
        && session.surfaceId === invocation.surfaceId && session.codec === "h264"
        && ["ready", "streaming", "paused", "stopping", "stopped", "error"].includes(session.state)
        && typeof session.createdAt === "string" && Number.isFinite(Date.parse(session.createdAt)),
      "Ailoha video session identity does not match its captured owner.");
      const resourcePath = `${collection}/${segment(session.videoSessionId)}`;
      requireCondition(sameResourceLocation(response.location, resourcePath), "Video session Location mismatch.");
      const websocketPath = `/ws/v1/targets/${segment(invocation.targetId)}/surfaces/${segment(invocation.surfaceId)}/video/${segment(session.videoSessionId)}`;
      requireCondition(session.websocketUrl === websocketPath, "Video descriptor does not match the fixed owned relative channel.");
      return publicSnapshot({ ...session, resourcePath, websocketPath });
    },

    async deleteVideo(invocation, descriptor) {
      requireCondition(descriptor.targetId === invocation.targetId && descriptor.surfaceId === invocation.surfaceId,
        "Video cleanup cannot change target or surface ownership.");
      let state = deletions.get(descriptor);
      if (!state) {
        state = { submitted: false, operationId: null, pending: null, completed: null };
        deletions.set(descriptor, state);
      }
      if (state.completed) return state.completed;
      if (state.pending) return state.pending;
      const captured = state;
      captured.pending = (async () => {
        if (!captured.operationId) {
          if (captured.submitted) {
            throw new MobileAilohaError("video_delete_uncertain",
              "The owned video DELETE has an uncertain result without a recovery operation. It will not be submitted again.", 502);
          }
          captured.submitted = true;
          let reply;
          try {
            reply = await transport.response(descriptor.resourcePath, { method: "DELETE", timeoutMs: 30_000 });
          } catch (error) {
            if (error?.name === "TargetHostTransportError" && error.response?.status === 202) {
              captured.operationId = acceptedOperationId(error.response.location);
            }
            if (!captured.operationId) throw error;
          }
          if (reply) {
            if (reply.status === 202) captured.operationId = acceptedOperationId(reply.location);
            const result = responseBody(reply, 202);
            validateOperation(result);
            if (!captured.operationId || result.operationId !== captured.operationId) {
              throw new AilohaProtocolError("operation_identity_mismatch", {
                operationId: captured.operationId ?? undefined,
              });
            }
            requireCondition(result.kind === "stopLiveVideoSession" && result.destructive === false,
              "Video cleanup returned a different operation.");
          }
        }
        const result = await client.waitForOperation(captured.operationId, { timeoutMs: 30_000 });
        validateOperation(result);
        requireCondition(result.operationId === captured.operationId && result.kind === "stopLiveVideoSession"
          && result.destructive === false && (result.targetId === undefined || result.targetId === invocation.targetId),
        "The captured video cleanup poll returned a different owner or operation.");
        if (result.status !== "succeeded") {
          throw new AilohaProtocolError("operation_failed", { operationId: captured.operationId, operation: result });
        }
        captured.completed = publicSnapshot(result);
        return captured.completed;
      })();
      try { return await captured.pending; }
      finally { captured.pending = null; }
    },

    async attachVideo(invocation, descriptor, callbacks) {
      requireCondition(descriptor.targetId === invocation.targetId && descriptor.surfaceId === invocation.surfaceId,
        "Video attachment cannot change target or surface ownership.");
      const current = responseBody(await transport.response(descriptor.resourcePath, active()), 200);
      validateVideo(current);
      requireCondition(current.videoSessionId === descriptor.videoSessionId && current.targetId === invocation.targetId
        && current.surfaceId === invocation.surfaceId && current.websocketUrl === descriptor.websocketPath,
      "Video session inspection returned another owner.");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const socket = await transport.websocket(descriptor.websocketPath, {
        onMessage(data, isBinary) {
          const captured = isBinary ? new Uint8Array(data) : decoder.decode(data);
          return callbacks.onMessage(captured);
        },
        onError(error) { callbacks.onError(error); },
        onClose() {
          callbacks.onError(new MobileAilohaError("video_disconnected", "The captured Ailoha video socket closed.", 502));
        },
      });
      return Object.freeze({
        protocol: "ailoha.video.v1",
        get readyState() { return socket.readyState; },
        send: (text) => socket.send(text),
        close: () => socket.close(),
      });
    },
  });
}
