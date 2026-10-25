import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { sourceHash } from "../../scripts/source-hash.mjs";
import { verifyLocalReviewRuntime } from "../../scripts/review-local-runtime.mjs";
import packageInfo from "../../package.json" with { type: "json" };
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("single-RID review packaging requires matching unpublished source and actual local binary bytes", (t) => {
  mkdirSync(".build", { recursive: true });
  const directory = mkdtempSync(join(".build", "review-runtime-test-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const files = {};
  for (const name of ["mobile-canvas", "mobile-screencap"]) {
    const bytes = Buffer.from(`local-${name}`);
    const archive = `osx-arm64/${name}.gz`;
    mkdirSync(join(directory, "osx-arm64"), { recursive: true });
    writeFileSync(join(directory, archive), gzipSync(bytes));
    files[name] = { archive, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  }
  const manifest = {
    version: packageInfo.version, sourceHash: sourceHash().hash,
    distribution: { repository: "Redth/mobile-canvas-ghcp", tag: "unpublished-review-abcdef0" },
    runtimes: { "darwin-arm64": { rid: "osx-arm64", executable: "mobile-canvas", files } },
  };
  assert.doesNotThrow(() => verifyLocalReviewRuntime(manifest, directory));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  const dist = join(root, "vscode/dist");
  const existingDist = existsSync(dist);
  const marker = join(dist, ".review-thin-rejection-marker");
  if (existingDist) {
    writeFileSync(marker, "unchanged");
    t.after(() => rmSync(marker, { force: true }));
  }
  const thinReview = spawnSync(process.execPath, [
    join(root, "scripts/prepare-vscode.mjs"), "--review-local-rid", "--runtime-dir", directory, "--thin",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(thinReview.status, 1);
  assert.match(thinReview.stderr, /--review-local-rid cannot be combined with --thin/);
  assert.equal(existsSync(dist), existingDist);
  if (existingDist) assert.equal(readFileSync(marker, "utf8"), "unchanged");
  for (const script of ["prepare-plugin.mjs", "prepare-vscode.mjs"]) {
    const ordinary = spawnSync(process.execPath, [join(root, "scripts", script), "--runtime-dir", directory], {
      cwd: root, encoding: "utf8",
    });
    assert.equal(ordinary.status, 1);
    assert.match(ordinary.stderr, /missing required darwin-x64 runtime/);
  }
  const invalid = (modify) => {
    const copy = structuredClone(manifest);
    modify(copy);
    assert.throws(() => verifyLocalReviewRuntime(copy, directory));
  };
  invalid((copy) => { copy.sourceHash = "0".repeat(64); });
  invalid((copy) => { copy.distribution.tag = "v0.1.18"; });
  invalid((copy) => { copy.runtimes["darwin-x64"] = copy.runtimes["darwin-arm64"]; });
  invalid((copy) => { copy.runtimes["darwin-arm64"].files["mobile-canvas"].asset = "remote.gz"; });
  invalid((copy) => { delete copy.runtimes["darwin-arm64"].files["mobile-screencap"]; });
  writeFileSync(join(directory, files["mobile-canvas"].archive), gzipSync(Buffer.from("changed-binary")));
  assert.throws(() => verifyLocalReviewRuntime(manifest, directory), /bytes do not match/);
});
