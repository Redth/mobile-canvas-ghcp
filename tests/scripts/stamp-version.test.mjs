import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

function fixture(t) {
  mkdirSync(join(root, ".build"), { recursive: true });
  const directory = mkdtempSync(join(root, ".build/version-stamp-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of ["scripts/stamp-version.mjs", "package.json", "package-lock.json",
    "vscode/package.json", "vscode/package-lock.json", "Directory.Build.props",
    ".github/plugin/plugin.json", ".github/plugin/marketplace.json",
    ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json",
    "lib/ailoha/runtime-package.json", "runtimes/manifest.json"]) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    cpSync(join(root, path), join(directory, path));
  }
  return directory;
}

test("the product stamp updates both lock roots without changing SDK pins or published native evidence", (t) => {
  const directory = fixture(t);
  const targetVersion = "9.8.7";
  const before = (path) => readFileSync(join(directory, path));
  assert.notEqual(JSON.parse(before("package.json").toString("utf8")).version, targetVersion);
  const native = before("runtimes/manifest.json");
  const sdk = before("lib/ailoha/runtime-package.json");
  const locks = ["package-lock.json", "vscode/package-lock.json"].map((path) =>
    JSON.parse(before(path).toString("utf8")));
  const catalogs = [".github/plugin/marketplace.json", ".claude-plugin/marketplace.json"]
    .map((path) => JSON.parse(before(path).toString("utf8")).metadata);
  execFileSync(process.execPath, [join(directory, "scripts/stamp-version.mjs"), targetVersion]);
  const check = execFileSync(process.execPath, [join(directory, "scripts/stamp-version.mjs"), "--check"],
    { encoding: "utf8" });
  assert(check.includes(`all 9 agree on ${targetVersion}`));
  for (const [index, path] of ["package-lock.json", "vscode/package-lock.json"].entries()) {
    const lock = JSON.parse(before(path).toString("utf8"));
    assert.equal(lock.version, targetVersion);
    assert.equal(lock.packages[""].version, targetVersion);
    for (const [key, value] of Object.entries(locks[index].packages)) {
      if (key) assert.deepEqual(lock.packages[key], value);
    }
    assert.equal(lock.packages[""].dependencies["@ailoha/cli"], "0.2.5-preview.4");
  }
  for (const [index, path] of [".github/plugin/marketplace.json", ".claude-plugin/marketplace.json"].entries()) {
    assert.deepEqual(JSON.parse(before(path).toString("utf8")).metadata, catalogs[index]);
  }
  assert.deepEqual(before("runtimes/manifest.json"), native);
  assert.deepEqual(before("lib/ailoha/runtime-package.json"), sdk);
  const stampedFiles = ["package.json", "package-lock.json", "vscode/package.json",
    "vscode/package-lock.json", "Directory.Build.props", ".github/plugin/plugin.json",
    ".github/plugin/marketplace.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"];
  const stamped = stampedFiles.map(before);
  execFileSync(process.execPath, [join(directory, "scripts/stamp-version.mjs"), targetVersion]);
  for (const [index, path] of stampedFiles.entries()) assert.deepEqual(before(path), stamped[index]);
  assert.deepEqual(before("runtimes/manifest.json"), native);
  assert.deepEqual(before("lib/ailoha/runtime-package.json"), sdk);
});

for (const path of ["package-lock.json", "vscode/package-lock.json"]) {
  test(`version consistency rejects an internally mismatched ${path}`, (t) => {
    const directory = fixture(t);
    const lock = JSON.parse(readFileSync(join(directory, path), "utf8"));
    lock.packages[""].version = "0.0.0";
    writeFileSync(join(directory, path), JSON.stringify(lock));
    const result = spawnSync(process.execPath, [join(directory, "scripts/stamp-version.mjs"), "--check"],
      { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /disagrees internally/);
  });
}
