import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const products = process.argv.length > 2
  ? [resolve(process.argv[2])]
  : [
    join(root, ".build/copilot-plugin-thin/mobile-canvas"),
    join(root, "vscode/dist"),
  ];
const modules = [
  "lib/ailoha/mobile-backend.mjs", "lib/ailoha/mobile-projection.mjs", "lib/ailoha/context-adapter.mjs",
  "lib/ailoha/media-adapter.mjs", "lib/ailoha/reveal-adapter.mjs", "lib/ailoha/system-ui-adapter.mjs",
  "lib/ailoha/canvas-host.mjs", "lib/ailoha/mcp-host.mjs",
  "lib/ailoha/artifact-stage-protocol.mjs", "lib/ailoha/guarded-file-protocol.mjs",
  "lib/ailoha/control-adapter.mjs",
  "lib/ailoha/runtime-sdk.mjs", "lib/ailoha/runtime-backend.mjs", "lib/ailoha/github-adapter.mjs",
  "lib/ailoha/staged-apps.mjs", "lib/ailoha/fenced-apps.mjs",
  "lib/ailoha/destructive-consent.mjs",
  "lib/ailoha/index.mjs", "web/ailoha-canvas-state.js", "web/ailoha-video-player.js", "web/ailoha-video-receiver.js",
  "lib/ailoha/protocol.mjs", "lib/ailoha/mobile-catalog.mjs", "lib/ailoha/operation-receipts.mjs",
  "web/create-device-options.js",
  "lib/ailoha/workspace-inspection.mjs", "web/ailoha-workspace-view.js",
  "lib/ailoha/semantic-inspection.mjs", "lib/ailoha/semantic-mcp.mjs", "web/ailoha-semantic-view.js",
  "web/device-canvas.js", "web/device-canvas.css", "web/index.html",
];
const tests = [
  "tests/scripts/mobile-ailoha-projection.test.mjs",
  "tests/scripts/mobile-ailoha-backend.test.mjs",
  "tests/scripts/ailoha-staged-apps.test.mjs",
  "tests/scripts/ailoha-fenced-apps.test.mjs",
  "tests/scripts/ailoha-guarded-file-protocol.test.mjs",
  "tests/scripts/mobile-ailoha-creation.test.mjs",
  "tests/scripts/parent-operation-receipts.test.mjs",
  "tests/scripts/ailoha-owner-transport.test.mjs",
  "tests/scripts/ailoha-media-adapter.test.mjs",
  "tests/scripts/ailoha-reveal-adapter.test.mjs",
  "tests/scripts/ailoha-system-ui-adapter.test.mjs",
  "tests/scripts/ailoha-control-adapter.test.mjs",
  "tests/scripts/ailoha-canvas-host.test.mjs",
  "tests/scripts/ailoha-context-adapter.test.mjs",
  "tests/scripts/ailoha-workspace-inspection.test.mjs",
  "tests/scripts/ailoha-semantic-inspection.test.mjs",
  "tests/scripts/ailoha-runtime-pin.test.mjs",
  "tests/scripts/ailoha-mcp-host.test.mjs",
  "tests/scripts/ailoha-destructive-consent.test.mjs",
  "tests/web/ailoha-video-player.test.mjs",
  "tests/web/ailoha-presentation-lease.test.mjs",
  "tests/web/ailoha-canvas-state.test.mjs",
  "tests/web/ailoha-workspace-view.test.mjs",
  "tests/web/ailoha-semantic-view.test.mjs",
];
for (const product of products) {
  for (const path of modules) {
    if (!readFileSync(join(root, path)).equals(readFileSync(join(product, path)))) {
      throw new Error(`Prepared host differs from shared source: ${path}`);
    }
  }
  console.log(`Checking actual prepared host modules: ${product}`);
  execFileSync(process.execPath, ["--test", "--test-reporter=dot", ...tests.map((file) => join(root, file))], {
    env: { ...process.env, AILOHA_TEST_PRODUCT_ROOT: product },
    cwd: root,
    stdio: "inherit",
  });
}
