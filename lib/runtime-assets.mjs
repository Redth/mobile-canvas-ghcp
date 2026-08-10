const DEFAULT_REPOSITORY = "Redth/mobile-canvas-ghcp";

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
