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
  let content;
  try {
    content = await readFile(fileURLToPath(new URL("./runtime-package.json", import.meta.url)), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new MobileAilohaError("ailoha_runtime_pin_unreadable", "The packaged Ailoha runtime provenance could not be read.", 503);
    }
    throw new MobileAilohaError(
      "ailoha_runtime_unavailable",
      "The Ailoha opt-in is unavailable: an approved public runtime/package pin has not been prepared. Legacy was not started.",
      503,
    );
  }
  let pin;
  try {
    pin = JSON.parse(content);
  } catch {
    throw new MobileAilohaError("ailoha_runtime_pin_invalid", "The packaged Ailoha runtime provenance is invalid.", 503);
  }
  if (!pin || typeof pin !== "object" || Array.isArray(pin)
    || pin.schema !== "mobile-canvas.ailoha-runtime/v1" || typeof pin.version !== "string"
    || !pin.version || pin.version.length > 128 || pin.version.trim() !== pin.version
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
  if (actual?.version !== pin.version || actual?.sourceSha !== pin.sourceSha) {
    throw new MobileAilohaError("ailoha_runtime_pin_mismatch", "The official Ailoha runtime does not match the prepared version and source pin.", 503);
  }
  return { sdk, pin };
}

export function createVerifiedAilohaCli({ sdk, pin }) {
  return async (args, options = {}) => {
    const inspection = args[0] === "workspace" && args[1] === "inspect";
    const nativeArtifact = args[0] === "target"
      && (args.includes("native-stage") || args.includes("native-file"));
    let processClosed;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maximum = nativeArtifact ? 10 * 60_000 : 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximum) {
      throw new MobileAilohaError("ailoha_cli_budget_invalid",
        `The verified CLI requires an integer total budget in 1..${maximum} milliseconds.`, 400);
    }
    const deadline = performance.now() + timeoutMs;
    const timeout = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    const cancelled = () => new MobileAilohaError(
      timeout.signal.aborted ? "ailoha_cli_timeout" : "ailoha_cli_cancelled",
      timeout.signal.aborted ? "The verified CLI exceeded its original total budget." : "The captured verified CLI invocation was cancelled.",
      timeout.signal.aborted ? 504 : 409,
    );
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    try {
      const launch = await new Promise((resolve, reject) => {
        const onAbort = () => reject(cancelled());
        signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve().then(() => {
          if (signal.aborted) throw cancelled();
          return sdk.getVerifiedCliLaunch({ expectedVersion: pin.version });
        }).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      });
      if (launch.version !== pin.version || launch.sourceSha !== pin.sourceSha) {
        throw new MobileAilohaError("ailoha_cli_pin_mismatch", "The canonical Ailoha CLI launch does not match the prepared pin.", 503);
      }
      const remaining = Math.floor(deadline - performance.now());
      if (signal.aborted) throw cancelled();
      if (remaining < 1) {
        timeout.abort();
        throw cancelled();
      }
      const invocation = execFileAsync(launch.file, [...launch.args, ...args], {
        encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
        timeout: remaining, windowsHide: true, signal,
        ...(inspection || nativeArtifact ? { killSignal: "SIGKILL" } : {}),
      });
      if (inspection || nativeArtifact) processClosed = new Promise((resolve) => invocation.child.once("close", resolve));
      const { stdout } = await invocation;
      return stdout;
    } catch (error) {
      if (error instanceof MobileAilohaError) throw error;
      if (nativeArtifact && typeof error.stdout === "string" && Buffer.byteLength(error.stdout) <= 64 * 1024) {
        try {
          const value = JSON.parse(error.stdout);
          if (value && typeof value === "object" && !Array.isArray(value)
            && typeof value.status === "string" && value.receipt
            && typeof value.receipt === "object" && !Array.isArray(value.receipt)) return error.stdout;
        } catch {
          // Only complete canonical typed outcomes preserve the original staging receipt.
        }
      }
      if (inspection && !signal.aborted && error.code === 2 && typeof error.stdout === "string") {
        try {
          const value = JSON.parse(error.stdout);
          if (value.schema === "ailoha.workspace.inspection/v1" && value.scan?.complete === false) return error.stdout;
        } catch {
          // Exit 2 is useful only with canonical structured incomplete-scan evidence.
        }
      }
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new MobileAilohaError("ailoha_cli_output_limit", "The pinned canonical Ailoha command exceeded its 2 MiB output limit.", 502);
      }
      if (inspection && signal.aborted) throw cancelled();
      if (inspection && error.killed) {
        throw new MobileAilohaError("ailoha_cli_timeout", "The pinned canonical Ailoha command exceeded its deadline.", 504);
      }
      if (typeof error.stderr === "string") {
        try {
          const value = JSON.parse(error.stderr);
          if (value.schema === "ailoha.execution-context.result/v1" || value.ok === false) return error.stderr;
        } catch {
          // Only structured canonical context failures can be projected.
        }
      }
      if (signal.aborted) throw cancelled();
      throw new MobileAilohaError("ailoha_cli_failed", `The pinned canonical Ailoha ${inspection ? "workspace inspection" : "context"} command failed.`, 502);
    } finally {
      clearTimeout(timer);
      // execFile's AbortError can precede process exit. Do not admit a replacement scan until
      // the retired read-only child has actually closed.
      await processClosed;
    }
  };
}
