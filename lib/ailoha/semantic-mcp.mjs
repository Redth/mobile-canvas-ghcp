import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";
import { hasVerifiedCliCommand } from "./runtime-sdk.mjs";

const TOOLS = new Set(["app_tree", "app_query", "app_status"]);
const CANDIDATE_ERRORS = new Set([
  "AgentCandidatesRequestInvalid", "AgentCandidatesBrokerUnavailable", "AgentCandidatesBrokerInvalid",
  "AgentCandidatesInventoryInvalid", "AgentCandidatesAmbiguous", "AgentCandidatesLimitExceeded",
]);
const CLI_ENV = ["AILOHA_CONFIG_DIR", "AILOHA_BROKER_PORT", "AILOHA_NO_UPDATE_CHECK"];
// The native server advertises boolean JSON schemas the JS SDK rejects; only
// tool names are needed here, and the composed result is validated by the controller.
const ToolNamesResultSchema = ListToolsResultSchema.extend({
  tools: ListToolsResultSchema.shape.tools.element.pick({ name: true }).array().max(256),
});
const PUBLIC_ERRORS = new Map([
  ["CanonicalCapabilityUnsupported", "The selected owner does not support this canonical inspection capability."],
  ["ContextAgentSelectionRequired", "A verified native instance must be explicitly selected in this named context."],
  ["ContextRevisionConflict", "The named context changed during inspection; read its current selection before retrying."],
  ["AgentNotFound", "The exact selected native runtime is no longer registered. No replacement was selected."],
  ["AgentAmbiguous", "Native runtime registration is ambiguous. Choose an unambiguous exact instance."],
  ["AgentInstanceUnverified", "The selected runtime does not supply verified v2 instance evidence."],
  ["AgentInstanceMismatch", "The live native process no longer matches the selected runtime instance."],
  ["AgentTargetCorrelationUndeclared", "The native runtime does not declare its complete Target Host/target pair."],
  ["AgentTargetCorrelationMismatch", "The native runtime belongs to a different Target Host/target pair."],
  ["ContextOwnerUnavailable", "The selected canonical owner is unavailable. No fallback was attempted."],
]);

export async function readNativeAgentCandidates({ runCli, snapshot, ...options }) {
  if (!await hasVerifiedCliCommand(runCli, "agent candidates", false, options)) {
    return { available: false, candidates: null };
  }
  const { targetHostId, targetId } = snapshot.selection;
  const raw = await runCli(["agent", "candidates", "--target-host", targetHostId, "--target", targetId, "--json"], options);
  let value;
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 512 * 1024) throw new Error("size");
    value = JSON.parse(raw);
  } catch {
    throw new MobileAilohaError("semantic_candidates_invalid", "Canonical candidate inventory was not bounded JSON.", 502);
  }
  const invalid = () => { throw new MobileAilohaError("semantic_candidates_invalid", "Canonical candidate inventory did not preserve the exact target and v2 evidence.", 502); };
  if (!value || value.schema !== "ailoha.agent.candidates/v1" || typeof value.ok !== "boolean"
    || value.targetHostId !== targetHostId || value.targetId !== targetId
    || Object.keys(value).some((key) => !["schema", "ok", "targetHostId", "targetId", "candidates", "error"].includes(key))) invalid();
  if (!value.ok) {
    if (value.candidates !== null || typeof value.error?.code !== "string"
      || !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(value.error.code)) invalid();
    throw new MobileAilohaError(CANDIDATE_ERRORS.has(value.error.code) ? value.error.code : "semantic_candidates_failed",
      "Canonical registered-agent inventory failed. No empty inventory or fallback was substituted.", 502);
  }
  if (value.error !== null || !Array.isArray(value.candidates) || value.candidates.length > 256) invalid();
  const ids = new Set();
  const runtimes = new Set();
  for (const candidate of value.candidates) {
    if (!candidate || Object.keys(candidate).length !== 5
      || Object.keys(candidate).some((key) => !["agentId", "runtimeInstanceId", "registrationVersion", "targetHostId", "targetId"].includes(key))
      || candidate.registrationVersion !== 2 || typeof candidate.runtimeInstanceId !== "string"
      || !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.runtimeInstanceId)
      || candidate.agentId !== `agent-${candidate.runtimeInstanceId}`
      || candidate.targetHostId !== targetHostId || candidate.targetId !== targetId
      || ids.has(candidate.agentId) || runtimes.has(candidate.runtimeInstanceId)) invalid();
    ids.add(candidate.agentId);
    runtimes.add(candidate.runtimeInstanceId);
  }
  return publicSnapshot({ available: true, candidates: value.candidates });
}

export async function callSemanticTool({ sdk, pin, context, name, arguments: args, signal }) {
  if (!TOOLS.has(name)) throw new MobileAilohaError("semantic_tool_unsupported", "Only canonical read-only composed app tools are available.", 400);
  signal?.throwIfAborted();
  const launch = await sdk.getVerifiedCliLaunch({ expectedVersion: pin.version });
  if (launch.version !== pin.version || launch.sourceSha !== pin.sourceSha) {
    throw new MobileAilohaError("ailoha_cli_pin_mismatch", "The canonical MCP launch does not match the prepared source pin.", 503);
  }
  signal?.throwIfAborted();
  const transport = new StdioClientTransport({
    command: launch.file,
    args: [...launch.args, "mcp-serve", "--context", context.contextRef, "--context-epoch", context.scopeEpoch],
    env: Object.fromEntries(CLI_ENV.filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]])),
    stderr: "ignore",
    maxBufferSize: 1024 * 1024,
  });
  const client = new Client({ name: "mobile-canvas-semantic-inspection", version: "1.0.0" });
  const timeoutMs = 25_000;
  const options = { signal, timeout: timeoutMs };
  let closeTask;
  const abort = () => {
    closeTask = transport.close();
    void closeTask.catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  let primaryError;
  try {
    await client.connect(transport, options);
    let cursor;
    let advertised = false;
    for (let page = 0; page < 16; page += 1) {
      const listed = await client.request({ method: "tools/list", params: cursor ? { cursor } : {} },
        ToolNamesResultSchema, options);
      if (listed.tools.some((tool) => tool.name === name)) { advertised = true; break; }
      cursor = listed.nextCursor;
      if (!cursor) break;
    }
    if (!advertised) {
      throw new MobileAilohaError("semantic_capability_unavailable", `The pinned canonical MCP server does not advertise ${name}.`, 501);
    }
    const result = await client.callTool({ name, arguments: args }, undefined, options);
    if (result.isError) {
      const detail = result.content?.find((entry) => entry.type === "text")?.text;
      const prefix = `An error occurred invoking '${name}': `;
      const publicDetail = typeof detail === "string" && detail.startsWith(prefix)
        ? detail.slice(prefix.length) : detail;
      const code = typeof publicDetail === "string"
        ? /^([A-Za-z][A-Za-z0-9]{1,127}): /.exec(publicDetail)?.[1] : null;
      throw new MobileAilohaError(PUBLIC_ERRORS.has(code) ? code : "semantic_operation_failed",
        PUBLIC_ERRORS.get(code) ?? "The canonical inspection operation failed.", 502);
    }
    if (!result.structuredContent || typeof result.structuredContent !== "object") {
      throw new MobileAilohaError("semantic_invalid_response", `Canonical ${name} returned no structured result.`, 502);
    }
    return result.structuredContent;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    let cleanupError;
    try {
      await client.close();
    } catch (error) {
      cleanupError = error;
      try { await transport.close(); }
      catch (closeError) { cleanupError ??= closeError; }
    }
    try { await closeTask; }
    catch (error) { cleanupError ??= error; }
    if (!primaryError && cleanupError) throw cleanupError;
  }
}
