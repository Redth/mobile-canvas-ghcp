import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import "../scripts/fixtures/ailoha-installed-hooks.mjs";
import { scenario, sourceSha } from "../scripts/fixtures/ailoha-sdk-double.mjs";

const preparedProduct = resolve(process.argv[2]);
const contextPath = resolve(process.argv[3]);
const inspectionCheck = process.argv.includes("--workspace-inspection");
const product = inspectionCheck ? `${contextPath}.product` : preparedProduct;
if (inspectionCheck) {
  for (const directory of ["lib", "web"]) cpSync(join(preparedProduct, directory), join(product, directory), { recursive: true });
  cpSync(join(preparedProduct, "node_modules"), join(product, "node_modules"), { recursive: true });
  writeFileSync(join(product, "package.json"), '{"type":"module"}\n');
}
const fixtureRoot = join(contextPath, "..", "browser-workspace-root");
const secondRoot = join(contextPath, "..", "browser-workspace-second-root");
const inspectionLog = `${contextPath}.inspection.jsonl`;
if (inspectionCheck) {
  mkdirSync(fixtureRoot, { recursive: true });
  mkdirSync(secondRoot, { recursive: true });
  process.env.AILOHA_TEST_INSPECTION_LOG = inspectionLog;
  process.env.AILOHA_TEST_INSPECTION_MODE = "complete";
}
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
const evidence = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/control" && inspectionCheck) {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024) throw new Error("Synthetic control exceeds its bound.");
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks));
      if (input.type === "root" && ["first", "second"].includes(input.root)) {
        host.workspaceInspection.bindRoot(input.root === "first" ? fixtureRoot : secondRoot, ["explicit-exclusion/**"]);
      } else if (input.type === "mode" && ["complete", "incomplete", "unknown-schema", "empty", "xss"].includes(input.mode)) {
        process.env.AILOHA_TEST_INSPECTION_MODE = input.mode;
        const delay = input.delayMs ?? 0;
        if (!Number.isInteger(delay) || delay < 0 || delay > 5000) throw new Error("Invalid synthetic delay.");
        process.env.AILOHA_TEST_INSPECTION_DELAY_MS = String(delay);
      } else throw new Error("Unsupported synthetic control.");
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "GET" || request.url !== "/") throw new Error("Unsupported synthetic evidence route.");
    let context = null;
    try { context = JSON.parse(readFileSync(contextPath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    let inspectionCalls = [];
    if (inspectionCheck) {
      try { inspectionCalls = readFileSync(inspectionLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      synthetic: true, errors, targetStatus: scenario.status,
      leases: scenario.leases.size, videoResources: scenario.videos.size,
      calls: scenario.calls, context, inspectionCalls,
      workspace: inspectionCheck ? host.workspaceInspection.snapshot() : null,
    }));
  } catch (error) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ synthetic: true, error: error.message }));
  }
});
await new Promise((resolve) => evidence.listen(0, "127.0.0.1", resolve));
console.log(JSON.stringify({
  url: opened.url, evidenceUrl: `http://127.0.0.1:${evidence.address().port}`,
  inspectionCheck, fixtureRoot, secondRoot,
}));
let closing;
async function close() {
  if (closing) return closing;
  closing = (async () => {
    await host.closeCanvas();
    await new Promise((resolve) => evidence.close(resolve));
    if (previous) writeFileSync(pinPath, previous);
    else rmSync(pinPath, { force: true });
    rmSync(contextPath, { force: true });
    if (inspectionCheck) {
      rmSync(inspectionLog, { force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
      rmSync(product, { recursive: true, force: true });
    }
  })();
  return closing;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  void close().catch((error) => {
    process.stderr.write(`Synthetic browser host cleanup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
});
