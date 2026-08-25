import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const extension = readFileSync(join(src, "extension.ts"), "utf8");
const viewProvider = readFileSync(join(src, "viewProvider.ts"), "utf8");

test("the device view keeps its webview context while hidden", () => {
  // Without this the webview is destroyed whenever the view is hidden, so returning to it restarts
  // the panel cold: a fresh bootstrap, another catalog load, and a reconnecting live stream.
  assert.match(
    extension,
    /registerWebviewViewProvider\(\s*VIEW_ID,\s*viewProvider,\s*\{\s*webviewOptions:\s*\{\s*retainContextWhenHidden:\s*true\s*\}/s,
  );
});

test("a hidden view still stops streaming instead of capturing in the background", () => {
  // Retaining the context is only cheap because visibility is still forwarded, so assert the wiring
  // that pays for it stays in place.
  assert.match(
    viewProvider,
    /onDidChangeVisibility\(\s*\(\) => void bridge\.setVisible\(webviewView\.visible\)/,
  );
});
