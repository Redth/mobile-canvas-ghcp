import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const script = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "media", "vscode-theme.js"),
  "utf8",
);

test("tracks VS Code light, dark, and high-contrast theme classes", () => {
  const classes = new Set(["vscode-dark"]);
  const root = { dataset: {} };
  let observer;
  class TestMutationObserver {
    constructor(callback) {
      observer = callback;
    }

    observe() {}
  }

  vm.runInNewContext(script, {
    document: {
      documentElement: root,
      body: { classList: { contains: (name) => classes.has(name) } },
    },
    window: {
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    MutationObserver: TestMutationObserver,
  });

  assert.deepEqual(root.dataset, {
    host: "vscode",
    hostTheme: "dark",
    hostContrast: "normal",
  });

  classes.clear();
  classes.add("vscode-light");
  observer();
  assert.equal(root.dataset.hostTheme, "light");
  assert.equal(root.dataset.hostContrast, "normal");

  classes.clear();
  classes.add("vscode-high-contrast");
  observer();
  assert.equal(root.dataset.hostTheme, "dark");
  assert.equal(root.dataset.hostContrast, "high");

  classes.clear();
  classes.add("vscode-high-contrast-light");
  observer();
  assert.equal(root.dataset.hostTheme, "light");
  assert.equal(root.dataset.hostContrast, "high");
});

test("infers the theme from VS Code colors when body classes are unavailable", () => {
  const root = { dataset: {} };
  class TestMutationObserver {
    observe() {}
  }

  vm.runInNewContext(script, {
    document: {
      documentElement: root,
      body: { classList: { contains: () => false } },
    },
    window: {
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    },
    getComputedStyle: () => ({
      getPropertyValue: (name) =>
        name === "--vscode-sideBar-background" ? "#181818" : "",
    }),
    MutationObserver: TestMutationObserver,
  });

  assert.equal(root.dataset.hostTheme, "dark");
  assert.equal(root.dataset.hostContrast, "normal");
});
