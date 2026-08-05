#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
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

  const mobileCanvas = discovered.find((extension) => extension.name === "mobile-canvas");
  if (!mobileCanvas) {
    fail("configured containers do not expose mobile-canvas/extension.mjs");
  } else {
    const source = readFileSync(mobileCanvas.entrypoint, "utf8");
    const importPath = /import\s+["']([^"']+)["'];/.exec(source)?.[1];
    if (!importPath || !existsSync(resolve(dirname(mobileCanvas.entrypoint), importPath))) {
      fail("plugin entrypoint does not import an existing shared extension module");
    }

    const icon = join(dirname(mobileCanvas.entrypoint), "assets", "icon.png");
    if (!existsSync(icon)) {
      fail("plugin extension icon is missing at assets/icon.png");
    } else if (
      !readFileSync(icon).equals(readFileSync(join(root, "assets", "icon.png")))
    ) {
      fail("plugin extension icon differs from the shared extension icon");
    }
  }

  if (failures === 0) {
    console.log(
      `ok   discovered ${discovered.map((extension) => extension.name).join(", ")}`,
    );
  }
}

process.exit(failures === 0 ? 0 : 1);
