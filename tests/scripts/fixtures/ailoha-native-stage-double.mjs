import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const ticks = (value) => (BigInt(Date.parse(value)) + 62135596800000n) * 10000n;
const journal = () => readFileSync(process.env.AILOHA_TEST_STAGE_JOURNAL, "utf8")
  .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

export function stageEvents() {
  try { return journal(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

export function runNativeStage(args, contexts) {
  const value = (flag) => args[args.indexOf(flag) + 1];
  const context = contexts.find((entry) => entry.contextRef === value("--context"));
  if (!context || context.state !== "open" || context.scopeEpoch !== value("--context-epoch")
    || context.revision !== value("--context-revision")
    || context.selection?.targetId !== "opaque/target"
    || value("--target-host") !== "synthetic-host") throw new Error("Staging lost its original selected view.");
  const action = args[args.indexOf("native-stage") + 1];
  const earlier = stageEvents();
  let receipt;
  if (action === "stage") {
    const sources = JSON.parse(value("--sources"));
    const kind = value("--kind");
    const destination = value("--destination");
    if (!Array.isArray(sources) || !sources.length || !sources.every((source) => resolve(source) === source)) {
      throw new Error("Synthetic stage requires owned absolute source files.");
    }
    const host = {
      serviceId: "synthetic-service", pid: 12345,
      startedAt: "2026-10-09T23:00:00Z", processStartedAt: "2026-10-09T22:59:59Z",
    };
    const hostInstanceId = `host-${hash(`${host.serviceId}\0${host.pid}\0${ticks(host.startedAt)}\0${ticks(host.processStartedAt)}`)}`;
    const stageId = hash(`${context.contextRef}\0${earlier.length}\0${sources.join("\0")}`).slice(0, 32);
    receipt = {
      kind, destination, expectedArtifactCount: sources.length,
      artifacts: sources.map((source, slot) => {
        const bytes = readFileSync(source);
        const proof = {
          targetHostId: "synthetic-host", targetId: "opaque/target", providerId: "synthetic-provider",
          nativeTargetId: "native-deployment-not-opaque-target", nativeTargetPlatform: "ios",
          hostInstanceId, sourcePathHash: hash(source), destination,
          contextRef: context.contextRef, scopeEpoch: context.scopeEpoch, revision: context.revision,
          ownerProcessId: context.owner.processId, ownerStartedAt: context.owner.processStartedAt,
          stageId, expectedArtifactCount: sources.length, stageSlot: slot,
        };
        return {
          artifact: {
            artifactId: `owned-stage-${stageId}-${slot}`, kind, status: "ready",
            contentType: "application/octet-stream", createdAt: "2026-10-10T00:00:00Z",
            fileName: basename(source), size: statSync(source).size, sha256: hash(bytes),
            targetId: "opaque/target", metadata: { ...proof },
          },
          proof,
        };
      }),
    };
    appendFileSync(process.env.AILOHA_TEST_STAGE_JOURNAL, `${JSON.stringify({ action, sources, receipt })}\n`);
    return { status: "ready", receipt };
  }
  receipt = JSON.parse(value("--staged"));
  const staged = earlier.find((entry) => entry.action === "stage"
    && JSON.stringify(entry.receipt) === JSON.stringify(receipt));
  if (!staged) throw new Error("The original host did not stage this exact receipt.");
  if (action === "confirm") {
    appendFileSync(process.env.AILOHA_TEST_STAGE_JOURNAL, `${JSON.stringify({ action, receipt })}\n`);
    return { status: "ready", receipt };
  }
  if (action === "continue") {
    if (earlier.some((entry) => entry.action === "continue"
      && JSON.stringify(entry.receipt) === JSON.stringify(receipt))) {
      throw new Error("Duplicate device POST on the same original staging receipt.");
    }
    if (!args.includes("--confirm") || (receipt.kind === "file") !== args.includes("--overwrite")) {
      throw new Error("The native dispatch lacks its exact confirmed operation.");
    }
    const attemptId = hash(`attempt:${receipt.artifacts[0].proof.stageId}`).slice(0, 32);
    const operationId = `owned-import-${receipt.artifacts[0].proof.stageId}`;
    const operation = {
      operationId, kind: receipt.kind === "file" ? "importStagedTargetFile" : "importStagedTargetMediaBatch",
      status: "queued", destructive: true, targetId: "opaque/target", providerId: "synthetic-provider",
      createdAt: "2026-10-10T00:00:00Z",
      artifactIds: receipt.artifacts.map((entry) => entry.artifact.artifactId),
    };
    const uncertain = process.env.AILOHA_TEST_STAGE_UNCERTAIN === "1";
    appendFileSync(process.env.AILOHA_TEST_STAGE_JOURNAL,
      `${JSON.stringify({ action, receipt, operation, uncertain })}\n`);
    return uncertain
      ? { status: "acceptanceUnknown", receipt, attemptId, errorCode: "DeviceAcceptanceUnknown" }
      : { status: "accepted", receipt, attemptId, operation };
  }
  if (action !== "cleanup" || !args.includes("--confirm")) throw new Error("Unexpected native stage action.");
  const cleanupArtifacts = receipt.artifacts.map((entry, index) => {
    const operation = {
      operationId: `owned-cleanup-${receipt.artifacts[0].proof.stageId}-${index}`,
      kind: "deleteArtifact", status: "succeeded", destructive: true,
      targetId: "opaque/target", providerId: "synthetic-provider",
      createdAt: "2026-10-10T00:00:00Z", artifactIds: [entry.artifact.artifactId],
    };
    return { artifactId: entry.artifact.artifactId, status: "cleaned",
      attemptId: hash(operation.operationId).slice(0, 32), operationId: operation.operationId, operation };
  });
  const last = cleanupArtifacts.at(-1);
  appendFileSync(process.env.AILOHA_TEST_STAGE_JOURNAL, `${JSON.stringify({ action, receipt })}\n`);
  return { status: "cleaned", receipt, attemptId: last.attemptId,
    operation: last.operation, cleanupArtifacts };
}
