import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import "../scripts/fixtures/ailoha-installed-hooks.mjs";
import { scenario, sourceSha } from "../scripts/fixtures/ailoha-sdk-double.mjs";

const product = resolve(process.argv[2]);
const contextPath = resolve(process.argv[3]);
const pinPath = join(product, "lib/ailoha/runtime-package.json");
let previous;
try { previous = readFileSync(pinPath); }
catch (error) { if (error.code !== "ENOENT") throw error; }
writeFileSync(pinPath, JSON.stringify({ schema: "mobile-canvas.ailoha-runtime/v1", version: "synthetic-only", sourceSha }));
process.env.AILOHA_TEST_CONTEXT_STATE = contextPath;
const { createRuntimeCanvasHost: createPreparedHost } = await import(pathToFileURL(join(product, "lib/ailoha/runtime-backend.mjs")).href);
const errors = [];
const host = createPreparedHost({
  scope: { sessionId: randomUUID(), viewId: "browser-synthetic-view" },
  onError: (error) => errors.push(error),
});
const opened = await host.openCanvas();
await host.invokeAction("select_device", { deviceId: "opaque/target" });
const evidence = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    synthetic: true, errors, targetStatus: scenario.status,
    leases: scenario.leases.size, videoResources: scenario.videos.size,
    calls: scenario.calls,
  }));
});
await new Promise((resolve) => evidence.listen(0, "127.0.0.1", resolve));
console.log(JSON.stringify({ url: opened.url, evidenceUrl: `http://127.0.0.1:${evidence.address().port}` }));
let closing;
async function close() {
  if (closing) return closing;
  closing = (async () => {
    await host.closeCanvas();
    await new Promise((resolve) => evidence.close(resolve));
    if (previous) writeFileSync(pinPath, previous);
    else rmSync(pinPath, { force: true });
    rmSync(contextPath, { force: true });
  })();
  return closing;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  void close().catch((error) => {
    process.stderr.write(`Synthetic browser host cleanup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
});
