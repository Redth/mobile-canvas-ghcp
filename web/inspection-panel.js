function node(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function stored(action) {
  try { return action(globalThis.localStorage); }
  catch (error) {
    if (!["SecurityError", "QuotaExceededError", "SyntaxError"].includes(error?.name)) throw error;
    console.warn("Mobile Canvas panel preferences could not be saved or restored.");
  }
}

export function createInspectionPanel({ element, kind, title, preferenceId }) {
  let preferences = { collapsed: true, width: 280, height: 200 };
  let storageKey;
  let drag;
  const workspace = element.closest(".workspace");
  for (const name of ["pointerdown", "pointermove", "pointerup", "pointercancel", "click", "wheel"]) {
    element.addEventListener(name, (event) => event.stopPropagation());
  }
  element.addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", " ", "Enter"].includes(event.key)) {
      event.stopPropagation();
    }
  });
  const header = node("div", "inspection-panel-header");
  const toggle = node("button", "inspection-panel-toggle");
  toggle.type = "button";
  toggle.append(node("span", "inspection-panel-title", title));
  const status = node("span", "inspection-panel-status");
  header.append(toggle, status);
  const body = node("div", "inspection-panel-body");
  body.id = `${kind}-panel-body`;
  toggle.setAttribute("aria-controls", body.id);
  const resize = node("div", "inspection-panel-resize");
  resize.tabIndex = 0;
  resize.setAttribute("role", "separator");
  resize.setAttribute("aria-label", `Resize ${title}`);
  element.replaceChildren(resize, header, body);

  const stacked = () => globalThis.matchMedia?.("(max-width: 760px)").matches ?? false;
  function bounds(vertical) {
    const available = vertical ? workspace?.clientHeight : workspace?.clientWidth;
    const min = vertical ? 96 : 180;
    return { min, max: Math.max(min, Math.min(360, available ? available * (vertical ? 0.32 : 0.36) : 360)) };
  }
  function apply() {
    const vertical = stacked();
    const { min, max } = bounds(vertical);
    preferences.width = Math.round(Math.max(bounds(false).min, Math.min(bounds(false).max, preferences.width)));
    preferences.height = Math.round(Math.max(bounds(true).min, Math.min(bounds(true).max, preferences.height)));
    element.dataset.collapsed = String(preferences.collapsed);
    body.hidden = preferences.collapsed;
    resize.hidden = preferences.collapsed;
    toggle.setAttribute("aria-expanded", String(!preferences.collapsed));
    toggle.setAttribute("aria-label", `${preferences.collapsed ? "Expand" : "Collapse"} ${title}`);
    resize.setAttribute("aria-orientation", vertical ? "horizontal" : "vertical");
    resize.setAttribute("aria-valuemin", String(Math.round(min)));
    resize.setAttribute("aria-valuemax", String(Math.round(max)));
    resize.setAttribute("aria-valuenow", String(vertical ? preferences.height : preferences.width));
    workspace?.style?.setProperty(`--${kind}-panel-inline-size`, preferences.collapsed ? "44px" : `${preferences.width}px`);
    workspace?.style?.setProperty(`--${kind}-panel-block-size`, preferences.collapsed ? "40px" : `${preferences.height}px`);
  }
  function save() {
    if (storageKey) stored((storage) => storage?.setItem(storageKey, JSON.stringify(preferences)));
  }
  toggle.addEventListener("click", () => {
    preferences.collapsed = !preferences.collapsed;
    apply();
    save();
  });
  resize.addEventListener("pointerdown", (event) => {
    if (preferences.collapsed || event.button !== 0) return;
    event.preventDefault();
    const vertical = stacked();
    drag = {
      pointerId: event.pointerId, vertical,
      coordinate: vertical ? event.clientY : event.clientX,
      size: vertical ? preferences.height : preferences.width,
    };
    resize.setPointerCapture(event.pointerId);
  });
  resize.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    preferences[drag.vertical ? "height" : "width"] = drag.size + drag.coordinate
      - (drag.vertical ? event.clientY : event.clientX);
    apply();
  });
  const finish = (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    drag = undefined;
    save();
  };
  resize.addEventListener("pointerup", finish);
  resize.addEventListener("pointercancel", finish);
  resize.addEventListener("keydown", (event) => {
    if (preferences.collapsed) return;
    const vertical = stacked();
    const { min, max } = bounds(vertical);
    const key = vertical ? "height" : "width";
    const delta = event.shiftKey ? 64 : 16;
    if (event.key === "Home") preferences[key] = min;
    else if (event.key === "End") preferences[key] = max;
    else if (["ArrowLeft", "ArrowUp"].includes(event.key)) preferences[key] += delta;
    else if (["ArrowRight", "ArrowDown"].includes(event.key)) preferences[key] -= delta;
    else return;
    event.preventDefault();
    apply();
    save();
  });
  globalThis.addEventListener?.("resize", apply);

  return {
    render(children, snapshot) {
      const identity = preferenceId?.() ?? (snapshot?.scope
        ? `${snapshot.scope.sessionId}:${snapshot.scope.viewId}` : null);
      const nextKey = identity ? `mobile-canvas-panel:${identity}:${kind}` : null;
      if (nextKey && nextKey !== storageKey) {
        storageKey = nextKey;
        preferences = { collapsed: true, width: 280, height: 200 };
        const saved = stored((storage) => {
          const value = storage?.getItem(storageKey);
          return value ? JSON.parse(value) : null;
        });
        if (saved && typeof saved.collapsed === "boolean"
          && Number.isFinite(saved.width) && Number.isFinite(saved.height)) preferences = saved;
      }
      status.textContent = snapshot?.status?.replaceAll("-", " ") ?? "";
      body.replaceChildren(...children);
      apply();
    },
  };
}
