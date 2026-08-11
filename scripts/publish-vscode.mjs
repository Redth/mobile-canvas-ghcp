#!/usr/bin/env node
// Publishes the VS Code packages built by the release workflow to the
// Marketplace.
//
//   publish-vscode.mjs                 publish everything not already published
//   publish-vscode.mjs --version 1.2.3 refuse to publish anything else
//   publish-vscode.mjs --dry-run       report what would be published
//
// What goes to the Marketplace is deliberately not what gets attached to the
// GitHub Release. The Marketplace serves each target package to the platform it
// matches and falls back to the package carrying no target for everything else,
// so the set to publish is the six target packages plus the thin universal
// VSIX, which downloads its runtime on first use. The bundled universal VSIX is
// ~73 MiB because it carries all six runtimes at once; it stays a GitHub
// Release download, both because a version may only carry one package with no
// target and because handing every user five runtimes they cannot execute is a
// worse default than a first-use download.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readVsixIdentity, withVsix } from "./vsix.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDirectory = join(root, ".build");
const extensionRoot = join(root, "vscode");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const dryRun = process.argv.includes("--dry-run");
const versionIndex = process.argv.indexOf("--version");
// The workflow always passes --version so the command reads the same whether or
// not it has one to pass, which means an empty value has to mean "no
// expectation" rather than "expect the empty version".
const expectedVersion = versionIndex >= 0
  ? (process.argv[versionIndex + 1] ?? "").trim().replace(/^v/, "")
  : "";

// Marketplace versions are strictly major.minor.patch: "semver pre-release tags
// are not supported". The release workflow can be dispatched with a v*-rc.*
// prerelease to smoke-test artifacts against real release URLs, and that is a
// GitHub-only concept -- saying so here beats a rejected upload after some of
// the targets already went out.
const RELEASABLE = /^\d+\.\d+\.\d+$/;

const packages = collectPackages();
const { id, version } = describe(packages);

if (expectedVersion && version !== expectedVersion) {
  throw new Error(
    `packages carry version ${version} but the release is ${expectedVersion}`,
  );
}
if (!RELEASABLE.test(version)) {
  throw new Error(
    `the marketplace does not accept prerelease versions, so ${version} cannot be published`,
  );
}
if (!dryRun && !process.env.VSCE_PAT) {
  // vsce prompts for a token it cannot read, which on a runner is a job that
  // hangs until it times out rather than one that fails.
  throw new Error("VSCE_PAT is not set, so vsce would block prompting for it");
}

const published = publishedPackages(id);
const pending = packages.filter(
  (entry) => !published.has(`${entry.version}\u0000${entry.target ?? ""}`),
);
const skipped = packages.length - pending.length;

if (skipped > 0) {
  // A publish that fails partway through has already shipped some targets, and
  // the only useful thing to do about it is to run the job again. Re-publishing
  // one that landed is rejected, so the ones that landed are dropped instead.
  console.log(`${skipped} package(s) already published at ${version}`);
}

if (pending.length === 0) {
  console.log(`${id} ${version} is already published`);
  summarise(packages, []);
} else {
  console.log(
    `publishing ${id} ${version}: ${pending.map(describeTarget).join(", ")}`,
  );

  if (!dryRun) {
    execFileSync(
      npm,
      ["exec", "--", "vsce", "publish", "--packagePath", ...pending.map((entry) => entry.path)],
      { cwd: extensionRoot, stdio: "inherit" },
    );
  }

  summarise(packages, pending);
}

// The release job uploads one artifact holding every VSIX it built, so the set
// to publish is read off disk rather than recomputed from the runtime manifest:
// publishing something the release did not produce is the failure worth
// avoiding, and matching the release's own filenames is what prevents it.
function collectPackages() {
  if (!existsSync(buildDirectory)) {
    throw new Error(`no packages to publish: ${buildDirectory} does not exist`);
  }

  const found = readdirSync(buildDirectory)
    .filter((name) => /^mobile-canvas-vscode-.+\.vsix$/.test(name))
    .sort()
    .map((name) => {
      const path = join(buildDirectory, name);
      return { path, ...withVsix(path, readVsixIdentity) };
    });

  if (found.length === 0) {
    throw new Error(`no mobile-canvas-vscode-*.vsix packages in ${buildDirectory}`);
  }

  const universal = found.filter((entry) => entry.target === null);
  if (universal.length > 1) {
    throw new Error(
      `only one package may omit a target platform, found ${universal
        .map((entry) => basename(entry.path))
        .join(", ")}`,
    );
  }
  if (found.some((entry) => entry.target !== null) && universal.length === 0) {
    throw new Error(
      "no fallback package: platforms without a target package could not install the extension",
    );
  }

  return found;
}

function describe(entries) {
  const ids = new Set(entries.map((entry) => entry.id));
  const versions = new Set(entries.map((entry) => entry.version));
  if (ids.size !== 1 || versions.size !== 1) {
    throw new Error(
      `packages disagree: ${entries
        .map((entry) => `${basename(entry.path)} is ${entry.id} ${entry.version}`)
        .join(", ")}`,
    );
  }

  return { id: [...ids][0], version: [...versions][0] };
}

// `vsce show` prints "undefined" rather than failing for an extension that has
// never been published, so the first release has to read as an empty set rather
// than as an error.
function publishedPackages(extensionId) {
  let output;
  try {
    output = execFileSync(npm, ["exec", "--", "vsce", "show", extensionId, "--json"], {
      cwd: extensionRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch {
    return new Set();
  }

  let listing;
  try {
    listing = JSON.parse(output);
  } catch {
    return new Set();
  }

  return new Set(
    (listing?.versions ?? []).map(
      (entry) => `${entry.version}\u0000${entry.targetPlatform ?? ""}`,
    ),
  );
}

function describeTarget(entry) {
  return entry.target ?? "universal fallback";
}

function summarise(all, pending) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  const lines = ["## VS Code Marketplace", ""];
  for (const entry of all) {
    const state = dryRun
      ? "would publish"
      : pending.includes(entry)
        ? "published"
        : "already published";
    const mib = (statSync(entry.path).size / 1024 / 1024).toFixed(1);
    lines.push(
      `- \`${describeTarget(entry)}\` -- ${state}, ${mib} MiB `
      + `(\`${relative(root, entry.path)}\`)`,
    );
  }

  console.log(lines.join("\n"));
  if (summaryPath) {
    appendFileSync(summaryPath, `${lines.join("\n")}\n`);
  }
}
