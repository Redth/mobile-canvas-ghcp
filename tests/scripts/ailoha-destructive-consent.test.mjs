import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { productModule } from "../ailoha-test-module.mjs";
const { ScopedDestructiveConsent, destructiveConsentResult } = await import(productModule("lib/ailoha/destructive-consent.mjs"));
const { captureInvocation } = await import(productModule("lib/ailoha/mobile-projection.mjs"));

const invocation = () => captureInvocation({
  scope: { sessionId: "consent-session", viewId: "consent-view" }, selectionGeneration: 1,
  device: { targetHostId: "host", targetId: "opaque/target", provider: "provider", nativeIdentity: {
    platform: "ios", nativeId: "native-target",
  } },
  context: { contextRef: "ctx-consent", scopeEpoch: "epoch", revision: "3", ownerProcessId: 1234 },
  contextOwner: { processId: 1234, processStartedAt: "2026-10-10T00:00:00.1234567+00:00" },
  connectionRef: {
    serviceId: "service", pid: 4321, startedAt: "2026-10-10T00:00:00Z", processStartedAt: "2026-10-09T23:59:59Z",
  },
});

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

test("the trusted form response requires explicit approval, not confirm or a truthy payload", () => {
  assert.equal(destructiveConsentResult({ action: "accept", content: { decision: "approve" } }), true);
  assert.equal(destructiveConsentResult({ action: "accept", content: { decision: "cancel" } }), false);
  assert.equal(destructiveConsentResult({ action: "decline" }), false);
  assert.equal(destructiveConsentResult({ action: "cancel" }), "cancel");
  for (const value of [true, { confirm: true }, { action: "accept", content: { decision: "approve", confirm: true } },
    { action: "accept", content: { decision: true } }]) {
    assert.throws(() => destructiveConsentResult(value), { code: "consent_response_invalid" });
  }
});

test("one private approval retains the original frozen incarnation and cannot be cloned or consumed twice", async (t) => {
  const owner = new AbortController();
  let request;
  const authority = new ScopedDestructiveConsent(async (captured) => { request = captured; return true; }, owner.signal);
  t.after(() => authority.dispose());
  const original = invocation();
  const approval = authority.begin("delete", original);
  await approval.approved;
  assert.equal(request.invocation, original);
  assert.equal(request.invocation.connectionRef, original.connectionRef);
  assert.equal(JSON.stringify(request).includes("connectionRef"), false);
  assert.match(request.message, /native-target/);
  assert.match(request.message, /ctx-consent/);
  assert.throws(() => approval.consume(structuredClone(original)), { code: "consent_capture_mismatch" });
  approval.consume(original);
  assert.throws(() => approval.consume(original), { code: "consent_already_consumed" });
});

for (const result of [false, "cancel"]) {
  test(`the actual prompt decision ${result} never becomes an approval`, async (t) => {
    const owner = new AbortController();
    const authority = new ScopedDestructiveConsent(async () => result, owner.signal);
    t.after(() => authority.dispose());
    const approval = authority.begin("erase", invocation());
    await assert.rejects(approval.approved, { code: result === false ? "consent_denied" : "consent_cancelled" });
    assert.equal(approval.signal.aborted, true);
  });
}

test("caller cancellation rejects promptly and a late user approval cannot revive the capture", async (t) => {
  const answer = deferred();
  const owner = new AbortController();
  const caller = new AbortController();
  const authority = new ScopedDestructiveConsent(() => answer.promise, owner.signal);
  t.after(() => authority.dispose());
  const approval = authority.begin("delete", invocation(), { signal: caller.signal });
  const rejected = assert.rejects(approval.approved, { code: "consent_cancelled" });
  caller.abort();
  await rejected;
  answer.resolve(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => approval.consume(approval.request.invocation), { code: "consent_cancelled" });
});

test("the original consent deadline expires the pending UI without waiting for its response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const owner = new AbortController();
  const answer = deferred();
  const authority = new ScopedDestructiveConsent(() => answer.promise, owner.signal);
  t.after(() => authority.dispose());
  const approval = authority.begin("erase", invocation());
  const rejected = assert.rejects(approval.approved, { code: "consent_timeout", status: 408 });
  t.mock.timers.tick(60_000);
  await rejected;
  answer.resolve(true);
  assert.throws(() => approval.consume(approval.request.invocation), { code: "consent_timeout" });
});

test("expiry also retires approval while a revalidation read is stalled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const owner = new AbortController();
  const authority = new ScopedDestructiveConsent(async () => true, owner.signal);
  t.after(() => authority.dispose());
  const approval = authority.begin("delete", invocation());
  await approval.approved;
  const read = deferred();
  const waiting = approval.run(() => read.promise);
  const rejected = assert.rejects(waiting, { code: "consent_timeout" });
  t.mock.timers.tick(60_000);
  await rejected;
  read.resolve("late output");
  assert.throws(() => approval.consume(approval.request.invocation), { code: "consent_timeout" });
});

test("the original whole budget expires a stalled consumed submission without replaying or reviving late output", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const owner = new AbortController();
  const captured = invocation();
  const authority = new ScopedDestructiveConsent(async () => true, owner.signal);
  t.after(() => authority.dispose());
  const approval = authority.begin("delete", captured);
  await approval.approved;
  const accepted = deferred();
  const submitted = approval.run(async () => {
    approval.consume(captured);
    return accepted.promise;
  });
  const rejected = assert.rejects(submitted, { code: "submission_outcome_unknown" });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(60_000);
  await rejected;
  assert.equal(approval.signal.aborted, true);
  accepted.resolve("accepted-original-operation");
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => approval.consume(captured), { code: "consent_already_consumed" });
});

for (const cancelledBy of ["caller", "owner"]) {
  test(`consumed approval preserves original ${cancelledBy} submission cancellation and cannot be spent again`, async (t) => {
    const owner = new AbortController();
    const caller = new AbortController();
    const captured = invocation();
    const authority = new ScopedDestructiveConsent(async () => true, owner.signal);
    t.after(() => authority.dispose());
    const approval = authority.begin("delete", captured, { signal: caller.signal });
    await approval.approved;
    approval.consume(captured);
    assert.equal(approval.signal.aborted, false);
    const beforeWire = approval.run(async () => {
      if (approval.signal.aborted) throw new Error("cancelled-before-wire");
      return "not-dispatched";
    });
    const rejected = assert.rejects(beforeWire, /cancelled|retired/);
    (cancelledBy === "caller" ? caller : owner).abort();
    assert.equal(approval.signal.aborted, true);
    await rejected;
    assert.throws(() => approval.consume(captured), { code: "consent_already_consumed" });
  });
}

test("run never executes revalidation or consume before the genuine human answer", async (t) => {
  const answer = deferred();
  const owner = new AbortController();
  const authority = new ScopedDestructiveConsent(() => answer.promise, owner.signal);
  t.after(() => authority.dispose());
  const captured = invocation();
  const approval = authority.begin("delete", captured);
  let calls = 0;
  const work = approval.run(async () => {
    calls += 1;
    approval.consume(captured);
    return "accepted";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  answer.resolve(true);
  assert.equal(await work, "accepted");
  assert.equal(calls, 1);
});

test("remaining submission ceilings use the original monotonic budget and never reset it", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const owner = new AbortController();
  const authority = new ScopedDestructiveConsent(async () => true, owner.signal);
  t.after(() => authority.dispose());
  const captured = invocation();
  const approval = authority.begin("delete", captured);
  await approval.approved;
  clock = 59_900;
  approval.consume(captured);
  assert.equal(approval.remainingTimeoutMs(30_000), 100);
  assert.equal(approval.remainingTimeoutMs(15_000), 100);
  assert.throws(() => approval.remainingTimeoutMs(0), { code: "consent_budget_invalid" });
  clock = 60_000;
  assert.throws(() => approval.remainingTimeoutMs(30_000), { code: "consent_timeout" });
  assert.equal(approval.signal.aborted, true);
  assert.throws(() => approval.submitted(), { code: "submission_outcome_unknown" });
});

test("cooperative accepted metadata after caller abort is captured within the original budget", async (t) => {
  const owner = new AbortController();
  const caller = new AbortController();
  const authority = new ScopedDestructiveConsent(async () => true, owner.signal);
  t.after(() => authority.dispose());
  const captured = invocation();
  const approval = authority.begin("delete", captured, { signal: caller.signal });
  let receipt;
  const entered = deferred();
  const work = approval.run(async () => {
    approval.consume(captured);
    entered.resolve();
    await new Promise((resolve) => approval.signal.addEventListener("abort", () => {
      setImmediate(() => setImmediate(resolve));
    }, { once: true }));
    receipt = { status: 202, operationId: "original-accepted-operation", invocation: captured };
    return receipt;
  });
  await entered.promise;
  caller.abort();
  await assert.rejects(work, { code: "consent_cancelled" });
  assert.equal(receipt.invocation, captured);
  assert.equal(approval.submissionResult.value.operationId, "original-accepted-operation");
  assert.equal(JSON.stringify(approval).includes("original-accepted-operation"), false);
  assert.throws(() => approval.consume(captured), { code: "consent_already_consumed" });
});

test("unsupported hosts and missing canonical evidence cannot collect destructive approval", () => {
  const owner = new AbortController();
  const unsupported = new ScopedDestructiveConsent(Object.assign(async () => true, { isSupported: () => false }), owner.signal);
  assert.throws(() => unsupported.begin("delete", invocation()), { code: "capability_not_supported" });
  unsupported.dispose();
  const authority = new ScopedDestructiveConsent(async () => true, new AbortController().signal);
  assert.throws(() => authority.begin("delete", {}), { code: "consent_context_unavailable" });
  authority.dispose();
});

function stagedArtifact(captured) {
  const sourcePath = "/owned/staged-package.apk";
  const receipt = "a".repeat(64);
  const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
  return {
    artifactId: "staged-artifact", sourcePath, receipt, size: 123, sha256: "b".repeat(64),
    proof: {
      targetHostId: captured.targetHostId, targetId: captured.targetId, providerId: captured.providerId,
      nativeTargetId: captured.nativeIdentity.nativeId, nativeTargetPlatform: captured.nativeIdentity.platform,
      contextRef: captured.executionContext.contextRef, scopeEpoch: captured.executionContext.scopeEpoch,
      revision: captured.executionContext.revision, hostInstanceId: "native-receipt-instance",
      ownerProcessId: captured.executionContext.ownerProcessId, ownerStartedAt: captured.contextOwner.processStartedAt,
      sourcePathHash: hash(sourcePath), packageName: "Owned test package", receiptHash: hash(receipt),
    },
  };
}

test("install approval binds the entire staged proof privately without exposing receipt or source path", async (t) => {
  const captured = invocation();
  const artifact = stagedArtifact(captured);
  const authority = new ScopedDestructiveConsent(async () => true, new AbortController().signal);
  t.after(() => authority.dispose());
  const approval = authority.begin("install", captured, { stagedArtifact: artifact });
  await approval.approved;
  assert.match(approval.request.message, /Owned test package/);
  assert.match(approval.request.message, /123 bytes/);
  assert.equal(JSON.stringify(approval.request).includes(artifact.sourcePath), false);
  assert.equal(JSON.stringify(approval.request).includes(artifact.receipt), false);
  assert.equal(Object.isFrozen(approval.request.stagedArtifact.proof), true);
  for (const field of ["artifactId", "sourcePath", "size", "sha256", "receipt"]) {
    const changed = structuredClone(artifact);
    changed[field] = field === "size" ? 456 : `${changed[field]}-changed`;
    assert.throws(() => approval.consume(captured, changed), { code: "consent_capture_mismatch" });
  }
  const changedProof = structuredClone(artifact);
  changedProof.proof.ownerStartedAt = "2026-10-10T00:00:01Z";
  assert.throws(() => approval.consume(captured, changedProof), { code: "consent_capture_mismatch" });
  approval.consume(captured, artifact);
});

test("unbound or mutated install proof cannot create a host prompt", () => {
  const captured = invocation();
  let prompts = 0;
  const authority = new ScopedDestructiveConsent(async () => { prompts += 1; return true; }, new AbortController().signal);
  for (const change of [
    (artifact) => { artifact.proof.contextRef = "ctx-other"; },
    (artifact) => { artifact.proof.nativeTargetId = "other-native"; },
    (artifact) => { artifact.sourcePath += "/changed"; },
    (artifact) => { artifact.receipt = "c".repeat(64); },
    (artifact) => { artifact.proof.ownerProcessId += 1; },
    (artifact) => { artifact.proof.ownerStartedAt = "2026-10-10T00:00:00.1234568+00:00"; },
  ]) {
    const artifact = stagedArtifact(captured);
    change(artifact);
    assert.throws(() => authority.begin("install", captured, { stagedArtifact: artifact }), { code: "consent_artifact_invalid" });
  }
  assert.equal(prompts, 0);
  authority.dispose();
});

test("install proof cannot invent a missing process birth or leak its canonical high-precision capture", async (t) => {
  const owner = new AbortController();
  let prompts = 0;
  const authority = new ScopedDestructiveConsent(async () => { prompts += 1; return true; }, owner.signal);
  t.after(() => authority.dispose());
  const captured = invocation();
  const artifact = stagedArtifact(captured);
  const missing = captureInvocation({
    scope: captured.scope, selectionGeneration: captured.selectionGeneration,
    device: {
      targetHostId: captured.targetHostId, targetId: captured.targetId, provider: captured.providerId,
      nativeIdentity: captured.nativeIdentity,
    },
    context: captured.executionContext, connectionRef: captured.connectionRef,
  });
  assert.throws(() => authority.begin("install", missing, { stagedArtifact: artifact }), { code: "consent_owner_unavailable" });
  assert.equal(prompts, 0);
  assert.equal(JSON.stringify(captured).includes("1234567"), false);
  assert.equal(Object.hasOwn(structuredClone(captured), "contextOwner"), false);
  const approval = authority.begin("install", captured, { stagedArtifact: artifact });
  await approval.approved;
  assert.equal(approval.request.stagedArtifact.proof.ownerStartedAt, "2026-10-10T00:00:00.1234567+00:00");
  approval.consume(captured, artifact);
  approval.submitted();
});

test("pending approvals are independently bounded without changing the64 operation receipt policy", async () => {
  const owner = new AbortController();
  const authority = new ScopedDestructiveConsent(() => new Promise(() => {}), owner.signal);
  const pending = Array.from({ length: 128 }, () => authority.begin("erase", invocation()));
  const results = Promise.allSettled(pending.map((approval) => approval.approved));
  assert.throws(() => authority.begin("erase", invocation()), { code: "consent_prompt_limit", status: 429 });
  authority.dispose();
  assert.equal((await results).every((result) => result.status === "rejected" && result.reason.code === "consent_cancelled"), true);
});

test("consumed output after the original monotonic deadline cannot beat a delayed timer", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const authority = new ScopedDestructiveConsent(async () => true, new AbortController().signal);
  t.after(() => authority.dispose());
  const captured = invocation();
  const approval = authority.begin("delete", captured);
  const attempt = approval.run(async () => {
    approval.consume(captured);
    clock = 60_001;
    return { operationId: "late-original-operation" };
  });
  await assert.rejects(attempt, { code: "submission_outcome_unknown" });
  assert.equal(approval.signal.aborted, true);
  assert.equal(approval.submissionResult.value.operationId, "late-original-operation");
  assert.equal(JSON.stringify(approval).includes("late-original-operation"), false);
});

test("direct submitted finalization cannot turn late or cancelled metadata into a valid approval", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const authority = new ScopedDestructiveConsent(async () => true, new AbortController().signal);
  t.after(() => authority.dispose());
  const captured = invocation();
  const approval = authority.begin("delete", captured);
  await approval.approved;
  approval.consume(captured);
  clock = 60_001;
  const metadata = { operationId: "late-direct-receipt" };
  assert.throws(() => approval.submitted(metadata), { code: "submission_outcome_unknown" });
  assert.equal(approval.signal.aborted, true);
  assert.equal(approval.submissionResult, metadata);
  assert.throws(() => approval.consume(captured), { code: "consent_already_consumed" });
});
