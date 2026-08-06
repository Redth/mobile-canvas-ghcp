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
