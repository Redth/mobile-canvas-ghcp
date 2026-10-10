import { createRequire } from "node:module";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  if (!existsSync(join(directory, "LICENSE")) || !existsSync(join(directory, "THIRD-PARTY-NOTICES.md"))) {
    throw new Error("The official Ailoha launcher lacks its license/provenance notices.");
  }
  if (typeof manifest.exports?.["./runtime"]?.import !== "string"
    || typeof manifest.exports?.["./target-host"] !== "string"
    || manifest.exports?.["./runtime-pins.json"] !== "./runtime-pins.json") {
    throw new Error("The official launcher does not export the approved runtime and transport surface.");
  }
  const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies;
  if (!Array.isArray(bundled) || Object.keys(manifest.dependencies ?? {}).some((name) => !bundled.includes(name))) {
    throw new Error("The official small launcher must contain its complete bundled dependency graph.");
  }
  const optionalPackages = Object.keys(manifest.optionalDependencies ?? {});
  const include = (path) => !optionalPackages.some((name) => {
    const child = relative(directory, path);
    const optionalPath = join("node_modules", name);
    return child === optionalPath || child.startsWith(`${optionalPath}${sep}`);
  });
  const inspect = (path) => {
    if (!include(path)) return;
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error("The prepared official launcher graph must not contain symlinks.");
    if (entry.isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name));
    else if (!entry.isFile()) throw new Error("The prepared official launcher graph contains a non-file payload.");
  };
  inspect(directory);
  const graphRequire = createRequire(packagePath);
  const dependencies = [];
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (!["ws", "undici", "tar"].includes(name) || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error("The approved Ailoha small dependency graph changed; review its package provenance first.");
    }
    const dependencyPath = graphRequire.resolve(`${name}/package.json`);
    const dependencyRoot = dirname(dependencyPath);
    if (dependencyRoot !== join(directory, "node_modules", name)) {
      throw new Error(`The official ${name} dependency must come from the bundled launcher graph.`);
    }
    const dependency = JSON.parse(readFileSync(dependencyPath, "utf8"));
    if (dependency.version !== version) throw new Error(`The official ${name} dependency is not exact-pinned.`);
    dependencies.push({ name, version, license: dependency.license });
  }
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
    nativeAcquisition: "official-sdk-selected-rid",
  }, null, 2)}\n`);
  return true;
}
