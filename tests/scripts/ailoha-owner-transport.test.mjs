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

test("destructive consumer options lower the original owner request budget without putting timeout or confirmation on the wire", async (t) => {
  const { client, calls } = await fixture(t, (_path, request) => response({
    ...operation, kind: request.method === "DELETE" ? "deleteTarget" : "resetTarget", destructive: true,
  }, 202, "/api/v1/operations/accepted%2Fopaque"), { timeoutMs: 1000 });
  await client.resetTarget(operation.targetId, { confirmed: true, timeoutMs: 25 });
  await client.deleteTarget(operation.targetId, { confirmed: true, timeoutMs: 25 });
  for (const call of calls.slice(1)) {
    assert.ok(call.request.timeoutMs >= 1 && call.request.timeoutMs <= 25);
    assert.equal(call.request.body, undefined);
  }
  const before = calls.length;
  for (const timeoutMs of [0, -1, 1.5, NaN, 1001]) {
    await assert.rejects(client.resetTarget(operation.targetId, { confirmed: true, timeoutMs }), { code: "invalid_options" });
    await assert.rejects(client.deleteTarget(operation.targetId, { confirmed: true, timeoutMs }), { code: "invalid_options" });
  }
  assert.equal(calls.length, before);
});

for (const [pollIntervalMs, responseElapsedMs] of [[60_000, 0.25], [80, 0.25], [80, 0]]) {
  test(`a ${pollIntervalMs}ms poll interval with ${responseElapsedMs}ms elapsed never schedules a deadline GET`, async (t) => {
    let now = 0;
    let terminal = false;
    t.mock.method(performance, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const timeout = setTimeout;
    const pollTimers = [];
    t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
      if (callback.name === "poll") pollTimers.push(delay);
      return timeout(callback, Math.max(1, Math.trunc(delay)), ...args);
    });
    const nonterminal = { ...operation, status: "cancelling", cancelRequested: true };
    const { client, calls } = await fixture(t, (_path, request) => {
      if (request.method === "POST") {
        return response(nonterminal, 202, "/api/v1/operations/accepted%2Fopaque");
      }
      if (now === 0) now = responseElapsedMs;
      return response(terminal ? { ...nonterminal, status: "succeeded" } : nonterminal);
    }, { timeoutMs: 1000 });
    const accepted = await client.startTarget(operation.targetId);
    let receipt;
    const pending = client.waitForOperation(accepted.operationId, { timeoutMs: 80, pollIntervalMs });
    const rejected = assert.rejects(pending, (error) => {
      assert.equal(error.code, "timeout");
      assert.equal(error.operationId, accepted.operationId);
      assert.equal(error.operation.status, "cancelling");
      assert.equal(error.operation.cancelRequested, true);
      receipt = error;
      return true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    now = 79.25;
    t.mock.timers.tick(79);
    await new Promise((resolve) => setImmediate(resolve));
    const requestsBeforeDeadline = calls.length;
    now = 80;
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(requestsBeforeDeadline, 3);
    assert.equal(calls.length, 3);
    assert.deepEqual(pollTimers, []);
    assert.equal(calls.filter((call) => call.request.method === "POST").length, 1);
    assert.equal(calls.some((call) => call.request.method === "DELETE"), false);
    terminal = true;
    assert.equal((await client.waitForOperation(receipt.operationId, {
      timeoutMs: 80, pollIntervalMs: 10,
    })).status, "succeeded");
    assert.equal(calls.length, 4);
    assert.equal(calls.filter((call) => call.request.method === "POST").length, 1);
  });
}

test("a fitting short poll interval completes normally and clears its deadline without replay", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const states = ["queued", "running", "succeeded"];
  const pollTimes = [];
  const { client, calls } = await fixture(t, (_path, request) => {
    if (request.method === "POST") return response(operation, 202, "/api/v1/operations/accepted%2Fopaque");
    pollTimes.push(now);
    return response({ ...operation, status: states[pollTimes.length - 1] });
  }, { timeoutMs: 1000 });
  const accepted = await client.startTarget(operation.targetId);
  const pending = client.waitForOperation(accepted.operationId, { timeoutMs: 80, pollIntervalMs: 10 });
  await new Promise((resolve) => setImmediate(resolve));
  now = 10;
  t.mock.timers.tick(10);
  await new Promise((resolve) => setImmediate(resolve));
  now = 20;
  t.mock.timers.tick(10);
  const completed = await pending;
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.operationId, accepted.operationId);
  assert.deepEqual(pollTimes, [0, 10, 20]);
  assert.equal(calls.length, 5);
  assert.equal(calls.filter((call) => call.request.method === "POST").length, 1);
  assert.equal(calls.some((call) => call.request.method === "DELETE"), false);
  now = 80;
  t.mock.timers.tick(60);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 5);
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

test("available owner accepted Location survives caller abort without retrying the mutation", async (t) => {
  const { client, calls } = await fixture(t, (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("typed sanitized owner failure");
      Object.assign(error, {
        name: "TargetHostTransportError", code: "RequestAborted", status: 202, problem: null,
        response: {
          status: 202, location: "/api/v1/operations/accepted%2Fopaque",
          retryAfterMs: 1000, contentType: "application/json",
        },
      });
      reject(error);
    }, { once: true });
  }), { timeoutMs: 1000 });
  const controller = new AbortController();
  const pending = client.startTarget("target/one", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "cancelled");
    assert.equal(error.operationId, "accepted/opaque");
    assert.equal(error.status, 202);
    assert.equal(error.transportCode, "RequestAborted");
    return true;
  });
  assert.equal(calls.filter((call) => call.request.method === "POST").length, 1);
});

test("owner metadata delivered only in reaction to an expired deadline is explicitly unavailable", async (t) => {
  let ownerAborted = false;
  const { client, calls } = await fixture(t, (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      ownerAborted = true;
      const error = new Error("typed owner metadata was not delivered before budget expiry");
      Object.assign(error, {
        name: "TargetHostTransportError", code: "RequestAborted", status: 202, problem: null,
        response: {
          status: 202, location: "/api/v1/operations/accepted%2Fopaque",
          retryAfterMs: 1000, contentType: "application/json",
        },
      });
      reject(error);
    }, { once: true });
  }), { timeoutMs: 10 });
  await assert.rejects(client.startTarget("target/one"), (error) => {
    assert.equal(error.code, "timeout");
    assert.equal(error.status, undefined);
    assert.equal(error.operationId, undefined);
    return true;
  });
  assert.equal(ownerAborted, true);
  assert.equal(calls.filter((call) => call.request.method === "POST").length, 1);
});

test("cooperative asynchronous abort settlement retains validated metadata within the original deadline", async (t) => {
  let ownerAborted = false;
  const { client, calls } = await fixture(t, (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      ownerAborted = true;
      setImmediate(() => setImmediate(() => {
        const error = new Error("synthetic event-loop ordering, not SDK production timing evidence");
        Object.assign(error, {
          name: "TargetHostTransportError", code: "RequestAborted", status: 202, problem: null,
          response: {
            status: 202, location: "/api/v1/operations/accepted%2Fopaque",
            retryAfterMs: 1000, contentType: "application/json",
          },
        });
        reject(error);
      }));
    }, { once: true });
  }), { timeoutMs: 1000 });
  const controller = new AbortController();
  const pending = client.startTarget("target/one", { signal: controller.signal });
  controller.abort();
  assert.equal(ownerAborted, true);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "cancelled");
    assert.equal(error.status, 202);
    assert.equal(error.operationId, "accepted/opaque");
    assert.equal(error.transportCode, "RequestAborted");
    assert.equal(JSON.stringify(error).includes("production timing"), false);
    return true;
  });
  const posts = calls.filter((call) => call.request.method === "POST");
  assert.equal(posts.length, 1);
  assert.ok(posts[0].request.timeoutMs <= 1000);
  assert.equal((await client.getHostStatus()).hostId, status.hostId);
});

test("nonresponsive owner cancellation remains bounded by the unchanged original request budget", { timeout: 500 }, async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let ownerAborted = false;
  const { client, calls } = await fixture(t, (_path, options) => {
    options.signal.addEventListener("abort", () => { ownerAborted = true; }, { once: true });
    return new Promise(() => {});
  }, { timeoutMs: 40 });
  const controller = new AbortController();
  const started = performance.now();
  const pending = client.startTarget("target/one", { signal: controller.signal });
  now = 20;
  t.mock.timers.tick(20);
  controller.abort();
  assert.equal(ownerAborted, true);
  now = 40;
  t.mock.timers.tick(20);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "cancelled");
    assert.equal(error.status, undefined);
    assert.equal(error.operationId, undefined);
    return true;
  });
  assert.equal(performance.now() - started, 40);
  const posts = calls.filter((call) => call.request.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].request.timeoutMs, 40);
  assert.equal((await client.getHostStatus()).hostId, status.hostId);
});

test("an already available owner response cannot become successful after the absolute deadline", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const { client, calls } = await fixture(t, () => {
    now = 21;
    return response(operation, 202, "/api/v1/operations/accepted%2Fopaque");
  }, { timeoutMs: 20 });
  await assert.rejects(client.startTarget("target/one"), (error) => {
    assert.equal(error.code, "timeout");
    assert.equal(error.status, 202);
    assert.equal(error.operationId, "accepted/opaque");
    return true;
  });
  assert.equal(calls.filter((call) => call.request.method === "POST").length, 1);
});

test("metadata withheld past the deadline stays explicitly unavailable rather than mutating a delivered error", async (t) => {
  let settleLate;
  const late = new Promise((resolve) => { settleLate = resolve; });
  const { client, calls } = await fixture(t, (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      setTimeout(() => {
        const error = new Error("synthetic owner violated its settlement budget");
        Object.assign(error, {
          name: "TargetHostTransportError", code: "RequestAborted", status: 202, problem: null,
          response: {
            status: 202, location: "/api/v1/operations/accepted%2Fopaque",
            retryAfterMs: 1000, contentType: "application/json",
          },
        });
        reject(error);
        settleLate();
      }, 60);
    }, { once: true });
  }), { timeoutMs: 10 });
  const controller = new AbortController();
  const pending = client.startTarget("target/one", { signal: controller.signal });
  controller.abort();
  let delivered;
  await assert.rejects(pending, (error) => {
    delivered = error;
    assert.equal(error.code, "cancelled");
    assert.equal(error.status, undefined);
    assert.equal(error.operationId, undefined);
    return true;
  });
  await late;
  assert.equal(delivered.operationId, undefined);
  assert.equal(delivered.status, undefined);
  assert.equal(calls.filter((call) => call.request.method === "POST").length, 1);
});
