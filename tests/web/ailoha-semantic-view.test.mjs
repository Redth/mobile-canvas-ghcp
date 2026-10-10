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
