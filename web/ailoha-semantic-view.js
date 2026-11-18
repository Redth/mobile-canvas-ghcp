const SCHEMA = "mobile-canvas.semantic-inspection/v1";
const STATUSES = new Set(["ready", "reading", "binding", "complete", "error", "suspended"]);

function node(tag, text, className = "") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function validate(value) {
  if (!value || value.schema !== SCHEMA || !Number.isSafeInteger(value.generation)
    || !STATUSES.has(value.status) || typeof value.scope?.sessionId !== "string"
    || typeof value.scope?.viewId !== "string" || typeof value.appAvailable !== "boolean"
    || (value.binding !== undefined && (typeof value.binding.available !== "boolean"
      || !["idle", "complete", "unavailable", "error"].includes(value.binding.discovery)
      || typeof value.binding.message !== "string"
      || (value.binding.token !== null && typeof value.binding.token !== "string")
      || (value.binding.candidates != null && (!Array.isArray(value.binding.candidates)
        || value.binding.candidates.length > 256 || value.binding.candidates.some((candidate) =>
          typeof candidate?.token !== "string" || typeof candidate.agentId !== "string"
          || typeof candidate.runtimeInstanceId !== "string")))))
    || (value.error !== null && (typeof value.error?.code !== "string" || typeof value.error.message !== "string"))) {
    throw new Error("Invalid canonical semantic inspection view.");
  }
}

export function createSemanticInspectionView({ element, request, preferenceId }) {
  const panel = createInspectionPanel({ element, kind: "semantic", title: "Live inspection", preferenceId });
  let state = null;
  let target = null;
  let active = false;
  let visible = true;
  let version = 0;
  let retiredGeneration = -1;
  let retiring = false;
  let chosenLens = null;
  let chosenOperation = null;
  const queryFilters = { type: "", automationId: "", text: "" };
  const bindingFields = { agentId: "", runtimeInstanceId: "" };
  let draftBindingToken = null;
  let chosenCandidateToken = "";

  function render() {
    element.hidden = !active || !visible;
    element.closest(".workspace")?.classList.toggle("has-semantic-inspection", active && visible);
    if (!active || !visible) return;
    const lens = node("select", "");
    lens.setAttribute("aria-label", "Inspection lens");
    for (const name of ["system", "app"]) {
      const option = node("option", name === "app" ? "App (native instance)" : "System (Target Host)");
      option.value = name;
      lens.append(option);
    }
    lens.value = chosenLens ?? state?.lens ?? "system";
    const operation = node("select", "");
    operation.setAttribute("aria-label", "Inspection operation");
    for (const name of ["tree", "query", "status"]) {
      const option = node("option", name === "status" ? "Agent status" : name === "query" ? "Query elements" : "UI tree");
      option.value = name;
      operation.append(option);
    }
    operation.value = chosenOperation ?? state?.operation ?? "tree";
    const filters = node("div", "", "semantic-inspection-filters");
    const fields = Object.fromEntries(["type", "automationId", "text"].map((name) => {
      const input = node("input", "");
      input.placeholder = { type: "Type", automationId: "Automation ID", text: "Text" }[name];
      input.setAttribute("aria-label", input.placeholder);
      input.maxLength = 128;
      input.value = queryFilters[name];
      input.addEventListener("input", () => { queryFilters[name] = input.value; });
      return [name, input];
    }));
    filters.append(...Object.values(fields));
    const actions = node("div", "", "semantic-inspection-actions");
    const inspect = node("button", "Inspect", "button");
    inspect.type = "button";
    const busy = retiring || ["reading", "binding", "suspended"].includes(state?.status);
    const systemUnavailable = lens.value === "system" && (!state?.selection
      || target?.id !== state.selection.targetId || target?.targetHostId !== state.selection.targetHostId
      || target?.isAvailable === false || target?.state !== "booted");
    inspect.disabled = busy || systemUnavailable;
    const cancel = node("button", "Cancel", "button");
    cancel.type = "button";
    cancel.hidden = !["reading", "binding"].includes(state?.status);
    actions.append(inspect, cancel);
    const message = state?.error ? `${state.error.code}: ${state.error.message}`
      : !state?.selection ? "Select a target to inspect its System UI."
        : systemUnavailable ? target?.unavailableReason ?? "Start an available target to inspect its live System UI."
        : lens.value === "app" && !state.appAvailable
          ? state.selection.runtimeInstanceId
            ? "App binding needs live re-verification. Verify and bind again or explicitly inspect App; System is never a fallback."
            : "App unavailable: verify and bind a running native instance. Choosing a project does not bind an agent."
          : state.status === "binding" ? "Verifying the explicit native binding with Ailoha..."
            : state.status === "reading" ? "Reading canonical composed operation..."
            : "System is Target Host-owned. App requires an explicitly selected native instance; no automatic fallback.";
    const status = node("p", message, "semantic-inspection-status");
    status.setAttribute("role", "status");
    status.dataset.tone = state?.error ? "danger" : "neutral";
    const output = node("div", "", "semantic-inspection-output");
    if (state?.result) {
      const route = state.result.route;
      output.append(node("p", `${route.owner} / ${route.reason} / ${route.correlation}`));
      output.append(node("p", `Target ${route.targetHostId} / ${route.targetId}; surface ${route.surfaceId ?? "not selected"}; context ${route.executionContext.contextRef} @ ${route.executionContext.scopeEpoch}:${route.executionContext.revision}`));
      if (state.result.provenance?.ownerProcessId) {
        output.append(node("p", `View owner process ${state.result.provenance.ownerProcessId} started ${state.result.provenance.processStartedAt}; native evidence ${state.result.provenance.runtimeInstanceEvidence}`));
      }
      if (route.owner === "agent" && route.runtimeInstanceId) output.append(node("p", `Native runtime ${route.runtimeInstanceId}; agent ${route.agentId ?? "unreported"}`));
      if (state.result.status) {
        output.append(node("pre", JSON.stringify(state.result.status, null, 2)));
      } else {
        function appendElements(elements, depth = 0) {
          for (const item of elements) {
            output.append(node("div", `${"  ".repeat(depth)}${item.type} [${item.id}] ${item.automationId ?? ""} ${item.text ?? ""}`, "semantic-element"));
            appendElements(item.children, depth + 1);
          }
        }
        appendElements(state.result.elements);
        if (state.result.truncated) output.append(node("p", "Tree truncated at the view's 300-element / 16-level bound."));
      }
    }
    const binding = node("div", "", "semantic-native-binding");
    binding.setAttribute("role", "group");
    binding.setAttribute("aria-label", "Optional native app-agent binding");
    binding.append(node("h2", "Native app agent (optional)"));
    binding.append(node("p", "Leave unbound for device-only System inspection. Binding changes this named view's context only; it does not launch or install an app."));
    if (state?.selection) binding.append(node("p", `Selected target ${state.selection.targetHostId} / ${state.selection.targetId}; surface ${state.selection.surfaceId ?? "not selected"}.`));
    binding.append(node("p", state?.binding?.message ?? "Native binding is unavailable in this host."));
    const bindingToken = state?.binding?.token ?? null;
    if (draftBindingToken !== bindingToken) {
      bindingFields.agentId = "";
      bindingFields.runtimeInstanceId = "";
      chosenCandidateToken = "";
      draftBindingToken = bindingToken;
    }
    const ids = node("div", "", "semantic-inspection-filters");
    const discover = node("button", "Read registered candidates", "button");
    discover.type = "button";
    discover.disabled = busy || !bindingToken || !state?.selection;
    const candidates = node("select", "");
    candidates.setAttribute("aria-label", "Registered native instance");
    const placeholder = node("option", "Choose a native instance...");
    placeholder.value = "";
    candidates.append(placeholder);
    for (const candidate of state?.binding?.candidates ?? []) {
      const option = node("option", `${candidate.runtimeInstanceId} / ${candidate.agentId}`);
      option.value = candidate.token;
      candidates.append(option);
    }
    candidates.value = chosenCandidateToken;
    candidates.disabled = busy || !bindingToken || !state?.binding?.candidates?.length;
    const bindCandidate = node("button", "Verify selected candidate", "button");
    bindCandidate.type = "button";
    bindCandidate.disabled = busy || !state?.binding?.available || !bindingToken || !chosenCandidateToken;
    candidates.addEventListener("change", () => {
      chosenCandidateToken = candidates.value;
      bindCandidate.disabled = busy || !state?.binding?.available || !chosenCandidateToken;
    });
    discover.addEventListener("click", () => {
      void perform("POST", { operation: "candidates", bindingToken });
    });
    bindCandidate.addEventListener("click", () => {
      void perform("POST", { operation: "bind", bindingToken, candidateToken: chosenCandidateToken });
    });
    const candidateActions = node("div", "", "semantic-inspection-actions");
    candidateActions.append(discover, candidates, bindCandidate);
    const bind = node("button", "Verify and bind", "button");
    bind.type = "button";
    const canBind = () => Boolean(!busy && state?.selection && state?.binding?.available && bindingToken
      && /^[A-Za-z0-9_-]{1,128}$/.test(bindingFields.runtimeInstanceId)
      && bindingFields.agentId === `agent-${bindingFields.runtimeInstanceId}`);
    for (const [key, labelText] of [["runtimeInstanceId", "Runtime instance ID"], ["agentId", "Agent ID"]]) {
      const label = node("label", labelText);
      const input = node("input", "");
      input.setAttribute("aria-label", labelText);
      input.maxLength = key === "runtimeInstanceId" ? 128 : 134;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.value = bindingFields[key];
      input.disabled = busy || !state?.selection || !state?.binding?.available || !bindingToken;
      input.addEventListener("input", () => {
        bindingFields[key] = input.value;
        bind.disabled = !canBind();
      });
      label.append(input);
      ids.append(label);
    }
    bind.disabled = !canBind();
    const unbind = node("button", "Clear native binding", "button");
    unbind.type = "button";
    unbind.disabled = busy || !state?.binding?.available || !bindingToken || !state?.selection?.runtimeInstanceId;
    const refresh = node("button", "Read current binding", "button");
    refresh.type = "button";
    refresh.disabled = busy;
    const bindingActions = node("div", "", "semantic-inspection-actions");
    bindingActions.append(bind);
    const manual = node("details", "");
    manual.append(node("summary", "Enter exact native IDs"), ids, bindingActions);
    const contextActions = node("div", "", "semantic-inspection-actions");
    contextActions.append(unbind, refresh);
    binding.append(candidateActions, manual, contextActions);
    if (state?.selection?.runtimeInstanceId) {
      binding.append(node("p", `Native runtime ${state.selection.runtimeInstanceId}; agent ${state.selection.agentId ?? "unreported"}; ${state.appAvailable ? "verified native instance" : "requires re-verification"}. Workspace application: not correlated.`));
    }
    bind.addEventListener("click", () => {
      void perform("POST", { operation: "bind", bindingToken,
        runtimeInstanceId: bindingFields.runtimeInstanceId, agentId: bindingFields.agentId });
    });
    unbind.addEventListener("click", () => { void perform("POST", { operation: "unbind", bindingToken }); });
    refresh.addEventListener("click", () => { void perform(); });
    panel.render([lens, operation, filters, actions, status, binding, output], state);
    function changeSelection() {
      chosenLens = lens.value;
      chosenOperation = operation.value;
      if (state) retiredGeneration = Math.max(retiredGeneration, state.generation);
      retiring = true;
      if (state) state = { ...state, lens: chosenLens, operation: chosenOperation,
        status: "ready", result: null, error: null };
      render();
      void perform("DELETE");
    }
    lens.addEventListener("change", () => {
      changeSelection();
    });
    operation.addEventListener("change", () => {
      changeSelection();
    });
    inspect.addEventListener("click", () => {
      if (inspect.disabled) return;
      const input = { lens: lens.value, operation: operation.value, maxDepth: 6 };
      if (input.operation === "query") {
        for (const [key, value] of Object.entries(queryFilters)) if (value.trim()) input[key] = value.trim();
      }
      void perform("POST", input);
    });
    cancel.addEventListener("click", () => { void perform("DELETE"); });
  }

  function acceptState(value) {
    validate(value);
    if (state && (state.scope.sessionId !== value.scope.sessionId || state.scope.viewId !== value.scope.viewId
      || value.generation < state.generation)) return;
    if (value.generation <= retiredGeneration && value.status !== "suspended") return;
    if (!visible) return;
    state = { ...value, lens: chosenLens ?? value.lens, operation: chosenOperation ?? value.operation,
      result: chosenLens && value.lens !== chosenLens || chosenOperation && value.operation !== chosenOperation
        ? null : value.result };
    render();
  }

  async function perform(method = "GET", input) {
    const current = ++version;
    try {
      const value = await request("/api/v1/semantic/inspection", {
        method, ...(input ? { body: JSON.stringify(input) } : {}),
      });
      if (current === version && visible) acceptState(value);
    } catch (error) {
      if (current !== version || !visible) return;
      state = { ...state, result: null, appAvailable: false,
        ...(state?.binding ? { binding: { ...state.binding, token: null, candidates: null } } : {}),
        status: "error",
        error: { code: "semantic_request_failed", message: "Semantic inspection request failed." } };
      render();
    } finally {
      if (method === "DELETE" && current === version) {
        retiring = false;
        render();
      }
    }
  }

  return Object.freeze({
    acceptState, load: () => perform(),
    setTarget(value) { target = value; render(); },
    setActive(value) { active = value; if (!value) version += 1; render(); },
    setVisible(value) {
      visible = value;
      version += 1;
      if (!value && state) {
        retiredGeneration = Math.max(retiredGeneration, state.generation);
        state = { ...state, result: null, appAvailable: false,
          ...(state.binding ? { binding: { ...state.binding, token: null, candidates: null } } : {}) };
      }
      render();
    },
  });
}
import { createInspectionPanel } from "./inspection-panel.js";
