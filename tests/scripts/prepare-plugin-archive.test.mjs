import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const archive = join(root, `.build/mobile-canvas-copilot-plugin-thin-v${version}.tar.gz`);
const sourceFiles = new Set([
  "extension.mjs",
  "lib/ailoha/recording-coordinator.mjs",
  "lib/ailoha/mcp-host.mjs",
  "scripts/mcp.mjs",
  "web/device-canvas.js",
]);

function text(bytes, start, end) {
  return bytes.toString("utf8", start, end).replace(/\0.*$/s, "");
}

function octal(bytes, start, end) {
  return Number.parseInt(text(bytes, start, end).trim() || "0", 8);
}

test("actual thin plugin tar excludes macOS metadata and retains shared source files", () => {
  const bytes = gunzipSync(readFileSync(archive));
  const entries = new Set();
  const verified = new Set();
  let nextPath;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (!header.some(Boolean)) break;
    const size = octal(header, 124, 136);
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    const payload = bytes.subarray(offset + 512, offset + 512 + size);
    const type = text(header, 156, 157);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "g") continue;
    if (type === "L") {
      nextPath = text(payload, 0, payload.length);
      continue;
    }
    if (type === "x") {
      for (let index = 0; index < payload.length;) {
        const separator = payload.indexOf(32, index);
        const length = Number.parseInt(payload.toString("ascii", index, separator), 10);
        assert.ok(Number.isSafeInteger(length) && length > 0);
        const field = payload.toString("utf8", separator + 1, index + length - 1);
        if (field.startsWith("path=")) nextPath = field.slice(5);
        index += length;
      }
      continue;
    }
    assert.ok(type === "0" || type === "5", `Unexpected tar entry type: ${type}`);
    const name = text(header, 0, 100);
    const prefix = text(header, 345, 500);
    const path = (nextPath ?? (prefix ? `${prefix}/${name}` : name)).replace(/\/$/, "");
    nextPath = undefined;
    assert.doesNotMatch(path, /(?:^|\/)\._[^/]+/, `AppleDouble metadata in ${path}`);
    assert.equal(entries.has(path), false, `Duplicate tar entry: ${path}`);
    entries.add(path);
    const relative = path.slice("mobile-canvas/".length);
    if (type === "0" && sourceFiles.has(relative)) {
      const source = join(root, relative);
      assert.deepEqual(payload, readFileSync(source), path);
      assert.equal(octal(header, 100, 108) & 0o111, statSync(source).mode & 0o111, path);
      verified.add(relative);
    }
  }
  assert.ok(entries.size > 0);
  assert.deepEqual(verified, sourceFiles);
});
