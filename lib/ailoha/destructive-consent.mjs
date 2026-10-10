import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute } from "node:path";
import { immutableSnapshot, MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";
import { isOpaqueId } from "./protocol.mjs";

export const DESTRUCTIVE_CONSENT_TIMEOUT_MS = 60_000;
export const DESTRUCTIVE_CONSENT_SCHEMA = publicSnapshot({
  type: "object",
  properties: {
    decision: {
      type: "string", title: "Approve this captured action once",
      enum: ["cancel", "approve"], enumNames: ["Do not proceed", "Approve once"], default: "cancel",
    },
  },
  required: ["decision"],
});

export function destructiveConsentResult(result) {
  if (result?.action === "decline") return false;
  if (result?.action === "cancel") {
    return "cancel";
  }
  const decision = result?.content && Object.getOwnPropertyDescriptor(result.content, "decision");
  if (result?.action !== "accept" || !decision || !["approve", "cancel"].includes(decision.value)
    || Object.keys(result.content).some((key) => key !== "decision")) {
    throw new MobileAilohaError("consent_response_invalid", "The trusted host did not return the requested approval decision.", 502);
  }
  return decision.value === "approve";
}

function cancelled() {
  return new MobileAilohaError("consent_cancelled", "The captured destructive approval was cancelled.", 409);
}

function capturedArtifact(artifact, invocation) {
  const proof = Object.getOwnPropertyDescriptor(artifact ?? {}, "proof")?.value;
  const plainData = (value, allowed, required) => value && typeof value === "object"
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key, descriptor]) =>
      allowed.includes(key) && Object.hasOwn(descriptor, "value") && descriptor.enumerable)
    && required.every((key) => Object.hasOwn(value, key));
  const artifactFields = ["artifactId", "sourcePath", "receipt", "size", "sha256", "proof"];
  const proofFields = [
    "targetHostId", "targetId", "providerId", "nativeTargetId", "nativeTargetPlatform", "contextRef",
    "scopeEpoch", "revision", "hostInstanceId", "ownerProcessId", "ownerStartedAt", "sourcePathHash",
    "packageName", "receiptHash",
  ];
  const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
  if (!invocation.contextOwner) {
    throw new MobileAilohaError("consent_owner_unavailable", "Install approval requires the exact captured canonical process owner.");
  }
  if (!plainData(artifact, artifactFields, artifactFields)
    || !plainData(proof, proofFields, proofFields.filter((key) => !["nativeTargetId", "nativeTargetPlatform"].includes(key)))
    || typeof artifact.artifactId !== "string" || !artifact.artifactId
    || typeof artifact.sourcePath !== "string" || !isAbsolute(artifact.sourcePath)
    || !Number.isSafeInteger(artifact.size) || artifact.size < 0 || !digest(artifact.sha256) || !digest(artifact.receipt)
    || !proof || typeof proof.packageName !== "string" || !proof.packageName
    || typeof proof.hostInstanceId !== "string" || !proof.hostInstanceId
    || !Number.isSafeInteger(proof.ownerProcessId) || proof.ownerProcessId < 1
    || typeof proof.ownerStartedAt !== "string" || !Number.isFinite(Date.parse(proof.ownerStartedAt))
    || proof.ownerProcessId !== invocation.executionContext.ownerProcessId
    || proof.ownerProcessId !== invocation.contextOwner.processId
    || proof.ownerStartedAt !== invocation.contextOwner.processStartedAt
    || proof.sourcePathHash !== hash(artifact.sourcePath) || proof.receiptHash !== hash(artifact.receipt)
    || proof.targetHostId !== invocation.targetHostId || proof.targetId !== invocation.targetId
    || proof.providerId !== invocation.providerId || proof.contextRef !== invocation.executionContext.contextRef
    || proof.scopeEpoch !== invocation.executionContext.scopeEpoch || proof.revision !== invocation.executionContext.revision
    || (proof.nativeTargetId !== undefined && proof.nativeTargetId !== invocation.nativeIdentity?.nativeId)
    || (proof.nativeTargetPlatform !== undefined && proof.nativeTargetPlatform !== invocation.nativeIdentity?.platform)) {
    throw new MobileAilohaError("consent_artifact_invalid", "Install approval requires the exact staged artifact and captured receipt proof.");
  }
  return immutableSnapshot(artifact);
}

function capturedAppAction(action, details, invocation) {
  const fields = action === "uninstall" ? ["appId", "packageId", "receipt"]
    : ["appId", "packageId", "receipt", "operation", "currentMode", "requestedMode", "uidScoped"];
  const descriptors = details && typeof details === "object" && !Array.isArray(details)
    ? Object.getOwnPropertyDescriptors(details) : {};
  const modes = ["allow", "deny", "ignored", "default", "foreground"];
  if (!invocation.contextOwner || !invocation.connectionRef || !invocation.nativeIdentity
    || !["ios", "android"].includes(invocation.nativeIdentity.platform)
    || (action === "app-op" && invocation.nativeIdentity.platform !== "android")
    || !details || typeof details !== "object" || Array.isArray(details)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(details))
    || Object.getOwnPropertySymbols(details).length
    || Object.keys(descriptors).sort().join() !== fields.sort().join()
    || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
    || !isOpaqueId(details.appId) || typeof details.packageId !== "string"
    || details.packageId.length > 255 || !/^[A-Za-z0-9_.-]+$/.test(details.packageId)
    || !details.receipt || typeof details.receipt !== "object" || Array.isArray(details.receipt)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(details.receipt))
    || typeof details.receipt.schema !== "string" || details.receipt.schema.length > 128
    || !/^[A-Za-z0-9./-]+$/.test(details.receipt.schema)
    || Buffer.byteLength(JSON.stringify(details.receipt), "utf8") > 64 * 1024
    || (action === "app-op" && (typeof details.operation !== "string" || details.operation.length > 128
      || !/^[A-Za-z0-9_.:]+$/.test(details.operation)
      || !modes.includes(details.currentMode)
      || !modes.slice(0, 4).includes(details.requestedMode)
      || typeof details.uidScoped !== "boolean"))) {
    throw new MobileAilohaError("consent_app_action_invalid",
      "App approval requires one captured native app and complete immutable action details.", 400);
  }
  return immutableSnapshot(details);
}

export class ScopedDestructiveConsent {
  #prompt;
  #pending = new Set();
  #lifetime;
  #onAbort;

  constructor(prompt, lifetime) {
    this.#prompt = prompt;
    this.#lifetime = lifetime;
    this.#onAbort = () => this.cancelAll(new MobileAilohaError("view_closed", "The captured approval owner was retired."));
    lifetime.addEventListener("abort", this.#onAbort, { once: true });
  }

  get supported() {
    return typeof this.#prompt === "function"
      && (typeof this.#prompt.isSupported !== "function" || this.#prompt.isSupported() === true);
  }

  begin(action, invocation, { signal, stagedArtifact, appAction, subject } = {}) {
    if (!this.supported) {
      throw new MobileAilohaError("capability_not_supported", "This host cannot request genuine destructive approval.", 501);
    }
    if (this.#pending.size >= 128) {
      throw new MobileAilohaError("consent_prompt_limit", "The bounded pending approval pool is full.", 429);
    }
    const context = invocation.executionContext;
    if (!context || !invocation.connectionRef) {
      throw new MobileAilohaError("consent_context_unavailable", "Destructive approval requires its captured canonical context and runtime incarnation.");
    }
    if (!["erase", "delete", "install", "uninstall", "app-op", "file_push", "file_delete"].includes(action)) {
      throw new MobileAilohaError("consent_action_unsupported", "This action has no approved human-consent workflow.", 501);
    }
    if (["file_push", "file_delete"].includes(action)
      && (typeof subject !== "string" || !subject || subject.length > 4096 || /[\0\r\n]/.test(subject))) {
      throw new MobileAilohaError("consent_subject_invalid", "File approval requires one captured device path.", 400);
    }
    const artifact = action === "install" ? capturedArtifact(stagedArtifact, invocation) : undefined;
    const capturedApp = ["uninstall", "app-op"].includes(action)
      ? capturedAppAction(action, appAction, invocation) : undefined;
    const requestId = randomUUID();
    const verb = action === "erase" ? "Erase" : action === "install" ? "Install"
      : action === "uninstall" ? "Uninstall" : action === "app-op" ? "Change app operation on"
        : action === "file_push" ? "Replace file on" : "Delete";
    const native = invocation.nativeIdentity;
    const request = {
      action, invocation, requestId,
      title: `${verb} ${subject ?? capturedApp?.packageId ?? invocation.targetId}?`,
      message: [
        action === "file_push" ? "Copy this staged file to the captured device path, replacing any existing file?"
          : action === "file_delete" ? "Delete exactly this captured device file or directory?"
          : action === "install" ? "Install exactly this staged application package on the captured target?"
          : action === "uninstall" ? "Uninstall exactly this native application from the captured target?"
          : action === "app-op" ? "Change exactly this Android app operation on the captured target?"
          : `${verb} this target and permanently remove its data?`,
        ...(subject ? [`Device path: ${subject}`] : []),
        `Target: ${invocation.targetId}`,
        `Provider: ${invocation.providerId}`,
        `Native deployment identity: ${native ? `${native.platform}: ${native.nativeId}` : "unavailable"}`,
        `Context: ${context.contextRef}; epoch: ${context.scopeEpoch}; revision: ${context.revision}`,
        ...(artifact ? [
          `Package: ${artifact.proof.packageName}`, `SHA-256: ${artifact.sha256}`, `Size: ${artifact.size} bytes`,
        ] : []),
        ...(capturedApp ? [
          `Native package: ${capturedApp.packageId}`,
          ...(action === "app-op" ? [
            `Operation: ${capturedApp.operation}`,
            `Current mode: ${capturedApp.currentMode} (${capturedApp.uidScoped ? "whole UID" : "package"} scope)`,
            `Requested package mode: ${capturedApp.requestedMode}`,
            "A whole-UID mode overrides the package mode; the effective mode must be read back after this change.",
          ] : []),
        ] : []),
        "Approval applies once to this capture, expires after 60 seconds, and cannot follow a changed context or target.",
        `Approval request: ${requestId}`,
      ].join("\n"),
    };
    if (artifact) Object.defineProperty(request, "stagedArtifact", { value: artifact });
    if (capturedApp) Object.defineProperty(request, "appAction", { value: capturedApp });
    Object.freeze(request);
    const controller = new AbortController();
    const submissionSignal = AbortSignal.any([controller.signal, this.#lifetime, ...(signal ? [signal] : [])]);
    const deadline = performance.now() + DESTRUCTIVE_CONSENT_TIMEOUT_MS;
    let state = "waiting";
    let consumed = false;
    let expired = false;
    let failure;
    let capturedOutcome;
    let timer;
    let resolve;
    let reject;
    const approved = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    const deadlineWaiters = new Set();
    const onAbort = () => retire(cancelled());
    const cleanup = (clearBudget = true) => {
      if (clearBudget) {
        clearTimeout(timer);
        this.#pending.delete(record);
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const retire = (error) => {
      if (state === "retired" || state === "finished") return;
      state = "retired";
      failure = error;
      cleanup(!consumed);
      controller.abort(error);
      reject(error);
    };
    const requireCurrent = () => {
      if (state === "retired") throw failure;
      if (state === "finished") throw new MobileAilohaError("consent_already_consumed", "This approval attempt has finished.");
      if (signal?.aborted) retire(cancelled());
      else if (this.#lifetime.aborted) this.#onAbort();
      else if (expired || performance.now() >= deadline) {
        retire(new MobileAilohaError("consent_timeout", "The captured destructive approval expired before submission.", 408));
      }
      if (state === "retired") throw failure;
    };
    const finishSubmission = (outcome) => {
      if (!consumed) throw new MobileAilohaError("consent_not_consumed", "No captured submission attempt has consumed this approval.");
      if (state === "finished") return;
      if (outcome !== undefined && capturedOutcome === undefined) capturedOutcome = outcome;
      if (expired || performance.now() >= deadline) {
        expired = true;
        const error = new MobileAilohaError("submission_outcome_unknown",
          "The captured submission settled after its original budget; late metadata remains owned and must not authorize replay.", 502);
        retire(error);
        cleanup();
        throw error;
      }
      try { requireCurrent(); }
      catch (error) { cleanup(); throw error; }
      state = "finished";
      cleanup();
    };
    const dispose = () => {
      retire(cancelled());
      cleanup();
      for (const onDeadline of [...deadlineWaiters]) onDeadline();
    };
    const record = { retire, dispose };
    const approval = {
      request, approved, signal: submissionSignal,
      requireCurrent,
      remainingTimeoutMs(ceilingMs = 30_000) {
        if (!Number.isSafeInteger(ceilingMs) || ceilingMs < 1 || ceilingMs > 120_000) {
          throw new MobileAilohaError("consent_budget_invalid", "The captured submission ceiling must be an integer in 1..120000 milliseconds.", 400);
        }
        requireCurrent();
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) {
          retire(new MobileAilohaError("consent_timeout", "No original approval budget remains for submission.", 408));
          throw failure;
        }
        return Math.min(ceilingMs, remaining);
      },
      run(work) {
        return approved.then(() => {
          requireCurrent();
          return new Promise((accept, decline) => {
            const onRetire = () => {
              if (consumed) return;
              finish();
              decline(failure ?? cancelled());
            };
            const onDeadline = () => {
              finish();
              decline(new MobileAilohaError(
                consumed ? "submission_outcome_unknown" : "consent_timeout",
                consumed
                  ? "The captured submission did not settle within its original budget; its receipt remains owned and must not be replayed."
                  : "The captured approval expired before submission.",
                consumed ? 502 : 408,
              ));
            };
            const finish = () => {
              controller.signal.removeEventListener("abort", onRetire);
              deadlineWaiters.delete(onDeadline);
            };
            deadlineWaiters.add(onDeadline);
            controller.signal.addEventListener("abort", onRetire, { once: true });
            Promise.resolve().then(() => {
              requireCurrent();
              return work();
            }).then((value) => {
              finish();
              try {
                if (consumed) finishSubmission({ value });
                else requireCurrent();
                accept(value);
              } catch (error) { decline(error); }
            }, (error) => {
              finish();
              try {
                if (consumed) finishSubmission({ error });
                else requireCurrent();
                decline(error);
              } catch (retired) { decline(retired); }
            });
          });
        });
      },
      consume(captured, currentArtifact) {
        if (consumed) throw new MobileAilohaError("consent_already_consumed", "This approval was already consumed.");
        requireCurrent();
        if (state !== "approved" || captured !== invocation
          || (artifact && !isDeepStrictEqual(artifact, currentArtifact))
          || (capturedApp && !isDeepStrictEqual(capturedApp, currentArtifact))) {
          throw new MobileAilohaError("consent_capture_mismatch", "Approval cannot authorize another captured invocation.");
        }
        consumed = true;
        state = "consumed";
      },
      submitted: finishSubmission,
      dispose,
    };
    Object.defineProperty(approval, "submissionResult", { get: () => capturedOutcome });
    Object.freeze(approval);
    this.#pending.add(record);
    timer = setTimeout(() => {
      expired = true;
      retire(new MobileAilohaError("consent_timeout", "The original destructive submission budget expired.", 408));
      for (const onDeadline of [...deadlineWaiters]) onDeadline();
    }, DESTRUCTIVE_CONSENT_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => {
      requireCurrent();
      return this.#prompt(request, { signal: controller.signal });
    }).then((result) => {
      if (state !== "waiting") return;
      requireCurrent();
      if (result === "cancel") {
        retire(cancelled());
        return;
      }
      if (result !== true) {
        retire(new MobileAilohaError("consent_denied", "The captured destructive operation was not approved.", 403));
        return;
      }
      state = "approved";
      resolve(approval);
    }).catch((error) => retire(error instanceof MobileAilohaError ? error
      : new MobileAilohaError("consent_prompt_failed", "The trusted host approval prompt failed.", 502)));
    return approval;
  }

  cancelAll(error) {
    for (const pending of [...this.#pending]) pending.retire(error);
  }

  dispose() {
    for (const pending of [...this.#pending]) pending.dispose();
    this.#lifetime.removeEventListener("abort", this.#onAbort);
  }
}
