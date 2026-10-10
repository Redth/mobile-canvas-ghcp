import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";
const { connectTargetHostTransport } = await import(productModule("lib/ailoha/index.mjs"));

const status = {
  hostId: "owned-host", profile: "ailoha.target-host/v1", version: "fixture", state: "ready", capabilities: [],
};
const operation = {
  operationId: "accepted/opaque",
  kind: "startTarget",
  targetId: "target/one",
  status: "running",
  destructive: false,
  createdAt: "2026-10-09T23:00:00Z",
  startedAt: "2026-10-09T23:00:01Z",
  cancellationProblem: { type: "about:blank", title: "Delivery failed", status: 500, detail: "Synthetic" },
  cleanupProblem: { type: "about:blank", title: "Cleanup failed", status: 500 },
};
function response(body, code = 200, location = null) {
  return { status: code, location, contentType: "application/json", retryAfterMs: null, body };
}

async function fixture(t, handler, options = {}) {
  const calls = [];
  const transport = {
    async response(path, request) {
      calls.push({ path, request });
      if (path === "/api/v1/host/status") return response(status);
      return handler(path, request);
    },
  };
  const client = await connectTargetHostTransport(transport, { hostId: status.hostId, ...options });
  t.after(() => client.dispose());
  return { client, calls };
}

test("the official owner boundary needs no private reader, credential or origin projection", async (t) => {
  const { client } = await fixture(t, () => response([]));
  assert.deepEqual(JSON.parse(JSON.stringify(client)), { hostId: "owned-host", profile: "ailoha.target-host/v1" });
  assert.equal(Object.hasOwn(client.connection, "origin"), false);
  assert.equal(await client.listTargets().then((targets) => targets.length), 0);
});

test("owner response metadata retains strict accepted status/Location and real operation fields", async (t) => {
  const { client, calls } = await fixture(t, (path, request) =>
    request.method === "POST" ? response(operation, 202, "/api/v1/operations/accepted%2Fopaque")
      : response({ ...operation, status: "succeeded", completedAt: "2026-10-09T23:00:02Z" }));
  const accepted = await client.startTarget("target/one");
  assert.equal(accepted.startedAt, operation.startedAt);
  assert.equal(accepted.cancellationProblem.detail, "Synthetic");
  assert.equal((await client.waitForOperation(accepted.operationId)).status, "succeeded");
  assert.equal(calls[1].path, "/api/v1/targets/target%2Fone/actions/start");
  assert.equal(calls[1].request.body, undefined);
});

test("a truncated accepted body retains its recovery identity without resubmitting", async (t) => {
  const { client, calls } = await fixture(t, () => {
    const error = new Error("never expose this raw diagnostic");
    Object.assign(error, {
      name: "TargetHostTransportError", code: "InvalidResponseJson", status: 202,
      response: { status: 202, location: "/api/v1/operations/accepted%2Fopaque", retryAfterMs: 1000, contentType: "application/json" },
      problem: null,
    });
    throw error;
  });
  await assert.rejects(client.startTarget("target/one"), (error) => {
    assert.equal(error.operationId, "accepted/opaque");
    assert.equal(error.status, 202);
    assert.equal(error.transportCode, "InvalidResponseJson");
    assert.equal(JSON.stringify(error).includes("raw diagnostic"), false);
    return true;
  });
  assert.equal(calls.filter((call) => call.request.method === "POST").length, 1);
});

test("unexpected success or a different accepted operation is not success-shaped", async (t) => {
  for (const reply of [
    response(operation, 201, "/api/v1/operations/accepted%2Fopaque"),
    response(operation, 202, "/api/v1/operations/another"),
  ]) {
    const { client } = await fixture(t, () => reply);
    await assert.rejects(client.startTarget("target/one"));
  }
});

test("per-call abort does not close a sibling owner channel or cancel external work", async (t) => {
  let cancelled;
  const { client } = await fixture(t, (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => { cancelled = true; reject(new Error("aborted")); });
  }));
  const controller = new AbortController();
  const pending = client.listTargets({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: "cancelled" });
  assert.equal(cancelled, true);
  assert.equal((await client.getHostStatus()).hostId, "owned-host");
});

test("protected success fields are rejected even behind the owner transport", async (t) => {
  const { client } = await fixture(t, () => response([{ credential: "private" }]));
  await assert.rejects(client.listTargets(), { code: "credential_exposure" });
});

test("accepted timeout is bounded and cannot become another mutation", async (t) => {
  const { client, calls } = await fixture(t, () => new Promise(() => {}), { timeoutMs: 10 });
  await assert.rejects(client.startTarget("target/one"), { code: "timeout" });
  assert.equal(calls.filter((call) => call.request.method === "POST").length, 1);
});

test("slash, dot-containing and percent-literal opaque IDs are encoded/decoded exactly once", async (t) => {
  const targetId = "nested/../opaque%2F..%2F";
  const operationId = "operation/../opaque%252F";
  const { client, calls } = await fixture(t, () =>
    response({ ...operation, targetId, operationId }, 202, `/api/v1/operations/${encodeURIComponent(operationId)}`));
  const result = await client.startTarget(targetId);
  assert.equal(result.operationId, operationId);
  assert.equal(calls[1].path, `/api/v1/targets/${encodeURIComponent(targetId)}/actions/start`);
});
