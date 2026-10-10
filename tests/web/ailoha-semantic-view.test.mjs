import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";

const { createSemanticInspectionView } = await import(productModule("web/ailoha-semantic-view.js"));
class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.attributes = {};
    this.classList = { toggle() {} };
    this.hidden = false;
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text ?? "") + this.children.map((child) => child.textContent).join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.text = ""; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  closest() { return this; }
}
function find(element, predicate) {
  if (predicate(element)) return element;
  for (const child of element.children) {
    const result = find(child, predicate);
    if (result) return result;
  }
}
const state = (generation = 1) => ({
  schema: "mobile-canvas.semantic-inspection/v1",
  scope: { sessionId: "test", viewId: "view" }, generation, status: "complete",
  selection: { targetHostId: "host", targetId: "target" }, appAvailable: false,
  lens: "system", operation: "tree", error: null,
  result: {
    elements: [{ id: "<svg/onload=alert(1)>", type: "Button", text: "<script>unsafe()</script>", children: [] }],
    route: { owner: "target-host", reason: "explicit-preference", correlation: "no-agent",
      targetHostId: "host", targetId: "target",
      executionContext: { contextRef: "ctx", scopeEpoch: "epoch", revision: "1" } },
  },
});

test("shared semantic renderer displays literal UI text and only read controls", (t) => {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag) };
  t.after(() => { globalThis.document = previous; });
  const element = new Element("aside");
  const requests = [];
  const view = createSemanticInspectionView({
    element, async request(path, options) { requests.push({ path, options }); return { ...state(2), result: null }; },
  });
  view.setActive(true);
  view.acceptState(state());
  assert.match(element.textContent, /<script>unsafe\(\)<\/script>/);
  assert.equal(find(element, (entry) => entry.tag === "script"), undefined);
  assert.match(element.textContent, /System is Target Host-owned/);
  const inspect = find(element, (entry) => entry.tag === "button" && entry.textContent === "Inspect");
  inspect.listeners.get("click")();
  assert.equal(requests[0].path, "/api/v1/semantic/inspection");
  assert.deepEqual(JSON.parse(requests[0].options.body), { lens: "system", operation: "tree", maxDepth: 6 });
  const lens = find(element, (entry) => entry.attributes?.["aria-label"] === "Inspection lens");
  lens.value = "app";
  lens.listeners.get("change")();
  assert.match(element.textContent, /App unavailable/);
  view.setVisible(false);
  assert.equal(element.hidden, true);
  view.setVisible(true);
  view.acceptState(state(0));
  assert.equal(element.textContent.includes("unsafe()"), false);
});

test("changing lens retires pending reads and retains query filters through events", async (t) => {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag) };
  t.after(() => { globalThis.document = previous; });
  const element = new Element("aside");
  const requests = [];
  let finishDelete;
  const view = createSemanticInspectionView({
    element, request(path, options) {
      requests.push({ path, options });
      if (options.method === "DELETE") return new Promise((resolve) => { finishDelete = resolve; });
      return Promise.resolve({ ...state(4), lens: "app", operation: "query", result: null });
    },
  });
  view.setActive(true);
  view.acceptState({ ...state(2), operation: "query", status: "reading", result: null });
  const text = find(element, (entry) => entry.attributes?.["aria-label"] === "Text");
  text.value = "submit";
  text.listeners.get("input")();
  const lens = find(element, (entry) => entry.attributes?.["aria-label"] === "Inspection lens");
  lens.value = "app";
  lens.listeners.get("change")();
  assert.equal(requests[0].options.method, "DELETE");
  view.acceptState(state(2));
  assert.doesNotMatch(element.textContent, /unsafe\(\)/);
  assert.equal(find(element, (entry) => entry.attributes?.["aria-label"] === "Text").value, "submit");
  finishDelete({ ...state(3), status: "ready", result: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(find(element, (entry) => entry.attributes?.["aria-label"] === "Inspection lens").value, "app");
  assert.equal(find(element, (entry) => entry.attributes?.["aria-label"] === "Text").value, "submit");
  const inspect = find(element, (entry) => entry.tag === "button" && entry.textContent === "Inspect");
  assert.equal(inspect.disabled, false);
  inspect.listeners.get("click")();
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    lens: "app", operation: "query", maxDepth: 6, text: "submit",
  });
  view.acceptState({ ...state(4), lens: "app", operation: "query", status: "complete", result: null });
  assert.equal(find(element, (entry) => entry.attributes?.["aria-label"] === "Text").value, "submit");
});

test("changing operation retires the previous tree response", async (t) => {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag) };
  t.after(() => { globalThis.document = previous; });
  const element = new Element("aside");
  const view = createSemanticInspectionView({
    element, async request() { return { ...state(3), status: "ready", result: null }; },
  });
  view.setActive(true);
  view.acceptState({ ...state(2), status: "reading", result: null });
  const operation = find(element, (entry) => entry.attributes?.["aria-label"] === "Inspection operation");
  operation.value = "status";
  operation.listeners.get("change")();
  view.acceptState(state(2));
  assert.doesNotMatch(element.textContent, /unsafe\(\)/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(find(element, (entry) => entry.attributes?.["aria-label"] === "Inspection operation").value, "status");
});
