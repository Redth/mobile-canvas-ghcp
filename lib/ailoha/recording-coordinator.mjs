import { MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";
import { isOpaqueId } from "./protocol.mjs";
import { isAbsolute } from "node:path";

const ACTIVE = new Set(["pending", "starting", "recording", "running", "stopping", "queued", "cancelling"]);
const TERMINAL = new Set(["completed", "stopped", "failed", "cancelled", "canceled"]);
const COMPLETE = new Set(["completed", "stopped"]);
const RECOVERY = new Set(["downloaded", "downloadFailed", "pending", "unknown", "failed", "notAttempted"]);

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

  async #call(owner, action, flags = [], beforeDispatch) {
    const raw = await this.#run(["recording", action, ...this.#binding(owner), ...flags], {
      timeoutMs: 120_000, ...(beforeDispatch ? { beforeDispatch } : {}),
    });
    let value;
    try { value = JSON.parse(raw); }
    catch { throw new MobileAilohaError("recording_invalid_response", "The pinned Ailoha recording command did not return JSON.", 502); }
    if (value?.error !== undefined && value?.type) {
      throw new MobileAilohaError("recording_command_failed", "The canonical Ailoha recording command rejected the captured operation.", 502);
    }
    if (value === null && action === "status") return null;
    if (!value || ![value.targetHostId, value.targetId, value.surfaceId].every(isOpaqueId)
      || (!isOpaqueId(value.recordingId)
        && !((action === "status" || action === "recover")
          && (value.recordingId === "" || value.recordingId === undefined)
          && owner.recordingId === undefined
          && (action === "recover" ? value.outcome !== "downloaded" : value.state === "pending")))
      || typeof value.state !== "string"
      || (action !== "recover" && ![...ACTIVE, ...TERMINAL].includes(value.state.toLowerCase()))
      || (action === "recover" && !RECOVERY.has(value.outcome))
      || (action === "recover" && value.outcome !== "downloaded"
        && (typeof value.code !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(value.code)))
      || ["operationId", "requestId", "stopOperationId", "stopRequestId", "artifactId"].some(
        (field) => value[field] !== undefined && !isOpaqueId(value[field]))
      || typeof value.outputFile !== "string" || !isAbsolute(value.outputFile)
      || value.targetHostId !== owner.invocation.targetHostId
      || (value.hostInstanceId !== undefined && !isOpaqueId(value.hostInstanceId))
      || (owner.hostInstanceId !== undefined && value.hostInstanceId !== owner.hostInstanceId)
      || (owner.recordingId !== undefined && value.recordingId !== owner.recordingId)
      || (action === "recover" && owner.operationId !== undefined && value.operationId !== owner.operationId)
      || (action === "recover" && owner.requestId !== undefined && value.requestId !== owner.requestId)
      || (action === "recover" && owner.stopOperationId !== undefined && value.stopOperationId !== owner.stopOperationId)
      || (action === "recover" && owner.stopRequestId !== undefined && value.stopRequestId !== owner.stopRequestId)
      || (action === "recover" && owner.artifactId !== undefined && value.artifactId !== owner.artifactId)
      || (owner.invocation.targetId !== undefined && value.targetId !== owner.invocation.targetId)
      || (owner.invocation.surfaceId !== undefined && value.surfaceId !== owner.invocation.surfaceId)
      || (value.contextRef !== undefined && value.contextRef !== owner.invocation.executionContext.contextRef)
      || (value.scopeEpoch !== undefined && value.scopeEpoch !== owner.invocation.executionContext.scopeEpoch)
      || (value.contextRevision !== undefined && value.contextRevision !== owner.invocation.executionContext.revision)
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
      if (record.recordingId) owner.recordingId ??= record.recordingId;
      owner.hostInstanceId ??= record.hostInstanceId;
      owner.operationId ??= record.operationId;
      owner.requestId ??= record.requestId;
      return record;
    }
    throw new MobileAilohaError("recording_state_unresolved", "The captured recording may have been accepted; its authoritative status is unavailable.", 502);
  }

  async start(invocation, { timeoutSeconds = 180, outputPath } = {}, requireCurrent = () => {}) {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
      throw new MobileAilohaError("invalid_request", "Recording timeout must be between 1 and 3600 seconds.", 400);
    }
    return this.#serial(async () => {
      requireCurrent();
      if (this.#owner?.stopAttempted) await this.#recoverOwned(this.#owner);
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
          outputPath: existing.outputFile, ...(existing.recordingId ? { recordingId: existing.recordingId } : {}),
          hostInstanceId: existing.hostInstanceId, operationId: existing.operationId,
          requestId: existing.requestId, accepted: true,
        };
        throw new MobileAilohaError("recording_already_tracked", "The canonical view already tracks a recording; finalize it first.", 409);
      }
      const path = await this.#output(outputPath, invocation.nativeIdentity?.platform);
      requireCurrent();
      const owner = { invocation: publicSnapshot(invocation), outputPath: path, timeoutSeconds };
      this.#owner = owner; // Retain even if CLI acceptance is lost: native stop recovers its persisted marker.
      const record = await this.#call(owner, "start", [
        "--target-host", invocation.targetHostId, "--target", invocation.targetId,
        "--surface", invocation.surfaceId, "--context-revision", invocation.executionContext.revision,
        "--output", path, "--timeout", String(timeoutSeconds),
      ], () => {
        try { requireCurrent(); }
        catch (error) {
          if (this.#owner === owner) this.#owner = null;
          throw error;
        }
      });
      owner.accepted = true;
      owner.recordingId = record.recordingId;
      owner.hostInstanceId = record.hostInstanceId;
      owner.operationId = record.operationId;
      owner.requestId = record.requestId;
      return this.#project(owner, record);
    });
  }

  async status(invocation) {
    return this.#serial(async () => {
      const owner = this.#owner ?? { invocation: publicSnapshot(invocation) };
      if (owner.invocation.targetId !== invocation.targetId) {
        return publicSnapshot({ deviceId: invocation.targetId, isRecording: false, outputPath: null, startedAt: null, timeoutSeconds: null });
      }
      if (this.#owner?.stopAttempted) return this.#recoverOwned(owner);
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
        outputPath: record.outputFile, ...(record.recordingId ? { recordingId: record.recordingId } : {}),
        hostInstanceId: record.hostInstanceId, operationId: record.operationId,
        requestId: record.requestId, accepted: true,
      };
      return record.targetId === invocation.targetId ? this.#project(this.#owner, record)
        : publicSnapshot({ deviceId: invocation.targetId, isRecording: false, outputPath: null, startedAt: null, timeoutSeconds: null });
    });
  }

  async #stopOwned(deviceId) {
    const owner = this.#owner;
    if (!owner || owner.invocation.targetId !== deviceId) {
      throw new MobileAilohaError("recording_not_tracked", "No recording belongs to this captured target.", 409);
    }
    if (owner.stopAttempted) return this.#recoverOwned(owner);
    owner.stopAttempted = true;
    const record = await this.#call(owner, "stop");
    if (!COMPLETE.has(record.state.toLowerCase()) || !record.artifactId) {
      throw new MobileAilohaError("recording_not_finalized", "The canonical recording has not finalized an artifact.", 502);
    }
    owner.recordingId ??= record.recordingId;
    owner.hostInstanceId ??= record.hostInstanceId;
    owner.artifactId = record.artifactId;
    owner.stopOperationId = record.stopOperationId;
    owner.stopRequestId = record.stopRequestId;
    return this.#recoverOwned(owner);
  }

  async #recoverOwned(owner) {
    const record = await this.#call(owner, "recover");
    if (record.outcome !== "downloaded") {
      throw new MobileAilohaError(
        `recording_recovery_${record.outcome.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
        `The captured recording remains unresolved (${record.code ?? record.outcome}).`,
        502,
      );
    }
    if (!COMPLETE.has(record.state.toLowerCase()) || !isOpaqueId(record.hostInstanceId)
      || ![record.stopOperationId, record.stopRequestId, record.artifactId].every(isOpaqueId)
      || record.contextRef !== owner.invocation.executionContext.contextRef
      || record.scopeEpoch !== owner.invocation.executionContext.scopeEpoch
      || record.contextRevision !== owner.invocation.executionContext.revision
      || typeof record.downloadedAt !== "string" || !record.downloadedAt
      || !Number.isSafeInteger(record.downloadedLength) || record.downloadedLength <= 0) {
      throw new MobileAilohaError("recording_owner_mismatch", "The canonical recovery receipt did not prove the captured recording and landed artifact.", 502);
    }
    const result = this.#project(owner, record);
    this.#owner = null;
    return result;
  }

  async stop(deviceId) { return this.#serial(() => this.#stopOwned(deviceId)); }

  get tracked() { return this.#owner !== null; }

  async probe(targetHostId, executionContext) {
    return this.#serial(async () => {
      if (this.#owner) return;
      const record = await this.#call({ invocation: { targetHostId, executionContext } }, "status");
      if (record) this.#owner = {
        invocation: publicSnapshot({
          targetHostId, targetId: record.targetId, surfaceId: record.surfaceId, executionContext,
        }),
        outputPath: record.outputFile, ...(record.recordingId ? { recordingId: record.recordingId } : {}),
        hostInstanceId: record.hostInstanceId, operationId: record.operationId,
        requestId: record.requestId, accepted: true,
      };
    });
  }

  async finalize() {
    return this.#serial(async () => {
      if (this.#owner?.stopAttempted) {
        await this.#recoverOwned(this.#owner);
        return;
      }
      if (this.#owner?.accepted) await this.#refreshOwned(this.#owner);
      if (this.#owner) await this.#stopOwned(this.#owner.invocation.targetId);
    });
  }
}
