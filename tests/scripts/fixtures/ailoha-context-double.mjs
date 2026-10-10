import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const args = process.argv.slice(2);
const path = process.env.AILOHA_TEST_CONTEXT_STATE;
if (!path) throw new Error("The synthetic CLI is only available in an isolated test.");
let contexts;
try { contexts = JSON.parse(readFileSync(path, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; contexts = []; }
if (args[0] === "recording") {
  const option = (name) => args[args.indexOf(name) + 1];
  const contextRef = option("--context");
  const scopeEpoch = option("--context-epoch");
  const recordingPath = `${path}.recording`;
  let tracked = null;
  try { tracked = JSON.parse(readFileSync(recordingPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  appendFileSync(`${path}.recording-calls`, `${args[1]}\n`);
  if (tracked && (tracked.contextRef !== contextRef || tracked.scopeEpoch !== scopeEpoch)) {
    throw new Error("The synthetic recording belongs to another scoped authority.");
  }
  if (args[1] === "status") {
    process.stdout.write(JSON.stringify(tracked?.output ?? null));
  } else if (args[1] === "start") {
    const context = contexts.find((entry) => entry.contextRef === contextRef && entry.scopeEpoch === scopeEpoch);
    if (!context || context.state !== "open" || context.revision !== option("--context-revision")
      || context.selection?.targetHostId !== option("--target-host")
      || context.selection.targetId !== option("--target")
      || context.selection.surfaceId !== option("--surface") || tracked) {
      throw new Error("The synthetic recording start was not authorized by the captured view.");
    }
    const outputFile = option("--output");
    if (!isAbsolute(outputFile) || !outputFile.endsWith(".mp4")) throw new Error("The synthetic output must be an absolute MP4.");
    const output = {
      recordingId: randomUUID(), targetHostId: context.selection.targetHostId,
      targetId: context.selection.targetId, surfaceId: context.selection.surfaceId,
      state: "recording", outputFile, startedAt: new Date().toISOString(),
    };
    writeFileSync(recordingPath, JSON.stringify({ contextRef, scopeEpoch, output }), { flag: "wx" });
    process.stdout.write(JSON.stringify(output));
  } else if (args[1] === "stop") {
    if (!tracked) throw new Error("The synthetic recording has no accepted owner.");
    writeFileSync(tracked.output.outputFile, Buffer.from("synthetic-mp4-fixture"), { flag: "wx" });
    rmSync(recordingPath);
    process.stdout.write(JSON.stringify({ ...tracked.output, state: "completed", artifactId: randomUUID() }));
  } else throw new Error("Unexpected synthetic recording command.");
  process.exit(0);
}
const requestIndex = args.indexOf("--request-json");
const input = requestIndex >= 0 ? JSON.parse(args[requestIndex + 1]) : null;
let context;
if (args[1] === "open") {
  context = contexts.find((entry) => JSON.stringify(entry.scope) === JSON.stringify(input.scope));
  if (!context) {
    context = {
      schema: "ailoha.execution-context/v1", version: 1, contextRef: `ctx-${randomUUID()}`,
      scope: input.scope, scopeEpoch: randomUUID(), revision: "0", state: "open",
      owner: { processId: input.ownerProcessId, processStartedAt: "2026-10-09T23:00:00Z" },
      selection: null, observed: null,
    };
    contexts.push(context);
  }
} else {
  const contextRef = input?.contextRef ?? args[2];
  context = contexts.find((entry) => entry.contextRef === contextRef);
}
if (!context) throw new Error("The synthetic named context does not exist.");
if (args[1] === "select") {
  if (input.expected.scopeEpoch !== context.scopeEpoch || input.expected.revision !== context.revision) {
    const result = { ok: false, context: null, error: { code: "ContextRevisionConflict", message: "Synthetic CAS conflict" } };
    process.stderr.write(JSON.stringify(result));
    process.exit(1);
  }
  context.selection = input.selection;
  context.revision = String(BigInt(context.revision) + 1n);
}
if (args[1] === "detach") {
  context.state = "detached";
  context.selection = null;
  context.observed = null;
  context.revision = String(BigInt(context.revision) + 1n);
}
if (["open", "select", "detach"].includes(args[1])) {
  const pending = `${path}.${process.pid}.${randomUUID()}.pending`;
  try {
    writeFileSync(pending, JSON.stringify(contexts), { flag: "wx" });
    renameSync(pending, path);
  } finally {
    rmSync(pending, { force: true });
  }
}
process.stdout.write(JSON.stringify({ ok: true, context, error: null }));
