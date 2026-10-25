import { productModule } from "../../ailoha-test-module.mjs";

const { createAilohaContextStore } = await import(productModule("lib/ailoha/context-adapter.mjs"));
const { createSemanticInspectionController } = await import(productModule("lib/ailoha/semantic-inspection.mjs"));
const { readNativeAgentCandidates } = await import(productModule("lib/ailoha/semantic-mcp.mjs"));
const { MobileAilohaError } = await import(productModule("lib/ailoha/mobile-projection.mjs"));

// Synthetic contract double: no broker, device, app or real registration is accessed.
export function nativeAgent(runtimeInstanceId, targetId = "target", changes = {}) {
  return { agentId: `agent-${runtimeInstanceId}`, runtimeInstanceId, registrationVersion: 2,
    targetHostId: "host", targetId, appName: "Same app", ...changes };
}

export function createNativeBindingFixture({ registrations = [], advertised = true } = {}) {
  const calls = [];
  const contexts = new Map();
  const model = { registrations, advertised, inventoryError: null, disconnected: false,
    beforeCandidates: null, beforeSelect: null, afterSelect: null, mutateInventory: null };
  const errorResult = (code) => ({ ok: false, context: null,
    error: { code, message: "Synthetic private diagnostic: token=must-not-project" } });
  function resolve(selection) {
    const matches = model.registrations.filter((entry) => entry.runtimeInstanceId === selection.runtimeInstanceId);
    if (!matches.length) throw new MobileAilohaError("AgentNotFound", "The selected synthetic runtime is absent.", 409);
    if (matches.length !== 1) throw new MobileAilohaError("AgentAmbiguous", "The synthetic runtime is ambiguous.", 409);
    const agent = matches[0];
    if (agent.registrationVersion !== 2 || agent.agentId !== selection.agentId) {
      throw new MobileAilohaError("AgentInstanceUnverified", "The synthetic registration is not v2.", 409);
    }
    if (agent.targetHostId !== selection.targetHostId || agent.targetId !== selection.targetId) {
      throw new MobileAilohaError("AgentTargetCorrelationMismatch", "The synthetic target pair differs.", 409);
    }
    if (agent.liveRuntimeInstanceId && agent.liveRuntimeInstanceId !== agent.runtimeInstanceId) {
      throw new MobileAilohaError("AgentInstanceMismatch", "The synthetic process restarted.", 409);
    }
    return agent;
  }
  async function runCli(args, options = {}) {
    options.signal?.throwIfAborted();
    options.beforeDispatch?.();
    calls.push(structuredClone(args));
    if (model.disconnected) throw new MobileAilohaError("ContextOwnerUnavailable", "The synthetic owner disconnected.", 502);
    if (args[0] === "commands") return JSON.stringify([
      { command: "context get", description: "Synthetic read", mutating: false },
      ...(model.advertised ? [{ command: "agent candidates", description: "Synthetic candidates", mutating: false }] : []),
    ]);
    if (args[0] === "agent" && args[1] === "candidates") {
      await model.beforeCandidates?.();
      options.signal?.throwIfAborted();
      const targetHostId = args[args.indexOf("--target-host") + 1];
      const targetId = args[args.indexOf("--target") + 1];
      let code = model.inventoryError;
      const runtimes = new Set();
      for (const agent of model.registrations) {
        if (agent.registrationVersion !== 2) continue;
        if (runtimes.has(agent.runtimeInstanceId)) code = "AgentCandidatesAmbiguous";
        runtimes.add(agent.runtimeInstanceId);
      }
      const value = code
        ? { schema: "ailoha.agent.candidates/v1", ok: false, targetHostId, targetId, candidates: null,
          error: { code, message: "token=must-not-project /private/registration" } }
        : { schema: "ailoha.agent.candidates/v1", ok: true, targetHostId, targetId, error: null,
          candidates: model.registrations.filter((agent) => agent.registrationVersion === 2
            && agent.targetHostId === targetHostId && agent.targetId === targetId)
            .map(({ agentId, runtimeInstanceId, registrationVersion }) => ({
              agentId, runtimeInstanceId, registrationVersion, targetHostId, targetId,
            })) };
      return JSON.stringify(model.mutateInventory ? model.mutateInventory(value) : value);
    }
    if (args[0] !== "context") throw new Error("Unexpected synthetic command.");
    const index = args.indexOf("--request-json");
    const input = index >= 0 ? JSON.parse(args[index + 1]) : null;
    let context;
    if (args[1] === "open") {
      context = contexts.get(`ctx-${input.scope.viewId}`);
    } else context = contexts.get(input?.contextRef ?? args[2]);
    if (!context) throw new Error("No synthetic context.");
    if (args[1] === "select") {
      await model.beforeSelect?.();
      options.signal?.throwIfAborted();
      if (input.expected.scopeEpoch !== context.scopeEpoch || input.expected.revision !== context.revision) {
        return JSON.stringify(errorResult("ContextRevisionConflict"));
      }
      try { if (input.selection.runtimeInstanceId) resolve(input.selection); }
      catch (error) { return JSON.stringify(errorResult(error.code)); }
      context.selection = input.selection;
      context.revision = String(BigInt(context.revision) + 1n);
      context.observed = { hostInstanceId: "synthetic-host-incarnation", applicationEvidence: null,
        runtimeInstanceEvidence: input.selection.runtimeInstanceId ? "verified-native-instance" : "unsupported" };
      await model.afterSelect?.(context);
    }
    if (args[1] === "detach") {
      context.state = "detached";
      context.selection = null;
      context.observed = null;
      context.revision = String(BigInt(context.revision) + 1n);
    }
    return JSON.stringify({ ok: true, context, error: null });
  }
  async function createView(viewId = "view", targetId = "target") {
    const scope = { sessionId: "synthetic-binding-session", viewId };
    const context = {
      schema: "ailoha.execution-context/v1", version: 1,
      contextRef: `ctx-${viewId}`, scope, scopeEpoch: `epoch-${viewId}`, revision: "0", state: "open",
      owner: { processId: process.pid, processStartedAt: "2026-10-25T00:00:00Z" },
      selection: { workspaceId: null, applicationId: null, targetHostId: "host", targetId, surfaceId: "surface",
        agentId: null, runtimeInstanceId: null },
      observed: { hostInstanceId: "synthetic-host-incarnation", applicationEvidence: null, runtimeInstanceEvidence: "unsupported" },
    };
    contexts.set(context.contextRef, context);
    const store = createAilohaContextStore({ scope, runCli });
    await store.binding();
    const toolCalls = [];
    const errors = [];
    const controller = createSemanticInspectionController({
      scope, readSnapshot: (options) => store.readSnapshot(options),
      bindNativeInstance: (binding, snapshot, options) => store.bindNativeInstance(binding, snapshot, options),
      readCandidates: (snapshot, options) => readNativeAgentCandidates({ runCli, snapshot, ...options }),
      onError: (error) => errors.push(error.code),
      async callTool(request) {
        toolCalls.push(request);
        if (model.disconnected) throw new MobileAilohaError("ContextOwnerUnavailable", "The synthetic owner disconnected.", 502);
        const selection = context.selection;
        if (request.arguments.route === "require-agent") resolve(selection);
        return { running: true, elements: [], route: {
          owner: request.arguments.route === "require-agent" ? "agent" : "target-host",
          targetHostId: selection.targetHostId, targetId: selection.targetId, surfaceId: selection.surfaceId,
          agentId: selection.agentId, runtimeInstanceId: selection.runtimeInstanceId,
          executionContext: {
            contextRef: context.contextRef, scopeEpoch: context.scopeEpoch, revision: context.revision, scope,
            observed: context.observed,
          },
        } };
      },
    });
    const request = (input) => controller.request("POST", JSON.stringify(input));
    return { scope, context, store, controller, request, toolCalls, errors,
      mcpStore: () => createAilohaContextStore({ scope, runCli, contextRef: context.contextRef, scopeEpoch: context.scopeEpoch }),
    };
  }
  return { createView, model, calls, contexts, runCli };
}
