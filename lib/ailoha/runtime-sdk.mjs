import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MobileAilohaError } from "./mobile-projection.mjs";

const execFileAsync = promisify(execFile);
const REQUIRED_EXPORTS = Object.freeze([
  "getRuntimePin", "getVerifiedCliLaunch", "ensureTargetHost", "openTargetHostTransport",
  "registerRuntimeCleanup", "releaseRuntimeLease",
]);

export async function loadAilohaRuntimeSdk() {
  let pin;
  try {
    pin = JSON.parse(await readFile(fileURLToPath(new URL("./runtime-package.json", import.meta.url)), "utf8"));
  } catch {
    throw new MobileAilohaError(
      "ailoha_runtime_unavailable",
      "The Ailoha opt-in is unavailable: an approved public runtime/package pin has not been prepared. Legacy was not started.",
      503,
    );
  }
  if (pin.schema !== "mobile-canvas.ailoha-runtime/v1" || typeof pin.version !== "string"
    || typeof pin.sourceSha !== "string" || !/^[a-f0-9]{40}$/.test(pin.sourceSha)) {
    throw new MobileAilohaError("ailoha_runtime_pin_invalid", "The packaged Ailoha runtime provenance is invalid.", 503);
  }
  let sdk;
  try { sdk = await import("@ailoha/cli/runtime"); }
  catch {
    throw new MobileAilohaError("ailoha_runtime_unavailable", "The approved official Ailoha runtime graph is not present in this installed host.", 503);
  }
  if (REQUIRED_EXPORTS.some((name) => typeof sdk[name] !== "function")) {
    throw new MobileAilohaError("ailoha_sdk_incompatible", "The installed official Ailoha SDK does not match the approved transport contract.", 503);
  }
  const actual = await sdk.getRuntimePin({ expectedVersion: pin.version });
  if (actual.version !== pin.version || actual.sourceSha !== pin.sourceSha) {
    throw new MobileAilohaError("ailoha_runtime_pin_mismatch", "The official Ailoha runtime does not match the prepared version and source pin.", 503);
  }
  return { sdk, pin };
}

export function createVerifiedAilohaCli({ sdk, pin }) {
  return async (args, options = {}) => {
    const launch = await sdk.getVerifiedCliLaunch({ expectedVersion: pin.version });
    if (launch.version !== pin.version || launch.sourceSha !== pin.sourceSha) {
      throw new MobileAilohaError("ailoha_cli_pin_mismatch", "The canonical Ailoha CLI launch does not match the prepared pin.", 503);
    }
    try {
      const { stdout } = await execFileAsync(launch.file, [...launch.args, ...args], {
        encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000, windowsHide: true, signal: options.signal,
      });
      return stdout;
    } catch (error) {
      if (typeof error.stderr === "string") {
        try {
          const value = JSON.parse(error.stderr);
          if (value.schema === "ailoha.execution-context.result/v1" || value.ok === false) return error.stderr;
        } catch {
          // Only structured canonical context failures can be projected.
        }
      }
      throw new MobileAilohaError("ailoha_cli_failed", "The pinned canonical Ailoha context command failed.", 502);
    }
  };
}
