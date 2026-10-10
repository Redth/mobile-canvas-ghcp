import { MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";

const SCHEMA = "mobile-canvas.semantic-inspection/v1";
const MAX_ELEMENTS = 300;
const MAX_DEPTH = 16;
const MAX_TEXT = 512;

function fail(code, message, status = 400) {
  throw new MobileAilohaError(code, message, status);
}

function inputOf(body) {
  if (typeof body !== "string" || Buffer.byteLength(body) > 4096) fail("semantic_invalid_request", "Semantic read arguments exceed 4 KiB.");
  let input;
  try { input = JSON.parse(body); }
  catch { fail("semantic_invalid_request", "Semantic read arguments must be JSON."); }
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !["lens", "operation", "maxDepth", "type", "automationId", "text"].includes(key))
    || !["system", "app"].includes(input.lens) || !["tree", "query", "status"].includes(input.operation)
    || (input.maxDepth !== undefined && (!Number.isInteger(input.maxDepth) || input.maxDepth < 1 || input.maxDepth > MAX_DEPTH))
    || ["type", "automationId", "text"].some((key) => input[key] !== undefined
      && (typeof input[key] !== "string" || input[key].length > 128))) {
    fail("semantic_invalid_request", "Use a bounded tree, query or App status read with literal filters.");
  }
  if (input.operation === "status" && input.lens !== "app") fail("semantic_capability_unavailable", "System has no app-agent status.", 501);
  if (input.operation === "query" && !["type", "automationId", "text"].some((key) => input[key]?.length)) {
    fail("semantic_invalid_request", "A query requires a nonempty type, automation ID or text filter.");
  }
  return input;
}

function boundedElements(elements) {
  if (!Array.isArray(elements)) fail("semantic_invalid_response", "Canonical elements must be an array.", 502);
  let count = 0;
  let truncated = false;
  function collect(items, depth) {
    const result = [];
    for (const item of items) {
      if (count >= MAX_ELEMENTS || depth > MAX_DEPTH) { truncated = true; break; }
      if (!item || typeof item.id !== "string" || typeof item.type !== "string") {
        fail("semantic_invalid_response", "Canonical element identity is missing.", 502);
      }
      count += 1;
      result.push({
        id: item.id.slice(0, MAX_TEXT), type: item.type.slice(0, MAX_TEXT),
        text: typeof item.text === "string" ? item.text.slice(0, MAX_TEXT) : null,
        automationId: typeof item.automationId === "string" ? item.automationId.slice(0, MAX_TEXT) : null,
        children: Array.isArray(item.children) ? collect(item.children, depth + 1) : [],
      });
    }
    return result;
  }
  return { elements: collect(elements, 1), truncated };
}

function identity(snapshot) {
  return [snapshot.contextProjection?.contextRef, snapshot.identity?.scopeEpoch,
    snapshot.identity?.revision, snapshot.contextProjection?.ownerProcessId,
    snapshot.contextProjection?.processStartedAt, snapshot.contextProjection?.runtimeInstanceEvidence,
    snapshot.selection?.targetHostId, snapshot.selection?.targetId, snapshot.selection?.surfaceId,
    snapshot.selection?.agentId, snapshot.selection?.runtimeInstanceId];
}

export function createSemanticInspectionController({ scope, readSnapshot, callTool, onError = () => {} }) {
  let generation = 0;
  let visible = true;
  let pending = null;
  let completedIdentity = null;
  let state = Object.freeze({
    schema: SCHEMA, scope: publicSnapshot(scope), generation, status: "ready",
    selection: null, appAvailable: false, lens: "system", operation: null, result: null, error: null,
  });
  const listeners = new Set();
  const publish = (changes) => {
    state = Object.freeze({ ...state, ...changes, generation });
    for (const listener of listeners) listener(state);
    return state;
  };
  const invalidate = () => {
    generation += 1;
    pending?.abort();
    pending = null;
    completedIdentity = null;
    return publish({ status: visible ? "ready" : "suspended", result: null, error: null, selection: null, appAvailable: false });
  };
  const capture = async () => {
    const snapshot = await readSnapshot();
    if (snapshot.state !== "open" || !snapshot.contextProjection
      || !snapshot.selection?.targetHostId || !snapshot.selection?.targetId) {
      fail("semantic_target_unavailable", "Select a target in this named view before inspecting its System or App lens.", 409);
    }
    return snapshot;
  };
  async function request(method, body) {
    if (method === "DELETE") return invalidate();
    if (method === "GET") {
      if (body !== undefined) fail("semantic_invalid_request", "GET does not accept read arguments.");
      const version = generation;
      try {
        const snapshot = await capture();
        if (version !== generation || !visible) return state;
        if (completedIdentity && identity(snapshot).some((part, index) => part !== completedIdentity[index])) invalidate();
        return publish({
          selection: publicSnapshot(snapshot.selection),
          appAvailable: Boolean(snapshot.selection.runtimeInstanceId
            && snapshot.contextProjection.runtimeInstanceEvidence === "verified-native-instance"),
          status: state.status === "suspended" ? "suspended" : state.status,
        });
      } catch (error) {
        if (version !== generation || !visible) return state;
        if (error.code !== "semantic_target_unavailable") throw error;
        invalidate();
        return state;
      }
    }
    if (method !== "POST") fail("semantic_request_unsupported", "Use GET, POST or DELETE on the read-only semantic inspection route.");
    const input = inputOf(body);
    if (!visible) fail("semantic_view_suspended", "The semantic view is hidden.", 409);
    invalidate();
    const version = generation;
    const controller = new AbortController();
    pending = controller;
    try {
      const before = await capture();
      if (input.lens === "app" && (!before.selection.runtimeInstanceId
        || before.contextProjection.runtimeInstanceEvidence !== "verified-native-instance")) {
        fail("semantic_app_unavailable", "No explicitly selected verified native instance exists in this named context. Workspace application IDs are not native agent bindings.", 409);
      }
      if (version !== generation) return state;
      publish({ status: "reading", lens: input.lens, operation: input.operation,
        selection: publicSnapshot(before.selection), appAvailable: Boolean(before.selection.runtimeInstanceId
          && before.contextProjection.runtimeInstanceEvidence === "verified-native-instance") });
      const common = {
        targetHostId: before.selection.targetHostId, targetId: before.selection.targetId,
        ...(before.selection.surfaceId ? { surfaceId: before.selection.surfaceId } : {}),
        contextRef: before.contextProjection.contextRef, contextEpoch: before.identity.scopeEpoch,
        contextRevision: before.identity.revision,
        route: input.lens === "app" ? "require-agent" : "target-host",
      };
      const args = {
        ...common,
        ...(input.operation === "tree" ? { maxDepth: input.maxDepth ?? 6 } : {}),
        ...(input.operation === "query" ? Object.fromEntries(["type", "automationId", "text"]
          .filter((key) => input[key]).map((key) => [key, input[key]])) : {}),
      };
      const name = { tree: "app_tree", query: "app_query", status: "app_status" }[input.operation];
      const output = await callTool({ name, arguments: args, context: before.contextProjection, signal: controller.signal });
      const after = await capture();
      if (version !== generation || identity(before).some((part, i) => part !== identity(after)[i])) {
        fail("semantic_context_superseded", "The named selection or native process changed during inspection.", 409);
      }
      const route = output.route;
      if (!route || route.owner !== (input.lens === "app" ? "agent" : "target-host")
        || route.targetHostId !== before.selection.targetHostId || route.targetId !== before.selection.targetId
        || (before.selection.surfaceId && route.surfaceId !== before.selection.surfaceId)
        || route.executionContext?.contextRef !== before.contextProjection.contextRef
        || route.executionContext?.scopeEpoch !== before.identity.scopeEpoch
        || route.executionContext?.revision !== before.identity.revision
        || route.executionContext?.scope?.sessionId !== scope.sessionId
        || route.executionContext?.scope?.viewId !== scope.viewId
        || (input.lens === "app" && (route.runtimeInstanceId !== before.selection.runtimeInstanceId
          || route.executionContext?.observed?.runtimeInstanceEvidence !== "verified-native-instance"
          || (before.selection.agentId && route.agentId !== before.selection.agentId)))) {
        fail("semantic_route_mismatch", "The composed result did not preserve its selected owner and target.", 502);
      }
      completedIdentity = identity(after);
      const provenance = {
        ownerProcessId: after.contextProjection.ownerProcessId,
        processStartedAt: after.contextProjection.processStartedAt,
        runtimeInstanceEvidence: after.contextProjection.runtimeInstanceEvidence,
      };
      return publish({
        status: "complete", selection: publicSnapshot(after.selection),
        result: publicSnapshot(input.operation === "status"
          ? { status: { running: output.running, agentName: output.agentName, framework: output.framework,
            capabilities: output.capabilities ?? null }, route, provenance }
          : { ...boundedElements(output.elements), geometryRevision: output.geometryRevision ?? null, route, provenance }),
        error: null,
      });
    } catch (error) {
      if (version !== generation) return state;
      const failure = error instanceof MobileAilohaError ? error
        : new MobileAilohaError(controller.signal.aborted ? "semantic_cancelled"
          : error?.code === -32001 ? "semantic_mcp_timeout" : "semantic_mcp_transport_failed",
          controller.signal.aborted ? "The semantic read was cancelled."
            : error?.code === -32001 ? "The canonical MCP inspection exceeded its deadline."
              : "The canonical MCP inspection transport failed.", 502);
      onError(failure);
      return publish({ status: "error", result: null, error: { code: failure.code, message: failure.message, status: failure.status } });
    } finally {
      if (pending === controller) pending = null;
    }
  }
  return Object.freeze({
    request, invalidate, snapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setVisible(value) { visible = value; return invalidate(); },
  });
}
