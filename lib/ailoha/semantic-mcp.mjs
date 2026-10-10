import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { MobileAilohaError } from "./mobile-projection.mjs";

const TOOLS = new Set(["app_tree", "app_query", "app_status"]);
const CLI_ENV = ["AILOHA_CONFIG_DIR", "AILOHA_BROKER_PORT", "AILOHA_NO_UPDATE_CHECK"];
// The native server advertises output-schema constructs the JS SDK rejects; only
// tool names are needed here, and the composed result is validated by the controller.
const ToolNamesResultSchema = ListToolsResultSchema.extend({
  tools: ListToolsResultSchema.shape.tools.element.pick({ name: true }).array().max(256),
});
const PUBLIC_ERRORS = new Map([
  ["CanonicalCapabilityUnsupported", "The selected owner does not support this canonical inspection capability."],
  ["ContextAgentSelectionRequired", "A verified native instance must be explicitly selected in this named context."],
  ["ContextRevisionConflict", "The named context changed during inspection; read its current selection before retrying."],
]);

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
