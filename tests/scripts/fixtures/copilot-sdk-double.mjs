import { randomUUID } from "node:crypto";

export const copilotUi = {
  supported: true, prompts: [], pending: new Map(), cancellations: [],
  respond(requestId, result) {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    pending.resolve(result);
    return true;
  },
};

export function createCanvas(options) {
  return {
    declaration: {
      id: options.id, displayName: options.displayName, description: options.description,
      inputSchema: options.inputSchema,
      actions: options.actions.map(({ handler, ...metadata }) => metadata),
    },
    ...options,
  };
}
export async function joinSession(options) {
  globalThis.ailohaTestCanvasRegistration = options;
  const listeners = new Map();
  return {
    sessionId: process.env.AILOHA_TEST_SESSION_ID ?? "fixture-session",
    get capabilities() { return { ui: { elicitation: copilotUi.supported } }; },
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
      return () => listeners.get(name).delete(handler);
    },
    ui: {
      elicitation(params) {
        const requestId = randomUUID();
        const prompt = { requestId, ...params };
        copilotUi.prompts.push(prompt);
        const result = new Promise((resolve) => copilotUi.pending.set(requestId, { resolve }));
        queueMicrotask(() => {
          for (const listener of listeners.get("elicitation.requested") ?? []) listener({ data: prompt });
        });
        return result;
      },
    },
    rpc: { ui: {
      async handlePendingElicitation({ requestId, result }) {
        copilotUi.cancellations.push(requestId);
        return { success: copilotUi.respond(requestId, result) };
      },
    } },
  };
}
