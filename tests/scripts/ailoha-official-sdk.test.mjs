import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { productModule } from "../ailoha-test-module.mjs";
import { verifyPreparedAilohaGraph } from "../../scripts/prepare-ailoha-graph.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sdkModule = productModule("lib/ailoha/runtime-sdk.mjs");
const requireProduct = createRequire(sdkModule);
const packageRoot = dirname(requireProduct.resolve("@ailoha/cli/package.json"));
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const pin = JSON.parse(readFileSync(new URL("./runtime-package.json", sdkModule), "utf8"));
const runtimePins = JSON.parse(readFileSync(join(packageRoot, "runtime-pins.json"), "utf8"));

test("both host locks use the exact anonymously published official SDK and approved source pin", () => {
  assert.equal(pin.version, "0.2.5-preview.3");
  assert.equal(pin.sourceSha, "d1d16d142b110406c6070665db9222d424983aa9");
  assert.equal(pin.sourceRunId, "40706552606");
  assert.equal(pin.sourceRunAttempt, "1");
  assert.equal(pin.tarball, "https://registry.npmjs.org/@ailoha/cli/-/cli-0.2.5-preview.3.tgz");
  assert.equal(pin.integrity, "sha512-fPjWPQHOwRGYL/wIwRHKDWhqlSk1aECE/uhbdmufYI9RXoN/BRzU2ITaeGpms/4c3ABWVA/MlP+9Ta0RPtS8Wg==");
  for (const host of [root, join(root, "vscode")]) {
    const pkg = JSON.parse(readFileSync(join(host, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(host, "package-lock.json"), "utf8"));
    assert.equal(pkg.dependencies["@ailoha/cli"], pin.version);
    const entry = lock.packages["node_modules/@ailoha/cli"];
    assert.equal(entry.version, pin.version);
    assert.equal(entry.resolved, pin.tarball);
    assert.equal(entry.integrity, pin.integrity);
    for (const [name, version] of Object.entries(manifest.optionalDependencies)) {
      assert.equal(version, pin.version);
      assert.equal(lock.packages[`node_modules/${name}`].version, pin.version);
      assert.equal(lock.packages[`node_modules/${name}`].optional, true);
    }
  }
});

test("official root runtime pins preserve five Target Hosts, six CLI packages and publication attestations", () => {
  assert.equal(manifest.name, "@ailoha/cli");
  assert.equal(manifest.version, pin.version);
  assert.equal(runtimePins.schema, "ailoha.runtime-distribution/v1");
  assert.equal(runtimePins.sourceRepository, "microsoft/ailoha");
  assert.equal(runtimePins.sourceSha, pin.sourceSha);
  assert.deepEqual(Object.keys(runtimePins.runtimes).sort(),
    ["linux-arm64", "linux-x64", "osx-arm64", "osx-x64", "win-x64"]);
  assert.equal(Object.keys(manifest.optionalDependencies).length, 6);
  assert.equal(manifest.optionalDependencies["@ailoha/cli-linux-musl-x64"], pin.version);
  assert.equal(runtimePins.runtimes["linux-musl-x64"], undefined);
  assert.deepEqual(manifest.deferredRuntimes, ["win-arm64"]);
  for (const runtime of Object.values(runtimePins.runtimes)) {
    for (const kind of ["cli", "targetHost"]) {
      assert.equal(runtime.provenance[kind].sourceSha, pin.sourceSha);
      assert.equal(runtime.provenance[kind].producer.runId, pin.sourceRunId);
      assert.equal(runtime.provenance[kind].producer.runAttempt, pin.sourceRunAttempt);
    }
    assert.match(runtime.manifestSha512, /^[a-f0-9]{128}$/);
    assert.match(runtime.targetHostArchiveSha512, /^[a-f0-9]{128}$/);
    assert(runtime.cliFiles.some((file) => file.path === "ailoha" || file.path === "ailoha.exe"));
  }
});

test("host packaging installs omit native optional packages and do not add lifecycle acquisition", () => {
  for (const name of ["preinstall", "install", "postinstall"]) assert.equal(manifest.scripts?.[name], undefined);
  for (const workflow of ["ci.yml", "release.yml", "marketplace-identity.yml"]) {
    const source = readFileSync(join(root, ".github/workflows", workflow), "utf8");
    const commands = source.split("\n").filter((line) => /npm ci\b/.test(line));
    assert(commands.length > 0);
    for (const command of commands) {
      assert(command.includes("--ignore-scripts"));
      assert(command.includes("--omit=optional"));
    }
  }
  const ignore = readFileSync(join(root, "vscode/.vscodeignore"), "utf8");
  assert(ignore.split("\n").includes("node_modules/@ailoha/**"));
  assert.equal(ignore.split("\n").includes("dist/node_modules/@ailoha/**"), false);
});

test("real official runtime and target-host exports import without native acquisition, spawning or network calls", async () => {
  const forbidden = () => { throw new Error("Metadata-only SDK qualification must not acquire, start or access a native runtime."); };
  const originalFetch = globalThis.fetch;
  const methods = ["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync", "fork"];
  const originals = Object.fromEntries(methods.map((name) => [name, childProcess[name]]));
  globalThis.fetch = forbidden;
  for (const name of methods) childProcess[name] = forbidden;
  try {
    const sdk = await import(pathToFileURL(join(packageRoot, manifest.exports["./runtime"].import)));
    const transport = await import(pathToFileURL(join(packageRoot, manifest.exports["./target-host"])));
    for (const name of ["getRuntimePin", "getVerifiedCliLaunch", "ensureTargetHost",
      "openTargetHostTransport", "registerRuntimeCleanup", "releaseRuntimeLease"]) assert.equal(typeof sdk[name], "function");
    assert.equal(typeof transport, "object");
    assert(readFileSync(join(packageRoot, "LICENSE"), "utf8").length > 100);
    assert(readFileSync(join(packageRoot, "THIRD-PARTY-NOTICES.md"), "utf8").length > 100);
    for (const name of manifest.bundleDependencies) {
      const directory = join(packageRoot, "node_modules", name);
      assert.equal(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version, manifest.dependencies[name]);
      assert(readdirSync(directory).some((file) => /^licen[cs]e(?:\.|$)/i.test(file)), `${name} license`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of methods) childProcess[name] = originals[name];
  }
});

if (process.env.AILOHA_TEST_PRODUCT_ROOT) test("the actual prepared host contains a verified complete official graph, not native optional payloads", () => {
  assert.equal(verifyPreparedAilohaGraph(process.env.AILOHA_TEST_PRODUCT_ROOT), true);
  const receipt = JSON.parse(readFileSync(join(process.env.AILOHA_TEST_PRODUCT_ROOT, "lib/ailoha/prepared-runtime-graph.json"), "utf8"));
  assert.equal(receipt.sourceRunId, pin.sourceRunId);
  assert.equal(receipt.sourceRunAttempt, pin.sourceRunAttempt);
  assert(receipt.graph.files >= 539);
  for (const name of Object.keys(manifest.optionalDependencies)) {
    assert.equal(existsSync(join(packageRoot, "node_modules", name)), false);
    assert.equal(existsSync(join(process.env.AILOHA_TEST_PRODUCT_ROOT, "node_modules", name)), false);
  }
});
