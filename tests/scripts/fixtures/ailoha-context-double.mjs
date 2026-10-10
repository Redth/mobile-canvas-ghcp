import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--fixture-state") {
  if (!args[1]) throw new Error("Combined inspection requires an explicitly owned synthetic state file.");
  process.env.AILOHA_TEST_CONTEXT_STATE = args[1];
  args.splice(0, 2);
}
if (args[0] === "mcp-serve") {
  await import("./semantic-mcp-server.mjs");
} else {
if (args[0] === "workspace") {
  const { runWorkspaceDouble } = await import("./ailoha-workspace-double.mjs");
  process.exitCode = await runWorkspaceDouble(args);
  process.exit();
}
const path = process.env.AILOHA_TEST_CONTEXT_STATE;
if (!path) throw new Error("The synthetic CLI is only available in an isolated test.");
if (args[0] === "commands" && args[1] === "--json") {
  const mode = process.env.AILOHA_TEST_RECOVERY_COMMANDS;
  if (mode === "fail") throw new Error("Synthetic command discovery failed.");
  if (mode === "malformed") process.stdout.write('{"commands":null}');
  else {
    const descriptors = ["start", "status", "stop", ...(mode === "missing" ? [] : ["recover"])]
      .map((action) => ({
        command: `recording ${action}`, description: `Synthetic recording ${action}`,
        mutating: action !== "status",
      }));
    process.stdout.write(JSON.stringify(descriptors));
  }
  process.exit(0);
}
let contexts;
try { contexts = JSON.parse(readFileSync(path, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; contexts = []; }
if (args[0] === "recording") {
  const option = (name) => args[args.indexOf(name) + 1];
  const contextRef = option("--context");
  const scopeEpoch = option("--context-epoch");
  const recordingPath = `${path}.recording`;
  const completedPath = `${path}.recording-completed`;
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
      hostInstanceId: "instance-synthetic", operationId: randomUUID(),
      state: "recording", outputFile, startedAt: new Date().toISOString(),
    };
    rmSync(completedPath, { force: true });
    writeFileSync(recordingPath, JSON.stringify({
      contextRef, scopeEpoch, contextRevision: context.revision, output,
    }), { flag: "wx" });
    const lostStart = `${path}.lost-start`;
    if (process.env.AILOHA_TEST_RECORDING_LOST_ACK && !existsSync(lostStart)) {
      writeFileSync(lostStart, "accepted");
      throw new Error("Synthetic accepted start response was lost.");
    }
    process.stdout.write(JSON.stringify(output));
  } else if (args[1] === "stop") {
    if (!tracked) throw new Error("The synthetic recording has no accepted owner.");
    writeFileSync(tracked.output.outputFile, Buffer.from("synthetic-mp4-fixture"), { flag: "wx" });
    const completed = {
      ...tracked.output, state: "completed", artifactId: randomUUID(),
      stopOperationId: randomUUID(), stopRequestId: randomUUID(),
      outcome: "downloaded", contextRef, scopeEpoch, contextRevision: tracked.contextRevision,
      downloadedAt: new Date().toISOString(), downloadedLength: Buffer.byteLength("synthetic-mp4-fixture"),
    };
    writeFileSync(completedPath, JSON.stringify(completed), { flag: "wx" });
    rmSync(recordingPath);
    process.stdout.write(JSON.stringify(completed));
  } else if (args[1] === "recover") {
    const completed = JSON.parse(readFileSync(completedPath, "utf8"));
    if (completed.contextRef !== contextRef || completed.scopeEpoch !== scopeEpoch) {
      throw new Error("The synthetic completed recording belongs to another scoped authority.");
    }
    if (process.env.AILOHA_TEST_RECORDING_REPLACED_HOST) {
      process.stdout.write(JSON.stringify({ ...completed, hostInstanceId: "instance-replaced" }));
    } else if (process.env.AILOHA_TEST_RECORDING_DOWNLOAD_FAILED) {
      process.stdout.write(JSON.stringify({
        ...completed, outcome: "downloadFailed", code: "RecordingDownloadFailed",
        downloadedAt: undefined, downloadedLength: undefined,
      }));
      process.exit(1);
    } else {
      process.stdout.write(JSON.stringify(completed));
    }
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
}
