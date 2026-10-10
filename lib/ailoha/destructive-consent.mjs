import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute } from "node:path";
import { immutableSnapshot, MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";

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
  if (!plainData(artifact, artifactFields, artifactFields)
    || !plainData(proof, proofFields, proofFields.filter((key) => !["nativeTargetId", "nativeTargetPlatform"].includes(key)))
    || typeof artifact.artifactId !== "string" || !artifact.artifactId
    || typeof artifact.sourcePath !== "string" || !isAbsolute(artifact.sourcePath)
    || !Number.isSafeInteger(artifact.size) || artifact.size < 0 || !digest(artifact.sha256) || !digest(artifact.receipt)
    || !proof || typeof proof.packageName !== "string" || !proof.packageName
    || typeof proof.hostInstanceId !== "string" || !proof.hostInstanceId
    || !Number.isSafeInteger(proof.ownerProcessId) || proof.ownerProcessId < 1
    || typeof proof.ownerStartedAt !== "string" || !Number.isFinite(Date.parse(proof.ownerStartedAt))
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

  begin(action, invocation, { signal, stagedArtifact } = {}) {
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
    if (!["erase", "delete", "install"].includes(action)) {
      throw new MobileAilohaError("consent_action_unsupported", "This action has no approved human-consent workflow.", 501);
    }
    const artifact = action === "install" ? capturedArtifact(stagedArtifact, invocation) : undefined;
    const requestId = randomUUID();
    const verb = action === "erase" ? "Erase" : action === "install" ? "Install" : "Delete";
    const native = invocation.nativeIdentity;
    const request = {
      action, invocation, requestId,
      title: `${verb} ${invocation.targetId}?`,
      message: [
        action === "install" ? "Install exactly this staged application package on the captured target?"
          : `${verb} this target and permanently remove its data?`,
        `Target: ${invocation.targetId}`,
        `Provider: ${invocation.providerId}`,
        `Native deployment identity: ${native ? `${native.platform}: ${native.nativeId}` : "unavailable"}`,
        `Context: ${context.contextRef}; epoch: ${context.scopeEpoch}; revision: ${context.revision}`,
        ...(artifact ? [
          `Package: ${artifact.proof.packageName}`, `SHA-256: ${artifact.sha256}`, `Size: ${artifact.size} bytes`,
        ] : []),
        "Approval applies once to this capture, expires after 60 seconds, and cannot follow a changed context or target.",
        `Approval request: ${requestId}`,
      ].join("\n"),
    };
    if (artifact) Object.defineProperty(request, "stagedArtifact", { value: artifact });
    Object.freeze(request);
    const controller = new AbortController();
    const deadline = performance.now() + DESTRUCTIVE_CONSENT_TIMEOUT_MS;
    let state = "waiting";
    let failure;
    let timer;
    let resolve;
    let reject;
    const approved = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    const onAbort = () => retire(cancelled());
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this.#pending.delete(record);
    };
    const retire = (error) => {
      if (state === "retired" || state === "consumed") return;
      state = "retired";
      failure = error;
      cleanup();
      controller.abort(error);
      reject(error);
    };
    const requireCurrent = () => {
      if (state === "retired") throw failure;
      if (state === "consumed") throw new MobileAilohaError("consent_already_consumed", "This approval was already consumed.");
      if (signal?.aborted) retire(cancelled());
      else if (this.#lifetime.aborted) this.#onAbort();
      else if (performance.now() >= deadline) {
        retire(new MobileAilohaError("consent_timeout", "The captured destructive approval expired before submission.", 408));
      }
      if (state === "retired") throw failure;
    };
    const record = { retire };
    const approval = Object.freeze({
      request, approved, signal: controller.signal,
      requireCurrent,
      run(work) {
        requireCurrent();
        return new Promise((accept, decline) => {
          const onRetire = () => {
            finish();
            decline(failure ?? cancelled());
          };
          const finish = () => controller.signal.removeEventListener("abort", onRetire);
          controller.signal.addEventListener("abort", onRetire, { once: true });
          Promise.resolve().then(() => {
            requireCurrent();
            return work();
          }).then((value) => {
            finish();
            try {
              if (state !== "consumed") requireCurrent();
              accept(value);
            } catch (error) { decline(error); }
          }, (error) => {
            finish();
            try {
              if (state !== "consumed") requireCurrent();
              decline(error);
            } catch (retired) { decline(retired); }
          });
        });
      },
      consume(captured, currentArtifact) {
        requireCurrent();
        if (state !== "approved" || captured !== invocation
          || (artifact && !isDeepStrictEqual(artifact, currentArtifact))) {
          throw new MobileAilohaError("consent_capture_mismatch", "Approval cannot authorize another captured invocation.");
        }
        state = "consumed";
        cleanup();
      },
      dispose() { retire(cancelled()); },
    });
    this.#pending.add(record);
    timer = setTimeout(() => retire(new MobileAilohaError(
      "consent_timeout", "The captured destructive approval expired before submission.", 408,
    )), DESTRUCTIVE_CONSENT_TIMEOUT_MS);
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
    this.#onAbort();
    this.#lifetime.removeEventListener("abort", this.#onAbort);
  }
}
