import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareAilohaGraph } from "../../scripts/prepare-ailoha-graph.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function fixture(t) {
  const parent = join(root, ".build");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, "ailoha-graph-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourceRoot = join(directory, "source");
  const launcher = join(sourceRoot, "node_modules", "@ailoha", "cli");
  const write = (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const json = (path, value) => write(path, `${JSON.stringify(value)}\n`);
  const pin = {
    schema: "mobile-canvas.ailoha-runtime/v1",
    version: "0.0.0-synthetic",
    sourceSha: "a".repeat(40),
    tarball: "https://fixtures.invalid/ailoha-cli.tgz",
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
  };
  const manifest = {
    name: "@ailoha/cli",
    version: pin.version,
    type: "module",
    license: "SEE LICENSE IN LICENSE",
    exports: {
      "./runtime": { import: "./runtime/index.mjs", types: "./runtime/index.d.ts" },
      "./target-host": "./target-host/client.mjs",
      "./runtime-pins.json": "./runtime-pins.json",
      "./package.json": "./package.json",
    },
    dependencies: { ws: "1.0.0", undici: "1.0.0", tar: "1.0.0" },
    bundleDependencies: ["ws", "undici", "tar"],
    optionalDependencies: { "@ailoha/cli-synthetic-native": pin.version },
  };
  json(join(sourceRoot, "package.json"), { name: "synthetic-mobile-canvas", type: "module" });
  json(join(sourceRoot, "lib", "ailoha", "runtime-package.json"), pin);
  json(join(sourceRoot, "package-lock.json"), {
    packages: {
      "node_modules/@ailoha/cli": {
        version: pin.version, resolved: pin.tarball, integrity: pin.integrity,
      },
    },
  });
  json(join(launcher, "package.json"), manifest);
  write(join(launcher, "LICENSE"), "Synthetic test license only.\n");
  write(join(launcher, "THIRD-PARTY-NOTICES.md"), "Synthetic test notices only.\n");
  json(join(launcher, "runtime-pins.json"), { synthetic: true, version: pin.version });
  write(join(launcher, "runtime", "index.d.ts"), "export declare const syntheticGraph: string[];\n");
  write(join(launcher, "runtime", "index.mjs"), [
    'import ws from "ws";',
    'import undici from "undici";',
    'import tar from "tar";',
    "export const syntheticGraph = [ws, undici, tar];\n",
  ].join("\n"));
  write(join(launcher, "target-host", "client.mjs"), "export const syntheticTransport = true;\n");
  for (const name of ["ws", "undici", "tar", "synthetic-transitive"]) {
    const dependency = join(launcher, "node_modules", name);
    json(join(dependency, "package.json"), {
      name, version: "1.0.0", type: "module", main: "index.js", license: "MIT",
      ...(name === "tar" ? { dependencies: { "synthetic-transitive": "1.0.0" } } : {}),
    });
    write(join(dependency, "LICENSE"), `Synthetic ${name} license.\n`);
    write(join(dependency, "index.js"), name === "tar"
      ? 'import value from "synthetic-transitive"; export default `tar:${value}`;\n'
      : `export default "${name}";\n`);
  }
  write(join(launcher, "node_modules", "@ailoha", "cli-synthetic-native", "payload"), "Excluded native fixture.\n");
  const output = (host) => {
    const path = join(directory, host);
    json(join(path, "package.json"), { type: "module" });
    mkdirSync(join(path, "lib", "ailoha"), { recursive: true });
    return path;
  };
  return { sourceRoot, launcher, pin, manifest, json, write, output };
}

test("both prepared hosts resolve the complete synthetic bundled launcher graph without the source install", (t) => {
  const state = fixture(t);
  const products = ["github", "vscode"].map(state.output);
  for (const product of products) {
    assert.equal(prepareAilohaGraph(product, { sourceRoot: state.sourceRoot }), true);
    const packageRoot = join(product, "node_modules", "@ailoha", "cli");
    assert.equal(existsSync(join(packageRoot, "node_modules", "@ailoha", "cli-synthetic-native")), false);
    assert.equal(readFileSync(join(packageRoot, "node_modules", "synthetic-transitive", "LICENSE"), "utf8"), "Synthetic synthetic-transitive license.\n");
    const provenance = JSON.parse(readFileSync(join(product, "lib", "ailoha", "prepared-runtime-graph.json"), "utf8"));
    assert.equal(provenance.sourceSha, state.pin.sourceSha);
    assert.equal(provenance.tarball, state.pin.tarball);
    assert.equal(provenance.integrity, state.pin.integrity);
    assert.deepEqual(provenance.dependencies.map(({ name }) => name), ["ws", "undici", "tar"]);
  }
  renameSync(join(state.sourceRoot, "node_modules"), join(state.sourceRoot, "retired-source-modules"));
  for (const product of products) {
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", [
      'import { syntheticGraph } from "@ailoha/cli/runtime";',
      'import { syntheticTransport } from "@ailoha/cli/target-host";',
      'import pins from "@ailoha/cli/runtime-pins.json" with { type: "json" };',
      "console.log(JSON.stringify({ syntheticGraph, syntheticTransport, pins }));",
    ].join("\n")], { cwd: product, encoding: "utf8", timeout: 10_000 });
    assert.deepEqual(JSON.parse(result), {
      syntheticGraph: ["ws", "undici", "tar:synthetic-transitive"],
      syntheticTransport: true,
      pins: { synthetic: true, version: state.pin.version },
    });
  }
});

test("an absent public pin leaves the preparer dormant rather than resolving any SDK", (t) => {
  const state = fixture(t);
  rmSync(join(state.sourceRoot, "lib", "ailoha", "runtime-package.json"));
  rmSync(join(state.sourceRoot, "node_modules"), { recursive: true });
  const output = state.output("github");
  assert.equal(prepareAilohaGraph(output, { sourceRoot: state.sourceRoot }), false);
  assert.equal(existsSync(join(output, "node_modules")), false);
});

test("a hoisted direct dependency cannot make an incomplete bundled launcher look install-ready", (t) => {
  const state = fixture(t);
  renameSync(join(state.launcher, "node_modules", "ws"), join(state.sourceRoot, "node_modules", "ws"));
  const output = state.output("github");
  assert.throws(() => prepareAilohaGraph(output, { sourceRoot: state.sourceRoot }), /ws dependency must come from the bundled launcher graph/);
  assert.equal(existsSync(join(output, "node_modules", "@ailoha", "cli")), false);
});

for (const [name, change, error] of [
  ["wrong root integrity", (state) => state.json(join(state.sourceRoot, "lib", "ailoha", "runtime-package.json"), { ...state.pin, integrity: "sha512-mismatch" }), /integrity pin/],
  ["missing bundle declaration", (state) => state.json(join(state.launcher, "package.json"), { ...state.manifest, bundleDependencies: ["ws"] }), /complete bundled dependency graph/],
  ["mismatched bundled version", (state) => state.json(join(state.launcher, "node_modules", "tar", "package.json"), { name: "tar", version: "2.0.0" }), /tar dependency is not exact-pinned/],
  ["missing notices", (state) => rmSync(join(state.launcher, "THIRD-PARTY-NOTICES.md")), /license\/provenance notices/],
  ["missing transport export", (state) => state.json(join(state.launcher, "package.json"), { ...state.manifest, exports: { ...state.manifest.exports, "./target-host": undefined } }), /approved runtime and transport surface/],
  ["symlinked payload", (state) => symlinkSync(join(state.launcher, "LICENSE"), join(state.launcher, "linked-license")), /must not contain symlinks/],
]) {
  test(`invalid launcher graph rejects ${name} before staging`, (t) => {
    const state = fixture(t);
    change(state);
    const output = state.output("vscode");
    assert.throws(() => prepareAilohaGraph(output, { sourceRoot: state.sourceRoot }), error);
    assert.equal(existsSync(join(output, "node_modules", "@ailoha", "cli")), false);
  });
}
