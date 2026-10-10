import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = join(root, "tests/scripts/fixtures");
for (const [host, product] of [
  ["github", join(root, ".build/copilot-plugin-thin/mobile-canvas")],
  ["vscode", join(root, "vscode/dist")],
]) {
  for (const focusedText of [false, true]) test(`${host} installed entrypoint with focused text ${focusedText}`, () => {
    const output = execFileSync(process.execPath, [
      "--import", join(fixtures, "ailoha-installed-hooks.mjs"),
      join(fixtures, "run-installed-ailoha-host.mjs"), product, host, ...(focusedText ? ["--focused-text"] : []),
    ], { encoding: "utf8", cwd: root, timeout: 30_000 });
    const evidence = JSON.parse(output);
    assert.equal(evidence.synthetic, true);
    assert.equal(evidence.focusedText, focusedText);
    assert.equal(evidence.focusedPosts, focusedText ? 2 : 0);
    assert.deepEqual(evidence.units, [0, 1, 2, 3, 4, 5]);
    assert.equal(evidence.nativeIdentityPreserved, true);
    assert.equal(evidence.returnedBindingConsumed, true);
    assert.equal(evidence.emptyContextInventory, true);
    assert.equal(evidence.externalRetirementRejected, true);
    assert.equal(evidence.readOnlyDiscovery, true);
    assert.equal(evidence.missingPublicPinRejected, true);
    assert.equal(evidence.runtimeLockFailureRejected, true);
    assert.equal(evidence.retiredDirectTargetReadRejected, true);
    assert.equal(evidence.connectionRefCapturedInternally, true);
    assert.equal(evidence.connectionRefNotSerialized, true);
    assert.equal(evidence.deviceFeaturesValidated, true);
    assert.equal(evidence.sourceFeatureResults, 42);
    assert.equal(evidence.installedAppRoutes, true);
    assert.equal(evidence.noUnsupportedAppMutations, true);
    assert.equal(evidence.videoResourcesAfterClose, 0);
    assert.equal(evidence.leaseCountAfterClose, 0);
    assert.equal(evidence.noHostStop, true);
    assert.equal(evidence.createPosts, host === "github" ? 3 : 4);
    assert.equal(evidence.noSeparateBootPost, true);
    assert.deepEqual(evidence.stagedEvidence, { mediaBatches: 2, approvals: 2, uncertainPosts: 1 });
    assert.deepEqual(evidence.guardedEvidence, { mutations: 7, submissions: 7, readbacks: 9, contentGets: 3 });
    assert.deepEqual(evidence.recordingCommands.filter((action) => action === "start"), ["start", "start", "start", "start"]);
    assert.deepEqual(evidence.recordingCommands.filter((action) => action === "stop"), ["stop", "stop", "stop", "stop"]);
    assert.deepEqual(evidence.recordingCommands.filter((action) => action === "recover"),
      ["recover", "recover", "recover", "recover", "recover", "recover"]);
    assert.equal(evidence.recordingFinalizedOnClose, true);
    assert.equal(evidence.recordingWithoutRecoveryRejected, true);
    assert.equal(evidence.creationRecords[0].platform, "ios");
    assert.equal(evidence.creationRecords[1].platform, "android");
    assert.equal(evidence.creationRecords.every((record) => record.state === "booted" && record.nativeId !== record.id), true);
    assert.equal(evidence.creationRecords[2].selectionApplied, false);
    assert.deepEqual(evidence.logs, host === "vscode"
      ? ["invalid_request", ...Array(9).fill("capability_not_supported"),
        "consent_denied", "ailoha_cli_failed", "GuardedDestinationChanged",
        ...(focusedText
          ? ["invalid_request"]
          : ["capability_not_supported"])] : []);
  });
}
