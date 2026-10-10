import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sourceSha } from "./ailoha-sdk-double.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const product = resolve(process.argv[2]);
const host = process.argv[3];
const scratch = join(source, ".build", `mcp-consent-${process.pid}-${randomUUID()}`);
mkdirSync(scratch, { recursive: true });
process.env.AILOHA_TEST_CONTEXT_STATE = join(scratch, "context.json");
const pin = join(product, "lib/ailoha/runtime-package.json");
const previousPin = existsSync(pin) ? readFileSync(pin) : undefined;
writeFileSync(pin, JSON.stringify({ schema: "mobile-canvas.ailoha-runtime/v1", version: "synthetic-only", sourceSha }));
let backend;
let child;
let exited;
try {
  const { createRuntimeMobileBackend } = await import(pathToFileURL(join(product, "lib/ailoha/runtime-backend.mjs")).href);
  backend = await createRuntimeMobileBackend({ scope: { sessionId: randomUUID(), viewId: "owned-mcp-consent-view" } });
  const returned = await backend.getSelected();
  assert.equal(returned.hasSelection, false);
  const binding = returned.contextBinding;
  child = spawn(process.execPath, [
    "--import", join(source, "tests/scripts/fixtures/ailoha-installed-hooks.mjs"),
    join(product, host === "github" ? "scripts/mcp.mjs" : "scripts/mcp-vscode.mjs"),
    "--session", returned.scope.sessionId, "--instance", returned.scope.viewId,
    "--context", binding.contextRef, "--context-epoch", binding.scopeEpoch,
    "--owner-process", String(binding.ownerProcessId),
  ], { env: { ...process.env, MOBILE_CANVAS_BACKEND: "ailoha" }, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  let buffer = "";
  let diagnostic = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      messages.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  child.stderr.on("data", (chunk) => { diagnostic += chunk.toString(); });
  exited = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const take = async (predicate) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`The installed MCP channel did not return its expected response: ${diagnostic}`);
  };
  const call = (id, name, arguments_) => send({
    jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ },
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: { elicitation: { form: {} } },
  } });
  assert.equal((await take((message) => message.id === 1)).result.serverInfo.name, "mobile-canvas");
  call(2, "mobile_device_erase", { deviceId: "opaque/target", confirm: true });
  const approval = await take((message) => message.method === "elicitation/create");
  assert.match(approval.params.message, /native-deployment-not-opaque-target/);
  assert.equal(approval.params.requestedSchema.properties.decision.default, "cancel");
  assert.equal(JSON.stringify(approval).includes("connectionRef"), false);
  assert.equal(JSON.stringify(approval).includes("processStartedAt"), false);
  assert.equal(messages.some((message) => message.id === 2), false);
  send({ jsonrpc: "2.0", id: approval.id, result: { action: "accept", content: { decision: "approve" } } });
  assert.notEqual((await take((message) => message.id === 2)).result.isError, true);
  call(3, "mobile_device_delete", { deviceId: "opaque/target", confirm: true });
  const cancelled = await take((message) => message.method === "elicitation/create");
  send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } });
  await take((message) => message.method === "notifications/cancelled" && message.params.requestId === cancelled.id);
  const rejected = await take((message) => message.id === 3);
  assert.equal(rejected.result.isError, true);
  assert.equal(JSON.parse(rejected.result.content[0].text).code, "consent_cancelled");
  send({ jsonrpc: "2.0", id: cancelled.id, result: { action: "accept", content: { decision: "approve" } } });
  call(4, "mobile_device_get", { deviceId: "opaque/target" });
  assert.equal((await take((message) => message.id === 4)).result.structuredContent.id, "opaque/target");
  child.stdin.end();
  assert.equal(await exited, 0);
  process.stdout.write(JSON.stringify({
    host, synthetic: true, actualInstalledMcpScript: true, returnedBindingConsumed: true,
    nestedHumanElicitationAnsweredWithoutQueueDeadlock: true, cancelledPromptRetired: true,
    lateApprovalIgnored: true, targetSurvivedCancelledDelete: true, realDeviceMutation: false,
  }));
} finally {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await exited; }
  if (backend) await backend.dispose();
  if (previousPin) writeFileSync(pin, previousPin);
  else rmSync(pin, { force: true });
  rmSync(scratch, { recursive: true });
}
