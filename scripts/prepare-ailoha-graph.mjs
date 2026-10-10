import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));

export function prepareAilohaGraph(output) {
  const pinPath = join(root, "lib", "ailoha", "runtime-package.json");
  if (!existsSync(pinPath)) return false;
  const pin = JSON.parse(readFileSync(pinPath, "utf8"));
  const packagePath = require.resolve("@ailoha/cli/package.json");
  const directory = dirname(packagePath);
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  if (manifest.name !== "@ailoha/cli" || manifest.version !== pin.version) {
    throw new Error("The prepared official Ailoha launcher does not match the approved public version.");
  }
  const source = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const key = relative(root, directory).split(sep).join("/");
  const entry = source.packages?.[key];
  if (!entry || entry.version !== pin.version || entry.integrity !== pin.integrity || entry.resolved !== pin.tarball) {
    throw new Error("The installed Ailoha launcher graph does not match its approved anonymous tarball and integrity pin.");
  }
  if (!existsSync(join(directory, "LICENSE")) || !existsSync(join(directory, "THIRD-PARTY-NOTICES.md"))) {
    throw new Error("The official Ailoha launcher lacks its license/provenance notices.");
  }
  const graphRoot = join(output, "node_modules", "@ailoha", "cli");
  mkdirSync(dirname(graphRoot), { recursive: true });
  cpSync(directory, graphRoot, {
    recursive: true,
    dereference: false,
    filter: (path) => !Object.keys(manifest.optionalDependencies ?? {}).some((name) => {
      const child = relative(directory, path);
      const optionalPath = join("node_modules", name);
      return child === optionalPath || child.startsWith(`${optionalPath}${sep}`);
    }),
  });
  const graphRequire = createRequire(packagePath);
  const dependencies = [];
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (!["ws", "undici", "tar"].includes(name) || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error("The approved Ailoha small dependency graph changed; review its package provenance first.");
    }
    const dependencyPath = graphRequire.resolve(`${name}/package.json`);
    const dependencyRoot = dirname(dependencyPath);
    const dependency = JSON.parse(readFileSync(dependencyPath, "utf8"));
    if (dependency.version !== version) throw new Error(`The official ${name} dependency is not exact-pinned.`);
    const destination = join(graphRoot, "node_modules", name);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(dependencyRoot, destination, { recursive: true, dereference: false });
    dependencies.push({ name, version, license: dependency.license });
  }
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
