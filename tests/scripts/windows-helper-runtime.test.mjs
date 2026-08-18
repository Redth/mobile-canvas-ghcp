import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  WINDOWS_APP_HELPER,
  validateWindowsAppHelperEntry,
  windowsAppHelperFilesForRid,
} from "../../lib/windows-app-helper.mjs";
import {
  materializeRuntime,
  resolveRuntimeCompanion,
} from "../../lib/runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bundleScript = join(root, "scripts", "bundle.mjs");
const verifierScript = join(root, "scripts", "verify-bundle.mjs");

test("Windows helper declarations are restricted to Windows runtime entries", () => {
  assert.deepEqual(windowsAppHelperFilesForRid("win-x64"), [WINDOWS_APP_HELPER]);
  assert.deepEqual(windowsAppHelperFilesForRid("win-arm64"), [WINDOWS_APP_HELPER]);
  assert.deepEqual(windowsAppHelperFilesForRid("osx-arm64"), []);
  assert.deepEqual(windowsAppHelperFilesForRid("linux-x64"), []);

  assert.throws(
    () => validateWindowsAppHelperEntry("darwin-arm64", {
      rid: "osx-arm64",
      files: { [WINDOWS_APP_HELPER]: {} },
    }),
    /only valid for Windows runtimes/,
  );
  assert.throws(
    () => validateWindowsAppHelperEntry("win32-x64", {
      rid: "win-x64",
      helpers: [WINDOWS_APP_HELPER],
      files: {},
    }),
    /without a checksummed file/,
  );
});

test("runtime preflight extracts the checksummed Windows helper beside its host", async () => {
  const workspace = join(root, ".build", `windows-helper-preflight-test-${process.pid}-${Date.now()}`);
  const runtimes = join(workspace, "runtimes");
  const cache = join(workspace, "cache");
  const executable = Buffer.from("managed host fixture");
  const helper = Buffer.from("native helper fixture");
  const executableHash = createHash("sha256").update(executable).digest("hex");
  const helperHash = createHash("sha256").update(helper).digest("hex");
  const entry = {
    rid: "win-x64",
    executable: "mobile-canvas.exe",
    id: executableHash,
    helpers: [WINDOWS_APP_HELPER],
    files: {
      "mobile-canvas.exe": {
        archive: "win-x64/mobile-canvas.exe.gz",
        sha256: executableHash,
        size: executable.length,
      },
      [WINDOWS_APP_HELPER]: {
        archive: `win-x64/${WINDOWS_APP_HELPER}.gz`,
        sha256: helperHash,
        size: helper.length,
      },
    },
  };

  try {
    mkdirSync(join(runtimes, "win-x64"), { recursive: true });
    writeFileSync(join(runtimes, "win-x64", "mobile-canvas.exe.gz"), gzipSync(executable));
    writeFileSync(join(runtimes, "win-x64", `${WINDOWS_APP_HELPER}.gz`), gzipSync(helper));

    const command = await materializeRuntime(
      { version: "9.8.7", runtimes: { "win32-x64": entry } },
      entry,
      { cacheRoot: cache, platformKey: "win32-x64", runtimesDir: runtimes },
    );
    const materializedHelper = resolveRuntimeCompanion(command, WINDOWS_APP_HELPER);

    assert.deepEqual(readFileSync(command), executable);
    assert.deepEqual(readFileSync(materializedHelper), helper);
    if (process.platform !== "win32") {
      assert.notEqual(statSync(materializedHelper).mode & 0o111, 0);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("bundle requires, checksums, and verifies the Windows helper", () => {
  const workspace = join(root, ".build", `windows-helper-runtime-test-${process.pid}-${Date.now()}`);
  const source = join(workspace, "bin");
  const runtimes = join(workspace, "runtimes");
  const environment = {
    ...process.env,
    MOBILE_CANVAS_RUNTIMES_DIR: runtimes,
  };

  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "mobile-canvas.exe"), "managed host fixture");
    writeFileSync(join(source, WINDOWS_APP_HELPER), "native helper fixture");

    execFileSync(
      process.execPath,
      [bundleScript, "--rid", "win-x64", "--from", source],
      { cwd: root, env: environment, encoding: "utf8" },
    );

    const manifestPath = join(runtimes, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry = manifest.runtimes["win32-x64"];

    assert.deepEqual(entry.helpers, [WINDOWS_APP_HELPER]);
    assert.deepEqual(
      gunzipSync(readFileSync(join(runtimes, entry.files[WINDOWS_APP_HELPER].archive))),
      Buffer.from("native helper fixture"),
    );

    execFileSync(process.execPath, [verifierScript], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });

    const helperFile = entry.files[WINDOWS_APP_HELPER];
    delete entry.files[WINDOWS_APP_HELPER];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const verification = spawnSync(process.execPath, [verifierScript], {
      cwd: root,
      env: environment,
      encoding: "utf8",
    });
    assert.notEqual(verification.status, 0);
    assert.match(verification.stderr, /declares helper .* without a checksummed file/);

    entry.files[WINDOWS_APP_HELPER] = helperFile;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const missingHelper = join(workspace, "missing-helper");
    mkdirSync(missingHelper, { recursive: true });
    writeFileSync(join(missingHelper, "mobile-canvas.exe"), "managed host fixture");
    const missingBundle = spawnSync(
      process.execPath,
      [bundleScript, "--rid", "win-arm64", "--from", missingHelper],
      { cwd: root, env: environment, encoding: "utf8" },
    );
    assert.notEqual(missingBundle.status, 0);
    assert.match(missingBundle.stderr, /missing windows-app-helper\.exe/);

    const linuxSource = join(workspace, "linux");
    mkdirSync(linuxSource, { recursive: true });
    writeFileSync(join(linuxSource, "mobile-canvas"), "managed host fixture");
    execFileSync(
      process.execPath,
      [bundleScript, "--rid", "linux-x64", "--from", linuxSource],
      { cwd: root, env: environment, encoding: "utf8" },
    );
    const linuxEntry = JSON.parse(readFileSync(manifestPath, "utf8")).runtimes["linux-x64"];
    assert.equal(Object.hasOwn(linuxEntry.files, WINDOWS_APP_HELPER), false);
    assert.equal(linuxEntry.helpers, undefined);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }

  assert.equal(existsSync(workspace), false);
});
