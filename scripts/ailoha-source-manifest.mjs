#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destinationRoot = "imports/mobile-canvas";

export function buildAilohaSourceManifest({
  repositoryRoot = root,
  outputPath,
} = {}) {
  const excluded = outputPath
    ? relative(repositoryRoot, outputPath).replaceAll("\\", "/")
    : undefined;
  const trackedModes = readTrackedModes(repositoryRoot);
  const files = listSourceFiles(repositoryRoot)
    .filter((path) => path !== excluded)
    .map((source) => describeFile(repositoryRoot, source, trackedModes));
  const snapshot = createHash("sha256");
  let totalBytes = 0;

  for (const file of files) {
    totalBytes += file.size;
    snapshot.update(file.source);
    snapshot.update("\0");
    snapshot.update(file.sha256);
    snapshot.update("\0");
    snapshot.update(file.executable ? "1" : "0");
    snapshot.update("\0");
  }

  const packageJson = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  );

  return {
    schemaVersion: 1,
    source: {
      repository: "Redth/mobile-canvas-ghcp",
      commit: git(repositoryRoot, ["rev-parse", "HEAD"]).trim(),
      version: packageJson.version,
      dirty: git(repositoryRoot, ["status", "--porcelain"]).trim().length > 0,
    },
    destinationRoot,
    snapshot: {
      sha256: snapshot.digest("hex"),
      fileCount: files.length,
      totalBytes,
    },
    surfaces: readProductSurfaces(repositoryRoot, files),
    files,
  };
}

function listSourceFiles(repositoryRoot) {
  const listed = git(repositoryRoot, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ])
    .split("\0")
    .filter((path) => path && existsSync(join(repositoryRoot, path)))
    .sort();

  if (listed.length === 0) {
    throw new Error("git ls-files matched no source files -- is this a git checkout?");
  }

  return listed;
}

function describeFile(repositoryRoot, source, trackedModes) {
  const path = join(repositoryRoot, source);
  const bytes = readFileSync(path);
  return {
    source,
    destination: `${destinationRoot}/${source}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    executable: trackedModes.get(source) ?? (lstatSync(path).mode & 0o111) !== 0,
  };
}

function readProductSurfaces(repositoryRoot, files) {
  const backend = readFileSync(
    join(repositoryRoot, "src", "MobileCanvas.Core", "DeviceBackend.cs"),
    "utf8",
  );
  const backendStart = backend.indexOf("public interface IDeviceBackend");
  const backendEnd = backend.indexOf("public interface ILiveVideoSession");
  if (backendStart < 0 || backendEnd <= backendStart) {
    throw new Error("Could not locate IDeviceBackend in DeviceBackend.cs.");
  }

  const api = readFileSync(
    join(repositoryRoot, "src", "MobileCanvas.Tool", "DeviceApi.cs"),
    "utf8",
  );
  const extension = readFileSync(join(repositoryRoot, "extension.mjs"), "utf8");
  const mcp = files
    .filter(
      (file) =>
        file.source.startsWith("src/MobileCanvas.Tool/Mcp/") &&
        file.source.endsWith(".cs"),
    )
    .map((file) => readFileSync(join(repositoryRoot, file.source), "utf8"))
    .join("\n");

  return {
    backendOperations: matches(
      backend.slice(backendStart, backendEnd),
      /\bTask(?:<[^;\n]+>)?\s+([A-Z]\w+Async)\s*\(/g,
    ),
    httpRoutes: matches(api, /"(\/(?:api\/v1|ws\/)[^"]+)"/g),
    mcpTools: matches(mcp, /Name\s*=\s*"(mobile_device_[^"]+)"/g),
    canvasActions: [
      ...matches(extension, /\bname:\s*"([a-z][a-z0-9_]*)"/g),
      ...matches(extension, /\btargetAction\(\s*"([a-z][a-z0-9_]*)"/g),
    ].sort(),
  };
}

function matches(source, pattern) {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]))].sort();
}

function readTrackedModes(repositoryRoot) {
  const modes = new Map();
  for (const entry of git(repositoryRoot, ["ls-files", "--stage", "-z"]).split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("\t");
    if (separator < 0) continue;
    const mode = entry.slice(0, separator).split(" ", 1)[0];
    const path = entry.slice(separator + 1);
    modes.set(path, mode === "100755");
  }
  return modes;
}

function git(repositoryRoot, arguments_) {
  return execFileSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseArguments(arguments_) {
  let output;
  let requireClean = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--require-clean") {
      requireClean = true;
      continue;
    }
    if (argument === "--output") {
      output = arguments_[++index];
      if (!output) throw new Error("--output requires a path.");
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return { output, requireClean };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArguments(process.argv.slice(2));
  const outputPath = options.output
    ? isAbsolute(options.output)
      ? options.output
      : resolve(root, options.output)
    : undefined;
  const manifest = buildAilohaSourceManifest({ outputPath });

  if (options.requireClean && manifest.source.dirty) {
    throw new Error(
      "The Mobile Canvas checkout has uncommitted changes; commit them before exporting an Ailoha source snapshot.",
    );
  }

  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, json);
    console.error(
      `Wrote ${manifest.snapshot.fileCount} files (${manifest.snapshot.sha256}) to ${outputPath}`,
    );
  } else {
    process.stdout.write(json);
  }
}
