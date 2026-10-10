import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function inspectLauncher(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (!existsSync(join(directory, "LICENSE")) || !existsSync(join(directory, "THIRD-PARTY-NOTICES.md"))) {
    throw new Error("The official Ailoha launcher lacks its license/provenance notices.");
  }
  const exports = [
    manifest.exports?.["./runtime"]?.import,
    manifest.exports?.["./target-host"],
    manifest.exports?.["./runtime-pins.json"],
  ];
  if (exports.some((path) => typeof path !== "string" || !path.startsWith("./"))
    || manifest.exports["./runtime-pins.json"] !== "./runtime-pins.json") {
    throw new Error("The official launcher does not export the approved runtime and transport surface.");
  }
  for (const path of exports) {
    const target = resolve(directory, path);
    const local = relative(directory, target);
    if (local.startsWith(`..${sep}`) || local === ".." || !existsSync(target) || !lstatSync(target).isFile()) {
      throw new Error("The approved launcher export is not a local packaged file.");
    }
  }
  const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies;
  if (!Array.isArray(bundled) || Object.keys(manifest.dependencies ?? {}).some((name) => !bundled.includes(name))) {
    throw new Error("The official small launcher must contain its complete bundled dependency graph.");
  }
  const graphRequire = createRequire(join(directory, "package.json"));
  const dependencies = [];
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (!["ws", "undici", "tar"].includes(name) || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error("The approved Ailoha small dependency graph changed; review its package provenance first.");
    }
    const dependencyPath = graphRequire.resolve(`${name}/package.json`);
    if (dirname(dependencyPath) !== join(directory, "node_modules", name)) {
      throw new Error(`The official ${name} dependency must come from the bundled launcher graph.`);
    }
    const dependency = JSON.parse(readFileSync(dependencyPath, "utf8"));
    if (dependency.version !== version) throw new Error(`The official ${name} dependency is not exact-pinned.`);
    dependencies.push({ name, version, license: dependency.license });
  }
  return { manifest, dependencies };
}

function fingerprintGraph(directory, include = () => true) {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const visit = (path) => {
    if (!include(path)) return;
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error("The prepared official launcher graph must not contain symlinks.");
    if (entry.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (entry.isFile()) {
      const content = readFileSync(path);
      hash.update(relative(directory, path).split(sep).join("/"));
      hash.update(`\0${content.length}\0`);
      hash.update(content);
      hash.update("\0");
      files += 1;
      bytes += content.length;
    } else throw new Error("The prepared official launcher graph contains a non-file payload.");
  };
  visit(directory);
  return { sha256: hash.digest("hex"), files, bytes };
}

export function prepareAilohaGraph(output, { sourceRoot = root } = {}) {
  const require = createRequire(join(sourceRoot, "package.json"));
  const pinPath = join(sourceRoot, "lib", "ailoha", "runtime-package.json");
  if (!existsSync(pinPath)) return false;
  const pin = JSON.parse(readFileSync(pinPath, "utf8"));
  const packagePath = require.resolve("@ailoha/cli/package.json");
  const directory = dirname(packagePath);
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  if (manifest.name !== "@ailoha/cli" || manifest.version !== pin.version) {
    throw new Error("The prepared official Ailoha launcher does not match the approved public version.");
  }
  const source = JSON.parse(readFileSync(join(sourceRoot, "package-lock.json"), "utf8"));
  const key = relative(sourceRoot, directory).split(sep).join("/");
  const entry = source.packages?.[key];
  if (!entry || entry.version !== pin.version || entry.integrity !== pin.integrity || entry.resolved !== pin.tarball) {
    throw new Error("The installed Ailoha launcher graph does not match its approved anonymous tarball and integrity pin.");
  }
  const optionalPackages = Object.keys(manifest.optionalDependencies ?? {});
  const include = (path) => !optionalPackages.some((name) => {
    const child = relative(directory, path);
    const optionalPath = join("node_modules", name);
    return child === optionalPath || child.startsWith(`${optionalPath}${sep}`);
  });
  const graph = fingerprintGraph(directory, include);
  const { dependencies } = inspectLauncher(directory);
  const graphRoot = join(output, "node_modules", "@ailoha", "cli");
  mkdirSync(dirname(graphRoot), { recursive: true });
  cpSync(directory, graphRoot, {
    recursive: true,
    dereference: false,
    filter: include,
  });
  writeFileSync(join(output, "lib", "ailoha", "prepared-runtime-graph.json"), `${JSON.stringify({
    schema: "mobile-canvas.prepared-ailoha-graph/v1",
    name: manifest.name,
    version: manifest.version,
    sourceSha: pin.sourceSha,
    tarball: entry.resolved,
    integrity: entry.integrity,
    license: manifest.license,
    dependencies,
    graph,
    nativeAcquisition: "official-sdk-selected-rid",
  }, null, 2)}\n`);
  return true;
}

export function prepareSemanticGraph(output, { sourceRoot = root } = {}) {
  const lock = JSON.parse(readFileSync(join(sourceRoot, "package-lock.json"), "utf8"));
  const version = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"))
    .dependencies["@modelcontextprotocol/sdk"];
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("The shared MCP client must be exact-pinned in the product manifest.");
  }
  const seen = new Set();
  const rootRequire = createRequire(join(sourceRoot, "package.json"));
  function include(name, fromRequire) {
    let entryPath;
    try { entryPath = fromRequire.resolve(`${name}/package.json`); }
    catch { entryPath = fromRequire.resolve(name); }
    let directory = dirname(entryPath);
    while (true) {
      const candidate = join(directory, "package.json");
      if (existsSync(candidate) && JSON.parse(readFileSync(candidate, "utf8")).name === name) break;
      const parent = dirname(directory);
      if (parent === directory || !directory.startsWith(sourceRoot)) {
        throw new Error(`MCP client dependency ${name} has no package root.`);
      }
      directory = parent;
    }
    const manifestPath = join(directory, "package.json");
    const key = relative(sourceRoot, directory).split(sep).join("/");
    if (!key.startsWith("node_modules/") || key.includes("..")) {
      throw new Error(`MCP client dependency ${name} escapes the prepared source graph.`);
    }
    if (seen.has(key)) return;
    seen.add(key);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry = lock.packages[key];
    if (!entry || entry.version !== manifest.version || !entry.integrity || !entry.resolved
      || !existsSync(join(directory, "LICENSE")) && !existsSync(join(directory, "LICENSE.md"))
        && !existsSync(join(directory, "LICENSE.txt"))) {
      throw new Error(`MCP client dependency ${name} has no locked source or license.`);
    }
    const destination = join(output, key);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(directory, destination, {
      recursive: true, dereference: false,
      filter: (path) => !path.endsWith(".map") && !path.endsWith(".d.ts") && !path.endsWith(".d.mts"),
    });
    const requireDependency = createRequire(manifestPath);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) include(dependency, requireDependency);
  }
  include("@modelcontextprotocol/sdk", rootRequire);
  const manifest = JSON.parse(readFileSync(join(output, "node_modules/@modelcontextprotocol/sdk/package.json"), "utf8"));
  if (manifest.version !== version) throw new Error("The prepared MCP client does not match the exact shared source pin.");
  return [...seen];
}

export function verifyPreparedAilohaGraph(output) {
  const pinPath = join(output, "lib", "ailoha", "runtime-package.json");
  const receiptPath = join(output, "lib", "ailoha", "prepared-runtime-graph.json");
  const directory = join(output, "node_modules", "@ailoha", "cli");
  if (!existsSync(pinPath)) {
    if (existsSync(receiptPath) || existsSync(directory)) {
      throw new Error("A prepared Ailoha graph cannot be installed without its approved package pin.");
    }
    return false;
  }
  if (!existsSync(receiptPath) || !existsSync(directory)) {
    throw new Error("The pinned Ailoha opt-in is missing its prepared launcher graph or receipt.");
  }
  const pin = JSON.parse(readFileSync(pinPath, "utf8"));
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const graph = fingerprintGraph(directory);
  const { manifest, dependencies } = inspectLauncher(directory);
  const runtimePins = JSON.parse(readFileSync(join(directory, "runtime-pins.json"), "utf8"));
  if (pin.schema !== "mobile-canvas.ailoha-runtime/v1" || !/^[a-f0-9]{40}$/.test(pin.sourceSha)
    || receipt.schema !== "mobile-canvas.prepared-ailoha-graph/v1" || receipt.name !== "@ailoha/cli"
    || manifest.name !== receipt.name || manifest.version !== pin.version || receipt.version !== pin.version
    || receipt.sourceSha !== pin.sourceSha || receipt.tarball !== pin.tarball || receipt.integrity !== pin.integrity
    || receipt.license !== manifest.license || receipt.nativeAcquisition !== "official-sdk-selected-rid"
    || runtimePins.version !== pin.version || runtimePins.sourceSha !== pin.sourceSha
    || JSON.stringify(receipt.dependencies) !== JSON.stringify(dependencies)
    || graph.sha256 !== receipt.graph?.sha256 || graph.files !== receipt.graph.files || graph.bytes !== receipt.graph.bytes) {
    throw new Error("The prepared Ailoha launcher bytes or provenance do not match the pinned graph receipt.");
  }
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
    if (existsSync(join(directory, "node_modules", name))) {
      throw new Error("The prepared small launcher must not bundle optional native payloads.");
    }
  }
  return true;
}
