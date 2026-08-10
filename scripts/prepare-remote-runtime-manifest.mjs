#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { remoteRuntimeManifest } from "../lib/runtime-assets.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "runtimes", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const remote = remoteRuntimeManifest(manifest);

writeFileSync(manifestPath, `${JSON.stringify(remote, null, 2)}\n`);
console.log(`prepared remote runtime manifest for ${remote.distribution.tag}`);
