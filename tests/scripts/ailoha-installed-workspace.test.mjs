import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
for (const [host, product] of [
  ["github", join(root, ".build/copilot-plugin-thin/mobile-canvas")],
  ["vscode", join(root, "vscode/dist")],
]) {
  test(`${host} actual prepared entrypoint exposes only read-only explicit-root inspection`, () => {
    const output = execFileSync(process.execPath, [
      "--import", join(root, "tests/scripts/fixtures/ailoha-installed-hooks.mjs"),
      join(root, "tests/scripts/fixtures/run-installed-workspace-inspection.mjs"), product, host, root,
    ], { cwd: root, encoding: "utf8", timeout: 30_000 });
    const evidence = JSON.parse(output);
    assert.equal(evidence.syntheticSdkHooks, true);
    assert.equal(evidence.offlineInspectionDidNotOpenContextOrHost, true);
    assert.equal(evidence.contextUnchangedByInspection, true);
    assert.equal(evidence.publicSdkAvailable, false);
    assert.equal(evidence.leasesAfterClose, 0);
    assert.equal(evidence.videoResourcesAfterClose, 0);
    assert.deepEqual(evidence.states, ["complete", "complete", "incomplete", "error", "complete"]);
  });
}
