import assert from "node:assert/strict";
import test from "node:test";
import { verifyDevelopmentFiles } from "../../scripts/vsix.mjs";

const dependencyMap = "extension/dist/node_modules/@ailoha/cli/node_modules/tar/dist/esm/index.js.map";

test("SDK dependency maps require a verified pinned graph rather than a path-only exception", () => {
  assert.throws(() => verifyDevelopmentFiles([dependencyMap]), /development-only file/);
  verifyDevelopmentFiles([dependencyMap], { verifiedAilohaGraph: true });
  assert.throws(() => verifyDevelopmentFiles([
    "extension/node_modules/tar/dist/esm/index.js.map",
  ], { verifiedAilohaGraph: true }), /development-only file/);
});

test("verified SDK graph maps cannot admit Mobile Canvas source, tests or generated maps", () => {
  for (const path of [
    "extension/src/extension.ts",
    "extension/test/host.test.mjs",
    "extension/.vscode-test/downloaded-editor",
    "extension/out/extension.js.map",
    "extension/dist/web/device-canvas.js.map",
  ]) {
    assert.throws(() => verifyDevelopmentFiles([dependencyMap, path], {
      verifiedAilohaGraph: true,
    }), /development-only file/);
  }
  verifyDevelopmentFiles(["extension/out/extension.js", "extension/dist/web/device-canvas.js"]);
});
