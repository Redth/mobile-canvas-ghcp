#!/usr/bin/env node
// Writes one version into the two places that carry it: package.json, which is
// the version the plugin manager shows, and Directory.Build.props, which is what
// the binary reports from `mobile-canvas --version`. They are separate files and
// drift apart silently, so a bug report ends up naming a version that never
// shipped. The release workflow runs this before building rather than only
// before bundling, because the binary bakes its version in at compile time.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version) {
  console.error("usage: stamp-version.mjs <version>");
  process.exit(1);
}

// NuGet splits a version at the first hyphen: everything before is the numeric
// prefix, everything after is the prerelease suffix.
const match = /^(\d+\.\d+\.\d+)(?:-(.+))?$/.exec(version);
if (!match) {
  console.error(`not a version: ${version} (expected 1.2.3 or 1.2.3-preview.1)`);
  process.exit(1);
}
const [, prefix, suffix = ""] = match;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const propsPath = join(root, "Directory.Build.props");
const before = readFileSync(propsPath, "utf8");
// Match on the elements rather than on whether the text changed: re-stamping the
// version that is already there is a legitimate no-op, and the failure worth
// catching is a renamed or missing element, which would otherwise ship the wrong
// version silently.
const prefixPattern = /<VersionPrefix>[^<]*<\/VersionPrefix>/;
const suffixPattern = /<VersionSuffix>[^<]*<\/VersionSuffix>/;
for (const [name, pattern] of [["VersionPrefix", prefixPattern], ["VersionSuffix", suffixPattern]]) {
  if (!pattern.test(before)) {
    console.error(`Directory.Build.props has no <${name}> to replace`);
    process.exit(1);
  }
}
writeFileSync(
  propsPath,
  before
    .replace(prefixPattern, `<VersionPrefix>${prefix}</VersionPrefix>`)
    .replace(suffixPattern, `<VersionSuffix>${suffix}</VersionSuffix>`),
);

console.log(`stamped ${version} into package.json and Directory.Build.props`);
