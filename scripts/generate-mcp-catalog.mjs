#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCommand } from "../lib/runtime.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { command } = await resolveCommand();
const child = spawn(command, ["mcp"], { stdio: ["pipe", "pipe", "pipe"] });
let output = "";
let diagnostics = "";
let settled = false;
const tools = await new Promise((resolve, reject) => {
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.stdin.end();
    child.kill("SIGTERM");
    if (error) reject(error);
    else resolve(result);
  };
  const timer = setTimeout(() => finish(new Error("Metadata-only MCP enumeration timed out.")), 30_000);
  child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-8192); });
  child.on("error", () => finish(new Error("Could not launch the metadata-only Mobile Canvas MCP server.")));
  child.on("exit", (code) => {
    if (!settled) finish(new Error(`Metadata-only MCP exited ${code}: ${diagnostics}`));
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.length > 512 * 1024) return finish(new Error("MCP metadata exceeds its bound."));
    while (output.includes("\n")) {
      const index = output.indexOf("\n");
      const line = output.slice(0, index);
      output = output.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { return finish(new Error("MCP metadata is not valid JSON.")); }
      if (message.id === 1) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      } else if (message.id === 2) {
        if (!Array.isArray(message.result?.tools)) return finish(new Error("MCP metadata contains no tools."));
        finish(null, message.result.tools);
      }
    }
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mobile-canvas-metadata-only", version: "1" } },
  })}\n`);
});
tools.sort((left, right) => left.name.localeCompare(right.name));
await writeFile(join(root, "lib/ailoha/mcp-catalog.json"), `${JSON.stringify({
  schemaVersion: 1,
  source: "Mobile Canvas metadata-only tools/list; no device operations invoked.",
  tools,
}, null, 2)}\n`);
