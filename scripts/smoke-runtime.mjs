#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCommand } from "../lib/runtime.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "runtimes", "manifest.json"), "utf8"));
const { command, source } = await resolveCommand();

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

execFileSync(command, ["host", "stop", "--json"], { stdio: "ignore" });
console.log(
  `ok   ${source} started host ${health.version} and listed ${devices.length} device(s)`,
);
