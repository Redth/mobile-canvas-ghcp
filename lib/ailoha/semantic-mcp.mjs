import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { immutableSnapshot, MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";
import { hasVerifiedCliCommand } from "./runtime-sdk.mjs";
import { parseAgentCandidates } from "./agent-candidates.mjs";
import { canonicalAppFailure, captureMetadataContext, validateInvocationMetadata, withInvocationMetadata } from "./invocation-metadata.mjs";

const TOOLS = new Set(["app_tree", "app_query", "app_status"]);
const CLI_ENV = ["AILOHA_CONFIG_DIR", "AILOHA_BROKER_PORT", "AILOHA_NO_UPDATE_CHECK"];
// The native server advertises boolean JSON schemas the JS SDK rejects; only
// tool names are needed here, and the composed result is validated by the controller.
const ToolNamesResultSchema = ListToolsResultSchema.extend({
  tools: ListToolsResultSchema.shape.tools.element.pick({ name: true }).array().max(256),
});

export async function readNativeAgentCandidates({ runCli, snapshot, ...options }) {
  if (!await hasVerifiedCliCommand(runCli, "agent candidates", false, options)) {
    return { available: false, candidates: null };
  }
  const { targetHostId, targetId } = snapshot.selection;
  const raw = await runCli(["agent", "candidates", "--target-host", targetHostId, "--target", targetId, "--json"], options);
  const value = parseAgentCandidates(raw, { targetHostId, targetId });
  if (!value.ok) {
    throw new MobileAilohaError(value.error.code,
      "Canonical registered-agent inventory failed. No empty inventory or fallback was substituted.", 502);
  }
  return publicSnapshot({ available: true, candidates: value.candidates });
}

export async function callSemanticTool({ sdk, pin, context, snapshot, scope, name, arguments: args, signal }) {
  if (!TOOLS.has(name)) throw new MobileAilohaError("semantic_tool_unsupported", "Only canonical read-only composed app tools are available.", 400);
  const capturedArgs = immutableSnapshot(args);
  const expectedMetadata = snapshot ? captureMetadataContext({ snapshot, scope, route: capturedArgs.route }) : undefined;
  const capturedContext = immutableSnapshot(context);
  if (expectedMetadata && (capturedContext.contextRef !== expectedMetadata.contextRef
    || capturedContext.scopeEpoch !== expectedMetadata.scopeEpoch
    || capturedArgs.contextRef !== expectedMetadata.contextRef || capturedArgs.contextEpoch !== expectedMetadata.scopeEpoch
    || capturedArgs.contextRevision !== expectedMetadata.revision
    || ["targetHostId", "targetId", "surfaceId"].some((key) =>
      (capturedArgs[key] ?? null) !== expectedMetadata.selection[key]))) {
    throw new MobileAilohaError("invocation_metadata_invalid", "The MCP invocation differs from the original captured context.", 409);
  }
  signal?.throwIfAborted();
  const launch = await sdk.getVerifiedCliLaunch({ expectedVersion: pin.version });
  if (launch.version !== pin.version || launch.sourceSha !== pin.sourceSha) {
    throw new MobileAilohaError("ailoha_cli_pin_mismatch", "The canonical MCP launch does not match the prepared source pin.", 503);
  }
  signal?.throwIfAborted();
  const transport = new StdioClientTransport({
    command: launch.file,
    args: [...launch.args, "mcp-serve", "--context", capturedContext.contextRef, "--context-epoch", capturedContext.scopeEpoch],
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
  let metadata;
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
    const result = await client.callTool({ name, arguments: capturedArgs }, undefined, options);
    if (Object.hasOwn(result, "_meta")) metadata = validateInvocationMetadata(result._meta, expectedMetadata);
    if (result.isError || (metadata?.["ailoha.agentExchange"] && !metadata["ailoha.agentExchange"].completed)) {
      const detail = result.content?.find((entry) => entry.type === "text")?.text;
      const prefix = `An error occurred invoking '${name}': `;
      const publicDetail = typeof detail === "string" && detail.startsWith(prefix)
        ? detail.slice(prefix.length) : detail;
      const code = typeof publicDetail === "string"
        ? /^([A-Za-z][A-Za-z0-9-]{1,127}): /.exec(publicDetail)?.[1] : null;
      throw canonicalAppFailure(code, metadata);
    }
    if (!result.structuredContent || typeof result.structuredContent !== "object") {
      throw new MobileAilohaError("semantic_invalid_response", `Canonical ${name} returned no structured result.`, 502);
    }
    return withInvocationMetadata(result.structuredContent, metadata);
  } catch (error) {
    primaryError = withInvocationMetadata(error, metadata);
    throw primaryError;
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
    if (!primaryError && cleanupError) throw withInvocationMetadata(new MobileAilohaError(
      "semantic_mcp_transport_failed", "The canonical MCP inspection transport failed.", 502), metadata);
  }
}
