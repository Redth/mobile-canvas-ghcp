import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";

const { createFencedAppCli } = await import(productModule("lib/ailoha/fenced-apps.mjs"));
const { AilohaProtocolError } = await import(productModule("lib/ailoha/errors.mjs"));
const { captureInvocation } = await import(productModule("lib/ailoha/mobile-projection.mjs"));
const { createVerifiedAilohaCli } = await import(productModule("lib/ailoha/runtime-sdk.mjs"));
const { submitOperationReceipt, waitForOperationReceipt } = await import(
  productModule("lib/ailoha/operation-receipts.mjs"));

function original(platform = "android") {
  return captureInvocation({
    scope: { sessionId: "session", viewId: "view" }, selectionGeneration: 1,
    device: { targetHostId: "host", targetId: "target", provider: "provider",
      nativeIdentity: { platform, nativeId: "native-target" } },
    context: { contextRef: "ctx", scopeEpoch: "epoch", revision: "7", ownerProcessId: 321 },
    contextOwner: { processId: 321, processStartedAt: "2026-10-10T00:00:00.1234567Z" },
    connectionRef: {
      serviceId: "service", pid: 4321, startedAt: "2026-10-10T00:00:00Z",
      processStartedAt: "2026-10-09T23:59:59Z",
    },
  });
}

function captured(invocation, action = "app-op") {
  return {
    schema: "ailoha.target-app-action/v2", action, attemptId: "b".repeat(32),
    contextRef: "ctx", scopeEpoch: "epoch", revision: "7",
    ownerProcessId: 321, ownerStartedAt: invocation.contextOwner.processStartedAt,
    targetHostId: "host",
    stamp: {
      hostInstanceId: "native-host-incarnation", targetId: "target", providerId: "provider",
      registrationEpoch: "registration-epoch", receipt: "captured-host-stamp",
      nativeIdentity: {
        platform: invocation.nativeIdentity.platform, nativeId: "native-target",
        serial: "native-serial", provider: "canonical-provider", modelIdentifier: "native-model",
        osVersion: "26.0", isVirtual: true,
      },
    },
    appId: "native-app", packageId: "com.example.native", version: "1", buildNumber: "2",
    installationEvidence: "a".repeat(64),
    ...(action === "app-op" ? {
      appOpId: "SYSTEM_ALERT_WINDOW", currentMode: "deny", requestedMode: "allow", uidScoped: true,
    } : {}),
  };
}

function accepted(kind, result) {
  return {
    operationId: "accepted-op", kind, status: "queued", destructive: true,
    targetId: "target", providerId: "provider", createdAt: "2026-10-10T00:01:00Z",
    ...(result ? { result } : {}),
  };
}

test("canonical capture binds exact owner, native installation and UID-scope evidence privately", async () => {
  const invocation = original();
  const calls = [];
  const cli = createFencedAppCli({
    async runCli(args, options) {
      calls.push([args, options]);
      return JSON.stringify(captured(invocation));
    },
  });
  const proof = await cli.capture(invocation, {
    appId: "native-app", packageId: "com.example.native", version: "1", buildNumber: "2",
    operation: "SYSTEM_ALERT_WINDOW", mode: "allow",
  }, { timeoutMs: 30_000 });
  assert.equal(proof.currentMode, "deny");
  assert.equal(proof.uidScoped, true);
  assert.equal(proof.receipt.attemptId, "b".repeat(32));
  assert.equal(proof.receipt.stamp.hostInstanceId, "native-host-incarnation");
  assert.equal(Object.isFrozen(proof.receipt.stamp), true);
  assert.deepEqual(calls[0][0], [
    "target", "app", "action-capture", "target",
    "--app-id", "native-app", "--package-id", "com.example.native",
    "--app-op", "SYSTEM_ALERT_WINDOW", "--mode", "allow",
    "--context", "ctx", "--context-epoch", "epoch", "--context-revision", "7", "--json",
  ]);
  assert.equal(JSON.stringify(calls[0][0]).includes("processStartedAt"), false);
});

test("native version strings are preserved within the bounded receipt without invented field limits", async () => {
  const invocation = original();
  const version = "v".repeat(350);
  const buildNumber = "b".repeat(350);
  const value = captured(invocation, "uninstall");
  value.version = version;
  value.buildNumber = buildNumber;
  const cli = createFencedAppCli({ async runCli() { return JSON.stringify(value); } });
  assert.equal((await cli.capture(invocation, {
    appId: value.appId, packageId: value.packageId, version, buildNumber,
  }, { timeoutMs: 30_000 })).receipt.version, version);
});

test("v2 capture requires a unique-form attempt ID and bounds the exact UTF-8 receipt bytes", async () => {
  const invocation = original();
  const request = (value) => ({
    appId: value.appId, packageId: value.packageId, version: value.version, buildNumber: value.buildNumber,
  });
  const cli = (value) => createFencedAppCli({ async runCli() { return JSON.stringify(value); } });
  for (const attemptId of [undefined, "B".repeat(32), "a".repeat(31), "g".repeat(32)]) {
    const value = captured(invocation, "uninstall");
    if (attemptId === undefined) delete value.attemptId;
    else value.attemptId = attemptId;
    await assert.rejects(cli(value).capture(invocation, request(value)), { code: "app_action_capture_mismatch" });
  }
  const value = captured(invocation, "uninstall");
  value.version = "";
  const remaining = 64 * 1024 - Buffer.byteLength(JSON.stringify(value), "utf8");
  value.version = "x".repeat(remaining);
  assert.equal(Buffer.byteLength(JSON.stringify(value), "utf8"), 64 * 1024);
  assert.equal((await cli(value).capture(invocation, request(value))).receipt.version, value.version);
  value.version += "x";
  await assert.rejects(cli(value).capture(invocation, request(value)), { code: "app_action_capture_mismatch" });
  value.version = "é".repeat(Math.floor(remaining / 2) + 1);
  assert.ok(JSON.stringify(value).length < 64 * 1024);
  await assert.rejects(cli(value).capture(invocation, request(value)), { code: "app_action_capture_mismatch" });
});

test("uninstall and setter submit only the original native receipt through the verified CLI", async () => {
  const invocation = original();
  const calls = [];
  const cli = createFencedAppCli({
    async runCli(args, options) {
      calls.push([args, options]);
      return JSON.stringify(args[2] === "uninstall-fenced"
        ? accepted("uninstallFencedTargetApp")
        : accepted("updateFencedTargetAppOp"));
    },
  });
  const receipt = captured(invocation);
  const options = { timeoutMs: 15_000, signal: new AbortController().signal };
  assert.equal((await cli.uninstall(invocation, receipt, options)).operationId, "accepted-op");
  assert.equal((await cli.setAppOp(invocation, receipt, options)).kind, "updateFencedTargetAppOp");
  for (const [args, forwarded] of calls) {
    assert.equal(args[4], JSON.stringify(receipt));
    assert.deepEqual(args.slice(5), [
      "--context", "ctx", "--context-epoch", "epoch", "--context-revision", "7", "--confirm", "--json",
    ]);
    assert.equal(forwarded, options);
  }
});

test("canonical accepted IDs remain opaque across Unicode and long ASCII values", async () => {
  const invocation = original();
  for (const operationId of ["café", "a".repeat(700)]) {
    const cli = createFencedAppCli({
      async runCli() {
        return JSON.stringify({ ...accepted("uninstallFencedTargetApp"), operationId });
      },
    });
    assert.equal((await cli.uninstall(invocation, captured(invocation, "uninstall"))).operationId, operationId);
  }
});

test("typed known-ID native errors surface first, then recover by original-host GET only", async () => {
  const invocation = original();
  const pin = { version: "synthetic", sourceSha: "a".repeat(40) };
  for (const [type, code, operationId] of [
    ["AppActionAcceptedMismatch", "app_action_accepted_mismatch", "café"],
    ["AppActionAttemptAlreadySubmitted", "app_action_attempt_already_submitted", "a".repeat(700)],
    ["AppActionAcceptedRecordUnavailable", "app_action_accepted_record_unavailable", "record-id"],
    ["AppActionDeliveryUnknown", "app_action_delivery_unknown", "location-id"],
  ]) {
    let launches = 0;
    const script = `process.stderr.write(${JSON.stringify(JSON.stringify({
      error: "private native diagnostic", type, retryable: false, operationId,
    }))}); process.exitCode = 1;`;
    const cli = createFencedAppCli({ runCli: createVerifiedAilohaCli({
      pin, sdk: { async getVerifiedCliLaunch() {
        launches++;
        return { file: process.execPath, args: ["-e", script], ...pin };
      } },
    }) });
    const state = new Map();
    const key = `known-${type}`;
    const submit = () => submitOperationReceipt({
      state, key, kind: "uninstallFencedTargetApp", invocation, requireCurrent() {},
      submit: () => cli.uninstall(invocation, captured(invocation, "uninstall"), { timeoutMs: 10_000 }),
    });
    const receipt = submit();
    await assert.rejects(receipt.submitted, (error) => {
      assert.equal(error.code, code);
      assert.equal(error.operationId, operationId);
      assert.equal(JSON.stringify(error).includes("private native"), false);
      return true;
    });
    assert.equal(receipt.operationId, operationId);
    assert.equal(submit(), receipt);
    const reads = [];
    const completed = await waitForOperationReceipt({
      state, key, receipt, outcome: "app_action",
      client: { async waitForOperation(id) {
        reads.push(id);
        return { ...accepted("uninstallFencedTargetApp"), operationId: id, status: "succeeded" };
      } },
    });
    assert.equal(completed.operationId, operationId);
    assert.deepEqual(reads, [operationId]);
    assert.equal(launches, 1);
  }
});

test("accepted operation owner mismatch keeps its ID without claiming success or replaying", async () => {
  const invocation = original();
  let calls = 0;
  const cli = createFencedAppCli({ async runCli() {
    calls++;
    return JSON.stringify({ ...accepted("uninstallFencedTargetApp"), targetId: "foreign-target" });
  } });
  const state = new Map();
  const submit = () => submitOperationReceipt({
    state, key: "foreign-accepted", kind: "uninstallFencedTargetApp", invocation, requireCurrent() {},
    submit: () => cli.uninstall(invocation, captured(invocation, "uninstall")),
  });
  const receipt = submit();
  await assert.rejects(receipt.submitted, {
    code: "app_action_owner_mismatch", operationId: "accepted-op",
  });
  assert.equal(receipt.operationId, "accepted-op");
  assert.equal(submit(), receipt);
  assert.equal(calls, 1);
});

test("native attempt and delivery errors without an ID retain uncertainty and cannot submit again", async () => {
  const invocation = original();
  const pin = { version: "synthetic", sourceSha: "a".repeat(40) };
  for (const [type, code] of [
    ["AppActionDeliveryUnknown", "app_action_delivery_unknown"],
    ["AppActionAttemptAlreadySubmitted", "app_action_attempt_already_submitted"],
    ["AppActionAcceptedRecordUnavailable", "app_action_accepted_record_unavailable"],
    ["AppActionAcceptedMismatch", "app_action_accepted_mismatch"],
  ]) {
    let launches = 0;
    const script = `process.stderr.write(${JSON.stringify(JSON.stringify({
      error: "private native diagnostic", type, retryable: false,
    }))}); process.exitCode = 1;`;
    const cli = createFencedAppCli({ runCli: createVerifiedAilohaCli({
      pin, sdk: { async getVerifiedCliLaunch() {
        launches++;
        return { file: process.execPath, args: ["-e", script], ...pin };
      } },
    }) });
    const state = new Map();
    const key = `unknown-${type}`;
    const submit = () => submitOperationReceipt({
      state, key, kind: "uninstallFencedTargetApp", invocation, requireCurrent() {},
      submit: () => cli.uninstall(invocation, captured(invocation, "uninstall"), { timeoutMs: 10_000 }),
    });
    const receipt = submit();
    await assert.rejects(receipt.submitted, { code });
    assert.equal(receipt.operationId, null);
    assert.equal(receipt.uncertain, true);
    assert.equal(submit(), receipt);
    await assert.rejects(waitForOperationReceipt({
      state, key, receipt, outcome: "app_action",
      client: { async waitForOperation() { throw Error("Unknown operation was polled."); } },
    }), { code: "app_action_outcome_uncertain" });
    assert.equal(launches, 1);
  }
});

test("malformed claimed native operation IDs do not become definitive rejections or accepted receipts", async () => {
  const pin = { version: "synthetic", sourceSha: "a".repeat(40) };
  const script = `process.stderr.write(JSON.stringify({
    error: "private native diagnostic", type: "AppActionRejected",
    retryable: false, operationId: "invalid\\nidentifier",
  })); process.exitCode = 1;`;
  const runCli = createVerifiedAilohaCli({
    pin, sdk: { async getVerifiedCliLaunch() {
      return { file: process.execPath, args: ["-e", script], ...pin };
    } },
  });
  await assert.rejects(runCli(["target", "app", "uninstall-fenced"]), (error) => {
    assert.equal(error.code, "app_action_invalid_response");
    assert.equal(Object.hasOwn(error, "operationId"), false);
    assert.equal(JSON.stringify(error).includes("private native"), false);
    return true;
  });
});

test("capture rejects owner, incarnation, installation and UID-proof substitution before approval", async () => {
  const invocation = original();
  const request = {
    appId: "native-app", packageId: "com.example.native", version: "1", buildNumber: "2",
    operation: "SYSTEM_ALERT_WINDOW", mode: "allow",
  };
  for (const change of [
    (value) => { value.ownerStartedAt = "2026-10-10T00:00:00Z"; },
    (value) => { value.stamp.nativeIdentity.nativeId = "replacement"; },
    (value) => { value.appId = "replacement"; },
    (value) => { value.installationEvidence = null; },
    (value) => { value.uidScoped = null; },
    (value) => { value.currentMode = "unknown"; },
  ]) {
    const value = captured(invocation);
    change(value);
    const cli = createFencedAppCli({ async runCli() { return JSON.stringify(value); } });
    await assert.rejects(cli.capture(invocation, request, { timeoutMs: 30_000 }), {
      code: "app_action_capture_mismatch",
    });
  }
});

test("setter exposes only complete matching authoritative effective readback", () => {
  const invocation = original();
  const cli = createFencedAppCli({ async runCli() { throw Error("No CLI calls expected."); } });
  const proof = {
    appId: "native-app", operation: "SYSTEM_ALERT_WINDOW", requestedMode: "allow",
  };
  assert.deepEqual(cli.readback({
    result: { appId: "native-app", appOpId: "SYSTEM_ALERT_WINDOW", mode: "allow", uidScoped: true },
  }, proof), {
    appId: "native-app", appOpId: "SYSTEM_ALERT_WINDOW", mode: "allow", uidScoped: true,
  });
  for (const result of [
    { appId: "different", appOpId: "SYSTEM_ALERT_WINDOW", mode: "allow", uidScoped: true },
    { appId: "native-app", appOpId: "SYSTEM_ALERT_WINDOW", mode: "allow" },
  ]) {
    assert.throws(() => cli.readback({ result }, proof), { code: "app_action_readback_invalid" });
  }
  assert.equal(invocation.contextOwner.processStartedAt, "2026-10-10T00:00:00.1234567Z");
});

test("verified CLI retains accepted native operation metadata even when its child exits nonzero", async () => {
  const pin = { version: "synthetic", sourceSha: "a".repeat(40) };
  const script = `process.stdout.write(JSON.stringify(${JSON.stringify(accepted("uninstallFencedTargetApp"))})); process.exitCode = 1;`;
  const runCli = createVerifiedAilohaCli({
    pin, sdk: { async getVerifiedCliLaunch() {
      return { file: process.execPath, args: ["-e", script], ...pin };
    } },
  });

  test("typed native CLI rejections are definitive while delivery-unknown errors remain non-replayable", async () => {
    const pin = { version: "synthetic", sourceSha: "a".repeat(40) };
    for (const [type, code, status] of [
      ["AppActionRejected", "app_action_rejected", 409],
      ["AppActionStale", "app_action_stale", 409],
      ["ContextRevisionConflict", "context_snapshot_superseded", 409],
      ["ContextBindingMismatch", "context_snapshot_superseded", 409],
      ["unsupported-capability", "capability_not_supported", 501],
      ["AppActionDeliveryUnknown", "app_action_delivery_unknown", 502],
      ["AppActionAcceptedMismatch", "app_action_accepted_mismatch", 409],
      ["AppActionAttemptAlreadySubmitted", "app_action_attempt_already_submitted", 409],
      ["AppActionAcceptedRecordUnavailable", "app_action_accepted_record_unavailable", 502],
    ]) {
      const script = `process.stderr.write(${JSON.stringify(JSON.stringify({
        error: "private native path and credential", type, retryable: false,
      }))}); process.exitCode = 1;`;
      const runCli = createVerifiedAilohaCli({
        pin, sdk: { async getVerifiedCliLaunch() {
          return { file: process.execPath, args: ["-e", script], ...pin };
        } },
      });
      await assert.rejects(runCli(["target", "app", "uninstall-fenced"], { timeoutMs: 10_000 }), (error) => {
        assert.equal(error.code, code);
        assert.equal(error.status, status);
        assert.equal(Object.hasOwn(error, "operationId"), false);
        assert.equal(JSON.stringify(error).includes("private native path"), false);
        return true;
      });
    }
    const runCli = createVerifiedAilohaCli({
      pin, sdk: { async getVerifiedCliLaunch() {
        const script = `process.stderr.write(JSON.stringify({
          error: "private path", type: "AppActionRejected", retryable: true,
        })); process.exitCode = 1;`;
        return {
          file: process.execPath, args: ["-e", script], ...pin,
        };
      } },
    });
    await assert.rejects(runCli(["target", "app", "uninstall-fenced"], { timeoutMs: 10_000 }), {
      code: "ailoha_cli_failed",
    });
  });

  test("accepted CLI metadata cannot assign another target or provider to the captured action", async () => {
    const invocation = original();
    const receipt = captured(invocation, "uninstall");
    for (const mismatch of [
      { targetId: "other-target" },
      { providerId: "other-provider" },
      { kind: "uninstallTargetApp" },
    ]) {
      const value = { ...accepted("uninstallFencedTargetApp"), ...mismatch };
      const cli = createFencedAppCli({
        async runCli() {
          throw new AilohaProtocolError("transport_error", {
            status: 202, operationId: value.operationId, operation: value,
          });
        },
      });
      await assert.rejects(cli.uninstall(invocation, receipt, { timeoutMs: 10_000 }), (error) => {
        assert.equal(error.code, "app_action_owner_mismatch");
        assert.equal(error.operationId, value.operationId);
        return true;
      });
    }
  });
  await assert.rejects(runCli(["target", "app", "uninstall-fenced"], { timeoutMs: 10_000 }), (error) => {
    assert.equal(error.status, 202);
    assert.equal(error.operationId, "accepted-op");
    assert.equal(error.operation.kind, "uninstallFencedTargetApp");
    return true;
  });
});
