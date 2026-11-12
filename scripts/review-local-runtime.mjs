import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { assertDarwinHelperEntries } from "../lib/runtime-assets.mjs";
import { sourceHash } from "./source-hash.mjs";

export function verifyLocalReviewRuntime(manifest, directory) {
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  if (manifest.version !== version || manifest.sourceHash !== sourceHash().hash
    || manifest.distribution?.repository !== "Redth/mobile-canvas-ghcp"
    || !/^unpublished-review-[a-f0-9]{7,40}$/.test(manifest.distribution?.tag ?? "")
    || Object.keys(manifest.runtimes ?? {}).length !== 1) {
    throw new Error("Review-only runtime requires one matching, unpublished local source build.");
  }
  const entry = manifest.runtimes["darwin-arm64"];
  if (entry?.rid !== "osx-arm64" || entry.executable !== "mobile-canvas"
    || Object.keys(entry.files ?? {}).sort().join(",") !== "mobile-canvas,mobile-screencap") {
    throw new Error("Review-only runtime must contain exactly the local macOS ARM binary and capture helper.");
  }
  assertDarwinHelperEntries(manifest, { context: "review-only runtime", requireAll: false });
  for (const [name, file] of Object.entries(entry.files)) {
    if (file.archive !== `osx-arm64/${name}.gz` || Object.hasOwn(file, "asset")
      || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new Error(`Review-only runtime has invalid local provenance for ${name}.`);
    }
    const bytes = gunzipSync(readFileSync(join(directory, file.archive)));
    if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error(`Review-only runtime bytes do not match ${name}.`);
    }
  }
}
