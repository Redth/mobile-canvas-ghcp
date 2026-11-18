export function ailohaDisplayGeometry(geometry, surfaceId) {
  if (!geometry) return null;
  const { bounds, pixelDensity } = geometry;
  return Object.freeze({
    backend: "ailoha",
    surfaceId,
    geometryRevision: geometry.geometryRevision,
    coordinate: bounds.coordinate ?? "window",
    pointX: bounds.x,
    pointY: bounds.y,
    pointWidth: bounds.width,
    pointHeight: bounds.height,
    scale: pixelDensity ?? null,
    pixelWidth: pixelDensity === undefined ? null : Math.round(bounds.width * pixelDensity),
    pixelHeight: pixelDensity === undefined ? null : Math.round(bounds.height * pixelDensity),
    orientation: geometry.orientation ?? "unknown",
    bounds: Object.freeze({ ...bounds, coordinate: bounds.coordinate ?? "window" }),
  });
}

export function captureCanvasInvocation(state) {
  const device = state.selected;
  if (!device) throw new Error("Select a device before capturing a canvas invocation.");
  return Object.freeze({
    deviceId: device.id,
    targetHostId: device.targetHostId,
    surfaceId: state.display?.surfaceId,
    geometryRevision: state.display?.geometryRevision,
    coordinate: state.display?.coordinate,
    display: state.display ? Object.freeze({ ...state.display }) : null,
    selectionVersion: state.selectionVersion,
    backend: device.backend ?? "legacy",
  });
}

export function isCanvasInvocationCurrent(invocation, state) {
  return state.selected?.id === invocation.deviceId
    && state.selectionVersion === invocation.selectionVersion
    && (invocation.backend !== "ailoha"
      || (state.selected?.targetHostId === invocation.targetHostId
        && state.display?.surfaceId === invocation.surfaceId
        && state.display?.geometryRevision === invocation.geometryRevision));
}

export function ailohaInputPayload(invocation, payload) {
  if (invocation.backend !== "ailoha") return payload;
  if (!invocation.display || !Number.isInteger(invocation.geometryRevision)
    || !invocation.surfaceId || !["window", "screen"].includes(invocation.coordinate)) {
    throw new Error("Ailoha input requires the observed surface, logical coordinate space and geometry revision.");
  }
  return {
    ...payload,
    surfaceId: invocation.surfaceId,
    geometryRevision: invocation.geometryRevision,
    coordinate: invocation.coordinate,
  };
}

export function pointInLogicalBounds(event, canvasBounds, display) {
  const originX = display.pointX ?? 0;
  const originY = display.pointY ?? 0;
  return {
    x: originX + Math.max(0, Math.min(display.pointWidth,
      (event.clientX - canvasBounds.left) / canvasBounds.width * display.pointWidth)),
    y: originY + Math.max(0, Math.min(display.pointHeight,
      (event.clientY - canvasBounds.top) / canvasBounds.height * display.pointHeight)),
  };
}

// Ailoha surfaces that expose continuous input stream the finger live, like the legacy backend;
// others keep the discrete tap/swipe replay.
export function usesAilohaLiveTouch(device) {
  return device?.backend === "ailoha" && device.capabilities?.liveTouch === true;
}

export function liveTouchRequest(invocation, point, phase) {
  const payload = point ? { x: point.x, y: point.y, phase } : { phase };
  return {
    path: `/api/v1/devices/${encodeURIComponent(invocation.deviceId)}/input/touch`,
    body: invocation.backend === "ailoha" ? ailohaInputPayload(invocation, payload) : payload,
  };
}

const CAPTURE_SOURCE_LABELS = Object.freeze({
  framebuffer: "Simulator framebuffer",
  screencapturekit: "ScreenCaptureKit",
  idb: "idb (fallback)",
  png: "Screenshots (fallback)",
});
const PRIMARY_CAPTURE_SOURCES = new Set(["framebuffer", "screencapturekit", "emulator-grpc"]);

// Names the capture backend actually feeding the view. A fallback keeps its reason visible rather
// than only reading as a slower or blurrier picture.
export function describeCaptureSource(descriptor) {
  if (!descriptor) return null;
  if (descriptor.pending === true) {
    return Object.freeze({
      source: "pending", label: "Starting…", detail: "Waiting for the Target Host to report its capture source.",
      degraded: false, reason: "",
    });
  }
  const source = descriptor.source || "unknown";
  const label = CAPTURE_SOURCE_LABELS[source] || source;
  const degraded = !PRIMARY_CAPTURE_SOURCES.has(source);
  const rate = Number.isInteger(descriptor.maxFramesPerSecond) ? `${descriptor.maxFramesPerSecond} fps` : "";
  const detail = typeof descriptor.sourceDetail === "string" && descriptor.sourceDetail.trim()
    ? descriptor.sourceDetail.trim() : "";
  return Object.freeze({
    source,
    label: rate ? `${label} · ${rate}` : label,
    detail: detail || label,
    degraded,
    reason: degraded && detail ? detail : "",
  });
}
