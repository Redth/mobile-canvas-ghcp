import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";

const { createAilohaSystemUiAdapter } =
  await import(productModule("lib/ailoha/system-ui-adapter.mjs"));

const invocation = {
  targetId: "target/one", providerId: "provider", surfaceId: "surface/one",
  nativeIdentity: { platform: "ios", nativeId: "native-one" },
  geometry: { geometryRevision: 7 },
};
const targetHost = {
  targetId: invocation.targetId, providerId: invocation.providerId,
  surfaceId: invocation.surfaceId, geometryRevision: 7,
};
const node = (label, frame = { x: 10, y: 20, width: 40, height: 60 }, children = []) => ({
  role: "button", rawRole: "AXButton", label, value: null, identifier: "save",
  hint: "Save changes", frame, enabled: true, focused: false,
  interactable: frame !== null, children,
});
const root = node("Root", null, [node("Save", null), node("Save", undefined, [node("Save")])]);
const asResponse = (body, status = 200) => ({ status, contentType: "application/json; charset=utf-8", body });

function fixture(respond) {
  const calls = [];
  const adapter = createAilohaSystemUiAdapter({
    signal: new AbortController().signal,
    transport: {
      async response(path, options) {
        calls.push({ path, options });
        return respond(path, options);
      },
    },
  });
  return { adapter, calls };
}

test("reviewed System surface snapshot projects legacy nullable frames, raw bytes and full node count", async () => {
  const { adapter, calls } = fixture(() => asResponse({
    targetId: invocation.targetId, targetHost, platform: "ios",
    root, elementCount: 4, raw: "é😀", uiRevision: "revision-a",
  }));
  const dump = await adapter.snapshot(invocation, true);
  assert.deepEqual(Object.keys(dump), ["schemaVersion", "deviceId", "platform", "root", "elementCount", "raw", "uiRevision"]);
  assert.equal(dump.schemaVersion, "1.0");
  assert.equal(dump.elementCount, 4);
  assert.equal(dump.root.frame, null);
  assert.equal(dump.root.children[0].rawRole, "AXButton");
  assert.equal(dump.root.children[0].frame, null);
  assert.deepEqual(dump.root.children[1].frame, {
    x: 10, y: 20, width: 40, height: 60, centerX: 30, centerY: 50,
  });
  assert.deepEqual(dump.root.children[1].children[0].frame, {
    x: 10, y: 20, width: 40, height: 60, centerX: 30, centerY: 50,
  });
  assert.equal(dump.raw, "é😀");
  assert.equal(calls[0].path,
    "/api/v1/targets/target%2Fone/surfaces/surface%2Fone/ui/system-snapshot?includeRaw=true");
  assert.equal(calls[0].options.method, "GET");
});

test("native find retains full total, child paths, null-frame zero centers and exact query", async () => {
  const { adapter, calls } = fixture(() => asResponse({
    targetId: invocation.targetId, targetHost, total: 3, uiRevision: "revision-a",
    matches: [
      { path: "0", element: node("Save", null) },
      { path: "1/0", element: node("Save"), centerX: 30, centerY: 50 },
    ],
  }));
  const found = await adapter.find(invocation, {
    text: "Save", identifier: "save", role: "AXButton", exact: true, limit: 2,
  });
  assert.equal(found.total, 3);
  assert.deepEqual(found.matches.map(({ path, centerX, centerY }) => [path, centerX, centerY]),
    [["0", 0, 0], ["1/0", 30, 50]]);
  assert.equal(found.matches[0].element.frame, null);
  assert.deepEqual(found.matches[1].element.frame, {
    x: 10, y: 20, width: 40, height: 60, centerX: 30, centerY: 50,
  });
  const url = new URL(calls[0].path, "http://example.invalid");
  assert.equal(url.pathname, "/api/v1/targets/target%2Fone/surfaces/surface%2Fone/ui/system-elements");
  assert.equal(url.searchParams.get("role"), "AXButton");
  assert.equal(url.searchParams.get("exact"), "true");
  assert.equal(url.searchParams.get("interactableOnly"), "false");
  assert.equal(url.searchParams.get("geometryRevision"), "7");
  assert.equal(adapter.validateQuery({ text: "Save", limit: 0 }).limit, 0);
  assert.equal(calls.length, 1);
});

test("native query admits large signed-int32 legacy limits without silent 256 truncation", async () => {
  const nativeMatches = Array.from({ length: 300 }, (_, index) => ({
    path: `1/${index}`, element: node("Save"), centerX: 30, centerY: 50,
  }));
  const { adapter, calls } = fixture(() => asResponse({
    targetId: invocation.targetId, targetHost, total: 321, uiRevision: "revision-a",
    matches: nativeMatches,
  }));
  const found = await adapter.find(invocation, { text: "Save", limit: 300 });
  assert.equal(found.total, 321);
  assert.equal(found.matches.length, 300);
  assert.equal(found.matches.at(-1).path, "1/299");
  assert.equal(new URL(calls[0].path, "http://example.invalid").searchParams.get("limit"), "300");
  assert.equal(adapter.validateQuery({ text: "Save", limit: -2147483648 }).limit, -2147483648);
  assert.equal(adapter.validateQuery({ text: "Save", limit: 2147483647 }).limit, 2147483647);
  for (const limit of [-2147483649, 2147483648, 1.5]) {
    await assert.rejects(adapter.find(invocation, { text: "Save", limit }), { code: "invalid_request" });
  }
  assert.equal(calls.length, 1);
});

test("nonpositive find limit reaches native unchanged and accepts the legacy one-match result", async () => {
  const { adapter, calls } = fixture(() => asResponse({
    targetId: invocation.targetId, targetHost, total: 300, uiRevision: "revision-a",
    matches: [{ path: "0", element: node("Save"), centerX: 30, centerY: 50 }],
  }));
  for (const limit of [0, -12, -2147483648]) {
    const found = await adapter.find(invocation, { text: "Save", limit });
    assert.equal(found.total, 300);
    assert.equal(found.matches.length, 1);
  }
  assert.deepEqual(calls.map(({ path }) =>
    new URL(path, "http://example.invalid").searchParams.get("limit")), ["0", "-12", "-2147483648"]);
});

test("native tap sends revision-fenced fresh selector, never a client coordinate tap", async () => {
  const { adapter, calls } = fixture(() => asResponse({
    targetId: invocation.targetId, targetHost, total: 2, uiRevision: "revision-a",
    match: { path: "1", element: node("Save"), centerX: 30, centerY: 50 },
  }));
  const tapped = await adapter.tap(invocation, { text: "Save", interactableOnly: false }, "revision-a");
  assert.deepEqual(Object.keys(tapped), ["schemaVersion", "success", "deviceId", "match", "total"]);
  assert.equal(tapped.total, 2);
  assert.deepEqual(tapped.match.element.frame, {
    x: 10, y: 20, width: 40, height: 60, centerX: 30, centerY: 50,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /\/ui\/system-elements\/actions\/tap$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    text: "Save", exact: false, interactableOnly: false, limit: 1,
    uiRevision: "revision-a", geometryRevision: 7,
  });
});

test("malformed, cross-owner, stale, missing-frame and oversized native replies fail closed", async () => {
  const base = { targetId: invocation.targetId, targetHost, total: 1, uiRevision: "revision-a",
    match: { path: "0", element: node("Save"), centerX: 30, centerY: 50 } };
  for (const change of [
    { targetHost: { ...targetHost, surfaceId: "other" } },
    { uiRevision: "revision-b" },
    { match: { path: "0.1", element: node("Save") } },
    { match: { path: "0", element: node("Save", null) } },
    { match: { path: "0", element: node("Save"), centerX: 100 } },
  ]) {
    const { adapter } = fixture(() => asResponse({ ...base, ...change }));
    await assert.rejects(adapter.tap(invocation, { text: "Save" }, "revision-a"),
      { code: "invalid_system_ui_response" });
  }
  const { adapter: oversized } = fixture(() => asResponse({
    targetId: invocation.targetId, targetHost, platform: "ios", root: null,
    elementCount: 0, raw: "😀".repeat(262145), uiRevision: "revision-a",
  }));
  await assert.rejects(oversized.snapshot(invocation, true), { code: "invalid_system_ui_response" });
  const { adapter: brokenCount } = fixture(() => asResponse({
    targetId: invocation.targetId, targetHost, platform: "ios", root,
    elementCount: 3, uiRevision: "revision-a",
  }));
  await assert.rejects(brokenCount.snapshot(invocation), { code: "invalid_system_ui_response" });
  const { adapter: oversizedBody } = fixture(() => asResponse({
    targetId: invocation.targetId, targetHost, platform: "ios",
    root: node("x".repeat(16 * 1024 * 1024)), elementCount: 1, uiRevision: "revision-a",
  }));
  await assert.rejects(oversizedBody.snapshot(invocation), { code: "invalid_system_ui_response" });
});
