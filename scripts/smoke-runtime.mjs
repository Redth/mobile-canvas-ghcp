#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  platformKey,
  resolveCommand,
  resolveRuntimeCompanion,
  validateRuntimePreflight,
} from "../lib/runtime.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "runtimes", "manifest.json"), "utf8"));
const { command, source } = await resolveCommand();
const entry = manifest.runtimes?.[platformKey()];
const helperFiles = entry ? validateRuntimePreflight(platformKey(), entry) : [];

// A same-version host from another installation could otherwise make the smoke
// test pass without executing this bundle's host.
execFileSync(command, ["host", "stop", "--json"], { stdio: "ignore" });

const versionText = execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
if (!versionText.includes(manifest.version)) {
  throw new Error(
    `bundled runtime version does not match ${manifest.version}: ${versionText}`,
  );
}

const devices = JSON.parse(
  execFileSync(command, ["devices", "list", "--json"], { encoding: "utf8" }),
);
if (!Array.isArray(devices)) {
  throw new Error("bundled runtime devices list did not return an array");
}

const health = JSON.parse(
  execFileSync(command, ["host", "status", "--json"], { encoding: "utf8" }),
);
if (health.version !== manifest.version) {
  throw new Error(
    `bundled runtime started host ${health.version}; expected ${manifest.version}`,
  );
}

for (const helperName of helperFiles) {
  const helper = resolveRuntimeCompanion(command, helperName);
  const capabilities = JSON.parse(
    execFileSync(helper, ["capabilities", "--json"], { encoding: "utf8" }),
  );
  if (
    capabilities.schemaVersion !== 1
    || capabilities.ok !== true
    || typeof capabilities.helperVersion !== "string"
    || typeof capabilities.architecture !== "string"
    || typeof capabilities.features?.authenticodeSignature?.valid !== "boolean"
  ) {
    throw new Error(`${helperName} did not return a valid capabilities report`);
  }
}

execFileSync(command, ["host", "stop", "--json"], { stdio: "ignore" });
console.log(
  `ok   ${source} started host ${health.version}, listed ${devices.length} device(s), `
    + `and preflighted ${helperFiles.length} helper(s)`,
);
