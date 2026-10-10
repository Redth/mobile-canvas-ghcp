import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
import { workspaceInspectionFixture } from "../scripts/fixtures/workspace-inspection-fixture.mjs";

const { createWorkspaceInspectionView } = await import(productModule("web/ailoha-workspace-view.js"));
const projectionSource = readFileSync(new URL("../../lib/ailoha/github-adapter.mjs", import.meta.url), "utf8");

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.attributes = {};
    this.hidden = false;
    this.classList = { toggle() {} };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text ?? "") + this.children.map((child) => child.textContent).join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.text = ""; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  closest() { return this; }
}

const state = (generation = 1, root = "/first-root", mode = "complete") => ({
  schema: "mobile-canvas.workspace-view/v1",
  scope: { sessionId: "renderer-session", viewId: "renderer-view" },
  generation, root, exclusions: ["ignored/**"], status: mode === "incomplete" ? "incomplete" : "complete",
  inspection: workspaceInspectionFixture(root, mode), error: null,
});

function fixture(t, options = {}) {
  const previous = globalThis.document;
  globalThis.document = { hidden: false, createElement: (tag) => new Element(tag) };
  t.after(() => { globalThis.document = previous; });
  const element = new Element("aside");
  const requests = [];
  const view = createWorkspaceInspectionView({
    element,
    request: options.request ?? (async (path, options) => { requests.push({ path, options }); return state(2); }),
    chooseRoot: options.chooseRoot ?? false,
  });
  return { element, view, requests };
}

function find(element, test) {
  if (test(element)) return element;
  for (const child of element.children) {
    const result = find(child, test);
    if (result) return result;
  }
}

test("shared app evidence uses semantic local details/text and never creates a selection or install action", (t) => {
  const { element, view, requests } = fixture(t);
  view.acceptState(state());
  assert.equal(element.dataset.status, "complete");
  assert.match(element.textContent, /installation not verified/);
  assert.match(element.textContent, /execution not verified/);
  assert.match(element.textContent, /release stripping not verified/);
  assert.match(element.textContent, /no device\/application association/);
  assert.equal(find(element, (node) => node.tag === "details").listeners.size, 0);
  const controls = [];
  const visit = (node) => {
    if (node.tag === "button") controls.push(node.textContent);
    for (const child of node.children) visit(child);
  };
  visit(element);
  assert.deepEqual(controls, ["Inspect"]);
  assert.equal(requests.length, 0);
  assert.equal(projectionSource.includes('name: "workspace_inspect"'), true);
});

test("renderer ignores other view/older-root results and clears old cards on hide/resume", (t) => {
  const { element, view } = fixture(t);
  view.acceptState(state(10));
  view.acceptState(state(9, "/obsolete"));
  view.acceptState({ ...state(11, "/wrong-view"), scope: { sessionId: "another", viewId: "renderer-view" } });
  assert.equal(element.dataset.generation, "10");
  assert.equal(element.textContent.includes("/wrong-view"), false);
  view.setVisible(false);
  assert.equal(element.hidden, true);
  view.acceptState(state(12, "/hidden-old-root"));
  view.setVisible(true);
  assert.equal(element.dataset.status, "ready");
  assert.equal(find(element, (node) => node.tag === "article"), undefined);
  assert.equal(element.textContent.includes("/hidden-old-root"), false);
  view.acceptState(state(10));
  assert.equal(find(element, (node) => node.tag === "article"), undefined);
  view.acceptState(state(13));
  assert.equal(find(element, (node) => node.tag === "article").dataset.applicationId.startsWith("app-"), true);
});

test("the clicked inspect button captures only its displayed generation, never root/context selectors", async (t) => {
  const { element, view, requests } = fixture(t);
  view.acceptState(state(7));
  find(element, (node) => node.tag === "button").listeners.get("click")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/v1/workspace/inspection");
  assert.deepEqual(JSON.parse(requests[0].options.body), { generation: 7 });
});

test("a delayed request cannot repaint after a newer root event or a hidden view", async (t) => {
  let resolve;
  const pending = new Promise((finish) => { resolve = finish; });
  const { element, view } = fixture(t, { request: () => pending });
  view.acceptState(state(5));
  const load = view.load();
  view.acceptState({ ...state(6, "/new-root"), status: "ready", inspection: null });
  resolve(state(5));
  await load;
  assert.equal(element.dataset.generation, "6");
  assert.equal(find(element, (node) => node.tag === "article"), undefined);
  view.setVisible(false);
  await view.load();
  view.setVisible(true);
  assert.equal(find(element, (node) => node.tag === "article"), undefined);
});

test("complete/incomplete/empty and XSS strings remain truthful plain-text evidence", (t) => {
  const { element, view } = fixture(t, { chooseRoot: true });
  view.acceptState(state(1, "/first-root", "incomplete"));
  assert.match(element.textContent, /Incomplete scan/);
  assert.match(element.textContent, /malformed-json/);
  assert.equal(find(element, (node) => node.textContent === "Choose workspace").tag, "button");
  view.acceptState(state(2, "/first-root", "empty"));
  assert.match(element.textContent, /No application candidates found/);
  view.acceptState(state(3, "/first-root", "xss"));
  assert.match(element.textContent, /<img src=x onerror=/);
  assert.equal(find(element, (node) => ["img", "script", "iframe"].includes(node.tag)), undefined);
  assert.throws(() => view.acceptState({ ...state(4), schema: "unknown" }), /Invalid workspace inspection response/);
});
