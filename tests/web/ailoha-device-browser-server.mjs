import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import "../scripts/fixtures/ailoha-installed-hooks.mjs";
import { scenario, sourceSha } from "../scripts/fixtures/ailoha-sdk-double.mjs";

const product = resolve(process.argv[2]);
const contextPath = resolve(process.argv[3]);
const recording = process.argv.includes("--recording");
const noRecovery = process.argv.includes("--no-recovery");
const recordingLostStart = process.argv.includes("--lost-start");
if (recordingLostStart && !recording) throw new Error("Lost-start proof requires --recording.");
if (noRecovery && !recording) throw new Error("Recovery gating proof requires recording capture capabilities.");
let recordingHome;
if (recording) {
  mkdirSync(dirname(contextPath), { recursive: true });
  recordingHome = mkdtempSync(join(dirname(contextPath), ".ailoha-browser-home-"));
  process.env.HOME = recordingHome;
  scenario.recordingEnabled = true;
  if (noRecovery) process.env.AILOHA_TEST_RECOVERY_COMMANDS = "missing";
  if (recordingLostStart) process.env.AILOHA_TEST_RECORDING_LOST_ACK = "1";
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
const evidence = createServer((_request, response) => {
  const recordingDirectory = join(recordingHome ?? dirname(contextPath), ".mobile-canvas", "artifacts", "recordings");
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    synthetic: true, errors, targetStatus: scenario.status,
    leases: scenario.leases.size, videoResources: scenario.videos.size,
    calls: scenario.calls,
    recordingCommands: recording && existsSync(`${contextPath}.recording-calls`)
      ? readFileSync(`${contextPath}.recording-calls`, "utf8").trim().split("\n") : [],
    recordingFiles: recording && existsSync(recordingDirectory)
      ? readdirSync(recordingDirectory).filter((file) => file.endsWith(".mp4")).length : 0,
  }));
});
await new Promise((resolve) => evidence.listen(0, "127.0.0.1", resolve));
console.log(JSON.stringify({
  url: opened.url, evidenceUrl: `http://127.0.0.1:${evidence.address().port}`,
  recording, recordingAvailable: recording && !noRecovery, recordingLostStart,
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
    if (recording) {
      rmSync(`${contextPath}.recording-calls`, { force: true });
      rmSync(`${contextPath}.recording-completed`, { force: true });
      rmSync(`${contextPath}.lost-start`, { force: true });
      rmSync(recordingHome, { recursive: true, force: true });
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
