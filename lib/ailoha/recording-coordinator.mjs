import { MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";
import { isOpaqueId } from "./protocol.mjs";
import { isAbsolute } from "node:path";
import { lstat } from "node:fs/promises";

const ACTIVE = new Set(["starting", "recording", "running", "stopping", "queued", "cancelling"]);
const TERMINAL = new Set(["completed", "stopped", "failed", "cancelled", "canceled"]);

// The official CLI owns the durable acceptance markers, target correlation, stop and artifact landing.
// This wrapper only retains the view's original binding while calls and presentation overlap.
export class AilohaRecordingCoordinator {
  #run;
  #output;
  #owner = null;
  #tail = Promise.resolve();
  #queued = 0;

  constructor({ run, output }) {
    this.#run = run;
    this.#output = output;
  }

  async #serial(work) {
    if (this.#queued >= 64) {
      throw new MobileAilohaError("recording_queue_limit", "The bounded recording intent queue is full.", 429);
    }
    this.#queued += 1;
    const flight = this.#tail.then(work);
    this.#tail = flight.then(() => {}, () => {});
    try { return await flight; }
    finally { this.#queued -= 1; }
  }

  #binding(owner) {
    const context = owner.invocation.executionContext;
    if (!context?.contextRef || !context.scopeEpoch) {
      throw new MobileAilohaError("context_not_bound", "Recording requires a captured canonical view authority.");
    }
    return ["--context", context.contextRef, "--context-epoch", context.scopeEpoch, "--json"];
  }

  async #call(owner, action, flags = []) {
    const raw = await this.#run(["recording", action, ...this.#binding(owner), ...flags], { timeoutMs: 120_000 });
    let value;
    try { value = JSON.parse(raw); }
    catch { throw new MobileAilohaError("recording_invalid_response", "The pinned Ailoha recording command did not return JSON.", 502); }
    if (value?.error !== undefined && value?.type) {
      throw new MobileAilohaError("recording_command_failed", "The canonical Ailoha recording command rejected the captured operation.", 502);
    }
    if (value === null && action === "status") return null;
    if (!value || ![value.targetHostId, value.targetId, value.surfaceId, value.recordingId].every(isOpaqueId)
      || typeof value.state !== "string" || ![...ACTIVE, ...TERMINAL].includes(value.state.toLowerCase())
      || typeof value.outputFile !== "string" || !isAbsolute(value.outputFile)
      || value.targetHostId !== owner.invocation.targetHostId
      || (owner.invocation.targetId !== undefined && value.targetId !== owner.invocation.targetId)
      || (owner.invocation.surfaceId !== undefined && value.surfaceId !== owner.invocation.surfaceId)
      || (owner.outputPath !== undefined && value.outputFile !== owner.outputPath)) {
      throw new MobileAilohaError("recording_owner_mismatch", "Canonical recording output did not identify the captured owner and destination.", 502);
    }
    return publicSnapshot(value);
  }

  #project(owner, record) {
    return publicSnapshot({
      deviceId: owner.invocation.targetId,
      isRecording: ACTIVE.has(record.state.toLowerCase()),
      outputPath: record.outputFile,
      startedAt: record.startedAt ?? null,
      timeoutSeconds: owner.timeoutSeconds ?? null,
    });
  }

  async #refreshOwned(owner) {
    const record = await this.#call(owner, "status");
    if (record) {
      owner.accepted = true;
      return record;
    }
    if (owner.accepted) {
      let file;
      try { file = await lstat(owner.outputPath); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (file?.isFile() && file.size > 0) {
        this.#owner = null;
        return null;
      }
    }
    throw new MobileAilohaError("recording_state_unresolved", "The captured recording may have been accepted; its authoritative status is unavailable.", 502);
  }

  async start(invocation, { timeoutSeconds = 180, outputPath } = {}) {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
      throw new MobileAilohaError("invalid_request", "Recording timeout must be between 1 and 3600 seconds.", 400);
    }
    return this.#serial(async () => {
      if (this.#owner) await this.#refreshOwned(this.#owner);
      if (this.#owner) throw new MobileAilohaError("recording_already_tracked", "Finalize the captured recording before starting another.", 409);
      const existing = await this.#call({
        invocation: { targetHostId: invocation.targetHostId, executionContext: invocation.executionContext },
      }, "status");
      if (existing) {
        this.#owner = {
          invocation: publicSnapshot({
            ...invocation, targetId: existing.targetId, surfaceId: existing.surfaceId,
          }),
          outputPath: existing.outputFile, accepted: true,
        };
        throw new MobileAilohaError("recording_already_tracked", "The canonical view already tracks a recording; finalize it first.", 409);
      }
      const path = await this.#output(outputPath, invocation.nativeIdentity?.platform);
      const owner = { invocation: publicSnapshot(invocation), outputPath: path, timeoutSeconds };
      this.#owner = owner; // Retain even if CLI acceptance is lost: native stop recovers its persisted marker.
      const record = await this.#call(owner, "start", [
        "--target-host", invocation.targetHostId, "--target", invocation.targetId,
        "--surface", invocation.surfaceId, "--context-revision", invocation.executionContext.revision,
        "--output", path, "--timeout", String(timeoutSeconds),
      ]);
      owner.accepted = true;
      return this.#project(owner, record);
    });
  }

  async status(invocation) {
    return this.#serial(async () => {
      const owner = this.#owner ?? { invocation: publicSnapshot(invocation) };
      if (owner.invocation.targetId !== invocation.targetId) {
        return publicSnapshot({ deviceId: invocation.targetId, isRecording: false, outputPath: null, startedAt: null, timeoutSeconds: null });
      }
      const record = this.#owner ? await this.#refreshOwned(owner) : await this.#call({
        invocation: { targetHostId: invocation.targetHostId, executionContext: invocation.executionContext },
      }, "status");
      if (!record) {
        return publicSnapshot({
          deviceId: invocation.targetId, isRecording: false,
          outputPath: owner.accepted ? owner.outputPath : null,
          startedAt: null, timeoutSeconds: owner.timeoutSeconds ?? null,
        });
      }
      if (!this.#owner) this.#owner = {
        invocation: publicSnapshot({ ...invocation, targetId: record.targetId, surfaceId: record.surfaceId }),
        outputPath: record.outputFile, accepted: true,
      };
      return record.targetId === invocation.targetId ? this.#project(this.#owner, record)
        : publicSnapshot({ deviceId: invocation.targetId, isRecording: false, outputPath: null, startedAt: null, timeoutSeconds: null });
    });
  }

  async stop(deviceId) {
    return this.#serial(async () => {
      const owner = this.#owner;
      if (!owner || owner.invocation.targetId !== deviceId) {
        throw new MobileAilohaError("recording_not_tracked", "No recording belongs to this captured target.", 409);
      }
      if (owner.stopAttempted) {
        await this.#refreshOwned(owner);
        throw new MobileAilohaError(
          "recording_stop_unresolved",
          "The captured stop may have been accepted; the canonical CLI cannot safely retry its artifact without risking another stop.",
          502,
        );
      }
      owner.stopAttempted = true;
      const record = await this.#call(owner, "stop");
      if (ACTIVE.has(record.state.toLowerCase()) || !record.artifactId) {
        throw new MobileAilohaError("recording_not_finalized", "The canonical recording has not finalized an artifact.", 502);
      }
      this.#owner = null;
      return this.#project(owner, record);
    });
  }

  get tracked() { return this.#owner !== null; }

  async probe(targetHostId, executionContext) {
    return this.#serial(async () => {
      if (this.#owner) return;
      const record = await this.#call({ invocation: { targetHostId, executionContext } }, "status");
      if (record) this.#owner = {
        invocation: publicSnapshot({
          targetHostId, targetId: record.targetId, surfaceId: record.surfaceId, executionContext,
        }),
        outputPath: record.outputFile, accepted: true,
      };
    });
  }

  async finalize() {
    if (this.#owner) {
      if (this.#owner.accepted) await this.status(this.#owner.invocation);
      if (this.#owner) await this.stop(this.#owner.invocation.targetId);
    }
  }
}
