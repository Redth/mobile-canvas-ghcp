#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.argv[2] ?? scriptRoot);
const manifestPath = join(root, ".github", "plugin", "plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const marketplace = JSON.parse(
  readFileSync(join(root, ".github", "plugin", "marketplace.json"), "utf8"),
);
const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const configured = typeof manifest.extensions === "object" && !Array.isArray(manifest.extensions)
  ? manifest.extensions.paths
  : manifest.extensions;
const containers = Array.isArray(configured) ? configured : [configured];

let failures = 0;
const fail = (message) => {
  console.error(`FAIL ${message}`);
  failures += 1;
};

const marketplacePlugin = marketplace.plugins?.find(
  (plugin) => plugin.name === manifest.name,
);
const metadataDocuments = [
  ["plugin.json", manifest],
  ["marketplace.json", marketplacePlugin],
  ["package.json", packageManifest],
];

if (!existsSync(join(root, "lib", "windows-app-helper.mjs"))) {
  fail("runtime helper preflight module is missing from lib/windows-app-helper.mjs");
}

for (const [name, metadata] of metadataDocuments) {
  if (!metadata) {
    fail(`${name} has no metadata for ${manifest.name}`);
  } else if (!metadata.keywords?.includes("canvas")) {
    fail(`${name} must include the exact "canvas" keyword`);
  }
}

const requiredLogo = "assets/preview.png";
if (manifest.logo !== requiredLogo) {
  fail(`plugin.json logo must be ${requiredLogo}`);
} else if (!existsSync(resolve(root, manifest.logo))) {
  fail(`plugin logo is missing at ${manifest.logo}`);
}

if (containers.some((entry) => typeof entry !== "string" || entry.length === 0)) {
  fail("plugin.json must configure at least one extension container path");
} else {
  const discovered = [];
  for (const relative of containers) {
    const container = resolve(root, relative);
    if (!existsSync(container)) {
      fail(`extension container does not exist: ${relative}`);
      continue;
    }

    for (const child of readdirSync(container, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const entrypoint = join(container, child.name, "extension.mjs");
      if (existsSync(entrypoint)) {
        discovered.push({ name: child.name, entrypoint });
      }
    }
  }

  // Both products ship as sibling children of the same container and must each bridge to a shared
  // source module and carry a byte-identical copy of the canvas icon.
  const requiredChildren = ["mobile-canvas", "windows-app"];
  const rootIcon = readFileSync(join(root, "assets", "icon.png"));
  for (const name of requiredChildren) {
    const child = discovered.find((extension) => extension.name === name);
    if (!child) {
      fail(`configured containers do not expose ${name}/extension.mjs`);
      continue;
    }

    const source = readFileSync(child.entrypoint, "utf8");
    const importPath = /import\s+["']([^"']+)["'];/.exec(source)?.[1];
    if (!importPath || !existsSync(resolve(dirname(child.entrypoint), importPath))) {
      fail(`${name} entrypoint does not import an existing shared extension module`);
    }

    const icon = join(dirname(child.entrypoint), "assets", "icon.png");
    if (!existsSync(icon)) {
      fail(`${name} extension icon is missing at assets/icon.png`);
    } else if (!readFileSync(icon).equals(rootIcon)) {
      fail(`${name} extension icon differs from the shared extension icon`);
    }
  }

  if (failures === 0) {
    console.log(
      `ok   discovered ${discovered.map((extension) => extension.name).join(", ")}`,
    );
  }
}

process.exit(failures === 0 ? 0 : 1);
