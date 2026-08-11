#!/usr/bin/env node
// Reads a packaged VSIX back out of the archive.
//
// Both the packaging check and the Marketplace publish need to know what a
// package actually contains, and neither can trust the working tree to answer:
// a release job re-stamps the version between packaging and publishing, and the
// publish job downloads the archive as an artifact rather than building it. The
// archive is the only thing that ships, so it is the only thing worth reading.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

// A VSIX is a zip. Windows runners have no unzip, so they go through the shell
// that is always present instead of taking a dependency to read our own output.
export function extractVsix(source, destination) {
	if (process.platform === "win32") {
		const archive = join(destination, "mobile-canvas-vsix.zip");
		copyFileSync(source, archive);
		try {
			execFileSync(
				"powershell.exe",
				[
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"Expand-Archive -LiteralPath $env:MC_VSIX -DestinationPath $env:MC_DEST -Force",
				],
				{
					env: { ...process.env, MC_VSIX: archive, MC_DEST: destination },
					stdio: "inherit",
				},
			);
		} finally {
			rmSync(archive, { force: true });
		}
		return;
	}

	execFileSync("unzip", ["-q", source, "-d", destination]);
}

export function withVsix(vsix, callback) {
	const extracted = mkdtempSync(join(tmpdir(), "mobile-canvas-vsix-"));
	try {
		extractVsix(vsix, extracted);
		return callback(extracted);
	} finally {
		rmSync(extracted, { recursive: true, force: true });
	}
}

export function listFiles(rootDirectory) {
	const files = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(path);
			} else if (entry.isFile()) {
				files.push(relative(rootDirectory, path).split(sep).join("/"));
			}
		}
	};
	visit(rootDirectory);
	return files;
}

// The Marketplace serves a package carrying no TargetPlatform to every platform
// that has no specific package, so a missing attribute is a meaningful value --
// "this is the fallback" -- rather than absent data, and is reported as null
// instead of being dropped.
export function readVsixIdentity(directory) {
	const manifest = readFileSync(join(directory, "extension.vsixmanifest"), "utf8");
	const identity = /<Identity\b[^>]*>/.exec(manifest);
	if (!identity) {
		throw new Error("VSIX manifest has no <Identity> element");
	}

	const target = /\bTargetPlatform="([^"]+)"/.exec(identity[0]);
	const extensionPackage = JSON.parse(
		readFileSync(join(directory, "extension", "package.json"), "utf8"),
	);

	return {
		id: `${extensionPackage.publisher}.${extensionPackage.name}`,
		version: extensionPackage.version,
		target: target ? target[1] : null,
		package: extensionPackage,
	};
}

// vsce refuses to publish an extension carrying user-provided SVG images, and
// it refuses at publish time -- long after packaging succeeded and a tag went
// out. Checking it here fails the pull request that introduces the image
// instead of the release that tries to ship it.
//
// The rule is narrower than "no SVGs in the package": it covers the manifest
// icon, manifest badges, and images in the readme. It does not cover contributed
// icons, which is why media/activitybar.svg stays an SVG -- the activity bar
// tints that mark with currentColor, so a raster copy would be wrong in half of
// the themes.
//
// vsce rewrites relative readme links against the repository field when it
// packages, so by the time an image reaches the VSIX it should already be
// absolute. One that is not would be broken on the Marketplace page.
export function verifyPublishableImages(extensionPackage, readme) {
  const reject = (where, source) => {
    if (source.toLowerCase().split("?")[0].endsWith(".svg")) {
      throw new Error(
        `${where} may not be an SVG; vsce refuses to publish it: ${source}`,
      );
    }
  };

  reject("the marketplace icon", extensionPackage.icon ?? "");
  for (const badge of extensionPackage.badges ?? []) {
    reject("a marketplace badge", badge.url ?? "");
  }

  const sources = [
    ...readme.matchAll(/!\[[^\]]*\]\(\s*<?([^)>\s]+)/g),
    ...readme.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi),
  ].map((match) => match[1]);

  for (const source of sources) {
    reject("a readme image", source);
    if (!/^https:\/\//i.test(source)) {
      throw new Error(
        `readme images must resolve to https URLs for the marketplace: ${source}`,
      );
    }
  }
}
