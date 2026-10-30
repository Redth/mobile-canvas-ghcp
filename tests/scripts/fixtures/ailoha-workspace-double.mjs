import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { workspaceInspectionFixture } from "./workspace-inspection-fixture.mjs";

export async function runWorkspaceDouble(args) {
  if (!process.env.AILOHA_TEST_CONTEXT_STATE) throw new Error("Workspace CLI doubles require an isolated test context.");
  const index = args.indexOf("--path");
  if (args[0] !== "workspace" || args[1] !== "inspect" || !isAbsolute(args[index + 1] ?? "") || !args.includes("--json")) {
    throw new Error("Unexpected synthetic workspace CLI arguments.");
  }
  const mode = process.env.AILOHA_TEST_INSPECTION_MODE ?? "complete";
  const log = process.env.AILOHA_TEST_INSPECTION_LOG;
  if (log) appendFileSync(log, `${JSON.stringify({ args, pid: process.pid })}\n`);
  const delay = Number(process.env.AILOHA_TEST_INSPECTION_DELAY_MS ?? 0);
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 10_000) throw new Error("Invalid synthetic inspection delay.");
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  if (mode === "failure") {
    await new Promise((resolve) => process.stderr.write("SYNTHETIC_PRIVATE_ERROR_MUST_NOT_LEAK", resolve));
    return 1;
  }
  if (mode === "oversized") {
    await new Promise((resolve) => process.stdout.write(" ".repeat(2 * 1024 * 1024 + 1), resolve));
    return 0;
  }
  const result = workspaceInspectionFixture(args[index + 1], mode);
  await new Promise((resolve) => process.stdout.write(JSON.stringify(result), resolve));
  return mode === "incomplete" ? 2 : 0;
}
