import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { MobileAilohaError } from "./mobile-projection.mjs";

function validateOutputPath(outputPath) {
  if (outputPath !== undefined && outputPath !== null && (typeof outputPath !== "string" || !outputPath.trim())) {
    throw new MobileAilohaError("invalid_output", "Recording output must be a nonempty host path.", 400);
  }
  if (outputPath && (!isAbsolute(outputPath) || !outputPath.toLowerCase().endsWith(".mp4"))) {
    throw new MobileAilohaError("invalid_output", "Recording output must be an absolute MP4 host path.", 400);
  }
}

export function captureRecordingStartInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new MobileAilohaError("invalid_request", "Recording start requires an options object.", 400);
  }
  const requestedTimeout = input.timeoutSeconds;
  const timeoutSeconds = requestedTimeout === undefined ? 180 : requestedTimeout;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new MobileAilohaError("invalid_request", "Recording timeout must be between 1 and 3600 seconds.", 400);
  }
  const outputPath = input.outputPath;
  validateOutputPath(outputPath);
  return Object.freeze({ timeoutSeconds, ...(outputPath !== undefined ? { outputPath } : {}) });
}

export async function recordingOutputPath(outputPath, platform) {
  validateOutputPath(outputPath);
  if (outputPath) {
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
