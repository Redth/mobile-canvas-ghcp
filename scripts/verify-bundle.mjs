#!/usr/bin/env node
// Verifies every locally bundled runtime and every remote-only manifest entry.
//
// The resolver checksums only the architecture it is extracting, so release
// packaging needs to verify every local archive. For source checkouts, this
// validates that every remote entry names the expected immutable release asset.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDarwinHelperEntries,
  defaultRuntimeAssetName,
} from "../lib/runtime-assets.mjs";

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

try {
  assertDarwinHelperEntries(manifest, { context: "runtimes/manifest.json" });
} catch (error) {
  console.error(`FAIL ${error.message}`);
  failures += 1;
}

if (entries.length === 0) {
  console.error("manifest declares no runtimes");
  process.exit(1);
}

for (const [platformKey, entry] of entries) {
  for (const [name, file] of Object.entries(entry.files)) {
    if (!file.archive) {
      const expected = defaultRuntimeAssetName(manifest, entry, name);
      if (file.asset !== expected) {
        console.error(
          `FAIL ${platformKey}/${name}: expected release asset ${expected}, got ${file.asset ?? "none"}`,
        );
        failures += 1;
      } else {
        console.log(`ok   ${platformKey}/${name} (${file.asset})`);
      }
      continue;
    }

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
