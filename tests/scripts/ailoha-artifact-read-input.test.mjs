import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";

const { artifactApiInput, artifactFilePath, artifactQueryLimit, artifactQueryText } =
  await import(productModule("lib/ailoha/artifact-read-input.mjs"));

test("read inputs retain legacy names, exact app addressing and root semantics", () => {
  assert.deepEqual(artifactApiInput("mobile_device_file_list",
    "/api/v1/devices/target/files?bundleId=com.example.app&path=Documents"), {
    bundleId: "com.example.app", path: "Documents",
  });
  assert.deepEqual(artifactApiInput("mobile_device_log",
    "/api/v1/devices/target/log?seconds=300&limit=200&text=warn"), {
    seconds: 300, limit: 200, text: "warn",
  });
  assert.deepEqual(artifactApiInput("mobile_device_crash_report",
    "/api/v1/devices/target/crashes/report%2Fone"), { crashId: "report/one" });
  assert.equal(artifactFilePath(null), "/");
  assert.equal(artifactFilePath("", "com.example.app"), "app://com.example.app/");
  assert.equal(artifactFilePath(".", "com.example.app"), "app://com.example.app/");
  assert.equal(artifactFilePath("/Documents", "com.example.app"), "app://com.example.app/Documents");
  assert.equal(artifactFilePath("/data/local/tmp"), "/data/local/tmp");
  assert.equal(artifactQueryLimit(undefined, 25, 500), 25);
  assert.equal(artifactQueryText(" Crash "), " Crash ");
  assert.equal(artifactQueryText(""), "");
  assert.equal(artifactQueryText(" \t"), " \t");
});

test("unsupported native query windows never silently clamp or reinterpret legacy input", () => {
  for (const limit of [0, -1, 501]) {
    assert.throws(() => artifactQueryLimit(limit, 25, 500),
      { code: "artifact_contract_unavailable", status: 501 });
  }
  for (const path of ["relative", "../etc", "/a/../b", "/a\\b"]) {
    assert.throws(() => artifactFilePath(path),
      { code: path.includes("..") || path.includes("\\") ? "invalid_request" : "artifact_contract_unavailable" });
  }
  assert.throws(() => artifactApiInput("mobile_device_log",
    "/api/v1/devices/target/log?limit=1&limit=2"), { code: "invalid_request" });
  assert.throws(() => artifactApiInput("mobile_device_file_list",
    "/api/v1/devices/target/files?output=%2Ftmp"), { code: "invalid_request" });
});
