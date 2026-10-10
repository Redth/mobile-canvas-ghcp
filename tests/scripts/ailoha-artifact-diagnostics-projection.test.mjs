import assert from "node:assert/strict";
import test from "node:test";
import { productModule } from "../ailoha-test-module.mjs";

const { projectDeviceLogs, projectDeviceCrashes, projectDeviceCrashReport } =
  await import(productModule("lib/ailoha/artifact-diagnostics-projection.mjs"));

test("native logs retain complete pre-limit totals and original chronological/raw device fields", () => {
  const result = projectDeviceLogs({
    deviceId: "target", platform: "android",
    result: {
      total: 8,
      entries: [
        {
          timestamp: "2026-10-10T02:00:02Z", nativeTimestamp: "10-10 02:00:02.000",
          level: "critical", nativeLevel: "fatal", source: "native", nativeSource: "AndroidRuntime",
          message: "second", processId: 122, subsystem: null,
        },
        {
          timestamp: "2026-10-10T02:00:01Z", nativeTimestamp: "10-10 02:00:01.000",
          level: "trace", nativeLevel: "verbose", source: "native", nativeSource: "ActivityManager",
          message: "first", processId: null,
        },
      ],
    },
  });
  assert.deepEqual(result, {
    schemaVersion: "1.0", deviceId: "target", platform: "android", total: 8,
    entries: [
      { timestamp: "10-10 02:00:01.000", level: "verbose", source: "ActivityManager",
        message: "first", processId: null, subsystem: null },
      { timestamp: "10-10 02:00:02.000", level: "fatal", source: "AndroidRuntime",
        message: "second", processId: 122, subsystem: null },
    ],
  });
});

test("native crash summaries and detail retain exact legacy names, kind and report content", () => {
  const raw = {
    crashId: "crash/one", process: "normalized", nativeName: "My App",
    appId: "com.example.app", timestamp: "2026-10-10T00:00:00Z",
    nativeTimestamp: "2026-10-10 00:00:00", nativeKind: "ANR",
  };
  assert.deepEqual(projectDeviceCrashes({
    deviceId: "target", platform: "ios", result: { crashes: [raw], total: 4 },
  }), {
    schemaVersion: "1.0", deviceId: "target", platform: "ios", total: 4,
    crashes: [{ id: "crash/one", name: "My App", bundleId: "com.example.app",
      timestamp: "2026-10-10 00:00:00", kind: "ANR" }],
  });
  assert.deepEqual(projectDeviceCrashReport({ deviceId: "target", result: { ...raw, content: "raw stack" } }), {
    schemaVersion: "1.0", deviceId: "target", content: "raw stack",
    report: { id: "crash/one", name: "My App", bundleId: "com.example.app",
      timestamp: "2026-10-10 00:00:00", kind: "ANR" },
  });
});

test("missing totals and raw fields cannot become normalized diagnostic successes", () => {
  const log = {
    total: 1,
    entries: [{
      nativeTimestamp: "native clock", nativeLevel: "info", nativeSource: "app", source: "native",
      message: "event",
    }],
  };
  for (const result of [
    { ...log, total: undefined },
    { ...log, total: 0 },
    { ...log, entries: [{ ...log.entries[0], nativeLevel: undefined }] },
    { ...log, entries: [{ ...log.entries[0], nativeSource: undefined }] },
    { ...log, entries: [{ ...log.entries[0], source: "app-agent" }] },
  ]) {
    assert.throws(() => projectDeviceLogs({ deviceId: "target", platform: "ios", result }),
      { code: "invalid_artifact_diagnostics", status: 502 });
  }
  const report = { crashId: "id", nativeName: "app", nativeTimestamp: "native time" };
  for (const result of [
    { crashes: [report] },
    { total: 1, crashes: [{ ...report, nativeName: undefined }] },
    { total: 1, crashes: [{ ...report, nativeTimestamp: undefined }] },
  ]) {
    assert.throws(() => projectDeviceCrashes({ deviceId: "target", platform: "ios", result }),
      { code: "invalid_artifact_diagnostics", status: 502 });
  }
  assert.throws(() => projectDeviceCrashReport({ deviceId: "target", result: report }),
    { code: "invalid_artifact_diagnostics", status: 502 });
});
