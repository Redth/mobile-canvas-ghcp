import { randomUUID } from "node:crypto";
import { MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";
import { copyInvocationMetadata, invocationMetadata } from "./invocation-metadata.mjs";

const SCHEMA = "mobile-canvas.semantic-inspection/v1";
const MAX_ELEMENTS = 300;
const MAX_DEPTH = 16;
const MAX_TEXT = 512;
const MAX_RESULT_BYTES = 1024 * 1024;

function fail(code, message, status = 400) {
  throw new MobileAilohaError(code, message, status);
}

function inputOf(body) {
  if (typeof body !== "string" || Buffer.byteLength(body) > 4096) fail("semantic_invalid_request", "Semantic read arguments exceed 4 KiB.");
  let input;
  try { input = JSON.parse(body); }
  catch { fail("semantic_invalid_request", "Semantic read arguments must be JSON."); }
  if (["bind", "unbind", "candidates"].includes(input?.operation)) {
    const candidate = input.operation === "bind" && Object.hasOwn(input, "candidateToken");
    const keys = input.operation === "bind"
      ? candidate ? ["operation", "bindingToken", "candidateToken"]
        : ["operation", "bindingToken", "agentId", "runtimeInstanceId"] : ["operation", "bindingToken"];
    if (Object.keys(input).some((key) => !keys.includes(key)) || typeof input.bindingToken !== "string"
      || input.bindingToken.length > 128 || !input.bindingToken
      || (candidate && (typeof input.candidateToken !== "string" || !input.candidateToken || input.candidateToken.length > 128))
      || (input.operation === "bind" && !candidate && (typeof input.runtimeInstanceId !== "string"
        || !/^[A-Za-z0-9_-]{1,128}$/.test(input.runtimeInstanceId)
        || input.agentId !== `agent-${input.runtimeInstanceId}`))) {
      fail("semantic_binding_invalid", "Use the captured binding token and exact canonical native runtime instance and agent IDs.");
    }
    return input;
  }
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
    snapshot.contextProjection?.hostInstanceId,
    snapshot.selection?.targetHostId, snapshot.selection?.targetId, snapshot.selection?.surfaceId,
    snapshot.selection?.agentId, snapshot.selection?.runtimeInstanceId];
}

function bindingOwner(snapshot) {
  return [snapshot.contextProjection?.contextRef, snapshot.identity?.scopeEpoch,
    snapshot.contextProjection?.ownerProcessId, snapshot.contextProjection?.processStartedAt,
    snapshot.contextProjection?.hostInstanceId, snapshot.selection?.targetHostId,
    snapshot.selection?.targetId, snapshot.selection?.surfaceId];
}

export function createSemanticInspectionController({ scope, readSnapshot, callTool, bindNativeInstance, readCandidates, onError = () => {} }) {
  let generation = 0;
  let visible = true;
  let pending = null;
  let completedIdentity = null;
  let bindingSnapshot = null;
  let bindingRevoked = false;
  let candidateResult = null;
  const candidateChoices = new Map();
  const bindingState = (token = null) => ({
    token, available: typeof bindNativeInstance === "function",
    discovery: typeof readCandidates === "function" ? "idle" : "unavailable", candidates: null,
    message: typeof readCandidates === "function"
      ? "Read registered candidates for this exact target, then choose one explicitly. Advertisements are not live verification or workspace application correlation."
      : "Automatic candidate discovery is unavailable: this runtime has no fail-closed read-only enumeration API. Enter exact native-instance IDs from trusted Ailoha registration evidence. This binds a native instance, not a workspace application.",
    ...candidateResult,
  });
  let state = Object.freeze({
    schema: SCHEMA, scope: publicSnapshot(scope), generation, status: "ready",
    selection: null, appAvailable: false, lens: "system", operation: null, result: null, error: null,
    binding: bindingState(),
  });
  const listeners = new Set();
  const publish = (changes) => {
    state = Object.freeze({ ...state, ...changes, generation });
    for (const listener of listeners) listener(state);
    return state;
  };
  const invalidate = () => {
    if (state.status === "binding") bindingRevoked = true;
    generation += 1;
    pending?.abort();
    pending = null;
    completedIdentity = null;
    bindingSnapshot = null;
    candidateResult = null;
    candidateChoices.clear();
    return publish({ status: visible ? "ready" : "suspended", result: null, error: null,
      selection: null, appAvailable: false, binding: bindingState() });
  };
  const capture = async (options) => {
    const snapshot = await readSnapshot(options);
    if (snapshot.state !== "open" || !snapshot.contextProjection
      || !snapshot.selection?.targetHostId || !snapshot.selection?.targetId) {
      fail("semantic_target_unavailable", "Select a target in this named view before inspecting its System or App lens.", 409);
    }
    return snapshot;
  };
  const sameIdentity = (left, right) => left.every((part, index) => part === right[index]);
  const appAvailable = (snapshot) => Boolean(snapshot.selection.runtimeInstanceId
    && snapshot.contextProjection.runtimeInstanceEvidence === "verified-native-instance"
    && !bindingRevoked);
  const exposeBinding = (snapshot) => {
    if (!bindingSnapshot || !sameIdentity(identity(snapshot), identity(bindingSnapshot.snapshot))) {
      bindingSnapshot = { token: randomUUID(), snapshot };
      candidateResult = null;
      candidateChoices.clear();
    }
    return {
      selection: publicSnapshot(snapshot.selection), appAvailable: appAvailable(snapshot),
      binding: bindingState(bindingSnapshot.token),
    };
  };
  async function discoverCandidates(input) {
    if (!visible) fail("semantic_view_suspended", "The semantic view is hidden.", 409);
    const captured = bindingSnapshot;
    if (!captured || input.bindingToken !== captured.token) {
      fail("semantic_binding_superseded", "Read this view's current target before reading candidates.", 409);
    }
    invalidate();
    const version = generation;
    const controller = new AbortController();
    pending = controller;
    try {
      const before = await capture({ signal: controller.signal });
      if (version !== generation || !sameIdentity(identity(before), identity(captured.snapshot))) {
        fail("semantic_binding_superseded", "The captured view or target changed before candidate enumeration.", 409);
      }
      publish({ status: "reading", ...exposeBinding(before) });
      const result = readCandidates ? await readCandidates(before, {
        signal: controller.signal,
        beforeDispatch() {
          if (version !== generation || !visible) fail("semantic_binding_superseded", "The candidate read was retired before dispatch.", 409);
        },
      }) : { available: false, candidates: null };
      const after = await capture({ signal: controller.signal });
      if (version !== generation) return state;
      if (!sameIdentity(identity(before), identity(after))) {
        fail("semantic_context_superseded", "The view, target or process changed while reading candidate advertisements.", 409);
      }
      const exposed = exposeBinding(after);
      candidateResult = result.available ? {
        discovery: "complete",
        candidates: result.candidates.map((candidate) => {
          const token = randomUUID();
          candidateChoices.set(token, publicSnapshot(candidate));
          return { ...candidate, token };
        }),
        message: result.candidates.length
          ? "Registered advertisements only. Choose an exact native instance; Verify and bind independently checks its live identity, target and canonical transport."
          : "No eligible native-instance advertisements were reported for this exact target. Device-only System inspection remains available.",
      } : {
        discovery: "unavailable", candidates: null,
        message: "Automatic candidate discovery is unavailable: the pinned CLI does not advertise the read-only agent candidates command. Enter exact native-instance IDs from trusted Ailoha registration evidence, or use device-only System inspection.",
      };
      completedIdentity = identity(after);
      return publish({ status: "ready", ...exposed, binding: bindingState(bindingSnapshot.token), error: null });
    } catch (error) {
      if (version !== generation) return state;
      bindingSnapshot = null;
      candidateChoices.clear();
      candidateResult = { discovery: "error", candidates: null,
        message: "Candidate inventory failed; this is not an empty registry. Read the current binding before retrying." };
      const failure = error instanceof MobileAilohaError ? error
        : new MobileAilohaError("semantic_candidates_failed", "The canonical registered-agent inventory could not be read.", 502);
      onError(failure);
      return publish({ status: "error", result: null, appAvailable: false, binding: bindingState(),
        error: { code: failure.code, message: failure.message, status: failure.status } });
    } finally {
      if (pending === controller) pending = null;
    }
  }
  async function changeBinding(input) {
    if (!visible) fail("semantic_view_suspended", "The semantic view is hidden.", 409);
    if (!bindNativeInstance) fail("semantic_binding_unavailable", "This host has no canonical native-instance binding adapter.", 501);
    const captured = bindingSnapshot;
    if (!captured || input.bindingToken !== captured.token) {
      fail("semantic_binding_superseded", "Read this view's current target before changing its native binding.", 409);
    }
    const binding = input.operation === "unbind" ? null : input.candidateToken
      ? candidateChoices.get(input.candidateToken) : { agentId: input.agentId, runtimeInstanceId: input.runtimeInstanceId };
    if (input.operation === "bind" && !binding) {
      fail("semantic_binding_superseded", "The candidate advertisement belongs to another or retired view read.", 409);
    }
    invalidate();
    const version = generation;
    const controller = new AbortController();
    pending = controller;
    try {
      const before = await capture({ signal: controller.signal });
      if (version !== generation || !sameIdentity(identity(before), identity(captured.snapshot))) {
        fail("semantic_binding_superseded", "The captured view or target changed before native binding.", 409);
      }
      publish({ status: "binding", selection: publicSnapshot(before.selection), binding: bindingState() });
      const after = await bindNativeInstance(binding
        ? { agentId: binding.agentId, runtimeInstanceId: binding.runtimeInstanceId } : null, before, {
        signal: controller.signal,
        beforeDispatch() {
          if (version !== generation || !visible) fail("semantic_binding_superseded", "The binding intent was retired before dispatch.", 409);
        },
      });
      if (version !== generation) return state;
      if (after.state !== "open" || !sameIdentity(bindingOwner(before), bindingOwner(after))
        || (after.selection?.agentId ?? null) !== (binding?.agentId ?? null)
        || (after.selection?.runtimeInstanceId ?? null) !== (binding?.runtimeInstanceId ?? null)
        || (input.operation === "bind" && after.contextProjection?.runtimeInstanceEvidence !== "verified-native-instance")) {
        fail("semantic_binding_mismatch", "The native binding read-back no longer matches the captured view, target and instance.", 409);
      }
      bindingRevoked = false;
      completedIdentity = identity(after);
      return publish({ status: "ready", ...exposeBinding(after), result: null, error: null });
    } catch (error) {
      if (version !== generation) return state;
      bindingRevoked = true;
      const failure = error instanceof MobileAilohaError ? error
        : new MobileAilohaError("semantic_binding_failed", "Canonical native binding failed. Read the current context before retrying.", 502);
      onError(failure);
      return publish({ status: "error", appAvailable: false, result: null, binding: bindingState(),
        error: { code: failure.code, message: failure.message, status: failure.status } });
    } finally {
      if (pending === controller) pending = null;
    }
  }
  async function request(method, body) {
    if (method === "DELETE") {
      const wasBinding = state.status === "binding";
      invalidate();
      return wasBinding ? publish({ error: { code: "semantic_binding_cancelled",
        message: "Native binding was cancelled. It may already be stored; read the current binding before retrying.", status: 409 } }) : state;
    }
    if (method === "GET") {
      if (body !== undefined) fail("semantic_invalid_request", "GET does not accept read arguments.");
      const version = generation;
      try {
        const snapshot = await capture();
        if (version !== generation || !visible) return state;
        if (completedIdentity && !sameIdentity(identity(snapshot), completedIdentity)) invalidate();
        return publish({
          ...exposeBinding(snapshot),
          status: state.status === "suspended" ? "suspended" : state.status,
        });
      } catch (error) {
        if (version !== generation || !visible) return state;
        invalidate();
        if (error.code === "semantic_target_unavailable") return state;
        bindingRevoked = true;
        const failure = error instanceof MobileAilohaError ? error
          : new MobileAilohaError("semantic_context_failed", "The canonical view context could not be read.", 502);
        onError(failure);
        return publish({ status: "error", error: { code: failure.code, message: failure.message, status: failure.status } });
      }
    }
    if (method !== "POST") fail("semantic_request_unsupported", "Use GET, POST or DELETE on the read-only semantic inspection route.");
    const input = inputOf(body);
    if (["candidates", "bind", "unbind"].includes(input.operation)) {
      try { return await (input.operation === "candidates" ? discoverCandidates(input) : changeBinding(input)); }
      catch (error) {
        if (!(error instanceof MobileAilohaError)) throw error;
        invalidate();
        onError(error);
        return publish({ status: "error", error: { code: error.code, message: error.message, status: error.status } });
      }
    }
    if (!visible) fail("semantic_view_suspended", "The semantic view is hidden.", 409);
    invalidate();
    const version = generation;
    const controller = new AbortController();
    pending = controller;
    let receiptSource;
    try {
      const before = await capture({ signal: controller.signal });
      if (input.lens === "app" && (!before.selection.runtimeInstanceId
        || before.contextProjection.runtimeInstanceEvidence !== "verified-native-instance")) {
        fail("semantic_app_unavailable", "No explicitly selected verified native instance exists in this named context. Workspace application IDs are not native agent bindings.", 409);
      }
      if (version !== generation) return state;
      publish({ status: "reading", lens: input.lens, operation: input.operation,
        ...exposeBinding(before) });
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
      const output = await callTool({ name, arguments: args, context: before.contextProjection,
        snapshot: before, scope, signal: controller.signal });
      receiptSource = output;
      const after = await capture({ signal: controller.signal });
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
      if (input.lens === "app") bindingRevoked = false;
      const provenance = {
        ownerProcessId: after.contextProjection.ownerProcessId,
        processStartedAt: after.contextProjection.processStartedAt,
        runtimeInstanceEvidence: after.contextProjection.runtimeInstanceEvidence,
      };
      const result = copyInvocationMetadata(output, publicSnapshot(input.operation === "status"
        ? { status: { running: output.running, agentName: output.agentName, framework: output.framework,
          capabilities: output.capabilities ?? null }, route, provenance }
        : { ...boundedElements(output.elements), geometryRevision: output.geometryRevision ?? null, route, provenance }));
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) {
        fail("semantic_invalid_response", "The canonical semantic result exceeds its 1 MiB projection bound.", 502);
      }
      return publish({
        status: "complete", ...exposeBinding(after),
        result,
        error: null,
      });
    } catch (error) {
      const failure = copyInvocationMetadata(receiptSource, error instanceof MobileAilohaError ? error
        : new MobileAilohaError(controller.signal.aborted ? "semantic_cancelled"
          : error?.code === -32001 ? "semantic_mcp_timeout" : "semantic_mcp_transport_failed",
          controller.signal.aborted ? "The semantic read was cancelled."
            : error?.code === -32001 ? "The canonical MCP inspection exceeded its deadline."
              : "The canonical MCP inspection transport failed.", 502));
      const errorState = copyInvocationMetadata(failure, {
        code: failure.code, message: failure.message, status: failure.status,
      });
      if (version !== generation) return invocationMetadata(failure)
        ? Object.freeze({ ...state, status: "error", result: null, selection: null, appAvailable: false, error: errorState }) : state;
      onError(failure);
      if (input.lens === "app" && failure.code !== "CanonicalCapabilityUnsupported") {
        bindingRevoked = true;
        bindingSnapshot = null;
      }
      return publish({ status: "error", result: null, ...(input.lens === "app" ? { appAvailable: false, binding: bindingState() } : {}),
        error: errorState });
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
