#!/usr/bin/env node
// Writes one version into every file that carries it. These files drift apart
// silently: package.json is the plugin version, vscode/package*.json describe
// the VS Code package,
// Directory.Build.props is what the binary reports from `mobile-canvas
// --version`, and the two files under .github/plugin are what someone browsing
// the marketplace sees. Drift means a bug report names a version that never
// shipped -- which had already happened, with the marketplace manifests left a
// whole release behind at 0.1.0 while the binary shipped 0.1.1.
//
// The release workflow runs this before building rather than only before
// bundling, because the binary bakes its version in at compile time.
//
//   stamp-version.mjs 1.2.3    write the version everywhere
//   stamp-version.mjs --check  verify every file already agrees
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// NuGet splits a version at the first hyphen: everything before is the numeric
// prefix, everything after is the prerelease suffix.
const VERSION = /^(\d+\.\d+\.\d+)(?:-(.+))?$/;

const jsonFile = (relative, select) => ({
	relative,
	read: () => select(JSON.parse(readFileSync(join(root, relative), "utf8"))).version,
	write: (version) => {
		const path = join(root, relative);
		const document = JSON.parse(readFileSync(path, "utf8"));
		select(document).version = version;
		writeFileSync(path, JSON.stringify(document, null, 2) + "\n");
	},
});

// marketplace.json carries two unrelated versions: metadata.version is the
// catalogue's own schema version and must not move, while the entry under
// plugins[] is this plugin's. Only the latter is ours.
const marketplacePlugin = (document) => {
	const entry = document.plugins?.find((plugin) => plugin.name === "mobile-canvas");
	if (!entry) {
		throw new Error("marketplace.json has no plugins[] entry named mobile-canvas");
	}

	return entry;
};

const propsPath = join(root, "Directory.Build.props");
const vscodeLockPath = join(root, "vscode", "package-lock.json");
const propsPatterns = {
	VersionPrefix: /<VersionPrefix>([^<]*)<\/VersionPrefix>/,
	VersionSuffix: /<VersionSuffix>([^<]*)<\/VersionSuffix>/,
};

const readProps = (text) => {
	const found = {};
	for (const [name, pattern] of Object.entries(propsPatterns)) {
		const match = pattern.exec(text);
		// Match on the elements rather than on whether the text changed: re-stamping
		// the version already there is a legitimate no-op, and the failure worth
		// catching is a renamed or missing element, which would otherwise ship the
		// wrong version silently.
		if (!match) {
			throw new Error(`Directory.Build.props has no <${name}>`);
		}

		found[name] = match[1];
	}

	return found;
};

const files = [
	jsonFile("package.json", (document) => document),
	jsonFile("vscode/package.json", (document) => document),
	{
		relative: "vscode/package-lock.json",
		read: () => {
			const document = JSON.parse(readFileSync(vscodeLockPath, "utf8"));
			const rootVersion = document.packages?.[""]?.version;
			if (document.version !== rootVersion) {
				throw new Error(
					`vscode/package-lock.json disagrees internally: ${document.version} and ${rootVersion}`,
				);
			}
			return document.version;
		},
		write: (version) => {
			const document = JSON.parse(readFileSync(vscodeLockPath, "utf8"));
			if (!document.packages?.[""]) {
				throw new Error("vscode/package-lock.json has no root package entry");
			}
			document.version = version;
			document.packages[""].version = version;
			writeFileSync(vscodeLockPath, JSON.stringify(document, null, 2) + "\n");
		},
	},
	jsonFile(".github/plugin/plugin.json", (document) => document),
	jsonFile(".github/plugin/marketplace.json", marketplacePlugin),
	{
		relative: "Directory.Build.props",
		read: () => {
			const { VersionPrefix, VersionSuffix } = readProps(readFileSync(propsPath, "utf8"));
			return VersionSuffix ? `${VersionPrefix}-${VersionSuffix}` : VersionPrefix;
		},
		write: (version) => {
			const [, prefix, suffix = ""] = VERSION.exec(version);
			const before = readFileSync(propsPath, "utf8");
			readProps(before);
			writeFileSync(
				propsPath,
				before
					.replace(propsPatterns.VersionPrefix, `<VersionPrefix>${prefix}</VersionPrefix>`)
					.replace(propsPatterns.VersionSuffix, `<VersionSuffix>${suffix}</VersionSuffix>`),
			);
		},
	},
];

const fail = (message) => {
	console.error(message);
	process.exit(1);
};

const argument = process.argv[2];
if (!argument) {
	fail("usage: stamp-version.mjs <version> | --check");
}

if (argument === "--check") {
	const found = files.map((file) => [file.relative, file.read()]);
	for (const [relative, version] of found) {
		console.log(`  ${version.padEnd(18)} ${relative}`);
	}

	const versions = new Set(found.map(([, version]) => version));
	if (versions.size > 1) {
		fail(
			"\nThese files disagree about the version. Run `node scripts/stamp-version.mjs <version>`\n"
			+ "to write one version into all of them.",
		);
	}

	console.log(`\nall ${found.length} agree on ${[...versions][0]}`);
	process.exit(0);
}

if (!VERSION.test(argument)) {
	fail(`not a version: ${argument} (expected 1.2.3 or 1.2.3-preview.1)`);
}

for (const file of files) {
	file.write(argument);
}

console.log(`stamped ${argument} into ${files.map((file) => file.relative).join(", ")}`);
