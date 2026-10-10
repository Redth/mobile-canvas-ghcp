import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { productModule } from "../ailoha-test-module.mjs";

const { createStagedAppCli, localAppPackage } = await import(productModule("lib/ailoha/staged-apps.mjs"));
const { createVerifiedAilohaCli } = await import(productModule("lib/ailoha/runtime-sdk.mjs"));
const invocation = {
  targetHostId: "host", targetId: "target", providerId: "provider",
  nativeIdentity: { platform: "ios", nativeId: "native" },
  executionContext: {
    contextRef: "ctx-owned", scopeEpoch: "epoch", revision: "7",
    ownerProcessId: 1234, processStartedAt: "2026-10-10T00:00:00Z",
  },
};

function stage(sourcePath) {
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  return {
    artifactId: "artifact", sourcePath, receipt: "a".repeat(64), size: 5, sha256: "b".repeat(64),
    proof: {
      targetHostId: "host", targetId: "target", providerId: "provider",
      nativeTargetId: "native", nativeTargetPlatform: "ios",
      contextRef: "ctx-owned", scopeEpoch: "epoch", revision: "7",
      hostInstanceId: "incarnation", ownerProcessId: 1234,
      ownerStartedAt: "2026-10-10T00:00:00Z",
      sourcePathHash: hash(sourcePath), receiptHash: hash("a".repeat(64)),
      packageName: basename(sourcePath) + (sourcePath.endsWith(".app") ? ".zip" : ""),
    },
  };
}

function accepted(kind, targetId = "target") {
  return {
    operationId: `operation-${kind}`, kind, status: "queued", destructive: true,
    targetId, providerId: "provider", createdAt: "2026-10-10T00:00:00Z",
  };
}

test("native staged CLI uses literal host path and original named authority; no package buffering", async () => {
  const sourcePath = "/host/a space \u2603.apk";
  const calls = [];
  const cli = createStagedAppCli({ async runCli(args) {
    calls.push(args);
    return JSON.stringify(calls.length === 1 ? stage(sourcePath)
      : calls.length === 2 ? accepted("installTargetApp") : accepted("deleteArtifact"));
  } });
  const receipt = await cli.stage(invocation, sourcePath);
  assert.deepEqual(calls[0], ["target", "app", "stage", "target", "--package", sourcePath,
    "--target-host", "host", "--context", "ctx-owned", "--context-epoch", "epoch",
    "--context-revision", "7", "--json"]);
  assert.equal((await cli.install(invocation, receipt)).operationId, "operation-installTargetApp");
  assert.deepEqual(calls[1], ["target", "app", "install-staged", "--staged", JSON.stringify(receipt),
    "--context", "ctx-owned", "--context-epoch", "epoch", "--context-revision", "7", "--confirm", "--json"]);
  assert.equal((await cli.cleanup(invocation, receipt)).operationId, "operation-deleteArtifact");
  assert.deepEqual(calls[2], ["target", "app", "stage-cleanup", "--staged", JSON.stringify(receipt),
    "--context", "ctx-owned", "--context-epoch", "epoch", "--confirm", "--json"]);
});

test("staged receipt and accepted operation cannot substitute host, provider, native target or revision", async () => {
  const sourcePath = "/host/app.apk";
  for (const changed of [
    { sourcePath: "/another/app.apk" },
    { proof: { ...stage(sourcePath).proof, providerId: "replacement" } },
    { proof: { ...stage(sourcePath).proof, revision: "8" } },
    { proof: { ...stage(sourcePath).proof, nativeTargetId: "replacement" } },
  ]) {
    const cli = createStagedAppCli({ async runCli() { return JSON.stringify({ ...stage(sourcePath), ...changed }); } });
    await assert.rejects(cli.stage(invocation, sourcePath), { code: "stage_owner_mismatch" });
  }
  const cli = createStagedAppCli({ async runCli(args) {
    return JSON.stringify(args[2] === "stage" ? stage(sourcePath) : accepted("installTargetApp", "replacement"));
  } });
  await assert.rejects(cli.install(invocation, await cli.stage(invocation, sourcePath)), {
    code: "operation_owner_mismatch",
  });
});

test("host package topology rejects links, directories and unreadable/missing files before CLI", async (t) => {
  const directory = await mkdtemp(join(process.cwd(), ".mobile-stage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const apk = join(directory, "app.apk");
  await writeFile(apk, "local fixture");
  const bundle = join(directory, "bundle.app");
  await mkdir(bundle);
  const link = join(directory, "linked.apk");
  await symlink(apk, link);
  const unsupported = join(directory, "unrecognised.txt");
  await writeFile(unsupported, "local fixture");
  assert.equal(await localAppPackage(apk), apk);
  assert.equal(await localAppPackage(bundle), bundle);
  await assert.rejects(localAppPackage(link), { code: "invalid_package" });
  await assert.rejects(localAppPackage(directory), { code: "invalid_package" });
  await assert.rejects(localAppPackage(join(directory, "missing.apk")), { code: "package_unreadable" });
  await assert.rejects(localAppPackage(unsupported), { code: "invalid_package" });
  await assert.rejects(localAppPackage(""), { code: "invalid_request" });
});

test("verified native CLI maps definitive rejection without leaking private paths or retrying unknown delivery", async () => {
  const pin = { version: "reviewed-source", sourceSha: "c8caabd589d8c008adac33107846bc322632977a" };
  for (const [type, code] of [
    ["InstallRejected", "install_rejected"],
    ["InstallDeliveryUnknown", "install_delivery_unknown"],
  ]) {
    const sdk = { async getVerifiedCliLaunch() {
      return { ...pin, file: process.execPath, args: ["-e",
        `process.stderr.write(JSON.stringify({type:"${type}",error:"PRIVATE /secret/app.apk"}));process.exit(1)`] };
    } };
    const run = createVerifiedAilohaCli({ sdk, pin });
    await assert.rejects(run(["target", "app", "install-staged", "--json"]), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message.includes("/secret/"), false);
      return true;
    });
  }
});
