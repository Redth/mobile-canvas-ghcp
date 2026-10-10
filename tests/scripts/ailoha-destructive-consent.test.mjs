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

test("consumed approval can finish its original accepted submission inside run without extending or replaying authority", async (t) => {
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
  await Promise.resolve();
  t.mock.timers.tick(60_000);
  accepted.resolve("accepted-original-operation");
  assert.equal(await submitted, "accepted-original-operation");
  assert.throws(() => approval.requireCurrent(), { code: "consent_already_consumed" });
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
      ownerProcessId: captured.executionContext.ownerProcessId, ownerStartedAt: "2026-10-10T00:00:00Z",
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
  const authority = new ScopedDestructiveConsent(async () => true, new AbortController().signal);
  for (const change of [
    (artifact) => { artifact.proof.contextRef = "ctx-other"; },
    (artifact) => { artifact.proof.nativeTargetId = "other-native"; },
    (artifact) => { artifact.sourcePath += "/changed"; },
    (artifact) => { artifact.receipt = "c".repeat(64); },
  ]) {
    const artifact = stagedArtifact(captured);
    change(artifact);
    assert.throws(() => authority.begin("install", captured, { stagedArtifact: artifact }), { code: "consent_artifact_invalid" });
  }
  authority.dispose();
});

test("pending approvals are independently bounded without changing the64 operation receipt policy", async () => {
  const owner = new AbortController();
  const authority = new ScopedDestructiveConsent(() => new Promise(() => {}), owner.signal);
  const pending = Array.from({ length: 128 }, () => authority.begin("erase", invocation()));
  const results = Promise.allSettled(pending.map((approval) => approval.approved));
  assert.throws(() => authority.begin("erase", invocation()), { code: "consent_prompt_limit", status: 429 });
  authority.dispose();
  assert.equal((await results).every((result) => result.status === "rejected" && result.reason.code === "view_closed"), true);
});
