import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = resolve(__dirname, "../..");
  const extensionTestsPath = resolve(__dirname, "suite/index");
  const downloaded = await downloadAndUnzipVSCode(
    process.env.VSCODE_TEST_VERSION ?? "1.101.0",
  );
  const macExecutable = join(dirname(downloaded), "Code");
  const vscodeExecutablePath = existsSync(downloaded)
    ? downloaded
    : existsSync(macExecutable)
      ? macExecutable
      : downloaded;
  const state = mkdtempSync(join(tmpdir(), "mc-vscode-"));
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      vscodeExecutablePath,
      launchArgs: [
        "--disable-workspace-trust",
        `--user-data-dir=${join(state, "user")}`,
        `--extensions-dir=${join(state, "extensions")}`,
      ],
    });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
