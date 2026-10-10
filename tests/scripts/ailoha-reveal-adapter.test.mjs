import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";

const { createAilohaRevealAdapter } = await import(productModule("lib/ailoha/reveal-adapter.mjs"));
const nativeIdentity = { platform: "ios", nativeId: "native-id", isVirtual: true };
const invocation = { targetId: "opaque/target", providerId: "provider", nativeIdentity };
const target = {
  targetId: invocation.targetId, providerId: invocation.providerId, targetTypeId: "type",
  status: "running", surfaces: [], nativeIdentity,
};

test("reveal sends only the canonical provider action and validates native ownership", async () => {
  const requests = [];
  const adapter = createAilohaRevealAdapter({
    transport: { async response(path, options) {
      requests.push([path, options]);
      return { status: 200, contentType: "application/json; charset=utf-8", body: target };
    } },
  });
  assert.equal((await adapter.reveal(invocation)).targetId, "opaque/target");
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], "/api/v1/targets/opaque%2Ftarget/actions/reveal");
  assert.equal(requests[0][1].method, "POST");
  assert.equal(requests[0][1].body, "{}");
  assert.equal(JSON.stringify(requests).includes("native-id"), false);
});

test("reveal rejects a different provider, target, native deployment or malformed result", async () => {
  for (const changed of [
    { targetId: "another" }, { providerId: "other" }, { nativeIdentity: { ...nativeIdentity, nativeId: "other" } },
    { status: "stopped" },
  ]) {
    const adapter = createAilohaRevealAdapter({
      transport: { async response() { return { status: 200, contentType: "application/json", body: { ...target, ...changed } }; } },
    });
    await assert.rejects(adapter.reveal(invocation), { code: "reveal_owner_mismatch" });
  }
  const adapter = createAilohaRevealAdapter({
    transport: { async response() { return { status: 204, contentType: "application/json", body: target }; } },
  });
  await assert.rejects(adapter.reveal(invocation), { code: "invalid_reveal_response" });
});
