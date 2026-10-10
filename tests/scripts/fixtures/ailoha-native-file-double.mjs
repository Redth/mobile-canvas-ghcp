import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const ticks = (value) => (BigInt(Date.parse(value)) + 62135596800000n) * 10000n;
const journalPath = () => process.env.AILOHA_TEST_GUARDED_JOURNAL;

export function guardedEvents() {
  try {
    return readFileSync(journalPath(), "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function runNativeFile(args, contexts) {
  const value = (flag) => args[args.indexOf(flag) + 1];
  const action = args[args.indexOf("native-file") + 1];
  const context = contexts.find((entry) => entry.contextRef === value("--context"));
  if (!context || value("--target-host") !== "synthetic-host"
    || context.scopeEpoch !== value("--context-epoch")) {
    throw new Error("The synthetic native file command lost the original context and host.");
  }
  const events = guardedEvents();
  let receipt;
  if (action === "prepare") {
    if (context.state !== "open" || context.revision !== value("--context-revision")
      || context.selection?.targetId !== "opaque/target") {
      throw new Error("The original selected view cannot prepare a file operation.");
    }
    const connection = {
      serviceId: "synthetic-service", pid: 12345,
      startedAt: "2026-10-09T23:00:00Z", processStartedAt: "2026-10-09T22:59:59Z",
    };
    const hostInstanceId = `host-${hash(`${connection.serviceId}\0${connection.pid}\0${ticks(connection.startedAt)}\0${ticks(connection.processStartedAt)}`)}`;
    const kind = value("--kind");
    const path = value("--path");
    let destinationPath = null;
    if (kind === "export") {
      const requested = value("--destination");
      if (!isAbsolute(requested)) throw new Error("Native export needs an absolute host destination.");
      destinationPath = existsSync(requested) && statSync(requested).isDirectory()
        ? join(requested, basename(path.replace(/\/+$/, ""))) : requested;
      if (!process.env.AILOHA_TEST_GUARDED_ROOT
        || !destinationPath.startsWith(`${process.env.AILOHA_TEST_GUARDED_ROOT}${sep}`)) {
        throw new Error("Synthetic export cannot write outside the isolated installed-host fixture.");
      }
    }
    receipt = {
      kind, path, targetHostId: "synthetic-host",
      attemptId: hash(`guarded:${context.contextRef}:${events.length}:${path}`).slice(0, 32),
      owner: {
        hostInstanceId, targetId: "opaque/target", providerId: "synthetic-provider",
        registrationEpoch: "01234567-89ab-cdef-0123-456789abcdef",
        nativeIdentity: { platform: "ios", nativeId: "native-deployment-not-opaque-target", isVirtual: true },
      },
      contextRef: context.contextRef, scopeEpoch: context.scopeEpoch, revision: context.revision,
      ownerProcessId: context.owner.processId, ownerStartedAt: context.owner.processStartedAt,
      appId: null, recursive: args.includes("--recursive"),
      destinationPath,
      overwrite: args.includes("--overwrite"), maximumBytes: Number(value("--maximum-bytes")),
    };
    appendFileSync(journalPath(), `${JSON.stringify({ action, receipt })}\n`);
    return { status: "prepared", receipt };
  }
  receipt = JSON.parse(value("--guarded"));
  if (!events.some((event) => event.action === "prepare"
    && JSON.stringify(event.receipt) === JSON.stringify(receipt))) {
    throw new Error("The original synthetic host did not prepare this exact receipt.");
  }
  const prior = events.filter((event) => event.action === "continue"
    && JSON.stringify(event.receipt) === JSON.stringify(receipt));
  if (action === "continue") {
    if (!args.includes("--confirm") || prior.length) {
      throw new Error("The synthetic file operation cannot post twice or proceed without confirmation.");
    }
  } else if (action !== "recover" || prior.length !== 1) {
    throw new Error("Only an original accepted device attempt can be recovered.");
  }
  const operation = {
    operationId: `guarded-${receipt.attemptId}`, requestId: receipt.attemptId,
    kind: receipt.kind === "export" ? "exportTargetFile"
      : receipt.kind === "delete" ? "deleteTargetFileWithOptions" : "createTargetDirectory",
    targetId: receipt.owner.targetId, providerId: receipt.owner.providerId,
    destructive: receipt.kind === "delete", createdAt: "2026-10-10T00:00:00Z",
    status: action === "continue" ? "queued" : "succeeded",
  };
  if (receipt.kind === "export") {
    const bytes = receipt.path.endsWith("/empty") ? Buffer.alloc(0) : Buffer.from("abcde");
    const artifactId = `artifact-${receipt.attemptId}`;
    operation.artifactIds = [artifactId];
    if (action === "recover") {
      operation.result = { artifactId, devicePath: receipt.path.startsWith("app://")
        ? receipt.path.split("/").slice(3).join("/") : receipt.path };
      const earlierReads = events.filter((event) => event.action === "recover"
        && JSON.stringify(event.receipt) === JSON.stringify(receipt));
      if (earlierReads.length) {
        const actual = readFileSync(receipt.destinationPath);
        if (hash(actual) !== hash(bytes)) {
          appendFileSync(journalPath(), `${JSON.stringify({ action, receipt, operation, contentGet: false })}\n`);
          return { status: "readbackUnconfirmed", receipt, operationId: operation.operationId,
            operation, errorCode: "GuardedDestinationChanged" };
        }
      } else {
        mkdirSync(dirname(receipt.destinationPath), { recursive: true });
        writeFileSync(receipt.destinationPath, bytes);
      }
      appendFileSync(journalPath(), `${JSON.stringify({
        action, receipt, operation, contentGet: earlierReads.length === 0, downloadedBytes: bytes.length,
      })}\n`);
      if (!earlierReads.length && process.env.AILOHA_TEST_GUARDED_LOST_REPLY === "1") {
        throw new Error("Synthetic native output was committed before the reply was lost.");
      }
      return { status: "downloaded", receipt, operationId: operation.operationId, operation,
        downloadedBytes: bytes.length, devicePath: operation.result.devicePath,
        artifact: {
          artifactId, kind: "file", status: "ready",
          contentType: "application/octet-stream", createdAt: operation.createdAt,
          targetId: receipt.owner.targetId, operationId: operation.operationId,
          fileName: basename(receipt.path), size: bytes.length, sha256: hash(bytes),
        } };
    }
  }
  if (action === "recover") operation.result = { path: receipt.path };
  appendFileSync(journalPath(), `${JSON.stringify({ action, receipt, operation })}\n`);
  return { status: action === "continue" ? "accepted" : "succeeded",
    receipt, operationId: operation.operationId, operation,
    ...(action === "recover" ? { mutation: { path: receipt.path } } : {}) };
}
