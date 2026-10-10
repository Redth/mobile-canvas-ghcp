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
  "lib/ailoha/media-adapter.mjs", "lib/ailoha/canvas-host.mjs", "lib/ailoha/mcp-host.mjs",
  "lib/ailoha/runtime-sdk.mjs", "lib/ailoha/runtime-backend.mjs", "lib/ailoha/github-adapter.mjs",
  "lib/ailoha/index.mjs", "web/ailoha-canvas-state.js", "web/ailoha-video-player.js", "web/ailoha-video-receiver.js",
  "lib/ailoha/protocol.mjs", "lib/ailoha/mobile-catalog.mjs", "lib/ailoha/operation-receipts.mjs",
  "web/create-device-options.js", "web/device-canvas.js",
];
const tests = [
  "tests/scripts/mobile-ailoha-projection.test.mjs",
  "tests/scripts/mobile-ailoha-backend.test.mjs",
  "tests/scripts/mobile-ailoha-creation.test.mjs",
  "tests/scripts/ailoha-owner-transport.test.mjs",
  "tests/scripts/ailoha-media-adapter.test.mjs",
  "tests/scripts/ailoha-canvas-host.test.mjs",
  "tests/scripts/ailoha-context-adapter.test.mjs",
  "tests/scripts/ailoha-mcp-host.test.mjs",
  "tests/web/ailoha-video-player.test.mjs",
  "tests/web/ailoha-presentation-lease.test.mjs",
  "tests/web/ailoha-canvas-state.test.mjs",
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
