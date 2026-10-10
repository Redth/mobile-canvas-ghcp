import { MobileAilohaError } from "./mobile-projection.mjs";
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
    if (result.contextIdentity) failure.contextIdentity = result.contextIdentity;
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
      },
    },
    actions: options.actions.map((action) => ({
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
    })),
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
