import { isOpaqueId } from "./protocol.mjs";
import { hasOperation, MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";

const STATUS_FIELDS = Object.freeze({
  enabled: "boolean", time: "string", batteryLevel: "integer", batteryCharging: "boolean",
  wifiBars: "integer", cellularBars: "integer", carrierName: "string", hideNotifications: "boolean",
});
const IOS_BUTTONS = new Set(["home", "lock", "side-button", "siri", "apple-pay"]);
const ANDROID_BUTTONS = new Set(["home", "back", "apps", "lock", "power", "volume-up", "volume-down", "menu"]);

function invalid(message) {
  throw new MobileAilohaError("invalid_request", message, 400);
}

function responseBody(reply) {
  if (reply.status !== 200 || reply.contentType?.split(";", 1)[0] !== "application/json"
    || !reply.body || typeof reply.body !== "object" || Array.isArray(reply.body)) {
    throw new MobileAilohaError("invalid_control_response", "Ailoha returned an invalid control response.", 502);
  }
  return publicSnapshot(reply.body);
}

function requireOwner(context, invocation, surface = false) {
  if (context?.targetId !== invocation.targetId
    || (surface && context.surfaceId !== invocation.surfaceId)
    || (context.providerId !== undefined && context.providerId !== invocation.providerId)
    || (surface && context.geometryRevision !== undefined
      && context.geometryRevision !== invocation.geometry.geometryRevision)) {
    throw new MobileAilohaError("control_owner_mismatch", "Ailoha control response changed its captured target or surface.", 502);
  }
}

function actionResponse(reply, invocation) {
  const result = responseBody(reply);
  if (typeof result.success !== "boolean") {
    throw new MobileAilohaError("invalid_control_response", "Ailoha did not return a target action result.", 502);
  }
  if (!result.success) throw new MobileAilohaError("input_operation_failed", "The captured Ailoha input failed.", 502);
  requireOwner(result["x-ailoha-target-host"], invocation, true);
}

function statusDocument(reply, invocation) {
  const result = responseBody(reply);
  if (result.namespace !== "status-bar" || !result.values || typeof result.values !== "object"
    || Array.isArray(result.values) || typeof result.values.enabled !== "boolean"
    || typeof result.values.readable !== "boolean") {
    throw new MobileAilohaError("invalid_control_response", "Ailoha did not return status-bar settings.", 502);
  }
  requireOwner(result["x-ailoha-target-host"], invocation);
  const overrides = Object.entries(result.values)
    .filter(([key]) => key !== "enabled" && key !== "readable")
    .map(([name, value]) => {
      if (!Object.hasOwn(STATUS_FIELDS, name) || typeof value !== "string") {
        throw new MobileAilohaError("invalid_control_response", "Ailoha returned invalid status-bar overrides.", 502);
      }
      return { name, value };
    });
  return publicSnapshot({
    schemaVersion: "1.0", deviceId: invocation.targetId,
    platform: invocation.nativeIdentity?.platform ?? "unknown",
    enabled: result.values.enabled, readable: result.values.readable, overrides,
  });
}

function statusValues(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Object.getOwnPropertyNames(input).some((key) => !Object.hasOwn(STATUS_FIELDS, key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), "value"))
    || Object.getOwnPropertySymbols(input).length) invalid("Invalid status-bar fields.");
  const values = {};
  for (const [key, value] of Object.entries(input)) {
    if (value == null) continue;
    const kind = STATUS_FIELDS[key];
    if (kind === "integer" ? !Number.isInteger(value)
      || value < 0 || value > (key === "batteryLevel" ? 100 : 4)
      : typeof value !== kind) invalid(`Invalid status-bar ${key}.`);
    if (key === "time" && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)) invalid("Status-bar time must be HH:mm.");
    if (typeof value === "string" && Buffer.byteLength(value) > 1024) invalid("Status-bar text is too long.");
    values[key] = value;
  }
  return values;
}

export function createAilohaControlAdapter({ transport, signal }) {
  const request = (path, options = {}) => transport.response(path, { signal, timeoutMs: 30_000, ...options });
  const targetPath = (invocation) => `/api/v1/targets/${encodeURIComponent(invocation.targetId)}`;
  const surfacePath = (invocation) => `${targetPath(invocation)}/surfaces/${encodeURIComponent(invocation.surfaceId)}`;
  return Object.freeze({
    supported(capabilities, surface) {
      const target = (id, operation) => hasOperation(capabilities, operation, id);
      const input = (feature) => surface && hasOperation(surface.capabilities, feature, "surface.input");
      return {
        key: !!(surface && target("surface.input", "pressTargetKey") && input("key")),
        button: !!(surface && target("surface.input", "pressTargetKey") && input("button")),
        text: !!(surface && target("surface.input", "fillTargetElement")
          && target("surface.ui", "getTargetUiTree") && input("text")),
        rotate: !!(surface && target("target.presentation", "updateTargetPresentation") && input("rotate")),
        presentation: target("target.settings", "getTargetSettings"),
      };
    },
    async key(invocation, keyCode) {
      if (!Number.isSafeInteger(keyCode) || keyCode < 0) invalid("Key code must be a USB HID usage integer.");
      actionResponse(await request(`${surfacePath(invocation)}/input/actions/key`, {
        method: "POST", body: JSON.stringify({ key: String(keyCode) }),
      }), invocation);
    },
    async button(invocation, button) {
      const platform = invocation.nativeIdentity?.platform;
      if (platform !== "ios" && platform !== "android") {
        throw new MobileAilohaError("capability_not_supported", "Unknown platform cannot identify a physical button.", 501);
      }
      const allowed = platform === "android" ? ANDROID_BUTTONS : IOS_BUTTONS;
      if (typeof button !== "string" || !allowed.has(button)) invalid("Unsupported physical device button.");
      actionResponse(await request(`${surfacePath(invocation)}/input/actions/key`, {
        method: "POST", body: JSON.stringify({ key: button }),
      }), invocation);
    },
    async text(invocation, text, requireCurrent) {
      if (typeof text !== "string" || !text || Buffer.byteLength(text) > 32 * 1024) invalid("Text must be nonempty and bounded.");
      const reply = await request(`${surfacePath(invocation)}/ui/tree?depth=64`);
      if (reply.status !== 200 || reply.contentType?.split(";", 1)[0] !== "application/json"
        || !Array.isArray(reply.body)) {
        throw new MobileAilohaError("invalid_control_response", "Ailoha did not return a UI tree.", 502);
      }
      const focused = [];
      let visited = 0;
      const visit = (node, depth) => {
        if (++visited > 4096 || depth > 64 || !node || typeof node !== "object" || !isOpaqueId(node.id)
          || !node.state || typeof node.state.focused !== "boolean"
          || !Array.isArray(node.children ?? [])) {
          throw new MobileAilohaError("invalid_control_response", "Ailoha returned an invalid focused-element tree.", 502);
        }
        requireOwner(node["x-ailoha-target-host"], invocation, true);
        if (node.state.focused) focused.push(node);
        for (const child of node.children ?? []) visit(child, depth + 1);
      };
      if (reply.body.length > 4096) throw new MobileAilohaError("invalid_control_response", "Ailoha UI tree is too large.", 502);
      for (const node of reply.body) visit(node, 0);
      if (focused.length !== 1 || !["field", "textbox"].includes(focused[0].role)
        || focused[0].state.displayed !== true || focused[0].state.enabled !== true) {
        throw new MobileAilohaError("focused_element_unavailable", "Ailoha must observe exactly one focused input element before text entry.");
      }
      requireCurrent();
      actionResponse(await request(`${surfacePath(invocation)}/input/actions/fill`, {
        method: "POST", body: JSON.stringify({ elementId: focused[0].id, text }),
      }), invocation);
    },
    async rotate(invocation, orientation) {
      if (!["portrait", "landscape-left", "landscape-right", "portrait-upside-down"].includes(orientation)) {
        invalid("Invalid device orientation.");
      }
      if (orientation === "portrait-upside-down" || orientation === "landscape-right") {
        throw new MobileAilohaError("capability_not_supported", "Ailoha presentation cannot guarantee this directional orientation.", 501);
      }
      const result = responseBody(await request(`${targetPath(invocation)}/presentation`, {
        method: "PATCH", body: JSON.stringify({ orientation: orientation === "portrait" ? "portrait" : "landscape" }),
      }));
      requireOwner(result["x-ailoha-target-host"], invocation);
      if (!Number.isFinite(result.width) || result.width < 0 || !Number.isFinite(result.height) || result.height < 0
        || !Number.isFinite(result.density) || result.density <= 0
        || typeof result.orientation !== "string"
        || !(orientation === "portrait" ? result.orientation === "portrait"
          : ["landscape", "landscape-left", "landscapeleft"].includes(result.orientation.toLowerCase()))) {
        throw new MobileAilohaError("invalid_control_response", "Ailoha did not confirm the requested orientation.", 502);
      }
    },
    async presentation(invocation, input) {
      const path = `${targetPath(invocation)}/settings/status-bar`;
      if (input === undefined) return statusDocument(await request(path), invocation);
      const values = statusValues(input);
      if (!Object.keys(values).length) return statusDocument(await request(path), invocation);
      return statusDocument(await request(path, {
        method: "PATCH", body: JSON.stringify({ values }),
      }), invocation);
    },
  });
}
