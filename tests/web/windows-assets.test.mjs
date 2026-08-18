import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

const indexHtml = read("web", "windows", "index.html");
const renderer = read("web", "windows", "windows-canvas.js");
const windowsApi = read("src", "MobileCanvas.Tool", "WindowsApi.cs");
const deviceApi = read("src", "MobileCanvas.Tool", "DeviceApi.cs");
const csproj = read("src", "MobileCanvas.Tool", "MobileCanvas.Tool.csproj");

/** Exactly the files the Windows canvas ships. A new one has to be served and embedded on purpose. */
const WINDOWS_ASSETS = ["index.html", "windows-canvas.css", "windows-canvas.js", "windows-state.js"];

const PUBLIC_PATHS = [
  "/windows/",
  "/windows/windows-canvas.css",
  "/windows/windows-canvas.js",
  "/windows/windows-state.js",
];

test("the Windows renderer is exactly the files the host serves", () => {
  assert.deepEqual(readdirSync(join(root, "web", "windows")).sort(), [...WINDOWS_ASSETS].sort());
});

test("the shell references only its own public assets", () => {
  assert.match(indexHtml, /<link rel="stylesheet" href="\/windows\/windows-canvas\.css">/);
  assert.match(indexHtml, /<script type="module" src="\/windows\/windows-canvas\.js"><\/script>/);
  // Those two markers are what each host adapter rewrites, so exactly one of each must exist.
  assert.equal(indexHtml.match(/href="\/windows\/windows-canvas\.css"/g).length, 1);
  assert.equal(indexHtml.match(/src="\/windows\/windows-canvas\.js"/g).length, 1);
  // Nothing else may be fetched from the host: every other asset is a module import.
  const references = [...indexHtml.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(references)].sort(),
    ["/windows/windows-canvas.css", "/windows/windows-canvas.js"],
  );
});

test("the shell has no inline script and no hardcoded unthemed colour", () => {
  assert.doesNotMatch(indexHtml, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(indexHtml, /style="[^"]*(#[0-9a-f]{3,8}|rgb\()/i);
});

test("the app picker starts with visual open-window cards and keeps launch paths secondary", () => {
  const tabs = [...indexHtml.matchAll(/<button id="(tab-[^"]+)"[^>]*>([^<]+)<\/button>/g)]
    .map((match) => [match[1], match[2].trim()]);
  assert.deepEqual(tabs.slice(0, 2), [
    ["tab-running", "Open windows"],
    ["tab-catalog", "Apps"],
  ]);
  assert.match(indexHtml, /id="tab-running" class="popover-tab is-active"[\s\S]*aria-selected="true"/);
  assert.match(indexHtml, /id="panel-running" class="popover-panel"/);
  assert.match(indexHtml, /id="window-list" class="window-grid"/);
  assert.match(indexHtml, /id="open-executable"/);
  assert.match(indexHtml, /id="executable-dialog"/);
});

test("the UI Automation inspector is a single rich query surface with progressive disclosure", () => {
  assert.match(indexHtml, /id="ui-query-input"[\s\S]*role="combobox"[\s\S]*aria-autocomplete="list"/);
  assert.match(indexHtml, /id="ui-query-suggestions"[\s\S]*role="listbox"/);
  assert.match(indexHtml, /id="ui-query-help"[\s\S]*aria-controls="ui-query-help-popover"/);
  assert.match(indexHtml, /data-query='name contains "save"'/);
  assert.match(indexHtml, /id="inspector-results-tab"[\s\S]*id="inspector-tree-tab"/);
  assert.match(indexHtml, /id="scope-details"[\s\S]*<summary>Scope<\/summary>/);
  assert.doesNotMatch(indexHtml, /id="selector-(automation-id|control-type|name|value|exact|index)"/);
  assert.match(renderer, /compileUiQuery\(elements\.queryInput\.value\)/);
  assert.match(renderer, /uiQuerySuggestions\(/);
  assert.match(renderer, /refineUiQueryResult\(/);
  assert.match(renderer, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(renderer, /state\.querySuggestionIndex >= 0/);
  assert.match(renderer, /row\.setAttribute\("role", "treeitem"\)/);
  assert.match(renderer, /row\.setAttribute\("aria-selected", "true"\)/);
});

test("the stylesheet themes everything through semantic tokens", () => {
  const css = read("web", "windows", "windows-canvas.css");
  for (const token of [
    "--canvas-default",
    "--canvas-subtle",
    "--control-default",
    "--border-default",
    "--fg-default",
    "--fg-muted",
    "--accent-emphasis",
    "--danger-fg",
    "--attention-fg",
    "--focus",
    "--control-radius",
  ]) {
    assert.ok(css.includes(`${token}:`), `${token} must be defined`);
    assert.ok(css.includes(`var(${token}`), `${token} must be used`);
  }
  // The VS Code adapter remaps these tokens, so nothing outside the token blocks may be a literal.
  const rules = css.slice(css.search(/^\* \{\s*$/m));
  const literals = rules.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
  assert.deepEqual(
    [...new Set(literals.map((value) => value.toLowerCase()))],
    ["#ffffff"],
    "only button-on-accent white may be literal, because it pairs with a themed accent",
  );
});

test("open-window cards use responsive semantic grid and state styling", () => {
  const css = read("web", "windows", "windows-canvas.css");
  assert.match(css, /\.window-grid \{[\s\S]*grid-template-columns: repeat\(auto-fit, minmax\(118px, 1fr\)\)/);
  assert.match(css, /\.window-card:hover:not\(\[data-disabled="true"\]\)/);
  assert.match(css, /\.window-card\[aria-pressed="true"\]/);
  assert.match(css, /\.window-card:focus-visible/);
  assert.match(css, /\.window-thumbnail-placeholder/);
  assert.match(css, /object-fit: contain/);
});

test("the host serves exactly the public Windows asset paths, as complete paths", () => {
  for (const path of PUBLIC_PATHS) {
    assert.ok(windowsApi.includes(`"${path}"`) || windowsApi.includes(`CanvasPath`), path);
  }
  assert.match(windowsApi, /\("\/windows\/windows-canvas\.css", "windows\.windows-canvas\.css"/);
  assert.match(windowsApi, /\("\/windows\/windows-canvas\.js", "windows\.windows-canvas\.js"/);
  assert.match(windowsApi, /\("\/windows\/windows-state\.js", "windows\.windows-state\.js"/);
  assert.match(windowsApi, /IsPublicPath\(PathString path\) =>\s*Array\.Exists\(Assets, asset => path == asset\.Path\)/);
  // A prefix would put every future file under /windows/ outside the credential check.
  assert.doesNotMatch(windowsApi, /StartsWithSegments\("\/windows"/);
});

test("the shared Annex-B module is served once and embedded once", () => {
  assert.match(deviceApi, /path == "\/annexb\.js"/);
  assert.match(deviceApi, /app\.MapGet\(\s*"\/annexb\.js"/);
  assert.match(csproj, /web\\annexb\.js" LogicalName="MobileCanvas\.Web\.annexb\.js"/);
});

test("every renderer asset is embedded in the published binary", () => {
  for (const asset of WINDOWS_ASSETS) {
    const logical = `MobileCanvas.Web.windows.${asset}`;
    assert.ok(
      csproj.includes(`web\\windows\\${asset}" LogicalName="${logical}"`),
      `${asset} must be embedded as ${logical}`,
    );
  }
});

test("the mobile public asset list is unchanged apart from the shared module", () => {
  for (const path of [
    '"/"',
    '"/canvas-state.js"',
    '"/create-device-options.js"',
    '"/device-canvas.js"',
    '"/device-canvas.css"',
    '"/api/v1/auth/bootstrap"',
  ]) {
    assert.ok(deviceApi.includes(`path == ${path}`), path);
  }
});

test("every element the renderer looks up exists in the shell", () => {
  const ids = new Set(
    [...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]),
  );
  const queried = [...renderer.matchAll(/document\.querySelector\("#([^"]+)"\)/g)]
    .map((match) => match[1]);
  assert.ok(queried.length > 30, "the renderer binds a real shell");
  const missing = queried.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], "renderer looked up elements the shell does not declare");
});

test("the shell declares no element the renderer never binds or references", () => {
  const declared = [...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const unused = declared.filter(
    (id) => !id.startsWith("icon-")
      && !renderer.includes(`"#${id}"`)
      && !indexHtml.includes(`aria-controls="${id}"`)
      && !indexHtml.includes(`aria-labelledby="${id}"`),
  );
  assert.deepEqual(unused, [], "the shell carries markup nothing drives");
});

test("the renderer names socket channels, never host routes", () => {
  assert.match(renderer, /video: "\/ws\/windows\/video"/);
  assert.match(renderer, /events: "\/ws\/windows\/events"/);
  assert.match(renderer, /createSocket\("video", query\)/);
  assert.match(renderer, /createSocket\("events"\)/);
  // The browser fallback resolves a channel through the fixed table and refuses anything else.
  assert.match(renderer, /const route = SOCKET_ROUTES\[channel\];/);
  assert.match(renderer, /if \(!route\) throw new Error/);
  assert.doesNotMatch(renderer, /\/ws\/\$\{channel\}/);
});

test("the host maps both Windows sockets and keeps them on the Windows surface", () => {
  assert.match(windowsApi, /"\/ws\/windows\/video"/);
  assert.match(windowsApi, /"\/ws\/windows\/events"/);
  const routes = [...windowsApi.matchAll(/app\.Map\(\s*"(\/ws\/[^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(routes.sort(), ["/ws/windows/events", "/ws/windows/video"]);
  assert.equal(
    (windowsApi.match(/\.WindowsSurface\(\)/g) ?? []).length >= routes.length,
    true,
    "every Windows endpoint declares its surface",
  );
});

test("the renderer only ever addresses its own product's API", () => {
  assert.match(renderer, /const API = "\/api\/v1\/windows";/);
  const paths = [...renderer.matchAll(/"(\/api\/v1\/[^"`$]*)"/g)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(paths)].sort(),
    ["/api/v1/auth/bootstrap", "/api/v1/windows"],
    "bootstrap is surface-neutral; everything else hangs off the windows prefix",
  );
  assert.doesNotMatch(renderer, /\/api\/v1\/devices/);
  assert.doesNotMatch(renderer, /\/api\/v1\/selection/);
});

test("candidate thumbnails load after metadata with bounded, cancellable object URL cleanup", () => {
  assert.match(renderer, /const THUMBNAIL_CONCURRENCY = 4/);
  assert.match(renderer, /await getJson\(`\$\{API\}\/windows`, \{ signal: controller\.signal \}\)/);
  assert.match(renderer, /loadCandidateThumbnails\(/);
  assert.match(renderer, /loadCandidateThumbnailWorker\(/);
  assert.match(renderer, /windowThumbnailUrl\(candidate\.id\)/);
  assert.match(renderer, /URL\.createObjectURL\(blob\)/);
  assert.match(renderer, /URL\.revokeObjectURL\(thumbnail\.url\)/);
  assert.match(renderer, /state\.candidateAbortController\?\.abort\(\)/);
  assert.match(renderer, /isCurrentThumbnailGeneration\(state\.candidateGeneration, generation\)/);
});

test("candidate cards use safe text nodes, retain unavailable explanations, and attach through sessions", () => {
  assert.match(renderer, /label\.textContent = presentation\.title/);
  assert.match(renderer, /detail\.textContent = presentation\.identity/);
  assert.match(renderer, /status\.textContent = presentation\.status/);
  assert.match(renderer, /button\.setAttribute\("aria-disabled", String\(!presentation\.attachable\)\)/);
  assert.match(renderer, /if \(presentation\.attachable\) void attachCandidate\(window\)/);
  assert.match(renderer, /postJson\(`\$\{API\}\/session\/attach`, \{ candidateId: candidate\.id \}\)/);
  assert.doesNotMatch(renderer, /\.innerHTML\s*=/);
});

test("the renderer refuses a grant issued for another surface", () => {
  assert.match(renderer, /if \(surface !== WINDOWS_SURFACE\)/);
  assert.match(renderer, /context\.surface !== WINDOWS_SURFACE/);
  assert.match(renderer, /sessionStorage\.setItem\(SESSION_KEYS\.surface, surface\)/);
});

test("the panel keys its own storage so two surfaces on one origin cannot mix", () => {
  const sharedState = read("web", "windows", "windows-state.js");
  assert.match(sharedState, /session: "windows-canvas-session"/);
  assert.match(sharedState, /instance: "windows-canvas-instance"/);
  assert.match(sharedState, /surface: "windows-canvas-surface"/);
  assert.doesNotMatch(sharedState, /mobile-canvas-(session|instance|surface)/);
});

test("coordinate input carries the transform token and the capture size, never rendered pixels", () => {
  assert.match(renderer, /captureFromClientPoint\(\{/);
  assert.match(renderer, /const frame = inputFrame\(state\.geometry\);/);
  for (const kind of ["click", "pointer", "wheel", "key", "text"]) {
    assert.ok(renderer.includes(`sendInput(\n      "${kind}"`)
      || renderer.includes(`sendInput("${kind}"`)
      || renderer.includes(`"${kind}",`), `${kind} input must be sent`);
  }
  // getBoundingClientRect feeds the mapper and nothing else: a rendered pixel is never a coordinate.
  const rectUses = renderer.match(/getBoundingClientRect\(\)/g) ?? [];
  assert.ok(rectUses.length >= 1);
  assert.doesNotMatch(renderer, /x: event\.clientX/);
  assert.doesNotMatch(renderer, /y: event\.clientY/);
});

test("a refused coordinate request re-measures instead of retrying the old point", () => {
  assert.match(renderer, /async function recoverFromInputError\(error\)/);
  assert.match(renderer, /requiresWindowRefresh\(error\)/);
  assert.match(renderer, /\/geometry`/);
  assert.match(renderer, /if \(isStaleTransformError\(error\) \|\| state\.geometry\?\.minimized\) \{\s*startStream\(\);/);
});

test("the stream handles descriptors, ends, reconnects, and falls back to screenshots", () => {
  assert.match(renderer, /function handleStreamMessage\(message\)/);
  assert.match(renderer, /message\?\.type === "end"/);
  assert.match(renderer, /describeStreamEnd\(end\)/);
  assert.match(renderer, /outcome\.reconnect && state\.panelVisible/);
  assert.match(
    renderer,
    /outcome\.kind === "capture-failed" \|\| outcome\.kind === "encoder-failed"[\s\S]*startPngFallback\("PNG"\)/,
  );
  assert.match(renderer, /if \(!\("VideoDecoder" in window\)\) \{\s*startPngFallback/);
  assert.match(renderer, /x-windows-capture-descriptor/);
  assert.match(renderer, /function startPngFallback\(label\)/);
});

test("a held pointer is always released, and moves are coalesced", () => {
  assert.match(renderer, /function cancelPointer\(\)/);
  assert.match(renderer, /state\.heldButtons/);
  assert.match(renderer, /queuePointer\("up", point, \{ button, modifiers: \[\] \}\)/);
  assert.match(renderer, /pointercancel/);
  assert.match(renderer, /lostpointercapture/);
  assert.match(renderer, /function queueMove\(point, pointer\)/);
  assert.match(renderer, /state\.pendingMove = \{ point, pointer \};/);
});

test("the panel draws agent activity only for its own window and never its text", () => {
  assert.match(renderer, /isActivityForWindow\(activity, \{ sessionId, instanceId, windowId: state\.selectedWindowId \}\)/);
  assert.match(renderer, /setText\(elements\.automationLabel, activityLabel\(activity\)\)/);
  assert.doesNotMatch(renderer, /activity\.text/);
});
