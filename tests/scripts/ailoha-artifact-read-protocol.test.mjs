import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";

const { artifactReadQuery, targetInstalledApps, targetFileListing, targetLogListing,
  targetCrashListing, targetCrashDetail } =
  await import(productModule("lib/ailoha/artifact-read-protocol.mjs"));

const owner = { "x-ailoha-target-host": { targetId: "original", providerId: "provider" } };

test("typed native read results require exact target/provider ownership and bounded fields", () => {
  assert.deepEqual(targetInstalledApps([{ appId: "app", packageId: null, ...owner }], "original"),
    [{ appId: "app", packageId: null, ...owner }]);
  assert.equal(targetFileListing({
    path: "/", nativePath: "/", total: 1,
    files: [{ name: "zero", type: "file", size: 0, ...owner }],
  }, "original").files[0].size, 0);
  assert.equal(targetLogListing({
    total: 1, entries: [{ message: "event", source: "native", ...owner }],
  }, "original").total, 1);
  assert.equal(targetCrashListing({
    total: 1, crashes: [{ crashId: "crash", ...owner }],
  }, "original").total, 1);
  assert.equal(targetCrashDetail({ crashId: "crash", content: "", ...owner },
    "original", "crash").content, "");
  for (const result of [
    () => targetInstalledApps([{ appId: "app", ...owner,
      "x-ailoha-target-host": { targetId: "replacement", providerId: "provider" } }], "original"),
    () => targetFileListing({ path: "/", total: 0, files: [{ name: "file", type: "file", ...owner }] }, "original"),
    () => targetLogListing({ total: 0, entries: [{ message: "event", source: "native", ...owner }] }, "original"),
    () => targetCrashListing({ crashes: [{ crashId: "crash", ...owner }],
      total: 1, extra: "allowed extension" }, "replacement"),
    () => targetCrashDetail({ crashId: "wrong", content: "stack", ...owner }, "original", "crash"),
    () => targetCrashDetail({ crashId: "crash", content: "é".repeat(524289), ...owner }, "original", "crash"),
  ]) assert.throws(result, { code: "invalid_response" });
});

test("query parameters are typed, bounded and cannot inject arbitrary native filters", () => {
  assert.deepEqual(artifactReadQuery({
    text: " \t", level: "critical", limit: "2", since: "2026-10-10T00:00:00.000Z",
  }, ["text", "level", "limit", "since"], 10_000), {
    text: " \t", level: "critical", limit: "2", since: "2026-10-10T00:00:00.000Z",
  });
  for (const input of [{ path: "/" }, { limit: "0" }, { limit: "10001" },
    { level: "fatal" }, { since: "not a timestamp" }, { appId: "bad\napp" }]) {
    assert.throws(() => artifactReadQuery(input,
      ["appId", "text", "level", "limit", "since"], 10_000), { code: "invalid_options" });
  }
});
