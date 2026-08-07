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

  const { tag } = runtimeRelease(manifest);
  return `${fileName.replace(/\.exe$/i, "")}-${tag}-${entry.rid}.gz`;
}

export function runtimeAssetUrl(manifest, entry, fileName, baseUrl) {
  const asset = runtimeAssetName(manifest, entry, fileName);
  if (baseUrl) return `${baseUrl.replace(/\/+$/, "")}/${asset}`;

  const { repository, tag } = runtimeRelease(manifest);
  return `https://github.com/${repository}/releases/download/${tag}/${asset}`;
}
