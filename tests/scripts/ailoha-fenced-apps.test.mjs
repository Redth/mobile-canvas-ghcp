import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";

const { createFencedAppCli } = await import(productModule("lib/ailoha/fenced-apps.mjs"));
const { AilohaProtocolError } = await import(productModule("lib/ailoha/errors.mjs"));
const { captureInvocation } = await import(productModule("lib/ailoha/mobile-projection.mjs"));
const { createVerifiedAilohaCli } = await import(productModule("lib/ailoha/runtime-sdk.mjs"));

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
    schema: "ailoha.target-app-action/v1", action,
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
      await assert.rejects(cli.uninstall(invocation, receipt, { timeoutMs: 10_000 }), {
        code: "app_action_owner_mismatch",
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
