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

function storageKey(instanceId) {
  if (typeof instanceId !== "string" || instanceId.length === 0) {
    throw new TypeError("A canvas instance ID is required.");
  }
  return `${SELECTED_DEVICE_PREFIX}${instanceId}`;
}
