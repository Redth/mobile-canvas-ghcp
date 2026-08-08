const SELECTED_DEVICE_PREFIX = "mobile-canvas-selected-device:";

export function readStoredDeviceId(storage, instanceId) {
  const value = storage.getItem(storageKey(instanceId));
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function storeDeviceId(storage, instanceId, deviceId) {
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    throw new TypeError("A selected device ID is required.");
  }
  storage.setItem(storageKey(instanceId), deviceId);
}

export function clearStoredDeviceId(storage, instanceId) {
  storage.removeItem(storageKey(instanceId));
}

export async function resumeAuthenticatedPanel({
  authenticate,
  isActive,
  resume,
}) {
  await authenticate();
  if (!isActive()) return false;
  resume();
  return true;
}

export function organizeDiagnostics(diagnostics) {
  const failures = (diagnostics ?? [])
    .flatMap((entry) => entry?.checks ?? [])
    .filter((check) => check?.status !== "ok");
  const notices = [];
  const popover = [];

  for (const check of failures) {
    const actions = (check.actions ?? []).filter(
      (action) =>
        action?.type === "open-system-settings" &&
        typeof action.target === "string" &&
        action.target.length > 0 &&
        typeof action.label === "string" &&
        action.label.length > 0,
    );
    if (actions.length > 0) notices.push({ ...check, actions });
    else popover.push(check);
  }

  return { notices, popover };
}

function storageKey(instanceId) {
  if (typeof instanceId !== "string" || instanceId.length === 0) {
    throw new TypeError("A canvas instance ID is required.");
  }
  return `${SELECTED_DEVICE_PREFIX}${instanceId}`;
}
