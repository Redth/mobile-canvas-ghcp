import { AilohaProtocolError } from "./errors.mjs";
import { isOpaqueId, operation as validateOperation } from "./protocol.mjs";
import { MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";

const LIMIT = 64 * 1024;
const OPERATION_PREFIX = "/api/v1/operations/";

function invalid(message) {
  throw new MobileAilohaError("invalid_feature_response", message, 502);
}

function resource(response, status) {
  if (response?.status !== status
    || (status !== 204 && response.contentType?.split(";", 1)[0] !== "application/json")) {
    invalid("The canonical device feature returned an unexpected status or content type.");
  }
  if (status === 204) {
    if (response.body != null) invalid("The location-clear response unexpectedly contained data.");
    return null;
  }
  if (response.body === undefined) invalid("The canonical feature omitted its response body.");
  const value = publicSnapshot(response.body);
  if (Buffer.byteLength(JSON.stringify(value)) > LIMIT * 2) invalid("The feature response exceeds the bounded output.");
  return value;
}

function owned(value, invocation) {
  const context = value?.["x-ailoha-target-host"];
  if (!context || context.targetId !== invocation.targetId
    || (context.providerId !== undefined && context.providerId !== invocation.providerId)) {
    invalid("The feature response does not belong to the captured target and provider.");
  }
  return value;
}

function segment(value) {
  if (!isOpaqueId(value)) throw new MobileAilohaError("invalid_identifier", "A canonical feature requires an opaque target ID.", 400);
  return encodeURIComponent(value);
}

function operationId(location) {
  if (typeof location !== "string" || !location.startsWith(OPERATION_PREFIX)
    || /[\\/?#\s]/.test(location.slice(OPERATION_PREFIX.length))) return null;
  try {
    const value = decodeURIComponent(location.slice(OPERATION_PREFIX.length));
    return isOpaqueId(value) ? value : null;
  } catch { return null; }
}

function accepted(response, kind, invocation) {
  const id = operationId(response.location);
  if (!id) invalid("The accepted feature operation has no canonical Location.");
  const operation = resource(response, 202);
  validateOperation(operation);
  if (operation.operationId !== id || operation.kind !== kind || operation.destructive !== false
    || (operation.targetId !== undefined && operation.targetId !== invocation.targetId)
    || (operation.providerId !== undefined && operation.providerId !== invocation.providerId)) {
    invalid("The accepted feature operation changed its captured identity.");
  }
  return operation;
}

export function createAilohaDeviceFeatures({ transport, signal, allowPut = false }) {
  const putSupported = allowPut === true;
  const path = (invocation, suffix) => `/api/v1/targets/${segment(invocation.targetId)}/${suffix}`;
  const options = (method, body, timeoutMs = 15_000) => ({
    method, signal, timeoutMs,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const read = async (invocation, suffix, timeoutMs) =>
    owned(resource(await transport.response(path(invocation, suffix), options("GET", undefined, timeoutMs)), 200), invocation);

  return Object.freeze({
    supportsPut: putSupported,
    async resolveApp(invocation, packageId) {
      const response = resource(await transport.response(`${path(invocation, "apps")}?includeSystem=true`,
        options("GET")), 200);
      if (!Array.isArray(response) || response.length > 4096) {
        invalid("The canonical installed app inventory is malformed or exceeds its bound.");
      }
      for (const app of response) {
        owned(app, invocation);
        if (!isOpaqueId(app.appId) || typeof app.packageId !== "string"
          || !["installed", "running", "stopped", "installing", "uninstalling"].includes(app.state)) {
          invalid("The canonical installed app inventory lacks package and app identities.");
        }
      }
      const matches = response.filter((app) => app.packageId === packageId
        && ["installed", "running", "stopped"].includes(app.state));
      if (matches.length !== 1) {
        throw new MobileAilohaError("app_identity_unavailable",
          "Push requires exactly one installed canonical app matching the requested native package.", 409);
      }
      return matches[0].appId;
    },
    async hardware(invocation, timeoutMs) {
      const state = await read(invocation, "hardware", timeoutMs);
      if (state.targetId !== invocation.targetId || state.platform !== invocation.nativeIdentity?.platform
        || (state.batteryLevel != null && (!Number.isFinite(state.batteryLevel)
          || Math.abs(state.batteryLevel * 100 - Math.round(state.batteryLevel * 100)) > 1e-7))
        || (state.batteryLevel != null && (state.batteryLevel < 0 || state.batteryLevel > 1))
        || (state.batteryState != null && !["charging", "discharging", "full", "unknown"].includes(state.batteryState))
        || typeof state.networkIsIndicatorOnly !== "boolean" || !Array.isArray(state.unreadable)
        || state.unreadable.some((name) => typeof name !== "string")) {
        invalid("The canonical hardware report lacks the legacy readback and unreadable evidence.");
      }
      for (const field of ["downloadBitsPerSecond", "uploadBitsPerSecond", "latencyMs"]) {
        if (state[field] != null && (!Number.isSafeInteger(state[field]) || state[field] < 0)) {
          invalid("The canonical hardware report contains an invalid metric.");
        }
      }
      return publicSnapshot({
        schemaVersion: "1.0", deviceId: invocation.targetId, platform: state.platform,
        batteryLevel: state.batteryLevel == null ? null : Math.round(state.batteryLevel * 100),
        batteryState: state.batteryState ?? null,
        downloadBitsPerSecond: state.downloadBitsPerSecond ?? null,
        uploadBitsPerSecond: state.uploadBitsPerSecond ?? null,
        latencyMs: state.latencyMs ?? null, networkIsIndicatorOnly: state.networkIsIndicatorOnly,
        unreadable: state.unreadable,
      });
    },
    async clipboard(invocation, timeoutMs) {
      const state = await read(invocation, "clipboard", timeoutMs);
      if (state.contentType !== "text/plain" || typeof state.text !== "string") {
        invalid("The canonical clipboard is not readable text.");
      }
      return publicSnapshot({ schemaVersion: "1.0", deviceId: invocation.targetId,
        platform: invocation.nativeIdentity.platform, text: state.text });
    },
    async settings(invocation, timeoutMs) {
      const state = await read(invocation, "settings/device", timeoutMs);
      if (state.namespace !== "device" || !state.values || typeof state.values !== "object"
        || Array.isArray(state.values)) invalid("The canonical device settings document is malformed.");
      const { appearance, fontScale, contentSize, increaseContrast } = state.values;
      if (appearance != null && !["light", "dark"].includes(appearance)
        || fontScale != null && (typeof fontScale !== "number" || !Number.isFinite(fontScale))
        || contentSize != null && typeof contentSize !== "string"
        || increaseContrast != null && typeof increaseContrast !== "boolean") {
        invalid("The canonical device settings contain an invalid legacy value.");
      }
      return publicSnapshot({ schemaVersion: "1.0", deviceId: invocation.targetId,
        platform: invocation.nativeIdentity.platform,
        appearance: appearance ?? null, fontScale: fontScale ?? null,
        contentSize: contentSize ?? null, increaseContrast: increaseContrast ?? null });
    },
    async patchSettings(invocation, values) {
      const result = owned(resource(await transport.response(path(invocation, "settings/device"),
        options("PATCH", { values })), 200), invocation);
      if (result.namespace !== "device" || !result.values || typeof result.values !== "object") {
        invalid("The settings update returned a different namespace.");
      }
    },
    async clearLocation(invocation) {
      resource(await transport.response(path(invocation, "location"), options("DELETE")), 204);
    },
    async updateBattery(invocation, input) {
      if (!putSupported) throw new MobileAilohaError("capability_not_supported", "Official PUT transport is not available.", 501);
      const body = owned(resource(await transport.response(path(invocation, "battery"),
        options("PUT", input)), 200), invocation);
      if (body.simulated !== true || typeof body.level !== "number"
        || !Number.isFinite(body.level) || body.level < 0 || body.level > 1) {
        invalid("The canonical battery update omitted its simulated state.");
      }
    },
    async updateNetwork(invocation, input) {
      if (!putSupported) throw new MobileAilohaError("capability_not_supported", "Official PUT transport is not available.", 501);
      const body = owned(resource(await transport.response(path(invocation, "network"),
        options("PUT", input)), 200), invocation);
      if (!Array.isArray(body.connectionProfiles) || !body.connectionProfiles.every((item) => typeof item === "string")) {
        invalid("The canonical network update omitted its network state.");
      }
    },
    async updateLocation(invocation, input) {
      if (!putSupported) throw new MobileAilohaError("capability_not_supported", "Official PUT transport is not available.", 501);
      const body = owned(resource(await transport.response(path(invocation, "location"),
        options("PUT", input)), 200), invocation);
      if (body.simulated !== true || body.latitude !== input.latitude || body.longitude !== input.longitude) {
        invalid("The canonical location update did not confirm the requested simulated fix.");
      }
    },
    async updateClipboard(invocation, input) {
      if (!putSupported) throw new MobileAilohaError("capability_not_supported", "Official PUT transport is not available.", 501);
      const body = owned(resource(await transport.response(path(invocation, "clipboard"),
        options("PUT", input)), 200), invocation);
      if (body.contentType !== "text/plain" || body.text !== input.text) {
        invalid("The canonical clipboard update did not confirm the requested text.");
      }
    },
    async submit(invocation, suffix, kind, body) {
      let reply;
      try {
        reply = await transport.response(path(invocation, suffix), options("POST", body));
      } catch (error) {
        if (error?.name === "TargetHostTransportError" && error.response?.status === 202) {
          const id = operationId(error.response.location);
          if (id) throw new AilohaProtocolError("transport_error", { status: 202, operationId: id });
        }
        throw error;
      }
      if (reply.status === 202 && operationId(reply.location)) {
        try { return accepted(reply, kind, invocation); }
        catch (error) {
          if (error instanceof MobileAilohaError || error instanceof AilohaProtocolError) {
            throw new AilohaProtocolError("invalid_response", {
              status: 202, operationId: operationId(reply.location),
            });
          }
          throw error;
        }
      }
      return accepted(reply, kind, invocation);
    },
  });
}
