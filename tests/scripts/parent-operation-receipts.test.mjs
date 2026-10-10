import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";

const { AilohaProtocolError } = await import(productModule("lib/ailoha/index.mjs"));
const { submitOperationReceipt } = await import(productModule("lib/ailoha/operation-receipts.mjs"));

for (const [name, code, status] of [
  ["HTTP 408", "http_error", 408],
  ["HTTP 499", "http_error", 499],
  ["disposed client", "client_disposed", undefined],
]) {
  test(`parent regression: shared submission keeps ${name} uncertainty non-replayable`, async () => {
    const state = new Map();
    const invocation = Object.freeze({ targetHostId: "host", targetId: "target", providerId: "provider" });
    let submissions = 0;
    const options = {
      state, key: "original-intent", kind: "createTarget", invocation,
      requireCurrent() {},
      async submit() {
        submissions += 1;
        throw new AilohaProtocolError(code, { status });
      },
    };
    const receipt = submitOperationReceipt(options);
    await assert.rejects(receipt.submitted);

    assert.equal(state.get(options.key), receipt);
    assert.equal(receipt.uncertain, true);
    assert.equal(submitOperationReceipt(options), receipt);
    assert.equal(submissions, 1);
  });
}

test("parent regression: a definitive shared HTTP403 rejection remains safely evictable", async () => {
  const state = new Map();
  const receipt = submitOperationReceipt({
    state, key: "rejected", kind: "createTarget", invocation: {},
    requireCurrent() {},
    async submit() { throw new AilohaProtocolError("http_error", { status: 403 }); },
  });
  await assert.rejects(receipt.submitted);
  assert.equal(state.has("rejected"), false);
});
