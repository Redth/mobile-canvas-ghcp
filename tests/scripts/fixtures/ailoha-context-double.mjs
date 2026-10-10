import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const path = process.env.AILOHA_TEST_CONTEXT_STATE;
if (!path) throw new Error("The synthetic CLI is only available in an isolated test.");
let contexts;
try { contexts = JSON.parse(readFileSync(path, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; contexts = []; }
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
if (args[1] !== "get") {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(contexts), { flag: "wx" });
  renameSync(temporary, path);
}
process.stdout.write(JSON.stringify({ ok: true, context, error: null }));
