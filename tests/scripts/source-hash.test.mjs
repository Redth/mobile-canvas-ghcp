import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sourceHash } from "../../scripts/source-hash.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("native source fingerprints include embedded web bytes and exclude host-only/generated outputs", () => {
  const parent = join(root, ".build");
  mkdirSync(parent, { recursive: true });
  const fixture = mkdtempSync(join(parent, "source-hash-test-"));
  const write = (path, content) => {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), content);
  };
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
    write(".gitignore", ".build/\nnative/out/\nsrc/**/obj/\n");
    write("src/Program.cs", "class Program {}\n");
    write("native/Sources/Entry.swift", "import Foundation\n");
    write("web/index.html", '<script type="module" src="/device-canvas.js"></script>\n');
    write("web/device-canvas.js", 'export const backend = "legacy";\n');
    write("web/device-canvas.css", "body { margin: 0; }\n");
    const baseline = sourceHash({ rootDirectory: fixture });
    assert.equal(baseline.count, 5);
    write(".build/generated.js", "generated\n");
    write("native/out/mobile-screencap", "compiled\n");
    write("src/obj/generated.cs", "compiled\n");
    write("tests/web/device-canvas.test.mjs", "test-only\n");
    write("vscode/src/hostBridge.ts", "host-only\n");
    assert.deepEqual(sourceHash({ rootDirectory: fixture }), baseline);
    write("web/device-canvas.js", 'export const backend = "ailoha";\n');
    const changed = sourceHash({ rootDirectory: fixture });
    assert.notEqual(changed.hash, baseline.hash);
    assert.equal(changed.count, baseline.count);
    assert.deepEqual(sourceHash({ rootDirectory: fixture }), changed);
    renameSync(join(fixture, "web/device-canvas.js"), join(fixture, "web/renamed-device.js"));
    assert.notEqual(sourceHash({ rootDirectory: fixture }).hash, changed.hash);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
