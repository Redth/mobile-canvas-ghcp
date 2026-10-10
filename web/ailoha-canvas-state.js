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
