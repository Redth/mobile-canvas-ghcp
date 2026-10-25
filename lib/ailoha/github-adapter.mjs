import { immutableSnapshot, MobileAilohaError } from "./mobile-projection.mjs";
import { mobileErrorResult } from "./mobile-backend.mjs";
import { DESTRUCTIVE_CONSENT_SCHEMA, destructiveConsentResult } from "./destructive-consent.mjs";

export function createAilohaCanvasConsent(getSession) {
  const prompt = async (request, { signal }) => {
    const session = getSession();
    if (session?.sessionId !== request.invocation.scope.sessionId) {
      throw new MobileAilohaError("consent_scope_mismatch", "Approval must use the captured canvas session.");
    }
    let requestId;
    let cancelling;
    const cancel = () => {
      if (!requestId || cancelling) return;
      cancelling = session.rpc.ui.handlePendingElicitation({ requestId, result: { action: "cancel" } }).catch(() => {
        process.stderr.write("Mobile Canvas: the host did not acknowledge prompt cancellation; the captured approval remains retired.\n");
      });
    };
    const unsubscribe = session.on("elicitation.requested", (event) => {
      if (event.data?.message !== request.message || event.data.mode === "url"
        || typeof event.data.requestId !== "string" || !event.data.requestId || requestId) return;
      requestId = event.data.requestId;
      if (signal.aborted) cancel();
    });
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) return "cancel";
      const result = await session.ui.elicitation({
        message: request.message, requestedSchema: DESTRUCTIVE_CONSENT_SCHEMA,
      });
      return signal.aborted ? "cancel" : destructiveConsentResult(result);
    } finally {
      signal.removeEventListener("abort", cancel);
      unsubscribe();
    }
  };
  prompt.isSupported = () => {
    const session = getSession();
    return session?.capabilities?.ui?.elicitation === true
      && typeof session.ui?.elicitation === "function" && typeof session.on === "function"
      && typeof session.rpc?.ui?.handlePendingElicitation === "function";
  };
  return Object.freeze(prompt);
}

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

export function withAilohaCanvas(options, { backend, createHost, onHostOpened, onHostClosing }) {
  if (backend === "legacy") return options;
  if (backend !== "ailoha") throw new Error("Invalid Mobile Canvas backend.");
  const hosts = new Map();
  function host(context, { opening = false } = {}) {
    if (!context?.sessionId || !context.instanceId) {
      throw new MobileAilohaError("canvas_scope_required", "Ailoha canvas actions require their live session and instance.");
    }
    const key = JSON.stringify([context.sessionId, context.instanceId]);
    let entry = hosts.get(key);
    if (entry?.retired && !opening) {
      throw new MobileAilohaError("view_closed", "Open the named Mobile Device canvas before invoking an action.", 409);
    }
    if (!entry) {
      if (hosts.size >= 64) throw new MobileAilohaError("canvas_owner_limit", "The bounded Ailoha canvas owner pool is full.", 429);
      entry = {
        host: createHost({ scope: { sessionId: context.sessionId, viewId: context.instanceId } }),
        generation: 0, openings: new Set(), openingCount: 0, closedOpeningCount: 0,
      };
      hosts.set(key, entry);
    }
    return entry.host;
  }
  function retire(entry, scope) {
    const newlyOpened = entry.openingCount !== entry.closedOpeningCount;
    if (entry.retired && !entry.cleanupFailed && !newlyOpened) return entry.closing;
    if (!entry.retired || newlyOpened) entry.generation += 1;
    entry.retired = true;
    entry.cleanupFailed = false;
    entry.closedOpeningCount = entry.openingCount;
    const openings = [...entry.openings];
    entry.closing = (async () => {
      const errors = [];
      try { await onHostClosing?.(scope); }
      catch (error) { errors.push(error); }
      await Promise.allSettled(openings);
      try { await invokeOwned(() => entry.host.closeCanvas()); }
      catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "The SDK tool and canvas host both failed to close.");
    })().then(
      () => { entry.cleanupFailed = false; },
      (error) => { entry.cleanupFailed = true; throw error; },
    );
    return entry.closing;
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
      const current = host(context, { opening: true });
      const scope = { sessionId: context.sessionId, viewId: context.instanceId };
      const input = immutableSnapshot(context.input ?? {});
      const key = JSON.stringify([scope.sessionId, scope.viewId]);
      const entry = hosts.get(key);
      const generation = entry.generation;
      const closing = entry.closing;
      if (closing) {
        try { await closing; }
        catch (error) { if (!entry.cleanupFailed && entry.closing === closing) throw error; }
      }
      if (entry.cleanupFailed) await retire(entry, scope);
      else if (entry.closing !== closing) await entry.closing;
      if (entry.generation !== generation) {
        throw new MobileAilohaError("view_closed", "The named canvas closed before its open request completed.", 409);
      }
      entry.openingCount += 1;
      const opening = Promise.resolve().then(() => {
        if (entry.generation !== generation) {
          throw new MobileAilohaError("view_closed", "The named canvas closed before its open request completed.", 409);
        }
        return invokeOwned(() => current.openCanvas(input));
      });
      entry.openings.add(opening);
      let result;
      try { result = await opening; }
      finally { entry.openings.delete(opening); }
      if (entry.generation !== generation) {
        throw new MobileAilohaError("view_closed", "The named canvas closed before its open request completed.", 409);
      }
      entry.retired = false;
      onHostOpened?.(scope);
      return { title: result.title, url: result.url, status: "Ailoha opt-in: owned Target Host transport" };
    },
    async onClose(context) {
      const key = JSON.stringify([context.sessionId, context.instanceId]);
      const entry = hosts.get(key);
      if (!entry) return;
      await retire(entry, { sessionId: context.sessionId, viewId: context.instanceId });
    },
  };
}
