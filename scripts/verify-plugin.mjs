#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDarwinHelperEntries } from "../lib/runtime-assets.mjs";

const scriptRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.argv[2] ?? scriptRoot);
const manifestPath = join(root, ".github", "plugin", "plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const agentManifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
const agentMcp = JSON.parse(readFileSync(join(root, "mcp.json"), "utf8"));
const marketplace = JSON.parse(
  readFileSync(join(root, ".github", "plugin", "marketplace.json"), "utf8"),
);
const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const runtimeManifest = JSON.parse(readFileSync(join(root, "runtimes", "manifest.json"), "utf8"));

const configured = typeof manifest.extensions === "object" && !Array.isArray(manifest.extensions)
  ? manifest.extensions.paths
  : manifest.extensions;
const containers = Array.isArray(configured) ? configured : [configured];

let failures = 0;
const fail = (message) => {
  console.error(`FAIL ${message}`);
  failures += 1;
};

const manifestFields = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);
if (
  agentManifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
) {
  fail("plugin.json must target the Agent Plugins 1.0.0 manifest schema");
}
if (
  typeof agentManifest.name !== "string"
  || !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(agentManifest.name)
  || agentManifest.name.length > 64
) {
  fail("plugin.json name must satisfy the Agent Plugins name constraints");
}
for (const key of Object.keys(agentManifest)) {
  if (!manifestFields.has(key)) {
    fail(`plugin.json has non-standard top-level field ${key}`);
  }
}
for (const key of ["version", "description", "homepage", "repository", "license"]) {
  if (typeof agentManifest[key] !== "undefined" && typeof agentManifest[key] !== "string") {
    fail(`plugin.json ${key} must be a string`);
  }
}
if (
  typeof agentManifest.keywords !== "undefined"
  && (
    !Array.isArray(agentManifest.keywords)
    || agentManifest.keywords.some((keyword) => typeof keyword !== "string")
  )
) {
  fail("plugin.json keywords must be an array of strings");
}
if (typeof agentManifest.author !== "undefined") {
  const authorFields = new Set(["name", "email", "url"]);
  if (
    !agentManifest.author
    || typeof agentManifest.author !== "object"
    || Array.isArray(agentManifest.author)
    || Object.entries(agentManifest.author).some(
      ([key, value]) => !authorFields.has(key) || typeof value !== "string",
    )
  ) {
    fail("plugin.json author must contain only string name, email, or url fields");
  }
}
if (agentManifest.name !== manifest.name) {
  fail("plugin.json name must match the Copilot plugin name");
}
if (agentManifest.version !== packageManifest.version) {
  fail("plugin.json version must match package.json");
}
if (
  !Array.isArray(agentManifest.keywords)
  || !agentManifest.keywords.includes("canvas")
) {
  fail('plugin.json must include the exact "canvas" keyword');
}
if (
  typeof agentManifest.extensions !== "undefined"
  && (
    agentManifest.extensions === null
    || typeof agentManifest.extensions !== "object"
    || Array.isArray(agentManifest.extensions)
    || Object.values(agentManifest.extensions).some(
      (value) => !value || typeof value !== "object" || Array.isArray(value),
    )
  )
) {
  fail("plugin.json extensions must be an object when present");
}

if (
  agentMcp.$schema !== "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
  || Object.keys(agentMcp).some((key) => !["$schema", "mcpServers"].includes(key))
  || !agentMcp.mcpServers
  || typeof agentMcp.mcpServers !== "object"
  || Array.isArray(agentMcp.mcpServers)
) {
  fail("mcp.json must use the Agent Plugins 1.0.0 schema and mcpServers object");
} else {
  const server = agentMcp.mcpServers["mobile-canvas"];
  if (
    Object.keys(agentMcp.mcpServers).length !== 1
    || !server
    || Object.keys(server).some((key) => !["type", "command", "args", "env", "cwd"].includes(key))
    || server.type !== "stdio"
    || server.command !== "node"
    || !Array.isArray(server.args)
    || server.args.length !== 1
    || server.args[0] !== "${PLUGIN_ROOT}/scripts/mcp.mjs"
    || server.cwd !== "${PLUGIN_ROOT}"
    || (server.env && (
      typeof server.env !== "object"
      || Array.isArray(server.env)
      || Object.values(server.env).some((value) => typeof value !== "string")
    ))
  ) {
    fail("mcp.json must configure the packaged mobile-canvas stdio server");
  }
}

try {
  assertDarwinHelperEntries(runtimeManifest, { context: "Copilot plugin runtime manifest" });
} catch (error) {
  fail(error.message);
}

for (const relative of [
  "lib/ailoha/index.mjs",
  "lib/ailoha/index.d.mts",
  "lib/ailoha/errors.mjs",
  "lib/ailoha/protocol.mjs",
  "web/ailoha-video-protocol.js",
  "web/ailoha-video-receiver.js",
]) {
  if (!existsSync(join(root, relative))) {
    fail(`plugin is missing shared foundation ${relative}`);
  }
}

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
} else if (containers.some((entry) => !entry.startsWith("com.github.copilot/"))) {
  fail("Copilot-specific files must live under the com.github.copilot namespace");
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
