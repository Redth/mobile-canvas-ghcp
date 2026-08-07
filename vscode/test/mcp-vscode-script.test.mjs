import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test(
  "terminates when its native MCP child exits from a signal",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mobile-canvas-mcp-test-"));
    const command = join(directory, "mobile-canvas");
    await writeFile(
      command,
      `#!/usr/bin/env node
if (process.argv[2] === "mcp") {
  process.stdin.resume();
} else {
  process.exitCode = 2;
}
`,
      "utf8",
    );
    await chmod(command, 0o755);

    const script = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "scripts",
      "mcp-vscode.mjs",
    );
    const proxy = spawn(
      process.execPath,
      [script, "--session", "test-session", "--instance", "test-view"],
      {
        env: { ...process.env, MOBILE_CANVAS_COMMAND: command },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      proxy.kill("SIGTERM");
      let timeout;
      const [code, signal] = await Promise.race([
        once(proxy, "exit"),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("The VS Code MCP proxy did not terminate.")),
            5_000,
          );
        }),
      ]);
      clearTimeout(timeout);
      assert.equal(code, null);
      assert.equal(signal, "SIGTERM");
    } finally {
      if (proxy.exitCode === null && proxy.signalCode === null) {
        proxy.kill("SIGKILL");
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
