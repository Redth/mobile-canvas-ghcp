import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createCatalogModel } from "./ailoha-catalog-creation.mjs";
import { stageEvents } from "./ailoha-native-stage-double.mjs";

export const scenario = {
  calls: [], leases: new Map(), videos: new Map(), operations: new Map(), status: "running", geometryRevision: 13,
  catalog: null, createdTargets: new Map(), creationGate: null,
  targets: new Map(), providerId: "synthetic-provider", nativeId: "native-deployment-not-opaque-target",
  connectionRef: {
    schema: "ailoha.target-host.connection/v1", serviceId: "synthetic-service", pid: 12345,
    startedAt: "2026-10-09T23:00:00Z", processStartedAt: "2026-10-09T22:59:59Z",
  },
};
export const sourceSha = "0000000000000000000000000000000000000000";
const targetId = "opaque/target";
const surfaceId = "opaque/surface";
const fixtureName = process.env.AILOHA_TEST_VIDEO_FIXTURE ?? "baseline";
if (!["baseline", "bframes"].includes(fixtureName)) throw new Error("The owned video fixture must be baseline or bframes.");
const packetRoot = new URL(`../../web/fixtures/ailoha-${fixtureName}/`, import.meta.url);
const imageRoot = new URL("../../web/fixtures/ailoha-baseline/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("manifest.json", packetRoot), "utf8"));
const pacingMs = Number(process.env.AILOHA_TEST_VIDEO_PACING_MS ?? 0);
if (!Number.isSafeInteger(pacingMs) || pacingMs < 0 || pacingMs > 1000) throw new Error("Invalid owned video fixture pacing.");
const initialGeometryRevision = fixture.geometry[0].geometryRevision;
scenario.geometryRevision = initialGeometryRevision;
const captures = [
  { id: "target.lifecycle", version: 1, features: ["listTargets", "getTarget", "getTargetCapabilities", "startTarget", "stopTarget", "rebootTarget", "resetTarget", "deleteTarget"] },
  { id: "target.surfaces", version: 1, features: ["listTargetSurfaces", "getTargetSurface"] },
  { id: "surface.capture", version: 1, features: ["captureTargetScreenshot", "createLiveVideoSession", "getLiveVideoSession", "stopLiveVideoSession"] },
  { id: "surface.input", version: 1, features: ["tapTargetElement", "performTargetGesture"] },
];
const surface = {
  surfaceId, kind: "display", bounds: { x: 0, y: 0, width: 48, height: 32 },
  geometryRevision: initialGeometryRevision, pixelDensity: 2, orientation: "landscape",
  capabilities: [{ id: "surface.input", version: 1, features: ["tap.point", "long-press.point", "gesture", "swipe.point"] }],
};
export function enableCatalogCreation() {
  scenario.catalog = createCatalogModel();
  scenario.catalog.status.hostId = "synthetic-host";
  for (const entry of scenario.catalog.providerCatalogs) entry.targetHostId = "synthetic-host";
  return scenario.catalog;
}
function mergedCapabilities(values) {
  const groups = new Map();
  for (const capability of values) {
    const previous = groups.get(capability.id);
    groups.set(capability.id, {
      ...capability, features: [...new Set([...(previous?.features ?? []), ...(capability.features ?? [])])],
    });
  }
  return [...groups.values()];
}
function providerRecords() {
  const readCapabilities = scenario.artifactReads ? [
    { id: "target.files", version: 1, features: ["queryTargetFiles"] },
    { id: "target.diagnostics", version: 1,
      features: ["queryTargetLogs", "queryTargetCrashes", "getTargetCrashDetail"] },
    { id: "target.apps", version: 1, features: ["listTargetApps"] },
  ] : [];
  if (scenario.artifactStaging) readCapabilities.push(
    { id: "target.files", version: 1, features: ["importStagedTargetFile"] },
    { id: "target.media", version: 1, features: ["importStagedTargetMediaBatch"] },
  );
  return [{
    providerId: scenario.providerId, name: "Synthetic provider", version: "synthetic", state: "ready",
    capabilities: [...captures, ...readCapabilities],
  }, ...(scenario.catalog?.providers ?? []).map((provider) => ({
    ...provider, capabilities: mergedCapabilities([...provider.capabilities, ...captures]),
  }))];
}
function target() {
  return {
    targetId, providerId: scenario.providerId, targetTypeId: "opaque/type", name: "Synthetic device",
    status: scenario.status, surfaces: scenario.status === "running" ? [{ ...surface, geometryRevision: scenario.geometryRevision }] : [],
    nativeIdentity: { platform: "ios", nativeId: scenario.nativeId, isVirtual: true },
  };
}
function createdTarget(id) {
  const record = scenario.createdTargets.get(id);
  return record ? {
    ...record, surfaces: record.status === "running" ? [{ ...surface, geometryRevision: scenario.geometryRevision }] : [],
  } : undefined;
}
const reply = (body, status = 200, location = null) => ({
  status, contentType: "application/json", body, location, retryAfterMs: status === 202 ? 1000 : null,
});

export async function getRuntimePin({ expectedVersion }) {
  return Object.freeze({ version: expectedVersion, rid: "synthetic", sourceSha, manifestSha512: "synthetic-only" });
}
export async function getVerifiedCliLaunch({ expectedVersion }) {
  if (scenario.beforeCliLaunch) await scenario.beforeCliLaunch();
  return {
    file: process.execPath,
    args: [
      fileURLToPath(new URL("./ailoha-context-double.mjs", import.meta.url)),
      ...(scenario.combinedInspection ? ["--fixture-state", process.env.AILOHA_TEST_CONTEXT_STATE] : []),
    ],
    version: expectedVersion, sourceSha,
  };
}
export async function ensureTargetHost(options) {
  scenario.calls.push({ ensure: structuredClone(options) });
  if (scenario.ensureFailureCode) {
    const error = new Error("synthetic private runtime diagnostic");
    Object.assign(error, { name: "RuntimeDeliveryError", code: scenario.ensureFailureCode });
    throw error;
  }
  const leaseId = randomUUID();
  scenario.leases.set(leaseId, []);
  return {
    leaseId,
    targetHost: { targetHostId: "synthetic-host", profile: "ailoha.target-host/v1", protocolVersion: "1" },
    connectionRef: scenario.connectionRef,
  };
}
export function registerRuntimeCleanup(leaseId, callback) {
  const callbacks = scenario.leases.get(leaseId);
  callbacks.push(callback);
  return () => {
    const index = callbacks.indexOf(callback);
    if (index >= 0) callbacks.splice(index, 1);
  };
}
export async function releaseRuntimeLease(leaseId) {
  const callbacks = scenario.leases.get(leaseId);
  for (const callback of [...(callbacks ?? [])].reverse()) await callback();
  scenario.leases.delete(leaseId);
  scenario.calls.push({ release: leaseId });
  return Object.freeze({ schema: "ailoha.runtime.release-result/v1", leaseId, alreadyReleased: !callbacks, hostDisposition: "retained" });
}
export async function openTargetHostTransport(leaseId) {
  let closed = false;
  const transport = Object.freeze({
    get closed() { return closed; },
    async response(path, options = {}) {
      const body = options.body === undefined || typeof options.body === "string"
        ? options.body : Buffer.from(options.body).toString("utf8");
      if (scenario.beforeMutationAdmission && (path.endsWith("/actions/reset")
        || (options.method === "DELETE" && /^\/api\/v1\/targets\/[^/]+$/.test(path)))) {
        await scenario.beforeMutationAdmission(path, options);
      }
      if (closed) throw new Error("closed double");
      if (options.signal?.aborted) {
        throw Object.assign(new Error("synthetic queued transport aborted"), { name: "TargetHostTransportError", code: "cancelled" });
      }
      scenario.calls.push({ path, method: options.method ?? "GET", body });
      if (path === "/api/v1/host/status") return reply({
        hostId: "synthetic-host", profile: "ailoha.target-host/v1", version: "synthetic",
        state: "ready", capabilities: mergedCapabilities([...captures, ...(scenario.catalog?.status.capabilities ?? [])]),
      });
      if (path === "/api/v1/providers") {
        if (scenario.beforeCatalogRead) await scenario.beforeCatalogRead(path, options);
        return reply(providerRecords());
      }
      const catalogRoute = /^\/api\/v1\/providers\/([^/]+)\/(catalogs|runtimes|target-types|templates)$/.exec(path);
      if (catalogRoute) {
        if (scenario.beforeCatalogRead) await scenario.beforeCatalogRead(path, options);
        const entry = scenario.catalog?.providerCatalogs.find((entry) => entry.providerId === decodeURIComponent(catalogRoute[1]));
        if (!entry) throw new Error("Unadvertised synthetic catalog");
        return reply(entry[catalogRoute[2] === "target-types" ? "targetTypes" : catalogRoute[2]]);
      }
      if (path === "/api/v1/targets" && options.method === "POST") {
        if (!scenario.catalog) throw new Error("Synthetic creation is disabled");
        if (scenario.creationSubmissionStatus !== undefined) {
          return reply({
            type: "about:blank", title: "Owned creation submission failure", status: scenario.creationSubmissionStatus,
          }, scenario.creationSubmissionStatus);
        }
        const input = JSON.parse(body);
        const provider = scenario.catalog.providerCatalogs.find((entry) => entry.providerId === input.providerId);
        const type = provider?.targetTypes.find((entry) => entry.targetTypeId === input.targetTypeId);
        if (!type) throw new Error("Unknown exact synthetic provider/type");
        const number = scenario.createdTargets.size + 1;
        const createdId = `created/opaque-${number}%2F`;
        const record = {
          targetId: createdId, providerId: input.providerId, targetTypeId: input.targetTypeId, name: input.name,
          ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
          ...(input.templateId ? { templateId: input.templateId } : {}),
          status: input.start === false ? "stopped" : scenario.creationTargetStatus ?? "running", surfaces: [],
          nativeIdentity: {
            platform: type.platform, nativeId: type.platform === "ios" ? `owned-udid-${number}` : `owned_avd_${number}`,
            ...(type.platform === "android" ? { serial: `emulator-${5600 + number}` } : {}),
            isVirtual: true,
          },
        };
        scenario.createdTargets.set(createdId, record);
        const operationId = `creation/operation-${number}%2F`;
        const operation = {
          operationId, kind: "createTarget", providerId: input.providerId, destructive: true, status: "queued",
          createdAt: "2026-10-10T03:00:00Z",
        };
        scenario.operations.set(operationId, {
          ...operation, status: "succeeded", targetId: createdId, result: { targetId: createdId },
          startedAt: "2026-10-10T03:00:01Z", completedAt: "2026-10-10T03:00:02Z",
        });
        if (scenario.creationAcceptance === "unknown") return reply({}, 202);
        return reply(operation, 202, `/api/v1/operations/${encodeURIComponent(operationId)}`);
      }
      if (path === "/api/v1/targets") return reply([
        ...(scenario.targets.size ? [...scenario.targets.values()] : scenario.deleted ? [] : [target()]),
        ...[...scenario.createdTargets.keys()].map(createdTarget),
      ]);
      const targetRoute = /^\/api\/v1\/targets\/([^/]+)(?:\/(capabilities|surfaces))?$/.exec(path);
      const selectedId = targetRoute ? decodeURIComponent(targetRoute[1]) : undefined;
      const selected = scenario.targets.get(selectedId)
        ?? (selectedId === targetId && !scenario.deleted ? target() : createdTarget(selectedId));
      if (targetRoute) {
        if (!selected) return reply({ status: 404, title: "Synthetic target not found" }, 404);
        if (targetRoute[2] === "capabilities") return reply(providerRecords().find((provider) => provider.providerId === selected.providerId).capabilities);
        if (targetRoute[2] === "surfaces") return reply(selected.surfaces);
        if (options.method === "DELETE") {
          const operationId = randomUUID();
          const operation = {
            operationId, kind: "deleteTarget", targetId: selectedId, providerId: selected.providerId,
            status: "queued", destructive: true, createdAt: "2026-10-09T23:00:00Z",
          };
          scenario.targets.delete(selectedId);
          scenario.createdTargets.delete(selectedId);
          if (selectedId === targetId) scenario.deleted = true;
          scenario.operations.set(operationId, { ...operation, status: "succeeded", startedAt: "2026-10-09T23:00:01Z", completedAt: "2026-10-09T23:00:02Z" });
          return reply(operation, 202, `/api/v1/operations/${operationId}`);
        }
        if (scenario.beforeTargetRead) await scenario.beforeTargetRead(selectedId);
        return reply(selected);
      }
      if (scenario.artifactReads) {
        const prefix = `/api/v1/targets/${encodeURIComponent(targetId)}`;
        const owner = { "x-ailoha-target-host": { targetId, providerId: scenario.providerId } };
        if (path === `${prefix}/apps?includeSystem=true`) {
          return reply([{ appId: "native-app", packageId: "com.example.app", ...owner }]);
        }
        if (path.startsWith(`${prefix}/files/listing?`)) {
          const nativePath = new URL(path, "http://localhost").searchParams.get("path");
          return reply({
            path: nativePath, nativePath: "/Documents", total: 1,
            files: [{ name: "empty.db", path: `${nativePath}/empty.db`, nativePath: "/Documents/empty.db",
              type: "file", size: 0, ...owner }],
          });
        }
        if (path.startsWith(`${prefix}/logs/query?`)) return reply({
          total: 2, entries: [
            { nativeTimestamp: "first", nativeLevel: "verbose", nativeSource: "process",
              source: "native", message: "first", ...owner },
            { nativeTimestamp: "second", nativeLevel: "fatal", nativeSource: "process",
              source: "native", message: "second", ...owner },
          ],
        });
        if (path.startsWith(`${prefix}/crashes/query?`)) return reply({
          total: 2, crashes: [{ crashId: "report", nativeName: "App",
            nativeTimestamp: "native clock", nativeKind: "crash", ...owner }],
        });
        if (path === `${prefix}/crashes/report/detail`) return reply({
          crashId: "report", nativeName: "App", nativeTimestamp: "native clock",
          nativeKind: "crash", content: "full stack", ...owner,
        });
      }
      if (/\/actions\/(start|stop|reboot|reset)$/.test(path)) {
        const action = path.split("/").at(-1);
        const id = decodeURIComponent(path.split("/").at(-3));
        const record = scenario.targets.get(id) ?? scenario.createdTargets.get(id);
        const operationId = randomUUID();
        const status = action === "stop" || action === "reset" ? "stopped" : "running";
        if (record) record.status = status;
        else scenario.status = status;
        const operation = {
          operationId, kind: `${action}Target`, targetId: id, providerId: record?.providerId ?? scenario.providerId,
          status: "queued", destructive: action === "reset", createdAt: "2026-10-09T23:00:00Z",
        };
        scenario.operations.set(operationId, {
          ...operation, status: "succeeded", startedAt: "2026-10-09T23:00:01Z", completedAt: "2026-10-09T23:00:02Z",
        });
        return reply(operation, 202, `/api/v1/operations/${operationId}`);
      }
      if (path.startsWith("/api/v1/operations/")) {
        const stage = scenario.artifactStaging && stageEvents().find((event) =>
          event.action === "continue" && `/api/v1/operations/${encodeURIComponent(event.operation.operationId)}` === path);
        if (stage) {
          if (scenario.failStageOperationReadOnce) {
            scenario.failStageOperationReadOnce = false;
            throw new Error("Owned operation GET interrupted");
          }
          return reply({
            ...stage.operation, status: "succeeded", completedAt: "2026-10-10T00:00:02Z",
            result: stage.receipt.kind === "file" ? { size: stage.receipt.artifacts[0].artifact.size }
              : { addedArtifactIds: stage.operation.artifactIds },
          });
        }
        if (scenario.beforeOperationRead) await scenario.beforeOperationRead(path, options);
        if (scenario.operationUnavailable) return reply({ status: 503, title: "Synthetic operation observation unavailable" }, 503);
        const id = decodeURIComponent(path.split("/").at(-1));
        if (id.startsWith("creation/") && scenario.creationPollFailure) {
          throw new Error("Owned synthetic operation read failed before completion.");
        }
        if (id.startsWith("creation/") && scenario.creationGate) await scenario.creationGate.promise;
        return reply(scenario.operations.get(id));
      }
      const surfaceRoute = /^\/api\/v1\/targets\/([^/]+)\/surfaces\/([^/]+)\/(.+)$/.exec(path);
      const mediaTargetId = surfaceRoute ? decodeURIComponent(surfaceRoute[1]) : targetId;
      const mediaSurfaceId = surfaceRoute ? decodeURIComponent(surfaceRoute[2]) : surfaceId;
      if (path.endsWith("/screenshots")) {
        const image = readFileSync(new URL("reference-1.png", imageRoot));
        return reply({
          artifactId: "synthetic/screenshot", kind: "screenshot", status: "ready", contentType: "image/png",
          targetId: mediaTargetId, surfaceId: mediaSurfaceId, createdAt: "2026-10-09T23:00:00Z", size: image.length,
        }, 201, "/api/v1/artifacts/synthetic%2Fscreenshot");
      }
      if (path.includes("/input/actions/")) return reply({
        success: true, "x-ailoha-target-host": { targetId: mediaTargetId, surfaceId: mediaSurfaceId, geometryRevision: scenario.geometryRevision },
      });
      const collection = `/api/v1/targets/${encodeURIComponent(mediaTargetId)}/surfaces/${encodeURIComponent(mediaSurfaceId)}/video/sessions`;
      if (path === collection && options.method === "POST") {
        scenario.geometryRevision = initialGeometryRevision;
        const videoSessionId = randomUUID();
        const session = {
          videoSessionId, targetId: mediaTargetId, surfaceId: mediaSurfaceId, codec: "h264", state: "ready",
          createdAt: "2026-10-09T23:00:00Z", geometryRevision: initialGeometryRevision, source: "synthetic-fixture",
          websocketUrl: `/ws/v1/targets/${encodeURIComponent(mediaTargetId)}/surfaces/${encodeURIComponent(mediaSurfaceId)}/video/${videoSessionId}`,
        };
        scenario.videos.set(videoSessionId, session);
        return reply(session, 201, `${collection}/${videoSessionId}`);
      }
      if (path.startsWith(`${collection}/`)) {
        const videoSessionId = path.split("/").at(-1);
        if (options.method === "DELETE") {
          scenario.videos.delete(videoSessionId);
          const operationId = `stop-video-${videoSessionId}`;
          const operation = {
            operationId, kind: "stopLiveVideoSession", status: "succeeded", destructive: false,
            createdAt: "2026-10-09T23:00:00Z", startedAt: "2026-10-09T23:00:01Z",
          };
          scenario.operations.set(operationId, operation);
          return reply(operation, 202, `/api/v1/operations/${operationId}`);
        }
        return reply(scenario.videos.get(videoSessionId));
      }
      throw new Error(`Unexpected synthetic route ${path}`);
    },
    async json(path, options) { return (await transport.response(path, options)).body; },
    async bytes(path) {
      scenario.calls.push({ bytes: path });
      return {
        status: 200, location: null, contentType: "image/png", retryAfterMs: null,
        bytes: new Uint8Array(readFileSync(new URL("reference-1.png", imageRoot))),
      };
    },
    async websocket(path, callbacks) {
      scenario.calls.push({ websocket: path });
      let next = 0;
      let active = true;
      let nextTimer;
      const videoSessionId = path.split("/").at(-1);
      function text(control) { callbacks.onMessage(new TextEncoder().encode(JSON.stringify(control)), false); }
      function sendNext() {
        if (!active || next >= fixture.units.length) return;
        const unit = fixture.units[next++];
        if (unit.sequence === 0 || unit.geometryRevision !== scenario.geometryRevision) {
          scenario.geometryRevision = unit.geometryRevision;
          text({ type: "geometryChanged", ...fixture.geometry.find((geometry) => geometry.geometryRevision === unit.geometryRevision) });
        }
        callbacks.onMessage(new Uint8Array(readFileSync(new URL(unit.filename, packetRoot))), true);
      }
      return Object.freeze({
        get readyState() { return active ? 1 : 3; },
        send(data) {
          if (!active) throw new Error("closed socket double");
          const control = JSON.parse(data);
          scenario.calls.push({ control });
          if (control.type === "hello") {
            text({ type: "ready", videoSessionId, codec: "h264", geometryRevision: initialGeometryRevision, resumeFromSequence: 0, maxInFlightFrames: 1 });
            sendNext();
          } else if (control.type === "ack") {
            if (pacingMs && next < fixture.units.length) nextTimer = setTimeout(sendNext, pacingMs);
            else sendNext();
          }
        },
        async close() {
          active = false;
          clearTimeout(nextTimer);
          scenario.calls.push({ socketClosed: path });
          callbacks.onClose?.(1000, "");
        },
      });
    },
    async close() { closed = true; },
  });
  registerRuntimeCleanup(leaseId, () => transport.close());
  return transport;
}
