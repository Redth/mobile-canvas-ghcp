#!/usr/bin/env node
// Hashes the source that produced the published binaries, so the runtime
// manifest can be checked against src/ without rebuilding.
//
// Rebuilding and comparing against published bytes does not work: Native AOT
// output is not bit-reproducible, so a fresh build of unchanged source still
// differs. A check like that fires on every run and therefore says nothing,
// which is worse than no check because real drift hides in the noise.
//
// Hashing the inputs instead is deterministic. bundle.mjs records the hash it
// built from; CI recomputes it and compares. Same source, same hash, no rebuild
// needed.
//
//   source-hash.mjs            print the hash
//   source-hash.mjs --check    compare against the hash in runtimes/manifest.json
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Everything the compiled binaries are built from. scripts/build.sh is included
// because it carries the publish flags, so changing them changes the output just
// as surely as changing a source file does.
const INPUTS = [
	"src",
	"native",
	"Directory.Build.props",
	"Directory.Packages.props",
	"MobileCanvas.slnx",
	"global.json",
	"scripts/build.sh",
];

export function sourceHash() {
	// Include new source files before their first commit as well as tracked files. Ignored build
	// output remains excluded, so a release prepared in the same change that adds a source file
	// records the same hash it will have after that file is committed.
	const listed = execFileSync("git", [
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard",
		"--",
		...INPUTS,
	], {
		cwd: root,
		maxBuffer: 64 * 1024 * 1024,
	})
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.sort();

	if (listed.length === 0) {
		throw new Error("git ls-files matched no source files -- is this a git checkout?");
	}

	const digest = createHash("sha256");
	for (const relative of listed) {
		// The path is hashed alongside the content so that renaming a file changes
		// the hash even when its bytes are untouched.
		digest.update(relative);
		digest.update("\0");
		digest.update(readFileSync(join(root, relative)));
		digest.update("\0");
	}

	return { hash: digest.digest("hex"), count: listed.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const { hash, count } = sourceHash();

	if (process.argv[2] !== "--check") {
		console.log(hash);
		process.exit(0);
	}

	const manifestPath = join(root, "runtimes", "manifest.json");
	const recorded = JSON.parse(readFileSync(manifestPath, "utf8")).sourceHash;

	console.log(`  source:   ${hash} (${count} files)`);
	console.log(`  manifest: ${recorded ?? "(none recorded)"}`);

	if (!recorded) {
		console.error(
			"\nruntimes/manifest.json records no sourceHash, so it cannot be checked against src/."
			+ "\nRebuild the runtimes to record one.",
		);
		process.exit(1);
	}

	if (recorded !== hash) {
		console.error(
			"\nThe published runtime was built from different source than what is here, so a plugin"
			+ "\ninstall would run a stale binary. Dispatch the 'Release runtimes' workflow.",
		);
		process.exit(1);
	}

	console.log("\nPublished runtimes match src/");
}
