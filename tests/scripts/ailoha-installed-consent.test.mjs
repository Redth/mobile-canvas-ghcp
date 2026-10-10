import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = join(dirname(fileURLToPath(import.meta.url)), "../..");
for (const [host, product] of [
  ["github", join(source, ".build/copilot-plugin-thin/mobile-canvas")],
  ["vscode", join(source, "vscode/dist")],
]) {
  test(`${host} consumed host prompts enforce captured human approval, cancellation and receipt admission`, () => {
    mkdirSync(join(source, ".build"), { recursive: true });
    const scratch = mkdtempSync(join(source, ".build/consent-product-"));
    const owned = join(scratch, "product");
    cpSync(product, owned, { recursive: true });
    if (host === "vscode") cpSync(join(source, "vscode/package.json"), join(scratch, "package.json"));
    try {
      const evidence = JSON.parse(execFileSync(process.execPath, [
        "--import", join(source, "tests/scripts/fixtures/ailoha-installed-hooks.mjs"),
        join(source, "tests/scripts/fixtures/run-installed-ailoha-consent.mjs"), owned, host,
      ], { encoding: "utf8", timeout: 90_000 }));
      assert.deepEqual(evidence.cases, [
        "deny", "cancel", "erase_device", "delete_device", "selection", "retirement", "epoch",
        "native", "provider", "replacement", "deadline", "revalidation-deadline", "external-during-probe",
        "queued-deadline", "queued-owner", "queued-caller", "unsupported-host", "admission-and-resume",
        "fenced-uninstall-denial", "fenced-uninstall-deadline", "fenced-uninstall-owner",
        "fenced-uninstall-queued-deadline", "fenced-uninstall-queued-owner",
        "fenced-uninstall-approved", "fenced-uninstall-accepted-nonzero",
        "fenced-ios-app-op-unsupported",
        "fenced-missing-installation-evidence",
        "fenced-native-errors",
        "fenced-android-app-op", "fenced-android-app-op-selection-recovery",
        "fenced-android-app-op-effective-mismatch",
        "fenced-android-app-op-denial",
        "fenced-app-op-known-id-unicode", "fenced-app-op-known-id-long-ascii",
        "accepted-peer-uninstall_app", "accepted-peer-set_app_op",
      ]);
      assert.equal(evidence.synthetic, true);
      assert.equal(evidence.realDeviceMutation, false);
      assert.equal(evidence.leaseCountAfterClose, 0);
      assert.equal(evidence.pendingHumanPrompts, 0);
      const mcp = JSON.parse(execFileSync(process.execPath, [
        "--import", join(source, "tests/scripts/fixtures/ailoha-installed-hooks.mjs"),
        join(source, "tests/scripts/fixtures/run-installed-ailoha-mcp-consent.mjs"), owned, host,
      ], { encoding: "utf8", timeout: 30_000 }));
      assert.equal(mcp.nestedHumanElicitationAnsweredWithoutQueueDeadlock, true);
      assert.equal(mcp.cancelledPromptRetired, true);
      assert.equal(mcp.lateApprovalIgnored, true);
      assert.equal(mcp.targetSurvivedCancelledDelete, true);
      assert.equal(mcp.fencedAppActionsThroughInstalledMcp, true);
      assert.equal(mcp.fencedAcceptedMismatchGetOnly, true);
    } finally { rmSync(scratch, { recursive: true }); }
  });
}
