import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildAilohaSourceManifest,
  computeAilohaSnapshot,
} from "../../scripts/ailoha-source-manifest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("Ailoha source manifest covers the complete product source", () => {
  const manifest = buildAilohaSourceManifest();
  const sources = manifest.files.map((file) => file.source);

  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.source.repository, "Redth/mobile-canvas-ghcp");
  assert.match(manifest.source.commit, /^[a-f0-9]{40}$/);
  assert.equal(manifest.destinationRoot, "imports/mobile-canvas");
  assert.deepEqual(sources, [...sources].sort());
  assert.equal(manifest.snapshot.fileCount, manifest.files.length);
  assert.ok(manifest.snapshot.totalBytes > 0);
  assert.match(manifest.snapshot.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    manifest.snapshot.includes,
    ["destinationRoot", "files", "surfaces"],
  );
  assert.ok(manifest.surfaces.backendOperations.length > 40);
  assert.ok(manifest.surfaces.httpRoutes.length > 50);
  assert.ok(manifest.surfaces.mcpTools.length > 30);
  assert.ok(manifest.surfaces.canvasActions.length > 20);

  for (const required of [
    "extension.mjs",
    "native/mobile-screencap/Sources/Entry.swift",
    "src/MobileCanvas.Core/DeviceService.cs",
    "vscode/src/hostBridge.ts",
    "web/device-canvas.js",
  ]) {
    assert.ok(sources.includes(required), `${required} is missing from the snapshot`);
  }

  assert.equal(sources.some((source) => source.startsWith(".build/")), false);
  assert.equal(sources.some((source) => source.includes("/bin/")), false);
  assert.equal(sources.some((source) => source.includes("/obj/")), false);

  assert.ok(manifest.surfaces.backendOperations.includes("OpenVideoStreamAsync"));
  assert.ok(manifest.surfaces.httpRoutes.includes("/ws/video"));
  assert.ok(manifest.surfaces.mcpTools.includes("mobile_device_screenshot"));
  assert.ok(manifest.surfaces.canvasActions.includes("list_devices"));
  for (const surface of Object.values(manifest.surfaces)) {
    assert.deepEqual(surface, [...surface].sort());
  }
});

test("Ailoha source manifest records byte-exact hashes and destinations", () => {
  const manifest = buildAilohaSourceManifest();
  const entry = manifest.files.find(
    (file) => file.source === "web/device-canvas.js",
  );

  assert.ok(entry);
  const bytes = readFileSync(join(root, entry.source));
  assert.equal(entry.size, bytes.length);
  assert.equal(
    entry.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(
    entry.destination,
    "imports/mobile-canvas/web/device-canvas.js",
  );
});

test("Ailoha source manifest is deterministic for an unchanged checkout", () => {
  const first = buildAilohaSourceManifest();
  const second = buildAilohaSourceManifest();

  assert.equal(first.snapshot.sha256, second.snapshot.sha256);
  assert.deepEqual(first.files, second.files);
});

test("Ailoha source snapshot authenticates the feature surface inventory", () => {
  const manifest = buildAilohaSourceManifest();
  assert.equal(
    computeAilohaSnapshot(
      manifest.files,
      manifest.surfaces,
      manifest.destinationRoot,
    ),
    manifest.snapshot.sha256,
  );

  const tampered = structuredClone(manifest.surfaces);
  tampered.canvasActions = [...tampered.canvasActions, "not_a_real_action"].sort();
  assert.notEqual(
    computeAilohaSnapshot(
      manifest.files,
      tampered,
      manifest.destinationRoot,
    ),
    manifest.snapshot.sha256,
  );
});

test("Ailoha source snapshot authenticates the complete import mapping", () => {
  const manifest = buildAilohaSourceManifest();
  const files = structuredClone(manifest.files);
  files[0].destination = `${manifest.destinationRoot}/different-path`;

  assert.notEqual(
    computeAilohaSnapshot(files, manifest.surfaces, manifest.destinationRoot),
    manifest.snapshot.sha256,
  );
  assert.notEqual(
    computeAilohaSnapshot(
      manifest.files,
      manifest.surfaces,
      `${manifest.destinationRoot}-elsewhere`,
    ),
    manifest.snapshot.sha256,
  );
});

test("Ailoha manifest output does not make its own checkout dirty", async () => {
  const output = join(root, `ailoha-source-manifest-${process.pid}.json`);
  const before = buildAilohaSourceManifest({ outputPath: output }).source.dirty;
  try {
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(output, "{}\n"),
    );
    const manifest = buildAilohaSourceManifest({ outputPath: output });
    assert.equal(manifest.source.dirty, before);
    assert.equal(
      manifest.files.some((file) => file.source === output.slice(root.length + 1)),
      false,
    );
  } finally {
    await import("node:fs/promises").then(({ rm }) =>
      rm(output, { force: true }),
    );
  }
});
