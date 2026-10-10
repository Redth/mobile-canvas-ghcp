import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createCatalogModel } from "./ailoha-catalog-creation.mjs";

export const scenario = {
  calls: [], leases: new Map(), videos: new Map(), operations: new Map(), status: "running", geometryRevision: 13,
  catalog: null, createdTargets: new Map(), creationGate: null,
  featureAppearance: "light",
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
  { id: "target.lifecycle", version: 1, features: ["listTargets", "getTarget", "getTargetCapabilities", "startTarget", "stopTarget", "rebootTarget"] },
  { id: "target.surfaces", version: 1, features: ["listTargetSurfaces", "getTargetSurface"] },
  { id: "surface.capture", version: 1, features: ["captureTargetScreenshot", "createLiveVideoSession", "getLiveVideoSession", "stopLiveVideoSession"] },
  { id: "surface.input", version: 1, features: ["tapTargetElement", "performTargetGesture"] },
  { id: "target.hardware", version: 1, features: ["getTargetHardware"] },
  { id: "target.clipboard", version: 1, features: ["getTargetClipboard"] },
  { id: "target.settings", version: 1, features: ["getTargetSettings", "updateTargetSettings"] },
  { id: "target.location", version: 1, features: ["clearTargetLocation"] },
  { id: "target.biometrics", version: 1, features: ["simulateTargetBiometricResult"] },
  { id: "target.apps", version: 1, features: ["listTargetApps"] },
  { id: "target.push", version: 1, features: ["sendTargetPushNotification"] },
  { id: "target.telephony", version: 1, features: ["simulateTargetSms"] },
];
const surface = {
  surfaceId, kind: "display", bounds: { x: 0, y: 0, width: 48, height: 32 },
  geometryRevision: 13, pixelDensity: 2, orientation: "landscape",
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
  return [{
    providerId: "synthetic-provider", name: "Synthetic provider", version: "synthetic", state: "ready", capabilities: captures,
  }, ...(scenario.catalog?.providers ?? []).map((provider) => ({
    ...provider, capabilities: mergedCapabilities([...provider.capabilities, ...captures]),
  }))];
}
function target() {
  return {
    targetId, providerId: "synthetic-provider", targetTypeId: "opaque/type", name: "Synthetic device",
    status: scenario.status, surfaces: scenario.status === "running" ? [{ ...surface, geometryRevision: scenario.geometryRevision }] : [],
    nativeIdentity: { platform: "ios", nativeId: "native-deployment-not-opaque-target", isVirtual: true },
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
      const body = options.body === undefined || typeof options.body === "string"
        ? options.body : Buffer.from(options.body).toString("utf8");
      scenario.calls.push({ path, method: options.method ?? "GET", body });
      if (closed) throw new Error("closed double");
      if (options.signal?.aborted) throw new Error("aborted double");
      if (!["GET", "POST", "PATCH", "DELETE"].includes(options.method ?? "GET")) {
        throw new Error("Official-shaped fixture does not support this HTTP verb");
      }
      if (path === "/api/v1/host/status") return reply({
        hostId: "synthetic-host", profile: "ailoha.target-host/v1", version: "synthetic",
        state: "ready", capabilities: mergedCapabilities([...captures, ...(scenario.catalog?.status.capabilities ?? [])]),
      });
      if (path === "/api/v1/providers") return reply(providerRecords());
      const catalogRoute = /^\/api\/v1\/providers\/([^/]+)\/(catalogs|runtimes|target-types|templates)$/.exec(path);
      if (catalogRoute) {
        const entry = scenario.catalog?.providerCatalogs.find((entry) => entry.providerId === decodeURIComponent(catalogRoute[1]));
        if (!entry) throw new Error("Unadvertised synthetic catalog");
        return reply(entry[catalogRoute[2] === "target-types" ? "targetTypes" : catalogRoute[2]]);
      }
      if (path === "/api/v1/targets" && options.method === "POST") {
        if (!scenario.catalog) throw new Error("Synthetic creation is disabled");
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
          status: input.start === false ? "stopped" : "running", surfaces: [],
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
        return reply(operation, 202, `/api/v1/operations/${encodeURIComponent(operationId)}`);
      }
      if (path === "/api/v1/targets") return reply([target(), ...[...scenario.createdTargets.keys()].map(createdTarget)]);
      const targetRoute = /^\/api\/v1\/targets\/([^/]+)(?:\/(capabilities|surfaces))?$/.exec(path);
      const selectedId = targetRoute ? decodeURIComponent(targetRoute[1]) : undefined;
      const selected = selectedId === targetId ? target() : createdTarget(selectedId);
      if (targetRoute) {
        if (!selected) throw new Error("Unknown synthetic target");
        if (targetRoute[2] === "capabilities") return reply(providerRecords().find((provider) => provider.providerId === selected.providerId).capabilities);
        if (targetRoute[2] === "surfaces") return reply(selected.surfaces);
        return reply(selected);
      }
      if (/\/actions\/(start|stop|reboot)$/.test(path)) {
        const action = path.split("/").at(-1);
        const operationId = randomUUID();
        scenario.status = action === "stop" ? "stopped" : "running";
        const operation = {
          operationId, kind: `${action}Target`, targetId, providerId: "synthetic-provider",
          status: "queued", destructive: false, createdAt: "2026-10-09T23:00:00Z",
        };
        scenario.operations.set(operationId, {
          ...operation, status: "succeeded", startedAt: "2026-10-09T23:00:01Z", completedAt: "2026-10-09T23:00:02Z",
        });
        return reply(operation, 202, `/api/v1/operations/${operationId}`);
      }
      if (path.startsWith("/api/v1/operations/")) {
        const id = decodeURIComponent(path.split("/").at(-1));
        if (id.startsWith("creation/") && scenario.creationGate) await scenario.creationGate.promise;
        return reply(scenario.operations.get(id));
      }
      const featureRoute = /^\/api\/v1\/targets\/([^/]+)\/(hardware|clipboard|settings\/device|location|biometrics\/results|apps\?includeSystem=true|push\/notifications|telephony\/sms)$/.exec(path);
      if (featureRoute) {
        const id = decodeURIComponent(featureRoute[1]);
        const device = id === targetId ? target() : createdTarget(id);
        if (!device) throw new Error("Unknown feature target");
        const provenance = { "x-ailoha-target-host": { targetId: id, providerId: device.providerId } };
        if (featureRoute[2] === "hardware" && options.method === "GET") return reply({
          ...provenance, targetId: id, platform: device.nativeIdentity.platform,
          batteryLevel: 0.8, batteryState: "charging", downloadBitsPerSecond: null,
          uploadBitsPerSecond: null, latencyMs: null, networkIsIndicatorOnly: false,
          unreadable: ["location"],
        });
        if (featureRoute[2] === "clipboard" && options.method === "GET") return reply({
          ...provenance, contentType: "text/plain", text: "synthetic clipboard",
        });
        if (featureRoute[2] === "apps?includeSystem=true" && options.method === "GET") return reply([{
          appId: "com.example.synthetic", packageId: "com.example.synthetic",
          state: "installed", ...provenance,
        }]);
        if (featureRoute[2] === "settings/device") {
          if (options.method === "PATCH") {
            scenario.featureAppearance = JSON.parse(body).values.appearance;
          }
          return reply({ ...provenance, namespace: "device", values: { appearance: scenario.featureAppearance } });
        }
        if (featureRoute[2] === "location" && options.method === "DELETE") {
          return { status: 204, contentType: null, body: null, location: null };
        }
        if (["biometrics/results", "push/notifications", "telephony/sms"].includes(featureRoute[2])
          && options.method === "POST") {
          const operationId = `feature-scan-${scenario.operations.size}`;
          const kind = featureRoute[2] === "biometrics/results"
            ? "simulateTargetBiometricResult" : featureRoute[2] === "telephony/sms"
              ? "simulateTargetSms" : "sendTargetPushNotification";
          const operation = {
            operationId, kind, status: "queued", destructive: false,
            targetId: id, providerId: device.providerId, createdAt: "2026-10-10T03:00:00Z",
          };
          scenario.operations.set(operationId, { ...operation, status: "succeeded", completedAt: "2026-10-10T03:00:01Z" });
          return reply(operation, 202, `/api/v1/operations/${operationId}`);
        }
        throw new Error("Unsupported feature verb");
      }
      const surfaceRoute = /^\/api\/v1\/targets\/([^/]+)\/surfaces\/([^/]+)\/(.+)$/.exec(path);
      const mediaTargetId = surfaceRoute ? decodeURIComponent(surfaceRoute[1]) : targetId;
      const mediaSurfaceId = surfaceRoute ? decodeURIComponent(surfaceRoute[2]) : surfaceId;
      if (path.endsWith("/screenshots")) {
        const image = readFileSync(new URL("reference-1.png", packetRoot));
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
        scenario.geometryRevision = 13;
        const videoSessionId = randomUUID();
        const session = {
          videoSessionId, targetId: mediaTargetId, surfaceId: mediaSurfaceId, codec: "h264", state: "ready",
          createdAt: "2026-10-09T23:00:00Z", geometryRevision: 13, source: "synthetic-fixture",
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
