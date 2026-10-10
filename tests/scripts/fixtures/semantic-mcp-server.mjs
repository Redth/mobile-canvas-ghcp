import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync, readFileSync } from "node:fs";

const launchArgs = process.argv.slice(2);
const statePath = launchArgs[0] === "--fixture-state" ? launchArgs.splice(0, 2)[1] : null;
const [command, flag, contextRef, epochFlag, scopeEpoch] = launchArgs;
if (command !== "mcp-serve" || flag !== "--context" || epochFlag !== "--context-epoch"
  || !contextRef || !scopeEpoch) process.exit(3);

const server = new Server({ name: "canonical-stdio-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ["app_tree", "app_query", "app_status"].map((name) => ({
    name, description: name, inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { result: { type: "invalid-native-schema-kind" } } },
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const context = statePath ? JSON.parse(readFileSync(statePath, "utf8"))
    .find((entry) => entry.contextRef === contextRef) : null;
  if (statePath) {
    appendFileSync(`${statePath}.semantic.jsonl`, `${JSON.stringify({ name: params.name, arguments: params.arguments, pid: process.pid })}\n`);
    if (context?.state !== "open" || context.scopeEpoch !== scopeEpoch || context.revision !== params.arguments.contextRevision) {
      return { isError: true, content: [{ type: "text", text: "ContextRevisionConflict: owned synthetic context changed" }] };
    }
  }
  if (params.arguments?.text === "wait") return new Promise(() => {});
  if (params.arguments?.text === "error") return { isError: true, content: [{ type: "text", text: "CanonicalCapabilityUnsupported: no query owner" }] };
  if (params.arguments?.text === "private") return { isError: true, content: [{ type: "text",
    text: "PrivateTokenError: token=private-secret at file:///private/owner/workspace and https://internal.invalid/api?key=private-secret" }] };
  if (params.arguments?.text === "known-private") return { isError: true, content: [{ type: "text",
    text: "CanonicalCapabilityUnsupported: token=private-secret at /private/owner/workspace" }] };
  if (params.arguments?.text === "native-private") return { isError: true, content: [{ type: "text",
    text: "An error occurred invoking 'app_query': ContextRevisionConflict: token=private-secret at /private/owner/workspace" }] };
  if (params.arguments?.text === "stderr-flood") process.stderr.write("x".repeat(2 * 1024 * 1024));
  if (params.arguments?.text === "transport-private") {
    process.stderr.write("token=private-secret at file:///private/owner/workspace");
    process.exit(2);
  }
  if (params.arguments?.text === "environment"
    && (process.env.AILOHA_CONFIG_DIR !== "/synthetic-config"
      || process.env.AILOHA_BROKER_PORT !== "4242"
      || process.env.AILOHA_NO_UPDATE_CHECK !== "1"
      || process.env.AILOHA_TARGET_ID !== undefined)) {
    return { isError: true, content: [{ type: "text", text: "Invalid allowlisted native environment." }] };
  }
  const args = params.arguments;
  const route = {
    owner: args.route === "target-host" ? "target-host" : "agent",
    targetHostId: args.targetHostId, targetId: args.targetId, surfaceId: args.surfaceId,
    runtimeInstanceId: args.route === "target-host" ? null : context?.selection.runtimeInstanceId ?? "runtime-1",
    agentId: args.route === "target-host" ? null : context?.selection.agentId ?? "agent-1",
    reason: "explicit-preference", correlation: "matched",
    executionContext: {
      contextRef, scopeEpoch, revision: args.contextRevision,
      scope: context?.scope ?? { sessionId: "test-session", viewId: "test-view" },
      observed: { runtimeInstanceEvidence: args.route === "target-host" ? "unsupported" : "verified-native-instance" },
    },
  };
  return {
    content: [{ type: "text", text: "Fixture composed result" }],
    structuredContent: params.name === "app_status"
      ? { running: true, agentName: String(process.pid), framework: "MAUI", route }
      : { elements: [{ id: "root", type: "Window", text: "<script>alert(1)</script>",
        children: [{ id: "button", type: "Button", text: "OK" }] }], route },
  };
});
await server.connect(new StdioServerTransport());
