import assert from "node:assert/strict";
import test from "node:test";
import { assertDarwinHelperEntries } from "../../lib/runtime-assets.mjs";

const helper = {
  sha256: "abc",
  size: 1,
  asset: "mobile-screencap-v1-osx-arm64.gz",
};

test("requires the helper in both Darwin runtimes", () => {
  assert.doesNotThrow(() => assertDarwinHelperEntries({
    runtimes: {
      "darwin-arm64": { files: { "mobile-screencap": helper } },
      "darwin-x64": { files: { "mobile-screencap": helper } },
    },
  }));
});

test("rejects a missing Darwin helper", () => {
  assert.throws(
    () => assertDarwinHelperEntries({
      runtimes: {
        "darwin-arm64": { files: {} },
        "darwin-x64": { files: { "mobile-screencap": helper } },
      },
    }),
    /darwin-arm64 runtime is missing mobile-screencap/,
  );
});

test("allows a targeted non-Darwin manifest when requireAll is false", () => {
  assert.doesNotThrow(() => assertDarwinHelperEntries(
    { runtimes: { "linux-x64": { files: {} } } },
    { requireAll: false },
  ));
});
