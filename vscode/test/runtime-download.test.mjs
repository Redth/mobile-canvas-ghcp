import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { runtimeAssetName } from "../../lib/runtime-assets.mjs";
import { materializeRuntime } from "../../lib/runtime.mjs";

function fixture(expectedHash) {
  const executable = Buffer.from("#!/bin/sh\necho mobile-canvas\n");
  const hash = expectedHash ?? createHash("sha256").update(executable).digest("hex");
  const manifest = {
    version: "9.8.7",
    distribution: {
      repository: "Redth/mobile-canvas-ghcp",
      tag: "v9.8.7",
    },
    runtimes: {},
  };
  const entry = {
    rid: "test-rid",
    executable: "mobile-canvas",
    id: hash,
    files: {
      "mobile-canvas": {
        archive: "test-rid/mobile-canvas.gz",
        sha256: hash,
        size: executable.length,
      },
    },
  };
  return { executable, manifest, entry };
}

test("runtime asset names are pinned to version and RID", () => {
  const { manifest, entry } = fixture();
  assert.equal(
    runtimeAssetName(manifest, entry, "mobile-canvas.exe"),
    "mobile-canvas-v9.8.7-test-rid.gz",
  );
});

test("downloads, verifies, and reuses a cached runtime", async () => {
  const { executable, manifest, entry } = fixture();
  const packed = gzipSync(executable);
  const cacheRoot = mkdtempSync(join(tmpdir(), "mobile-canvas-runtime-cache-"));
  const runtimesDir = mkdtempSync(join(tmpdir(), "mobile-canvas-empty-runtimes-"));
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    assert.equal(
      request.url,
      `/${runtimeAssetName(manifest, entry, "mobile-canvas")}`,
    );
    response.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": packed.length,
    });
    response.end(packed);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const options = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      cacheRoot,
      runtimesDir,
      platformKey: "test-platform",
    };
    const first = await materializeRuntime(manifest, entry, options);
    const second = await materializeRuntime(manifest, entry, options);

    assert.equal(first, second);
    assert.deepEqual(readFileSync(first), executable);
    assert.equal(requests, 1);
  } finally {
    server.close();
    rmSync(cacheRoot, { recursive: true, force: true });
    rmSync(runtimesDir, { recursive: true, force: true });
  }
});

test("rejects a downloaded runtime whose checksum does not match", async () => {
  const { executable, manifest, entry } = fixture("0".repeat(64));
  const packed = gzipSync(executable);
  const cacheRoot = mkdtempSync(join(tmpdir(), "mobile-canvas-runtime-cache-"));
  const runtimesDir = mkdtempSync(join(tmpdir(), "mobile-canvas-empty-runtimes-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/gzip" });
    response.end(packed);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await assert.rejects(
      materializeRuntime(manifest, entry, {
        baseUrl: `http://127.0.0.1:${address.port}`,
        cacheRoot,
        runtimesDir,
        platformKey: "test-platform",
      }),
      /checksum mismatch/,
    );
  } finally {
    server.close();
    rmSync(cacheRoot, { recursive: true, force: true });
    rmSync(runtimesDir, { recursive: true, force: true });
  }
});

test("stops reading a chunked runtime response at the archive limit", async () => {
  const { manifest, entry } = fixture();
  const cacheRoot = mkdtempSync(join(tmpdir(), "mobile-canvas-runtime-cache-"));
  const runtimesDir = mkdtempSync(join(tmpdir(), "mobile-canvas-empty-runtimes-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/gzip" });
    response.write(Buffer.alloc(8));
    response.end(Buffer.alloc(8));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await assert.rejects(
      materializeRuntime(manifest, entry, {
        baseUrl: `http://127.0.0.1:${address.port}`,
        cacheRoot,
        maxArchiveBytes: 8,
        runtimesDir,
        platformKey: "test-platform",
      }),
      /oversized runtime archive/,
    );
  } finally {
    server.close();
    rmSync(cacheRoot, { recursive: true, force: true });
    rmSync(runtimesDir, { recursive: true, force: true });
  }
});
