import assert from "node:assert/strict";
import test from "node:test";
import { createLatestCatalogLoader } from "../../web/canvas-state.js";
import {
  createOptionPlaceholders,
  presentCreateDialog,
} from "../../web/create-device-options.js";

const catalog = {
  runtimes: [{ id: "ios-18", isAvailable: true, platform: "ios" }],
  deviceTypes: [{ id: "iphone-16", platform: "ios" }],
};

test("empty options distinguish loading from unavailable runtimes and devices", () => {
  assert.deepEqual(createOptionPlaceholders(true), {
    runtime: "Loading installed runtimes...",
    deviceType: "Loading device types...",
  });
  assert.deepEqual(createOptionPlaceholders(false), {
    runtime: "No compatible runtime installed",
    deviceType: "No compatible device type found",
  });
});

test("a ready catalog opens without reloading", async () => {
  const calls = [];
  await presentCreateDialog({
    catalog,
    loadCatalog: async () => calls.push("load"),
    renderOptions: (pending) => calls.push(`render:${pending}`),
    showDialog: () => calls.push("show"),
    showError: (error) => calls.push(`error:${error.message}`),
  });

  assert.deepEqual(calls, ["render:false", "show"]);
});

test("an empty catalog opens in a loading state and repopulates after reloading", async () => {
  let finishReload;
  const reload = new Promise((resolve) => {
    finishReload = resolve;
  });
  const calls = [];
  const opening = presentCreateDialog({
    catalog: null,
    loadCatalog: async () => {
      calls.push("load");
      await reload;
    },
    renderOptions: (pending) => calls.push(`render:${pending}`),
    showDialog: () => calls.push("show"),
    showError: (error) => calls.push(`error:${error.message}`),
  });

  assert.deepEqual(calls, ["render:true", "show", "load"]);
  finishReload();
  await opening;
  assert.deepEqual(calls, ["render:true", "show", "load", "render:false"]);
});

test("a failed catalog reload reports the error and clears the loading state", async () => {
  const calls = [];
  await presentCreateDialog({
    catalog: null,
    loadCatalog: async () => {
      calls.push("load");
      throw new Error("catalog unavailable");
    },
    renderOptions: (pending) => calls.push(`render:${pending}`),
    showDialog: () => calls.push("show"),
    showError: (error) => calls.push(`error:${error.message}`),
  });

  assert.deepEqual(calls, [
    "render:true",
    "show",
    "load",
    "error:catalog unavailable",
    "render:false",
  ]);
});

test("a stale startup catalog cannot replace a successful dialog reload", async () => {
  let finishStartup;
  let finishReload;
  const startup = new Promise((resolve) => {
    finishStartup = resolve;
  });
  const reload = new Promise((resolve) => {
    finishReload = resolve;
  });
  const catalogs = [startup, reload];
  const applied = [];
  const loadCatalog = createLatestCatalogLoader(
    () => catalogs.shift(),
    (catalog) => applied.push(catalog),
  );

  const startupLoad = loadCatalog();
  const dialogReload = loadCatalog();
  finishReload({ source: "dialog" });
  assert.equal(await dialogReload, true);
  finishStartup({ source: "startup" });
  assert.equal(await startupLoad, false);
  assert.deepEqual(applied, [{ source: "dialog" }]);
});
