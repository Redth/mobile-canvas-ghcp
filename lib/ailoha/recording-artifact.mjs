import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { MobileAilohaError } from "./mobile-projection.mjs";

export async function recordingOutputPath(outputPath, platform) {
  if (outputPath !== undefined && outputPath !== null && (typeof outputPath !== "string" || !outputPath.trim())) {
    throw new MobileAilohaError("invalid_output", "Recording output must be a nonempty host path.", 400);
  }
  if (outputPath) {
    if (!isAbsolute(outputPath) || !outputPath.toLowerCase().endsWith(".mp4")) {
      throw new MobileAilohaError("invalid_output", "Recording output must be an absolute MP4 host path.", 400);
    }
    const path = resolve(outputPath);
    try {
      await lstat(path);
      throw new MobileAilohaError("recording_output_exists", "Recording output already exists; choose a new MP4 destination.", 409);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return path;
  }
  if (!["ios", "android"].includes(platform)) {
    throw new MobileAilohaError("recording_platform_unsupported", "Recording requires a confirmed iOS simulator or Android emulator.", 501);
  }
  const directory = join(homedir(), ".mobile-canvas", "artifacts", "recordings");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return join(directory, `${platform}-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomUUID()}.mp4`);
}
