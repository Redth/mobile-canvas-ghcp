import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyPublishableImages } from "../../scripts/vsix.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// vsce rejects user-provided SVGs at publish time, which is after packaging
// succeeded and after the tag went out. These pin the rule to the pull request
// that would introduce the image instead.
test("marketplace images reject SVG sources", () => {
  assert.throws(
    () => verifyPublishableImages({ icon: "media/icon.svg" }, ""),
    /marketplace icon may not be an SVG/,
  );
  assert.throws(
    () => verifyPublishableImages(
      { icon: "media/icon.png", badges: [{ url: "https://example.com/b.svg" }] },
      "",
    ),
    /badge may not be an SVG/,
  );
  assert.throws(
    () => verifyPublishableImages(
      { icon: "media/icon.png" },
      "![shot](https://example.com/shot.svg)",
    ),
    /readme image may not be an SVG/,
  );
  assert.throws(
    () => verifyPublishableImages(
      { icon: "media/icon.png" },
      '<img src="https://example.com/shot.SVG?v=2">',
    ),
    /readme image may not be an SVG/,
  );
});

// vsce rewrites relative readme links to absolute URLs when it packages, so a
// relative path surviving into the VSIX is a link that would be broken on the
// marketplace page.
test("marketplace readme images must be absolute https URLs", () => {
  assert.throws(
    () => verifyPublishableImages({ icon: "media/icon.png" }, "![shot](media/shot.png)"),
    /must resolve to https/,
  );
  assert.throws(
    () => verifyPublishableImages(
      { icon: "media/icon.png" },
      "![shot](http://example.com/shot.png)",
    ),
    /must resolve to https/,
  );
  verifyPublishableImages(
    { icon: "media/icon.png" },
    "![shot](https://example.com/shot.png)\n<img src='https://example.com/b.png'>",
  );
});

// The rule covers the manifest icon, badges, and readme images. It does not
// cover contributed icons, so the activity bar mark stays an SVG: the activity
// bar tints it with currentColor, and a raster copy would be wrong in half the
// themes.
test("the shipped extension satisfies the marketplace image rules", () => {
  const extensionPackage = JSON.parse(
    readFileSync(join(root, "vscode", "package.json"), "utf8"),
  );
  const readme = readFileSync(join(root, "vscode", "README.md"), "utf8");

  verifyPublishableImages(extensionPackage, readme);

  assert.equal(
    extensionPackage.contributes.viewsContainers.activitybar[0].icon,
    "media/activitybar.svg",
  );
});

test("the marketplace listing leads with product features", () => {
  const extensionPackage = JSON.parse(
    readFileSync(join(root, "vscode", "package.json"), "utf8"),
  );
  const readme = readFileSync(join(root, "vscode", "README.md"), "utf8");

  assert.match(extensionPackage.description, /Copilot-powered device automation/);
  assert.match(readme, /assets\/vscode-extension\.png/);
  assert.match(readme, /assets\/agent-ios\.png/);
  assert.match(readme, /assets\/agent-android\.png/);
  assert.doesNotMatch(readme, /code --install-extension/);
  assert.doesNotMatch(readme, /CI artifact/);
});

test("the Copilot marketplace listing leads with product features", () => {
  const marketplace = JSON.parse(
    readFileSync(join(root, ".github", "plugin", "marketplace.json"), "utf8"),
  );
  const readme = readFileSync(join(root, "README.md"), "utf8");

  assert.match(marketplace.plugins[0].description, /agent-ready device automation/);
  assert.match(readme, /assets\/preview\.png/);
  assert.match(readme, /assets\/github-copilot-canvas\.png/);
  assert.match(readme, /assets\/vscode-extension\.png/);
  assert.match(readme, /assets\/agent-ios\.png/);
  assert.match(readme, /assets\/agent-android\.png/);
  assert.doesNotMatch(readme, /assets\/install-[123]\.png/);
  assert.match(readme, /\/plugin marketplace add/);
});
