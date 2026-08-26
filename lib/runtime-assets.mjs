const DEFAULT_REPOSITORY = "Redth/mobile-canvas-ghcp";
const DARWIN_RUNTIME_KEYS = ["darwin-arm64", "darwin-x64"];
const DARWIN_HELPER_NAME = "mobile-screencap";

export function runtimeRelease(manifest) {
  const version = manifest?.version;
  if (!version) throw new Error("runtime manifest has no version");

  return {
    repository: manifest.distribution?.repository || DEFAULT_REPOSITORY,
    tag: manifest.distribution?.tag || `v${version}`,
  };
}

export function runtimeAssetName(manifest, entry, fileName) {
  const declared = entry.files?.[fileName]?.asset;
  if (declared) return declared;

  return defaultRuntimeAssetName(manifest, entry, fileName);
}

export function defaultRuntimeAssetName(manifest, entry, fileName) {
  const { tag } = runtimeRelease(manifest);
  return `${fileName.replace(/\.exe$/i, "")}-${tag}-${entry.rid}.gz`;
}

export function runtimeAssetUrl(manifest, entry, fileName, baseUrl) {
  const asset = runtimeAssetName(manifest, entry, fileName);
  if (baseUrl) return `${baseUrl.replace(/\/+$/, "")}/${asset}`;

  const { repository, tag } = runtimeRelease(manifest);
  return `https://github.com/${repository}/releases/download/${tag}/${asset}`;
}

export function remoteRuntimeManifest(manifest) {
  const remote = structuredClone(manifest);
  remote.distribution = runtimeRelease(remote);
  for (const entry of Object.values(remote.runtimes ?? {})) {
    for (const [fileName, file] of Object.entries(entry.files ?? {})) {
      file.asset = defaultRuntimeAssetName(remote, entry, fileName);
      delete file.archive;
    }
  }
  return remote;
}

export function localRuntimeManifest(manifest) {
  const local = structuredClone(manifest);
  local.runtimes = Object.fromEntries(
    Object.entries(local.runtimes ?? {}).filter(([, entry]) => {
      const files = Object.values(entry.files ?? {});
      return files.length > 0 && files.every((file) => file.archive);
    }),
  );
  return local;
}

export function assertDarwinHelperEntries(
  manifest,
  { context = "runtime manifest", requireAll = true } = {},
) {
  const runtimes = manifest?.runtimes ?? {};
  for (const platform of DARWIN_RUNTIME_KEYS) {
    const entry = runtimes[platform];
    if (!entry) {
      if (requireAll) {
        throw new Error(`${context} is missing required ${platform} runtime`);
      }
      continue;
    }

    const helper = entry.files?.[DARWIN_HELPER_NAME];
    if (!helper) {
      throw new Error(`${context} ${platform} runtime is missing ${DARWIN_HELPER_NAME}`);
    }
    if (!helper.archive && !helper.asset) {
      throw new Error(
        `${context} ${platform}/${DARWIN_HELPER_NAME} has neither a bundled archive nor a release asset`,
      );
    }
  }
}
