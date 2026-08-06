#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeAssetName, runtimeRelease } from "../lib/runtime-assets.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimes = join(root, "runtimes");
const output = join(root, ".build", "release-assets");
const manifest = JSON.parse(readFileSync(join(runtimes, "manifest.json"), "utf8"));
const release = runtimeRelease(manifest);

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const releaseManifest = structuredClone(manifest);
releaseManifest.distribution = release;
const packaged = [];

for (const [platform, entry] of Object.entries(releaseManifest.runtimes ?? {})) {
  for (const [fileName, file] of Object.entries(entry.files ?? {})) {
    if (!file.archive) {
      throw new Error(`${platform}/${fileName} has no local archive to package`);
    }

    const asset = runtimeAssetName(releaseManifest, entry, fileName);
    copyFileSync(join(runtimes, file.archive), join(output, asset));
    file.asset = asset;
    packaged.push(asset);
  }
}

const manifestName = `mobile-canvas-runtime-manifest-${release.tag}.json`;
writeFileSync(
  join(output, manifestName),
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
);
packaged.push(manifestName);

const checksums = packaged
  .sort()
  .map((name) => {
    const hash = createHash("sha256")
      .update(readFileSync(join(output, name)))
      .digest("hex");
    return `${hash}  ${basename(name)}`;
  });
writeFileSync(join(output, "SHA256SUMS"), `${checksums.join("\n")}\n`);

console.log(`packaged ${packaged.length - 1} runtime assets for ${release.tag} in ${output}`);
