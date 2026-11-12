import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = join(dirname(fileURLToPath(import.meta.url)), "../..");
for (const [host, product] of [
  ["github", join(source, ".build/copilot-plugin-thin/mobile-canvas")],
  ["vscode", join(source, "vscode/dist")],
]) {
  test(`${host} prepared bound stdio entry lists and calls UI-selected App tools without device follow`, () => {
    mkdirSync(join(source, ".build"), { recursive: true });
    const scratch = mkdtempSync(join(source, ".build/app-mcp-product-"));
    const owned = join(scratch, "product");
    cpSync(product, owned, { recursive: true });
    if (host === "vscode") cpSync(join(source, "vscode/package.json"), join(scratch, "package.json"));
    try {
      const evidence = JSON.parse(execFileSync(process.execPath, [
        "--import", join(source, "tests/scripts/fixtures/ailoha-installed-hooks.mjs"),
        join(source, "tests/scripts/fixtures/run-installed-ailoha-app-mcp.mjs"), owned, host,
      ], { encoding: "utf8", timeout: 30_000 }));
      assert.deepEqual(evidence, {
        synthetic: true, host, explicitTrustedLaunchFlags: true, realSdkLaunchRegistration: false,
        listed: 64, legacyDeviceIdentities: 61,
        appTools: ["mobile_app_tree", "mobile_app_query", "mobile_app_status"],
        uiSelectedExactInstance: true, viewIsolation: true, missingStaleDisconnectedFailClosed: true,
        selectorsRejected: true, noSystemFallback: true, noReadonlySelectionOrAutomation: true,
        cancelledCanonicalChildClosed: true, deviceReadsSurviveMissingAgent: true, realDeviceMutation: false,
      });
    } finally {
      rmSync(scratch, { recursive: true });
    }
  });
}
