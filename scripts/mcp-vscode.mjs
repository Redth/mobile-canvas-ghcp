#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";
import { McpVsCodeContextProxy } from "../lib/mcp-vscode-proxy.mjs";
import { resolveCommand } from "../lib/runtime.mjs";

const execFileAsync = promisify(execFile);
const options = parseOptions(process.argv.slice(2));
if (!options.session || !options.instance) {
  process.stderr.write(
    "mobile-canvas: --session and --instance are required for the VS Code MCP bridge\n",
  );
  process.exit(2);
}

let command;
try {
  ({ command } = await resolveCommand());
} catch (error) {
  process.stderr.write(`mobile-canvas: ${error.message}\n`);
  process.exit(1);
}

const proxy = new McpVsCodeContextProxy({
  sessionId: options.session,
  instanceId: options.instance,
  windowsInstanceId: options["windows-instance"],
  selectDevice: async (deviceId, { force = false } = {}) => {
    if (!force) {
      try {
        const { stdout } = await execFileAsync(
          command,
          [
            "devices",
            "selected",
            "--session",
            options.session,
            "--instance",
            options.instance,
            "--json",
          ],
          commandOptions(),
        );
        const current = JSON.parse(stdout);
        if (current.hasSelection && current.device?.id === deviceId) return;
      } catch (error) {
        process.stderr.write(
          `mobile-canvas: could not read the current VS Code selection: ${errorDetail(error)}\n`,
        );
      }
    }

    try {
      await execFileAsync(
        command,
        [
          "devices",
          "select",
          deviceId,
          "--session",
          options.session,
          "--instance",
          options.instance,
          "--json",
        ],
        commandOptions(),
      );
    } catch (error) {
      // Selection is presentation state. The actual MCP call still owns the user-facing error.
      process.stderr.write(
        `mobile-canvas: could not follow ${deviceId}: ${errorDetail(error)}\n`,
      );
    }
  },
  refreshView: () => writeViewSignal({ type: "refresh" }),
  showAutomation: (activity) =>
    writeViewSignal({ type: "automation", activity }),
});

const child = spawn(command, ["mcp"], { stdio: ["pipe", "pipe", "inherit"] });
let clientBuffer = "";
let serverBuffer = "";
let clientQueue = Promise.resolve();
let serverQueue = Promise.resolve();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  clientBuffer += chunk;
  const lines = takeLines(() => clientBuffer, (value) => { clientBuffer = value; });
  for (const line of lines) {
    clientQueue = clientQueue
      .then(() => forwardClientLine(line))
      .catch((error) => {
        process.stderr.write(`mobile-canvas MCP request proxy failed: ${error.message}\n`);
      });
  }
});
process.stdin.on("end", () => {
  if (clientBuffer.length > 0) {
    const line = clientBuffer;
    clientBuffer = "";
    clientQueue = clientQueue.then(() => forwardClientLine(line));
  }
  void clientQueue.finally(() => child.stdin.end());
});

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  serverBuffer += chunk;
  const lines = takeLines(() => serverBuffer, (value) => { serverBuffer = value; });
  for (const line of lines) {
    serverQueue = serverQueue
      .then(() => forwardServerLine(line))
      .catch((error) => {
        process.stderr.write(`mobile-canvas MCP response proxy failed: ${error.message}\n`);
      });
  }
});
child.stdout.on("end", () => {
  if (serverBuffer.length > 0) {
    const line = serverBuffer;
    serverBuffer = "";
    serverQueue = serverQueue.then(() => forwardServerLine(line));
  }
});

child.on("error", (error) => {
  process.stderr.write(`mobile-canvas: failed to start MCP server: ${error.message}\n`);
  process.exit(1);
});
const signalHandlers = new Map();
for (const signal of ["SIGINT", "SIGTERM"]) {
  const handler = () => child.kill(signal);
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}
child.on("close", async (code, signal) => {
  await serverQueue;
  if (signal) {
    const handler = signalHandlers.get(signal);
    if (handler) process.off(signal, handler);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

async function forwardClientLine(line) {
  const parsed = parseJson(line);
  if (parsed === null) {
    child.stdin.write(`${line}\n`);
    return;
  }
  const message = await proxy.clientMessage(parsed);
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function forwardServerLine(line) {
  const parsed = parseJson(line);
  if (parsed === null) {
    process.stdout.write(`${line}\n`);
    return;
  }
  const message = await proxy.serverMessage(parsed);
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function takeLines(read, write) {
  const value = read();
  const parts = value.split(/\r?\n/);
  write(parts.pop() ?? "");
  return parts.filter((line) => line.length > 0);
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    // --windows-instance is optional; when absent the proxy behaves exactly as before. Every other
    // unknown option is still rejected so a malformed launch fails fast.
    if (
      name !== "--session"
      && name !== "--instance"
      && name !== "--windows-instance"
    ) {
      throw new Error(`Unknown VS Code MCP option: ${name}`);
    }
    const value = args[++index];
    if (!value) throw new Error(`${name} requires a value.`);
    parsed[name.slice(2)] = value;
  }
  return parsed;
}

function commandOptions() {
  return {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  };
}

function errorDetail(error) {
  return String(error?.stderr || error?.message || error).trim();
}

async function writeViewSignal(message) {
  const signal = process.env.MOBILE_CANVAS_VSCODE_REFRESH_SIGNAL;
  if (!signal) return;
  try {
    await appendFile(
      signal,
      `${JSON.stringify({ ...message, nonce: randomUUID() })}\n`,
      "utf8",
    );
  } catch (error) {
    process.stderr.write(
      `mobile-canvas: could not update the VS Code view: ${errorDetail(error)}\n`,
    );
  }
}
