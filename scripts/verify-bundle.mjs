#!/usr/bin/env node
// Verifies every bundled runtime, on any host platform.
//
// The resolver checksums only the architecture it is extracting, so a corrupt
// or stale archive for another platform would stay invisible until a user on
// that platform hit it. This checks all of them, which is what CI needs.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimesDir = join(packageRoot, "runtimes");
const manifestPath = join(runtimesDir, "manifest.json");

if (!existsSync(manifestPath)) {
  console.error("runtimes/manifest.json is missing -- run scripts/bundle.mjs");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const entries = Object.entries(manifest.runtimes ?? {});
let failures = 0;

if (entries.length === 0) {
  console.error("manifest declares no runtimes");
  process.exit(1);
}

for (const [platformKey, entry] of entries) {
  for (const [name, file] of Object.entries(entry.files)) {
    const archive = join(runtimesDir, file.archive);
    if (!existsSync(archive)) {
      console.error(`FAIL ${platformKey}/${name}: missing ${file.archive}`);
      failures += 1;
      continue;
    }
    let bytes;
    try {
      bytes = gunzipSync(readFileSync(archive));
    } catch (error) {
      console.error(`FAIL ${platformKey}/${name}: not valid gzip (${error.message})`);
      failures += 1;
      continue;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== file.sha256) {
      console.error(`FAIL ${platformKey}/${name}: checksum mismatch`);
      failures += 1;
      continue;
    }
    if (bytes.length !== file.size) {
      console.error(`FAIL ${platformKey}/${name}: size mismatch`);
      failures += 1;
      continue;
    }
    console.log(`ok   ${platformKey}/${name} (${(bytes.length / 1048576).toFixed(1)} MB)`);
  }

  // The cache directory is named from this id, so a wrong value would make two
  // different builds collide in one directory.
  if (entry.id !== entry.files[entry.executable]?.sha256) {
    console.error(`FAIL ${platformKey}: id does not match ${entry.executable}`);
    failures += 1;
  }
}

process.exit(failures === 0 ? 0 : 1);
