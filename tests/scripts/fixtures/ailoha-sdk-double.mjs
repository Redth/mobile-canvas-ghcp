import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const scenario = {
  calls: [], leases: new Map(), videos: new Map(), operations: new Map(), status: "running", geometryRevision: 13,
  targets: new Map(), providerId: "synthetic-provider", nativeId: "native-deployment-not-opaque-target",
  connectionRef: {
    schema: "ailoha.target-host.connection/v1", serviceId: "synthetic-service", pid: 12345,
    startedAt: "2026-10-09T23:00:00Z", processStartedAt: "2026-10-09T22:59:59Z",
  },
};
export const sourceSha = "0000000000000000000000000000000000000000";
const targetId = "opaque/target";
const surfaceId = "opaque/surface";
const packetRoot = new URL("../../web/fixtures/ailoha-baseline/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("manifest.json", packetRoot), "utf8"));
const captures = [
  { id: "target.lifecycle", version: 1, features: ["listTargets", "getTarget", "getTargetCapabilities", "startTarget", "stopTarget", "rebootTarget", "resetTarget", "deleteTarget"] },
  { id: "target.surfaces", version: 1, features: ["listTargetSurfaces", "getTargetSurface"] },
  { id: "surface.capture", version: 1, features: ["captureTargetScreenshot", "createLiveVideoSession", "getLiveVideoSession", "stopLiveVideoSession"] },
  { id: "surface.input", version: 1, features: ["tapTargetElement", "performTargetGesture"] },
];
const surface = {
  surfaceId, kind: "display", bounds: { x: 0, y: 0, width: 48, height: 32 },
  geometryRevision: 13, pixelDensity: 2, orientation: "landscape",
  capabilities: [{ id: "surface.input", version: 1, features: ["tap.point", "long-press.point", "gesture", "swipe.point"] }],
};
function target() {
  return {
    targetId, providerId: scenario.providerId, targetTypeId: "opaque/type", name: "Synthetic device",
    status: scenario.status, surfaces: scenario.status === "running" ? [{ ...surface, geometryRevision: scenario.geometryRevision }] : [],
    nativeIdentity: { platform: "ios", nativeId: scenario.nativeId, isVirtual: true },
  };
}
const reply = (body, status = 200, location = null) => ({
  status, contentType: "application/json", body, location, retryAfterMs: status === 202 ? 1000 : null,
});

export async function getRuntimePin({ expectedVersion }) {
  return Object.freeze({ version: expectedVersion, rid: "synthetic", sourceSha, manifestSha512: "synthetic-only" });
}
export async function getVerifiedCliLaunch({ expectedVersion }) {
  return {
    file: process.execPath,
    args: [fileURLToPath(new URL("./ailoha-context-double.mjs", import.meta.url))],
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
      scenario.calls.push({ path, method: options.method ?? "GET", body: options.body });
      if (closed) throw new Error("closed double");
      if (options.signal?.aborted) throw new Error("aborted double");
      if (path === "/api/v1/host/status") return reply({
        hostId: "synthetic-host", profile: "ailoha.target-host/v1", version: "synthetic",
        state: "ready", capabilities: captures,
      });
      if (path === "/api/v1/providers") return reply([{
        providerId: scenario.providerId, name: "Synthetic provider", version: "synthetic", state: "ready", capabilities: captures,
      }]);
      if (path === "/api/v1/targets") return reply(scenario.targets.size ? [...scenario.targets.values()] : scenario.deleted ? [] : [target()]);
      const targetPath = /^\/api\/v1\/targets\/([^/]+)$/.exec(path);
      if (targetPath) {
        const id = decodeURIComponent(targetPath[1]);
        const record = scenario.targets.get(id) ?? (id === targetId ? target() : undefined);
        if (!record || (id === targetId && scenario.deleted)) return reply({ status: 404, title: "Synthetic target not found" }, 404);
        if (options.method === "DELETE") {
          const operationId = randomUUID();
          const operation = {
            operationId, kind: "deleteTarget", targetId: id, providerId: record.providerId,
            status: "queued", destructive: true, createdAt: "2026-10-09T23:00:00Z",
          };
          scenario.targets.delete(id);
          if (id === targetId) scenario.deleted = true;
          scenario.operations.set(operationId, { ...operation, status: "succeeded", startedAt: "2026-10-09T23:00:01Z", completedAt: "2026-10-09T23:00:02Z" });
          return reply(operation, 202, `/api/v1/operations/${operationId}`);
        }
        if (scenario.beforeTargetRead) await scenario.beforeTargetRead(id);
        return reply(record);
      }
      if (path.endsWith("/capabilities")) return reply(captures);
      if (path.endsWith("/surfaces")) return reply([{ ...surface, geometryRevision: scenario.geometryRevision }]);
      if (/\/actions\/(start|stop|reboot|reset)$/.test(path)) {
        const action = path.split("/").at(-1);
        const id = decodeURIComponent(path.split("/").at(-3));
        const record = scenario.targets.get(id);
        const operationId = randomUUID();
        const status = action === "stop" || action === "reset" ? "stopped" : "running";
        if (record) record.status = status;
        else scenario.status = status;
        const operation = {
          operationId, kind: `${action}Target`, targetId: id, providerId: scenario.providerId,
          status: "queued", destructive: action === "reset", createdAt: "2026-10-09T23:00:00Z",
        };
        scenario.operations.set(operationId, {
          ...operation, status: "succeeded", startedAt: "2026-10-09T23:00:01Z", completedAt: "2026-10-09T23:00:02Z",
        });
        return reply(operation, 202, `/api/v1/operations/${operationId}`);
      }
      if (path.startsWith("/api/v1/operations/")) return scenario.operationUnavailable
        ? reply({ status: 503, title: "Synthetic operation observation unavailable" }, 503)
        : reply(scenario.operations.get(decodeURIComponent(path.split("/").at(-1))));
      if (path.endsWith("/screenshots")) {
        const image = readFileSync(new URL("reference-1.png", packetRoot));
        return reply({
          artifactId: "synthetic/screenshot", kind: "screenshot", status: "ready", contentType: "image/png",
          targetId, surfaceId, createdAt: "2026-10-09T23:00:00Z", size: image.length,
        }, 201, "/api/v1/artifacts/synthetic%2Fscreenshot");
      }
      if (path.includes("/input/actions/")) return reply({
        success: true, "x-ailoha-target-host": { targetId, surfaceId, geometryRevision: scenario.geometryRevision },
      });
      const collection = "/api/v1/targets/opaque%2Ftarget/surfaces/opaque%2Fsurface/video/sessions";
      if (path === collection && options.method === "POST") {
        scenario.geometryRevision = 13;
        const videoSessionId = randomUUID();
        const session = {
          videoSessionId, targetId, surfaceId, codec: "h264", state: "ready",
          createdAt: "2026-10-09T23:00:00Z", geometryRevision: 13, source: "synthetic-fixture",
          websocketUrl: `/ws/v1/targets/opaque%2Ftarget/surfaces/opaque%2Fsurface/video/${videoSessionId}`,
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
        bytes: new Uint8Array(readFileSync(new URL("reference-1.png", packetRoot))),
      };
    },
    async websocket(path, callbacks) {
      scenario.calls.push({ websocket: path });
      let next = 0;
      let active = true;
      const videoSessionId = path.split("/").at(-1);
      function text(control) { callbacks.onMessage(new TextEncoder().encode(JSON.stringify(control)), false); }
      function sendNext() {
        if (!active || next >= fixture.units.length) return;
        const unit = fixture.units[next++];
        if (unit.sequence === 0 || unit.sequence === 3) {
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
            text({ type: "ready", videoSessionId, codec: "h264", geometryRevision: 13, resumeFromSequence: 0, maxInFlightFrames: 1 });
            sendNext();
          } else if (control.type === "ack") sendNext();
        },
        async close() { active = false; scenario.calls.push({ socketClosed: path }); callbacks.onClose?.(1000, ""); },
      });
    },
    async close() { closed = true; },
  });
  registerRuntimeCleanup(leaseId, () => transport.close());
  return transport;
}
