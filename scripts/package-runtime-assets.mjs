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
import {
  localRuntimeManifest,
  runtimeAssetName,
  runtimeRelease,
} from "../lib/runtime-assets.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimes = join(root, "runtimes");
const output = join(root, ".build", "release-assets");
const manifest = JSON.parse(readFileSync(join(runtimes, "manifest.json"), "utf8"));
const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--local-only");
if (unknown.length > 0) {
  throw new Error(`unknown argument: ${unknown.join(", ")}`);
}
const localOnly = args.includes("--local-only");
const release = runtimeRelease(manifest);

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const releaseManifest = localOnly
  ? localRuntimeManifest(manifest)
  : structuredClone(manifest);
releaseManifest.distribution = release;
const packaged = [];
const entries = Object.entries(releaseManifest.runtimes ?? {});

if (entries.length === 0) {
  throw new Error(
    localOnly
      ? "runtime manifest has no fully local runtimes to package"
      : "runtime manifest has no runtimes to package",
  );
}

for (const [platform, entry] of entries) {
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

console.log(
  `packaged ${packaged.length - 1} ${localOnly ? "local " : ""}runtime assets `
  + `for ${release.tag} in ${output}`,
);
