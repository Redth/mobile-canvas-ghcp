import { MobileAilohaError } from "./mobile-projection.mjs";
import { mobileErrorResult } from "./mobile-backend.mjs";

async function invokeOwned(action) {
  try { return await action(); }
  catch (error) {
    const result = mobileErrorResult(error);
    const failure = new MobileAilohaError(result.code, result.message, result.status);
    for (const key of ["contextIdentity", "operationId", "operation", "createdTargetId", "problem", "upstreamStatus"]) {
      if (Object.hasOwn(result, key)) failure[key] = result[key];
    }
    throw failure;
  }
}

export function withAilohaCanvas(options, { backend, createHost }) {
  if (backend === "legacy") return options;
  if (backend !== "ailoha") throw new Error("Invalid Mobile Canvas backend.");
  const hosts = new Map();
  function host(context) {
    if (!context?.sessionId || !context.instanceId) {
      throw new MobileAilohaError("canvas_scope_required", "Ailoha canvas actions require their live session and instance.");
    }
    const key = JSON.stringify([context.sessionId, context.instanceId]);
    let entry = hosts.get(key);
    if (!entry) {
      if (hosts.size >= 64) throw new MobileAilohaError("canvas_owner_limit", "The bounded Ailoha canvas owner pool is full.", 429);
      entry = createHost({ scope: { sessionId: context.sessionId, viewId: context.instanceId } });
      hosts.set(key, entry);
    }
    return entry;
  }
  return {
    ...options,
    inputSchema: {
      ...options.inputSchema,
      properties: {
        ...options.inputSchema.properties,
        surfaceId: { type: "string", description: "Explicit opaque Ailoha surface ID when a target has multiple surfaces." },
        workspaceRoot: { type: "string", description: "Explicit absolute local root for optional read-only workspace inspection. No root is inferred from session or process state." },
        workspaceExclusions: { type: "array", items: { type: "string" }, maxItems: 64, description: "Optional scan exclusions scoped to workspaceRoot." },
      },
    },
    actions: [...options.actions.map((action) => ({
      ...action,
      ...(action.name === "select_device" ? {
        inputSchema: {
          ...action.inputSchema,
          properties: {
            ...action.inputSchema.properties,
            surfaceId: { type: "string", description: "Explicit opaque surface ID from the Ailoha target record." },
          },
        },
      } : {}),
      ...(action.name === "create_device" ? {
        inputSchema: {
          ...action.inputSchema,
          properties: {
            ...action.inputSchema.properties,
            platform: {
              type: "string", enum: ["ios", "android"], default: "ios",
              description: "Mobile platform; defaults to ios. Must match the exact returned catalog choices.",
            },
          },
        },
      } : {}),
      ...(["tap_device", "long_press_device", "swipe_device"].includes(action.name) ? {
        inputSchema: {
          ...action.inputSchema,
          properties: {
            ...action.inputSchema.properties,
            surfaceId: { type: "string", description: "Observed opaque Ailoha surface ID." },
            geometryRevision: { type: "integer", minimum: 0, maximum: 0xffffffff, description: "Revision from observed logical display geometry." },
            coordinate: { type: "string", enum: ["window", "screen"], description: "Observed logical coordinate space, never encoded pixels." },
          },
        },
      } : {}),
      handler: (context) => invokeOwned(() => host(context).invokeAction(action.name, context.input ?? {})),
    })), {
      name: "workspace_inspect",
      description: "Read-only static inspection of an explicitly supplied workspace root. Does not start a device/runtime, install agents, execute project scripts, or select an application.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Explicit absolute local root to bind and display in this canvas." },
          exclusions: { type: "array", items: { type: "string" }, maxItems: 64 },
        },
        required: ["path"],
        additionalProperties: false,
      },
      handler: (context) => invokeOwned(() => host(context).invokeAction("workspace_inspect", context.input ?? {})),
    }],
    async open(context) {
      const result = await invokeOwned(() => host(context).openCanvas(context.input ?? {}));
      return { title: result.title, url: result.url, status: "Ailoha opt-in: owned Target Host transport" };
    },
    async onClose(context) {
      const key = JSON.stringify([context.sessionId, context.instanceId]);
      const entry = hosts.get(key);
      if (entry) await invokeOwned(() => entry.closeCanvas());
    },
  };
}
