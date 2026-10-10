import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MobileAilohaError } from "./mobile-projection.mjs";

const TOOLS = new Set(["app_tree", "app_query", "app_status"]);

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
    stderr: "pipe",
    maxBufferSize: 1024 * 1024,
  });
  const client = new Client({ name: "mobile-canvas-semantic-inspection", version: "1.0.0" });
  const timeoutMs = 25_000;
  const options = { signal, timeout: timeoutMs };
  const abort = () => { void transport.close(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await client.connect(transport, options);
    const listed = await client.listTools(undefined, options);
    if (!listed.tools.some((tool) => tool.name === name)) {
      throw new MobileAilohaError("semantic_capability_unavailable", `The pinned canonical MCP server does not advertise ${name}.`, 501);
    }
    const result = await client.callTool({ name, arguments: args }, undefined, options);
    if (result.isError) {
      const detail = result.content?.find((entry) => entry.type === "text")?.text;
      const code = typeof detail === "string" ? /^([A-Za-z][A-Za-z0-9]{1,127}): /.exec(detail)?.[1] : null;
      throw new MobileAilohaError(code ?? "semantic_operation_failed",
        typeof detail === "string" ? detail.slice(0, 1024) : `Canonical ${name} failed.`, 502);
    }
    if (!result.structuredContent || typeof result.structuredContent !== "object") {
      throw new MobileAilohaError("semantic_invalid_response", `Canonical ${name} returned no structured result.`, 502);
    }
    return result.structuredContent;
  } finally {
    signal?.removeEventListener("abort", abort);
    await client.close();
  }
}
