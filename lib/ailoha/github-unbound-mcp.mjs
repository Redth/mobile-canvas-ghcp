import { readFile } from "node:fs/promises";

const INSTRUCTIONS = "Ailoha device tools are registered by the Mobile Canvas SDK extension. Open a Mobile Device canvas and pass its explicit instanceId to a session-owned tool; this unbound MCP entry cannot infer or operate on a view.";

export async function runAilohaGithubUnboundMcp(input = process.stdin, output = process.stdout) {
  const { version } = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const write = (message) => new Promise((resolve, reject) => output.write(
    `${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve(),
  ));
  input.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of input) {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 256 * 1024) throw new Error("Unbound Mobile Canvas MCP request exceeds 256 KiB.");
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch {
        await write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid MCP JSON." } });
        continue;
      }
      if (message && typeof message === "object" && !Array.isArray(message)
        && message.id === undefined && typeof message.method === "string") continue;
      const id = message?.id ?? null;
      if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        await write({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid MCP request." } });
        continue;
      }
      let response;
      switch (message?.method) {
        case "initialize":
          response = {
            protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "mobile-canvas-unbound", version },
            instructions: INSTRUCTIONS,
          };
          break;
        case "tools/list": response = { tools: [] }; break;
        case "ping": response = {}; break;
        default:
          await write({
            jsonrpc: "2.0", id, error: {
              code: -32601, message: "No named view is bound to this MCP entry; use the session-owned Mobile Canvas SDK tools.",
            },
          });
          continue;
      }
      await write({ jsonrpc: "2.0", id, result: response });
    }
  }
}
