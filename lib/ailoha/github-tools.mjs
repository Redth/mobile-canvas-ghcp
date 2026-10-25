import { randomUUID } from "node:crypto";
import { mobileErrorResult } from "./mobile-backend.mjs";
import { MobileAilohaError } from "./mobile-projection.mjs";

function sdkResult(reply) {
  const result = reply?.result;
  if (reply?.error || !result || !Array.isArray(result.content)) {
    const message = reply?.error?.message ?? "The named Mobile Canvas tool returned an invalid response.";
    return { textResultForLlm: message, resultType: "failure", error: message };
  }
  const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const images = result.content.filter((part) => part.type === "image").map((part) => ({
    type: "image", data: part.data, mimeType: part.mimeType,
  }));
  return {
    textResultForLlm: text,
    ...(images.length ? { binaryResultsForLlm: images } : {}),
    resultType: result.isError ? "failure" : "success",
    ...(result.isError ? { error: text } : {}),
  };
}

function failure(error) {
  const result = mobileErrorResult(error);
  const text = JSON.stringify(result);
  return { textResultForLlm: text, resultType: "failure", error: text };
}

export function createAilohaGithubTools({ descriptors, getBinding, createDispatcher, nameForDescriptor = (name) => name }) {
  const active = new Map();
  let retired = false;
  const key = (sessionId, instanceId) => JSON.stringify([sessionId, instanceId]);
  return Object.freeze({
    tools: descriptors.map((descriptor) => {
      const parameters = structuredClone(descriptor.inputSchema);
      delete parameters.properties.sessionId;
      parameters.properties.instanceId = {
        type: "string", minLength: 1,
        description: "Explicit instance ID of an already opened Mobile Device canvas in this session.",
      };
      parameters.required = [...new Set([...(parameters.required ?? []).filter((name) => name !== "sessionId"), "instanceId"])];
      return {
        name: nameForDescriptor(descriptor.name), description: descriptor.description, parameters,
        async handler(input, invocation) {
          try {
            if (!input || typeof input !== "object" || Array.isArray(input)
              || Object.hasOwn(input, "sessionId")) {
              throw new MobileAilohaError("invalid_request", "Tool input cannot supply the SDK session identity.", 400);
            }
            const instanceId = input?.instanceId;
            if (typeof instanceId !== "string" || !instanceId || typeof invocation?.sessionId !== "string") {
              throw new MobileAilohaError("canvas_scope_required", "Choose an opened Mobile Device canvas instance in this session.", 400);
            }
            const entry = active.get(key(invocation.sessionId, instanceId));
            if (!entry || entry.controller.signal.aborted) {
              throw new MobileAilohaError("view_closed", "Open the named Mobile Device canvas before invoking this tool.", 409);
            }
            const args = { ...input };
            delete args.instanceId;
            delete args.sessionId;
            const signal = invocation.signal
              ? AbortSignal.any([entry.controller.signal, invocation.signal])
              : entry.controller.signal;
            const call = (async () => {
              if (signal.aborted) throw new MobileAilohaError("cancelled", "The named tool request was cancelled.", 409);
              const dispatcher = await (entry.dispatcher ??= (async () => {
                const binding = await getBinding(entry.scope);
                if (entry.controller.signal.aborted) throw new MobileAilohaError("view_closed", "The named canvas closed during binding.", 409);
                return createDispatcher({ binding });
              })());
              if (signal.aborted) throw new MobileAilohaError("cancelled", "The named tool request was cancelled.", 409);
              return sdkResult(await dispatcher.handle({
                jsonrpc: "2.0", id: randomUUID(), method: "tools/call",
                params: { name: descriptor.name, arguments: args },
              }, { signal }));
            })();
            entry.calls.add(call);
            try { return await call; }
            finally { entry.calls.delete(call); }
          } catch (error) { return failure(error); }
        },
      };
    }),
    opened(scope) {
      if (retired) throw new MobileAilohaError("view_closed", "The SDK session is retired; no canvas can be bound.", 409);
      const id = key(scope.sessionId, scope.viewId);
      if (active.has(id)) return;
      active.set(id, { scope: Object.freeze({ ...scope }), controller: new AbortController(), calls: new Set() });
    },
    async closing(scope) {
      const id = key(scope.sessionId, scope.viewId);
      const entry = active.get(id);
      if (!entry) return;
      active.delete(id);
      entry.controller.abort();
      await Promise.allSettled([...entry.calls]);
      if (entry.dispatcher) await entry.dispatcher.then((dispatcher) => dispatcher.dispose(), () => {});
    },
    async closeAll() {
      retired = true;
      await Promise.all([...active.values()].map((entry) => this.closing(entry.scope)));
    },
  });
}
