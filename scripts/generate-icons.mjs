#!/usr/bin/env node

// Renders every shipped raster icon from the single source of truth at assets/icon.svg so the
// Copilot canvas extension, the plugin copy the verifier compares byte-for-byte, and the VS Code
// marketplace icon can never drift apart. Run `npm run icons` after editing the SVG.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "assets", "icon.svg");

// The plugin copy is not generated from the SVG a second time: verify-plugin.mjs requires the two
// files to be byte-identical, so it is always copied from the shared render.
const renders = [
  { path: join(root, "assets", "icon.png"), size: 128, copies: [join(root, "extensions", "mobile-canvas", "assets", "icon.png")] },
  { path: join(root, "vscode", "media", "icon.png"), size: 256, copies: [] },
];

if (!hasRsvgConvert()) {
  throw new Error(
    "rsvg-convert is required to render the icons. Install it with `brew install librsvg`, "
    + "`apt-get install librsvg2-bin`, or `choco install rsvg-convert`.",
  );
}

readFileSync(source);

for (const render of renders) {
  mkdirSync(dirname(render.path), { recursive: true });
  execFileSync("rsvg-convert", [
    "--width", String(render.size),
    "--height", String(render.size),
    "--output", render.path,
    source,
  ]);
  console.log(`rendered ${relative(root, render.path)} at ${render.size}x${render.size}`);

  for (const copy of render.copies) {
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(render.path, copy);
    console.log(`copied   ${relative(root, copy)}`);
  }
}

function hasRsvgConvert() {
  try {
    execFileSync("rsvg-convert", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
