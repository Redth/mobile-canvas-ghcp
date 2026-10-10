const SCHEMA = "mobile-canvas.semantic-inspection/v1";
const STATUSES = new Set(["ready", "reading", "complete", "error", "suspended"]);

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
    || (value.error !== null && (typeof value.error?.code !== "string" || typeof value.error.message !== "string"))) {
    throw new Error("Invalid canonical semantic inspection view.");
  }
}

export function createSemanticInspectionView({ element, request }) {
  let state = null;
  let active = false;
  let visible = true;
  let version = 0;
  let retiredGeneration = -1;

  function render() {
    element.hidden = !active || !visible;
    element.closest(".workspace")?.classList.toggle("has-semantic-inspection", active && visible);
    if (!active || !visible) return;
    const header = node("div", "", "semantic-inspection-header");
    header.append(node("h2", "Live inspection"), node("span", "Read-only", "workspace-readonly-badge"));
    const lens = node("select", "");
    lens.setAttribute("aria-label", "Inspection lens");
    for (const name of ["system", "app"]) {
      const option = node("option", name === "app" ? "App (native instance)" : "System (Target Host)");
      option.value = name;
      lens.append(option);
    }
    lens.value = state?.lens ?? "system";
    const operation = node("select", "");
    operation.setAttribute("aria-label", "Inspection operation");
    for (const name of ["tree", "query", "status"]) {
      const option = node("option", name === "status" ? "Agent status" : name === "query" ? "Query elements" : "UI tree");
      option.value = name;
      operation.append(option);
    }
    operation.value = state?.operation ?? "tree";
    const filters = node("div", "", "semantic-inspection-filters");
    const fields = Object.fromEntries(["type", "automationId", "text"].map((name) => {
      const input = node("input", "");
      input.placeholder = { type: "Type", automationId: "Automation ID", text: "Text" }[name];
      input.setAttribute("aria-label", input.placeholder);
      input.maxLength = 128;
      return [name, input];
    }));
    filters.append(...Object.values(fields));
    const actions = node("div", "", "semantic-inspection-actions");
    const inspect = node("button", "Inspect", "button");
    inspect.type = "button";
    inspect.disabled = state?.status === "reading" || state?.status === "suspended";
    const cancel = node("button", "Cancel", "button");
    cancel.type = "button";
    cancel.hidden = state?.status !== "reading";
    actions.append(inspect, cancel);
    const message = state?.error ? `${state.error.code}: ${state.error.message}`
      : !state?.selection ? "Select a target to inspect its System UI."
        : lens.value === "app" && !state.appAvailable
          ? "App unavailable: no explicitly selected verified native instance in this named context. Workspace evidence cannot bind an agent."
          : state.status === "reading" ? "Reading canonical composed operation..."
            : "System is Target Host-owned. App requires an explicitly selected native instance; no automatic fallback.";
    const status = node("p", message, "semantic-inspection-status");
    status.setAttribute("role", "status");
    status.dataset.tone = state?.error ? "danger" : "neutral";
    const output = node("div", "", "semantic-inspection-output");
    if (state?.result) {
      const route = state.result.route;
      output.append(node("p", `${route.owner} / ${route.reason} / ${route.correlation}`));
      output.append(node("p", `Target ${route.targetHostId} / ${route.targetId}; surface ${route.surfaceId ?? "primary"}; context ${route.executionContext.contextRef} @ ${route.executionContext.scopeEpoch}:${route.executionContext.revision}`));
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
    element.replaceChildren(header, lens, operation, filters, actions, status, output);
    lens.addEventListener("change", () => {
      state = { ...state, lens: lens.value, operation: operation.value, result: null, error: null };
      render();
    });
    operation.addEventListener("change", () => {
      state = { ...state, operation: operation.value, lens: lens.value, result: null, error: null };
      render();
    });
    inspect.addEventListener("click", () => {
      const input = { lens: lens.value, operation: operation.value, maxDepth: 6 };
      if (input.operation === "query") {
        for (const [key, field] of Object.entries(fields)) if (field.value.trim()) input[key] = field.value.trim();
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
    state = value;
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
      state = { ...state, result: null, status: "error",
        error: { code: "semantic_request_failed", message: error instanceof Error ? error.message : "Semantic inspection failed." } };
      render();
    }
  }

  return Object.freeze({
    acceptState, load: () => perform(),
    setActive(value) { active = value; if (!value) version += 1; render(); },
    setVisible(value) {
      visible = value;
      version += 1;
      if (!value && state) {
        retiredGeneration = Math.max(retiredGeneration, state.generation);
        state = { ...state, result: null };
      }
      render();
    },
  });
}
