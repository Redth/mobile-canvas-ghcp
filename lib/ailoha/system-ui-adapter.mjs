import { AilohaProtocolError } from "./errors.mjs";
import { isOpaqueId } from "./protocol.mjs";
import { MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";
import { normalizeTypedHttpRejection } from "./operation-receipts.mjs";

export const REVIEWED_SYSTEM_UI_SOURCE = "afaccc8238bb9f15bf9e9dc707310bb55edc5026";
const RAW_LIMIT = 1024 * 1024;

function invalid() {
  throw new MobileAilohaError("invalid_system_ui_response", "Canonical System UI returned incomplete or mismatched native evidence.", 502);
}

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value;
}

function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function nullableString(value) { return value === null || typeof value === "string"; }

function element(value, depth = 0) {
  object(value);
  if (depth > 128 || typeof value.role !== "string"
    || ["rawRole", "label", "value", "identifier", "hint"].some((key) =>
      value[key] !== undefined && !nullableString(value[key]))
    || ["enabled", "focused", "interactable"].some((key) => typeof value[key] !== "boolean")
    || !Array.isArray(value.children) || !Object.hasOwn(value, "frame")) invalid();
  const frame = value.frame;
  if (frame !== null && (typeof frame !== "object" || Array.isArray(frame)
    || ["x", "y", "width", "height"].some((key) => !finite(frame[key]))
    || frame.width < 0 || frame.height < 0)) invalid();
  return {
    role: value.role, rawRole: value.rawRole ?? null, label: value.label ?? null, value: value.value ?? null,
    identifier: value.identifier ?? null, hint: value.hint ?? null,
    frame: frame === null ? null : { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
    enabled: value.enabled, focused: value.focused, interactable: value.interactable,
    children: value.children.map((child) => element(child, depth + 1)),
  };
}

function match(value) {
  object(value);
  if (typeof value.path !== "string" || !/^(0|[1-9]\d*)(?:\/(0|[1-9]\d*))*$/.test(value.path)) invalid();
  const node = element(value.element);
  const x = node.frame ? node.frame.x + node.frame.width / 2 : 0;
  const y = node.frame ? node.frame.y + node.frame.height / 2 : 0;
  if (node.children.length || (value.centerX !== undefined && value.centerX !== null && value.centerX !== x)
    || (value.centerY !== undefined && value.centerY !== null && value.centerY !== y)
    || (node.frame && (!finite(value.centerX) || !finite(value.centerY)))) invalid();
  return { element: node, path: value.path, centerX: x, centerY: y };
}

function owner(body, invocation) {
  object(body);
  const host = object(body.targetHost);
  if (body.targetId !== invocation.targetId || host.targetId !== invocation.targetId
    || host.providerId !== invocation.providerId || host.surfaceId !== invocation.surfaceId
    || host.geometryRevision !== invocation.geometry.geometryRevision
    || typeof body.uiRevision !== "string" || !body.uiRevision) invalid();
}

function responseBody(response) {
  if (response.status >= 400 && response.status < 500) {
    throw new AilohaProtocolError("http_error", { status: response.status });
  }
  if (response.status !== 200 || response.contentType?.split(";", 1)[0] !== "application/json") invalid();
  return object(response.body);
}

function query(input, limit = input.limit ?? 20) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || ["text", "identifier", "role"].some((key) =>
      input[key] !== undefined && input[key] !== null && typeof input[key] !== "string")
    || (input.exact !== undefined && typeof input.exact !== "boolean")
    || (input.interactableOnly !== undefined && typeof input.interactableOnly !== "boolean")
    || !Number.isSafeInteger(limit)) {
    throw new MobileAilohaError("invalid_request", "System UI requires a typed legacy query.", 400);
  }
  if (Math.max(1, limit) > 256) {
    throw new MobileAilohaError("ui_query_limit_unavailable",
      "The reviewed native System UI query cannot return more than 256 matches.", 501);
  }
  return publicSnapshot({
    ...Object.fromEntries(["text", "identifier", "role"]
      .filter((key) => input[key] !== undefined && input[key] !== null).map((key) => [key, input[key]])),
    exact: input.exact ?? false, interactableOnly: input.interactableOnly ?? false,
    limit: Math.max(1, limit),
  });
}

function result(body, invocation, limit) {
  owner(body, invocation);
  if (!integer(body.total) || !Array.isArray(body.matches)
    || body.matches.length !== Math.min(limit, body.total)) invalid();
  return publicSnapshot({
    schemaVersion: "1.0", deviceId: invocation.targetId,
    matches: body.matches.map(match), total: body.total,
  });
}

export function createAilohaSystemUiAdapter({ transport, signal }) {
  const response = async (route, request) => {
    try { return await transport.response(route, request); }
    catch (error) { throw normalizeTypedHttpRejection(error); }
  };
  const path = (invocation, endpoint) => {
    if (!isOpaqueId(invocation.targetId) || !isOpaqueId(invocation.surfaceId)) {
      throw new MobileAilohaError("invalid_identifier", "System UI requires exact opaque target and surface IDs.", 400);
    }
    return `/api/v1/targets/${encodeURIComponent(invocation.targetId)}/surfaces/${encodeURIComponent(invocation.surfaceId)}/ui/${endpoint}`;
  };
  const options = { signal, timeoutMs: 30_000 };
  return Object.freeze({
    async snapshot(invocation, includeRaw = false) {
      if (typeof includeRaw !== "boolean") {
        throw new MobileAilohaError("invalid_request", "includeRaw must be a boolean.", 400);
      }
      const body = responseBody(await response(
        `${path(invocation, "system-snapshot")}?includeRaw=${includeRaw}`, { ...options, method: "GET" }));
      owner(body, invocation);
      if (typeof body.platform !== "string" || body.platform !== invocation.nativeIdentity?.platform
        || !integer(body.elementCount)
        || (body.raw !== undefined && !nullableString(body.raw))
        || (!includeRaw && body.raw != null)
        || (typeof body.raw === "string" && Buffer.byteLength(body.raw, "utf8") > RAW_LIMIT)) invalid();
      const root = body.root == null ? null : element(body.root);
      let count = 0;
      const walk = (node) => { if (node) { count += 1; node.children.forEach(walk); } };
      walk(root);
      if (count !== body.elementCount) invalid();
      return publicSnapshot({
        schemaVersion: "1.0", deviceId: invocation.targetId, platform: body.platform,
        root, elementCount: count, raw: body.raw ?? null, uiRevision: body.uiRevision,
      });
    },
    async find(invocation, input) {
      const terms = query(input);
      const params = new URLSearchParams({
        exact: String(terms.exact), interactableOnly: String(terms.interactableOnly), limit: String(terms.limit),
        geometryRevision: String(invocation.geometry.geometryRevision),
      });
      for (const key of ["text", "identifier", "role"]) {
        if (terms[key] !== undefined) params.set(key, terms[key]);
      }
      const body = responseBody(await response(
        `${path(invocation, "system-elements")}?${params}`, { ...options, method: "GET" }));
      const found = result(body, invocation, terms.limit);
      return publicSnapshot({ ...found, uiRevision: body.uiRevision });
    },
    async tap(invocation, input, uiRevision) {
      const terms = query(input, 1);
      if (typeof uiRevision !== "string" || !uiRevision) invalid();
      const body = responseBody(await response(
        path(invocation, "system-elements/actions/tap"), {
          ...options, method: "POST",
          body: JSON.stringify({
            ...terms, uiRevision, geometryRevision: invocation.geometry.geometryRevision,
          }),
        }));
      owner(body, invocation);
      if (body.uiRevision !== uiRevision || !integer(body.total) || body.total < 1) invalid();
      const matched = match(body.match);
      if (!matched.element.frame) invalid();
      return publicSnapshot({
        schemaVersion: "1.0", success: true, deviceId: invocation.targetId,
        match: matched, total: body.total,
      });
    },
    validateQuery: query,
  });
}
