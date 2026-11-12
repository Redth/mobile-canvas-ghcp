import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";

const { createAilohaControlAdapter } = await import(productModule("lib/ailoha/control-adapter.mjs"));

const invocation = {
  targetId: "target/one", surfaceId: "surface/one", providerId: "provider",
  nativeIdentity: { platform: "ios" }, geometry: { geometryRevision: 14 },
};
const base = "/api/v1/targets/target%2Fone";
const surface = `${base}/surfaces/surface%2Fone`;
const owner = { targetId: invocation.targetId, providerId: invocation.providerId, surfaceId: invocation.surfaceId, geometryRevision: 14 };
const reply = (body) => ({ status: 200, contentType: "application/json; charset=utf-8", body });
const action = reply({ success: true, "x-ailoha-target-host": owner });
const status = reply({ namespace: "status-bar", values: { enabled: true, readable: true, time: "09:41" },
  "x-ailoha-target-host": { targetId: invocation.targetId } });

function fixture(responses = {}) {
  const calls = [];
  const adapter = createAilohaControlAdapter({ transport: {
    async response(path, options) {
      calls.push({ path, options });
      if (Object.hasOwn(responses, path)) {
        const result = responses[path];
        return typeof result === "function" ? result() : result;
      }
      if (path.endsWith("/ui/tree?depth=64")) return reply([{
        id: "focused/field", role: "field",
        state: { focused: true, displayed: true, enabled: true }, children: [],
        "x-ailoha-target-host": owner,
      }]);
      return path.endsWith("/settings/status-bar") ? status
        : path.endsWith("/presentation")
          ? reply({ width: 48, height: 32, density: 2, orientation: "landscape",
            "x-ailoha-target-host": { targetId: invocation.targetId } })
          : action;
    },
  } });
  return { adapter, calls };
}

test("advertises only target and surface operations actually available", () => {
  const { adapter } = fixture();
  const capabilities = [
    { id: "surface.input", version: 1, features: ["pressTargetKey", "fillTargetElement"] },
    { id: "surface.ui", version: 1, features: ["getTargetUiTree"] },
    { id: "target.presentation", version: 1, features: ["updateTargetPresentation"] },
    { id: "target.settings", version: 1, features: ["getTargetSettings", "updateTargetSettings"] },
  ];
  const actual = { capabilities: [
    { id: "surface.input", version: 1, features: ["key", "button", "text", "rotate"] },
  ] };
  assert.deepEqual(adapter.supported(capabilities, actual),
    { key: true, button: true, text: false, rotate: true, presentation: true });
  const focused = capabilities.map((capability) => capability.id === "surface.input"
    ? { ...capability, features: [...capability.features, "typeFocusedText"] } : capability);
  assert.equal(adapter.supported(focused, actual).text, true);
  assert.equal(adapter.supported(focused, { capabilities: [] }).text, false);
  assert.equal(adapter.supported(focused, { capabilities: [
    { id: "surface.input", version: 1, features: ["key", "button", "rotate"] },
  ] }).text, false);
  assert.deepEqual(adapter.supported(capabilities, { capabilities: [] }),
    { key: false, button: false, text: false, rotate: false, presentation: true });
  assert.equal(adapter.supported([], actual).presentation, false);
});

test("focused text uses only the distinct canonical route and captured owner", async () => {
  const { adapter, calls } = fixture();
  let checks = 0;
  const literal = `a'b";\n\u2603`;
  await adapter.text(invocation, literal, () => { checks++; });
  assert.equal(checks, 1);
  assert.deepEqual(calls.map(({ path, options }) => [path, options.method, JSON.parse(options.body)]), [
    [`${surface}/input/actions/type-focused-text`, "POST", { text: literal }],
  ]);
  const changed = fixture();
  await assert.rejects(changed.adapter.text(invocation, "text", () => {
    throw new Error("view superseded");
  }), /view superseded/);
  assert.equal(changed.calls.length, 0);
  const wrong = fixture({ [`${surface}/input/actions/type-focused-text`]: reply({
    success: true, "x-ailoha-target-host": { ...owner, surfaceId: "another-surface" },
  }) });
  await assert.rejects(wrong.adapter.text(invocation, "text", () => {}), { code: "control_owner_mismatch" });
  assert.equal(wrong.calls.length, 1);
  const incomplete = fixture({ [`${surface}/input/actions/type-focused-text`]: reply({
    success: true, "x-ailoha-target-host": { targetId: invocation.targetId, surfaceId: invocation.surfaceId },
  }) });
  await assert.rejects(incomplete.adapter.text(invocation, "text", () => {}), { code: "invalid_control_response" });
  assert.equal(incomplete.calls.length, 1);
  const failed = fixture({ [`${surface}/input/actions/type-focused-text`]: reply({
    success: false, "x-ailoha-target-host": owner,
  }) });
  await assert.rejects(failed.adapter.text(invocation, "text", () => {}), { code: "input_operation_failed" });
  assert.equal(failed.calls.length, 1);
  const unknown = fixture({ [`${surface}/input/actions/type-focused-text`]: () => {
    throw new Error("uncertain delivery");
  } });
  await assert.rejects(unknown.adapter.text(invocation, "text", () => {}), /uncertain delivery/);
  assert.equal(unknown.calls.length, 1);
  for (const text of ["", "\0", "a\0b", "\uD800", "\uDC00", "é".repeat(2049)]) {
    await assert.rejects(adapter.text(invocation, text, () => {}), { code: "invalid_request" });
  }
  await adapter.text(invocation, "é".repeat(2048), () => {});
  assert.equal(calls.length, 2);
});

test("key and button use structured canonical key requests, not host commands", async () => {
  const { adapter, calls } = fixture();
  await adapter.key(invocation, 40);
  await adapter.button(invocation, "HOME");
  await adapter.button(invocation, "SIDE");
  assert.deepEqual(calls.map(({ path, options }) => [path, options.method, JSON.parse(options.body)]), [
    [`${surface}/input/actions/key`, "POST", { key: "40" }],
    [`${surface}/input/actions/key`, "POST", { key: "home" }],
    [`${surface}/input/actions/key`, "POST", { key: "side" }],
  ]);
  const android = fixture();
  for (const alias of ["APP-SWITCH", "Recents", "VolumeUp", "VOLUMEDOWN"]) {
    await android.adapter.button({ ...invocation, nativeIdentity: { platform: "android" } }, alias);
  }
  assert.deepEqual(android.calls.map(({ options }) => JSON.parse(options.body).key),
    ["app-switch", "recents", "volumeup", "volumedown"]);
  await assert.rejects(adapter.button(invocation, "recents"), { code: "invalid_request" });
  await assert.rejects(android.adapter.button(
    { ...invocation, nativeIdentity: { platform: "android" } }, "siri"), { code: "invalid_request" });
  await assert.rejects(adapter.key(invocation, -1), { code: "invalid_request" });
  await assert.rejects(adapter.button(invocation, "home; echo unsafe"), { code: "invalid_request" });
  assert.equal(calls.length, 3);
});

test("fill is restricted to an explicitly named owned editable element and bounded literal JSON", async () => {
  const { adapter, calls } = fixture();
  let checked = 0;
  await adapter.fillElement(invocation, "focused/field", `a'b";\n\u2603`, () => { checked++; });
  assert.equal(checked, 1);
  assert.deepEqual(calls.map(({ path }) => path), [
    `${surface}/ui/tree?depth=64`, `${surface}/input/actions/fill`,
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), { elementId: "focused/field", text: `a'b";\n\u2603` });
  const stale = fixture({ [`${surface}/ui/tree?depth=64`]: reply([{
    id: "field", state: { focused: true }, "x-ailoha-target-host": { ...owner, geometryRevision: 13 },
  }]) });
  await assert.rejects(stale.adapter.fillElement(invocation, "field", "text", () => {}), { code: "control_owner_mismatch" });
  assert.equal(stale.calls.length, 1);
  const missing = fixture({ [`${surface}/ui/tree?depth=64`]: reply([]) });
  await assert.rejects(missing.adapter.fillElement(invocation, "focused/field", "text", () => {}), { code: "element_unavailable" });
  assert.equal(missing.calls.length, 1);
  const wrongRole = fixture({ [`${surface}/ui/tree?depth=64`]: reply([{
    id: "focused/field", role: "button", state: { focused: true, displayed: true, enabled: true },
    "x-ailoha-target-host": owner,
  }]) });
  await assert.rejects(wrongRole.adapter.fillElement(invocation, "focused/field", "text", () => {}), { code: "element_unavailable" });
  assert.equal(wrongRole.calls.length, 1);
  const changed = fixture();
  await assert.rejects(changed.adapter.fillElement(invocation, "focused/field", "text", () => {
    throw new Error("view superseded");
  }), /view superseded/);
  assert.equal(changed.calls.length, 1);
  await assert.rejects(adapter.fillElement(invocation, "focused/field", "x".repeat(33 * 1024), () => {}), { code: "invalid_request" });
  await assert.rejects(adapter.fillElement(invocation, "", "text", () => {}), { code: "invalid_request" });
  assert.equal(calls.length, 2);
});

test("rotation confirms presentation and status-bar settings retain legacy response shape", async () => {
  const { adapter, calls } = fixture();
  await adapter.rotate(invocation, "landscape-left");
  assert.equal(calls[0].path, `${base}/presentation`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { orientation: "landscape" });
  await assert.rejects(adapter.rotate(invocation, "portrait-upside-down"), { code: "capability_not_supported" });
  await assert.rejects(adapter.rotate(invocation, "landscape-right"), { code: "capability_not_supported" });
  const directional = fixture({ [`${base}/presentation`]: reply({
    width: 48, height: 32, density: 2, orientation: "landscape-left",
    "x-ailoha-target-host": { targetId: invocation.targetId },
  }) });
  await directional.adapter.rotate(invocation, "landscape-left");
  const read = await adapter.presentation(invocation);
  assert.deepEqual(read, {
    schemaVersion: "1.0", deviceId: "target/one", platform: "ios",
    enabled: true, readable: true, overrides: [{ name: "time", value: "09:41" }],
  });
  await adapter.presentation(invocation, { enabled: null, time: "09:41", batteryLevel: 75 });
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { values: { time: "09:41", batteryLevel: 75 } });
  assert.equal(calls.at(-1).options.method, "PATCH");
  await assert.rejects(adapter.presentation(invocation, { batteryLevel: 101 }), { code: "invalid_request" });
  await assert.rejects(adapter.presentation(invocation, { time: "nope" }), { code: "invalid_request" });
});

test("uncertain or mismatched accepted mutations never retry or switch owner", async () => {
  const failed = fixture({ [`${surface}/input/actions/key`]: reply({ success: false, "x-ailoha-target-host": owner }) });
  await assert.rejects(failed.adapter.key(invocation, 42), { code: "input_operation_failed" });
  assert.equal(failed.calls.length, 1);
  const wrong = fixture({ [`${surface}/input/actions/key`]: reply({
    success: true, "x-ailoha-target-host": { ...owner, targetId: "target/two" },
  }) });
  await assert.rejects(wrong.adapter.key(invocation, 42), { code: "control_owner_mismatch" });
  assert.equal(wrong.calls.length, 1);
  const unknown = fixture({ [`${base}/settings/status-bar`]: () => {
    throw new Error("delivery uncertain");
  } });
  await assert.rejects(unknown.adapter.presentation(invocation, { enabled: false }), /delivery uncertain/);
  assert.equal(unknown.calls.length, 1);
});
