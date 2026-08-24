const CREATE_PLATFORM_ORDER = ["ios", "android"];

function platformKey(value) {
  const key = String(value || "").trim().toLowerCase();
  return CREATE_PLATFORM_ORDER.includes(key) ? key : null;
}

function platformRuntimes(catalog, platform) {
  return (catalog?.runtimes || [])
    .filter((runtime) => runtime.isAvailable && platformKey(runtime.platform) === platform);
}

function platformDeviceTypes(catalog, platform) {
  return (catalog?.deviceTypes || [])
    .filter((type) => platformKey(type.platform) === platform);
}

export function creatablePlatforms(catalog) {
  return CREATE_PLATFORM_ORDER.filter((platform) =>
    platformRuntimes(catalog, platform).length > 0
      && platformDeviceTypes(catalog, platform).length > 0);
}

export function createOptions(catalog, platform, runtimeId) {
  const key = platformKey(platform);
  if (!key) return { runtimes: [], deviceTypes: [] };

  const runtimes = platformRuntimes(catalog, key);
  const runtime = runtimes.find((candidate) => candidate.id === runtimeId) || runtimes[0];
  const supportedTypeIds = new Set(runtime?.supportedDeviceTypeIds || []);
  const deviceTypes = platformDeviceTypes(catalog, key)
    .filter((type) => supportedTypeIds.size === 0 || supportedTypeIds.has(type.id));

  return { runtimes, deviceTypes };
}

/**
 * The create dialog is filled from the last catalog load, so a load that failed or has not happened
 * yet leaves it with nothing to offer. Callers use this to reload the catalog before the user is
 * left staring at two empty dropdowns.
 */
export function needsCatalogForCreate(catalog) {
  return creatablePlatforms(catalog).length === 0;
}

export function createOptionPlaceholders(pending) {
  return pending
    ? {
        runtime: "Loading installed runtimes...",
        deviceType: "Loading device types...",
      }
    : {
        runtime: "No compatible runtime installed",
        deviceType: "No compatible device type found",
      };
}

export async function presentCreateDialog({
  catalog,
  loadCatalog,
  renderOptions,
  showDialog,
  showError,
}) {
  const pending = needsCatalogForCreate(catalog);
  renderOptions(pending);
  showDialog();
  if (!pending) return;

  try {
    await loadCatalog();
  } catch (error) {
    showError(error);
  } finally {
    renderOptions(false);
  }
}
