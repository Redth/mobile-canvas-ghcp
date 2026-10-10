import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const required = (args, flag) => {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing synthetic ${flag}`);
  return args[index + 1];
};

export function runFencedAppCli(args) {
  const path = process.env.AILOHA_TEST_CONTEXT_STATE;
  if (!path) throw new Error("Synthetic fenced app commands require an isolated context file.");
  const contexts = JSON.parse(readFileSync(path, "utf8"));
  const context = contexts.find((entry) => entry.contextRef === required(args, "--context"));
  if (!context || context.state !== "open"
    || context.scopeEpoch !== required(args, "--context-epoch")
    || context.revision !== required(args, "--context-revision")) {
    process.stderr.write(JSON.stringify({ type: "ContextRevisionConflict" }));
    return 1;
  }
  const targetId = "opaque/target";
  const appId = "synthetic/app%id";
  const packageId = "com.example.native";
  const platform = process.env.AILOHA_TEST_APP_PLATFORM ?? "ios";
  const nativeId = "native-deployment-not-opaque-target";
  const installationEvidence = hash(`${platform}:synthetic-installation-uid-and-path`);
  const stamp = {
    hostInstanceId: "synthetic-host-instance", targetId, providerId: "synthetic-provider",
    registrationEpoch: "synthetic-registration-epoch",
    nativeIdentity: { platform, nativeId, isVirtual: true },
    receipt: hash("synthetic-host-incarnation:target:provider:native-installation"),
  };
  if (args[2] === "action-capture") {
    if (args[3] !== targetId || required(args, "--app-id") !== appId
      || required(args, "--package-id") !== packageId
      || context.selection?.targetHostId !== "synthetic-host" || context.selection.targetId !== targetId) {
      process.stderr.write(JSON.stringify({ type: "ContextSelectionMismatch" }));
      return 1;
    }
    const appOpId = args.includes("--app-op") ? required(args, "--app-op") : undefined;
    const receipt = {
      schema: "ailoha.target-app-action/v1", action: appOpId ? "app-op" : "uninstall",
      contextRef: context.contextRef, scopeEpoch: context.scopeEpoch, revision: context.revision,
      ownerProcessId: context.owner.processId, ownerStartedAt: context.owner.processStartedAt,
      targetHostId: "synthetic-host", stamp, appId, packageId, version: "1", buildNumber: "2",
      installationEvidence,
      ...(appOpId ? {
        appOpId, currentMode: "default", requestedMode: required(args, "--mode"), uidScoped: true,
      } : {}),
    };
    process.stdout.write(JSON.stringify(receipt));
    return 0;
  }
  if (!["uninstall-fenced", "set-app-op-fenced"].includes(args[2]) || !args.includes("--confirm")) {
    throw new Error("Unsupported synthetic fenced app action.");
  }
  const receipt = JSON.parse(required(args, "--receipt"));
  if (receipt.contextRef !== context.contextRef || receipt.scopeEpoch !== context.scopeEpoch
    || receipt.revision !== context.revision || receipt.ownerProcessId !== context.owner.processId
    || receipt.ownerStartedAt !== context.owner.processStartedAt
    || receipt.targetHostId !== "synthetic-host" || receipt.appId !== appId || receipt.packageId !== packageId
    || receipt.installationEvidence !== installationEvidence
    || JSON.stringify(receipt.stamp) !== JSON.stringify(stamp)) {
    process.stderr.write(JSON.stringify({ type: "FencedAppActionRejected" }));
    return 1;
  }
  const operationId = `synthetic-fenced-${randomUUID()}`;
  const operation = {
    operationId, kind: args[2] === "uninstall-fenced" ? "uninstallFencedTargetApp" : "updateFencedTargetAppOp",
    targetId, providerId: "synthetic-provider", status: "queued", destructive: true,
    createdAt: "2026-10-10T00:01:00Z",
  };
  const completed = {
    ...operation, status: "succeeded", startedAt: "2026-10-10T00:01:01Z", completedAt: "2026-10-10T00:01:02Z",
    ...(args[2] === "set-app-op-fenced" ? { result: {
      appId, appOpId: receipt.appOpId, mode: receipt.requestedMode, uidScoped: true,
      "x-ailoha-target-host": { targetId, providerId: "synthetic-provider" },
    } } : {}),
  };
  const recordPath = `${path}.fenced`;
  let operations;
  try { operations = JSON.parse(readFileSync(recordPath, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    operations = [];
  }
  operations.push(completed);
  writeFileSync(recordPath, JSON.stringify(operations));
  process.stdout.write(JSON.stringify(operation));
  return process.env.AILOHA_TEST_FENCED_ACCEPTED_NONZERO === "1" ? 1 : 0;
}
