import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(join(extensionRoot, "package.json"), "utf8"),
);
const contributes = manifest.contributes ?? {};

function commandsById() {
  return new Map((contributes.commands ?? []).map((entry) => [entry.command, entry]));
}

function toolsByName() {
  return new Map((contributes.languageModelTools ?? []).map((entry) => [entry.name, entry]));
}

test("the Mobile contributions are unchanged", () => {
  const containers = contributes.viewsContainers?.activitybar ?? [];
  assert.ok(
    containers.some((container) => container.id === "mobileCanvas"),
    "the mobileCanvas activity-bar container must still exist",
  );

  const mobileViews = contributes.views?.mobileCanvas ?? [];
  const deviceView = mobileViews.find((view) => view.id === "mobileCanvas.deviceView");
  assert.ok(deviceView, "the mobileCanvas.deviceView view must still exist");
  assert.equal(deviceView.type, "webview");
  // The Mobile view is unconditional; only the Windows view gates on platform support.
  assert.equal(deviceView.when, undefined);

  const commands = commandsById();
  assert.ok(commands.has("mobileCanvas.open"), "mobileCanvas.open must exist");
  assert.ok(commands.has("mobileCanvas.refresh"), "mobileCanvas.refresh must exist");

  const tools = toolsByName();
  for (const name of [
    "mobileCanvas_selectedDevice",
    "mobileCanvas_screenshot",
    "mobileCanvas_uiTree",
  ]) {
    assert.ok(tools.has(name), `${name} must still be contributed`);
    assert.equal(tools.get(name).canBeReferencedInPrompt, true);
  }
});

test("the Windows activity-bar container and view are contributed", () => {
  const containers = contributes.viewsContainers?.activitybar ?? [];
  const windowsContainer = containers.find((container) => container.id === "windowsCanvas");
  assert.ok(windowsContainer, "the windowsCanvas activity-bar container must exist");
  assert.equal(windowsContainer.title, "Windows");
  assert.equal(windowsContainer.icon, "media/windows-activitybar.svg");

  const windowsViews = contributes.views?.windowsCanvas ?? [];
  const appView = windowsViews.find((view) => view.id === "windowsCanvas.appView");
  assert.ok(appView, "the windowsCanvas.appView view must exist");
  assert.equal(appView.type, "webview");
  // The `when` clause is how the container disappears on hosts where Windows is unsupported.
  assert.equal(appView.when, "mobileCanvas.windowsSupported");
});

test("the Windows commands and menus are contributed", () => {
  const commands = commandsById();
  const open = commands.get("windowsCanvas.open");
  assert.ok(open, "windowsCanvas.open must exist");
  assert.equal(open.title, "Open Windows App");
  assert.equal(open.category, "Windows Apps");

  const refresh = commands.get("windowsCanvas.refresh");
  assert.ok(refresh, "windowsCanvas.refresh must exist");
  assert.equal(refresh.category, "Windows Apps");
  assert.equal(refresh.icon, "$(refresh)");

  const viewTitle = contributes.menus?.["view/title"] ?? [];
  assert.ok(
    viewTitle.some(
      (entry) =>
        entry.command === "windowsCanvas.refresh"
        && entry.when === "view == windowsCanvas.appView",
    ),
    "the Windows refresh must appear in the view title menu",
  );

  const palette = contributes.menus?.commandPalette ?? [];
  for (const command of ["windowsCanvas.open", "windowsCanvas.refresh"]) {
    assert.ok(
      palette.some(
        (entry) =>
          entry.command === command && entry.when === "mobileCanvas.windowsSupported",
      ),
      `${command} must be gated in the command palette`,
    );
  }
});

test("the Windows activation events are contributed", () => {
  const events = new Set(manifest.activationEvents ?? []);
  for (const event of [
    "onView:windowsCanvas.appView",
    "onCommand:windowsCanvas.refresh",
    "onLanguageModelTool:windowsCanvas_selectedApp",
    "onLanguageModelTool:windowsCanvas_screenshot",
    "onLanguageModelTool:windowsCanvas_uiTree",
  ]) {
    assert.ok(events.has(event), `${event} activation event must exist`);
  }
});

test("the Windows language model tools are contributed with reference names", () => {
  const tools = toolsByName();
  const expected = new Map([
    ["windowsCanvas_selectedApp", "windowsApp"],
    ["windowsCanvas_screenshot", "windowsScreenshot"],
    ["windowsCanvas_uiTree", "windowsUiTree"],
  ]);
  for (const [name, referenceName] of expected) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} must be contributed`);
    assert.equal(tool.toolReferenceName, referenceName);
    assert.equal(tool.canBeReferencedInPrompt, true);
    assert.equal(tool.inputSchema?.type, "object");
    assert.match(tool.modelDescription, /Windows/);
  }
});

test("the Mobile identity and versioning are untouched", () => {
  assert.equal(manifest.name, "mobile-canvas");
  assert.equal(manifest.publisher, "redth");
  assert.equal(manifest.displayName, "Mobile Canvas");
});
