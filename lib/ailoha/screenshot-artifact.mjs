import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { MobileAilohaError } from "./mobile-projection.mjs";

export async function saveAilohaScreenshot(bytes, input, invocation) {
  const output = input.output;
  if (output !== undefined && (typeof output !== "string" || !isAbsolute(output))) {
    throw new MobileAilohaError("invalid_output", "Screenshot output must be an absolute host path.", 400);
  }
  const root = join(homedir(), ".mobile-canvas", "artifacts", "ailoha");
  if (output === undefined) await mkdir(root, { recursive: true, mode: 0o700 });
  const path = output ?? join(root, `${randomUUID()}.png`);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return {
    path,
    mimeType: "image/png",
    bytes: bytes.byteLength,
    createdAt: new Date().toISOString(),
    context: invocation,
  };
}
