#!/usr/bin/env node
// Launches the MCP server for `.mcp.json`.
//
// `.mcp.json` cannot point straight at a bundled path, because the executable
// only exists after the gzipped bundle is extracted. Going through this shim
// means the canvas extension and the MCP server share one resolver, so both
// run the exact same build and neither can be configured into a stale one.

import { spawn } from "node:child_process";
import { resolveCommand } from "../lib/runtime.mjs";

let command;
try {
  ({ command } = await resolveCommand());
} catch (error) {
  // stdout is the JSON-RPC channel, so diagnostics must never go there.
  process.stderr.write(`mobile-canvas: ${error.message}\n`);
  process.exit(1);
}

// stdio is inherited so the transport is the real file descriptors: no
// buffering, no re-framing, and no chance of this shim corrupting a message.
const child = spawn(command, ["mcp", ...process.argv.slice(2)], { stdio: "inherit" });

child.on("error", (error) => {
  process.stderr.write(`mobile-canvas: failed to start ${command}: ${error.message}\n`);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
