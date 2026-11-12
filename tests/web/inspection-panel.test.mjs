import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
const { createInspectionPanel } = await import(productModule("web/inspection-panel.js"));

class Element {
  constructor() {
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this.dataset = {};
    this.style = { setProperty() {} };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  closest() { return this.workspace; }
  setPointerCapture() {}
}
const find = (element, className) => element.className === className ? element
  : element.children.map((child) => find(child, className)).find(Boolean);

function fixture(t) {
  const saved = new Map();
  const previous = { document: globalThis.document, localStorage: globalThis.localStorage, matchMedia: globalThis.matchMedia };
  let stacked = false;
  globalThis.document = { createElement: () => new Element() };
  globalThis.localStorage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  globalThis.matchMedia = () => ({ matches: stacked });
  t.after(() => Object.assign(globalThis, previous));
  const workspace = { clientWidth: 1200, clientHeight: 700, style: { setProperty() {} } };
  const create = (kind, identity = "github:view:host") => {
    const element = new Element();
    element.workspace = workspace;
    const panel = createInspectionPanel({ element, kind, title: kind === "workspace" ? "Workspace" : "Live inspection", preferenceId: () => identity });
    const content = new Element();
    content.textContent = "Retained inspection result";
    panel.render([content], { status: "complete" });
    return { element, panel, content, toggle: find(element, "inspection-panel-toggle"), resize: find(element, "inspection-panel-resize") };
  };
  const event = (extra = {}) => ({ preventDefault() {}, stopPropagation() {}, ...extra });
  return { create, saved, event, stacked: () => { stacked = true; } };
}

for (const host of ["github", "vscode"]) {
  test(`${host} shared panels collapse and resize independently, retain content and persist only scoped UI preferences`, (t) => {
    const state = fixture(t);
    const project = state.create("workspace", `${host}:view:host`);
    const live = state.create("semantic", `${host}:view:host`);
    assert.equal(project.element.dataset.collapsed, "true");
    assert.equal(live.element.dataset.collapsed, "true");
    project.toggle.listeners.get("click")();
    assert.equal(project.toggle.attributes["aria-expanded"], "true");
    assert.equal(live.element.dataset.collapsed, "true");
    assert.equal(find(project.element, "inspection-panel-body").children[0], project.content);
    project.resize.listeners.get("keydown")(state.event({ key: "End" }));
    assert.equal(project.resize.attributes["aria-valuenow"], "360");
    project.resize.listeners.get("keydown")(state.event({ key: "Home" }));
    assert.equal(project.resize.attributes["aria-valuenow"], "180");
    project.resize.listeners.get("pointerdown")(state.event({ button: 0, pointerId: 2, clientX: 500 }));
    project.resize.listeners.get("pointermove")(state.event({ pointerId: 2, clientX: 450 }));
    project.resize.listeners.get("pointerup")(state.event({ pointerId: 2 }));
    assert.equal(project.resize.attributes["aria-valuenow"], "230");
    const restored = state.create("workspace", `${host}:view:host`);
    assert.equal(restored.element.dataset.collapsed, "false");
    assert.equal(restored.resize.attributes["aria-valuenow"], "230");
    assert.equal(state.create("workspace", `${host}:other-view:host`).element.dataset.collapsed, "true");
    for (const value of state.saved.values()) assert.deepEqual(Object.keys(JSON.parse(value)).sort(), ["collapsed", "height", "width"]);
    state.stacked();
    restored.panel.render([restored.content], { status: "complete" });
    assert.equal(restored.resize.attributes["aria-orientation"], "horizontal");
    restored.resize.listeners.get("keydown")(state.event({ key: "Home" }));
    assert.equal(restored.resize.attributes["aria-valuenow"], "96");
    assert.equal(find(restored.element, "inspection-panel-body").children[0], restored.content);
  });
}

test("panel pointer/collapse/resize and keyboard events cannot escape to device input handlers", (t) => {
  const state = fixture(t);
  const panel = state.create("semantic");
  let stopped = 0;
  for (const name of ["pointerdown", "pointermove", "pointerup", "pointercancel", "click", "wheel"]) {
    panel.element.listeners.get(name)(state.event({ stopPropagation() { stopped += 1; } }));
  }
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", " ", "Enter"]) {
    panel.element.listeners.get("keydown")(state.event({ key, stopPropagation() { stopped += 1; } }));
  }
  assert.equal(stopped, 14);
});
