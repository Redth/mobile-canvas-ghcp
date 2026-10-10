import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";

const { projectFileListing } = await import(productModule("lib/ailoha/artifact-file-projection.mjs"));

test("native listing projects exact app-relative paths, raw metadata and legitimate empty files", () => {
  const input = {
    deviceId: "target", platform: "ios", bundleId: "com.example.app",
    listing: {
      path: "app://com.example.app/Documents", total: 2,
      files: [
        { name: "empty.db", path: "app://com.example.app/Documents/empty.db", type: "file",
          size: 0, lastModified: "1970-01-01T00:00:00Z" },
        { name: "cache", path: "app://com.example.app/Documents/cache", type: "directory",
          size: 8192, nativeModified: "raw device date" },
      ],
    },
  };
  assert.deepEqual(projectFileListing(input), {
    schemaVersion: "1.0", deviceId: "target", platform: "ios", path: "Documents", total: 2,
    files: [
      { name: "empty.db", path: "Documents/empty.db", isDirectory: false, size: 0, modified: null },
      { name: "cache", path: "Documents/cache", isDirectory: true, size: 0, modified: "raw device date" },
    ],
  });
  assert.equal(Object.isFrozen(projectFileListing(input).files), true);
});

test("unscoped native absolute paths remain absolute and directories report contractual size zero", () => {
  const value = projectFileListing({
    deviceId: "target", platform: "android",
    listing: {
      path: "/", total: 1, files: [{ name: "data", path: "/data", type: "directory" }],
    },
  });
  assert.equal(value.path, "/");
  assert.deepEqual(value.files, [{ name: "data", path: "/data", isDirectory: true, size: 0, modified: null }]);
});

test("partial, foreign, fabricated or missing native listing evidence never becomes a legacy success", () => {
  const base = {
    deviceId: "target", platform: "android", bundleId: "com.example.app",
    listing: {
      path: "app://com.example.app/Documents", total: 1,
      files: [{ name: "empty", path: "app://com.example.app/Documents/empty", type: "file", size: 0 }],
    },
  };
  const changed = (patch) => ({ ...base, listing: { ...base.listing, ...patch } });
  for (const input of [
    changed({ total: 5001 }),
    changed({ total: 0 }),
    changed({ total: undefined }),
    changed({ path: "app://another.app/Documents" }),
    changed({ files: [{ ...base.listing.files[0], path: "app://another.app/Documents/empty" }] }),
    changed({ files: [{ ...base.listing.files[0], path: "app://com.example.app/Other/empty" }] }),
    changed({ files: [{ ...base.listing.files[0], path: undefined }] }),
    changed({ files: [{ ...base.listing.files[0], size: undefined }] }),
    changed({ files: [{ ...base.listing.files[0], size: -1 }] }),
    changed({ files: [{ ...base.listing.files[0], type: "symlink" }] }),
    changed({ files: [{ ...base.listing.files[0], nativeModified: 0 }] }),
    changed({ files: [{ ...base.listing.files[0], path: "app://com.example.app/Documents/../empty" }] }),
  ]) {
    assert.throws(() => projectFileListing(input), { code: "invalid_artifact_listing", status: 502 });
  }
  assert.throws(() => projectFileListing({ ...base, bundleId: "another.app" }), { code: "invalid_artifact_listing" });
});
