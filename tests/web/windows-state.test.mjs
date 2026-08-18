import assert from "node:assert/strict";
import test from "node:test";

import {
  activityLabel,
  applyUiQuerySuggestion,
  availableUiActions,
  buildWindowTabs,
  captureFromClientPoint,
  captureSourceLabel,
  candidateCardPresentation,
  candidateSearchText,
  candidateThumbnailState,
  catalogEntryDetail,
  catalogSourceWarning,
  defaultPickerSection,
  describeStreamEnd,
  diffWindowTabs,
  filterWindowCandidates,
  findResultPresentation,
  compileUiQuery,
  inputErrorMessage,
  inputFrame,
  isActivityForWindow,
  isDegradedCaptureSource,
  isPasswordElement,
  isStaleTransformError,
  letterboxRect,
  organizeCatalog,
  isCurrentThumbnailGeneration,
  nextThumbnailGeneration,
  preflightPresentation,
  refineUiQueryResult,
  requiresSessionRefresh,
  requiresWindowRefresh,
  resolveSelectedTab,
  sessionOriginLabel,
  snapshotWarnings,
  stageStatusPresentation,
  uiElementLabel,
  uiElementValue,
  uiQueryChips,
  uiQuerySuggestions,
  wheelNotches,
  windowThumbnailUrl,
  WINDOWS_ERROR_CODES,
  WINDOWS_SURFACE,
} from "../../web/windows/windows-state.js";

/* --------------------------------------------------------------------------------------------
 * Preflight and helper diagnostics
 * ------------------------------------------------------------------------------------------ */

test("a ready host with every feature reports no problem", () => {
  const presentation = preflightPresentation({
    ready: true,
    platformSupported: true,
    helperVersion: "1.2.3",
    signatureStatus: "valid",
    features: [{ name: "uiAutomation", available: true }],
  });
  assert.equal(presentation.ready, true);
  assert.equal(presentation.tone, "ok");
  assert.match(presentation.detail, /1\.2\.3/);
});

test("a ready host with a missing feature says which one", () => {
  const presentation = preflightPresentation({
    ready: true,
    features: [
      { name: "uiAutomation", available: true },
      { name: "mediaFoundationH264", available: false },
    ],
  });
  assert.equal(presentation.tone, "warning");
  assert.match(presentation.detail, /H\.264 encoding unavailable/);
});

test("a missing helper is an actionable failure that names where it looked", () => {
  const presentation = preflightPresentation({
    ready: false,
    platformSupported: true,
    code: WINDOWS_ERROR_CODES.helperMissing,
    detail: "windows-app-helper.exe was not found.",
    helperPath: "C:\\bin\\windows-app-helper.exe",
  });
  assert.equal(presentation.ready, false);
  assert.equal(presentation.tone, "danger");
  assert.match(presentation.title, /helper is missing/);
  assert.match(presentation.detail, /C:\\bin/);
});

test("a non-Windows host is explained rather than treated as broken", () => {
  const presentation = preflightPresentation({ ready: false, platformSupported: false });
  assert.equal(presentation.tone, "neutral");
  assert.match(presentation.title, /Windows host/);
});

/* --------------------------------------------------------------------------------------------
 * App catalog
 * ------------------------------------------------------------------------------------------ */

const settingsA = {
  id: "packaged:windows.immersivecontrolpanel",
  displayName: "Settings",
  kind: "packaged",
  appUserModelId: "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel",
  ambiguousWith: ["desktop:vendor-settings"],
};
const settingsB = {
  id: "desktop:vendor-settings",
  displayName: "Settings",
  kind: "desktop",
  executablePath: "C:\\Program Files\\Vendor\\Settings.exe",
  publisher: "Vendor",
  ambiguousWith: ["packaged:windows.immersivecontrolpanel"],
};
const paint = {
  id: "packaged:paint",
  displayName: "Paint",
  kind: "packaged",
  appUserModelId: "Microsoft.Paint_8wekyb3d8bbwe!App",
  ambiguousWith: [],
};

test("apps that share a friendly name are shown as ambiguous, never resolved", () => {
  const organized = organizeCatalog({
    entries: [settingsA, settingsB, paint],
    totalMatches: 3,
  });
  assert.deepEqual(
    organized.entries.map((entry) => [entry.entry.id, entry.ambiguous]),
    [
      ["packaged:windows.immersivecontrolpanel", true],
      ["desktop:vendor-settings", true],
      ["packaged:paint", false],
    ],
  );
});

test("a duplicate display name is ambiguous even when the host did not cross-reference it", () => {
  const organized = organizeCatalog({
    entries: [
      { ...settingsA, ambiguousWith: [] },
      { ...settingsB, ambiguousWith: [] },
    ],
  });
  assert.ok(organized.entries.every((entry) => entry.ambiguous));
});

test("what distinguishes two same-named apps is what is shown beneath them", () => {
  assert.match(catalogEntryDetail(settingsA), /immersivecontrolpanel/);
  assert.match(catalogEntryDetail(settingsB), /Settings\.exe/);
  assert.match(catalogEntryDetail(settingsB), /Vendor/);
});

test("a source that could not answer is reported so 'not installed' is never guessed", () => {
  const organized = organizeCatalog({
    entries: [],
    sources: [
      { name: "appsFolder", supported: true, count: 40 },
      { name: "startMenu", supported: false, detail: "Access denied" },
    ],
  });
  const warning = catalogSourceWarning(organized);
  assert.match(warning, /startMenu/);
  assert.match(warning, /launched by path/);
  assert.equal(catalogSourceWarning(organizeCatalog({ entries: [] })), null);
});

/* --------------------------------------------------------------------------------------------
 * Open-window picker
 * ------------------------------------------------------------------------------------------ */

const pickerCandidates = [
  {
    id: "notepad",
    title: "notes.txt - Notepad",
    processName: "notepad.exe",
    attachable: true,
  },
  {
    id: "admin",
    title: "Administrator: Terminal",
    processName: "WindowsTerminal.exe",
    elevated: true,
    attachable: true,
  },
  {
    id: "minimized",
    title: "Mail",
    appUserModelId: "Microsoft.WindowsMail_8wekyb3d8bbwe!App",
    minimized: true,
    attachable: true,
  },
  {
    id: "protected",
    title: "Vault",
    processPath: "C:\\Program Files\\Vault\\vault.exe",
    attachable: false,
    unattachableCode: "captureProtected",
    unattachableDetail: "Windows does not permit this window to be captured.",
  },
];

test("the picker always starts with open windows, including while a session is attached", () => {
  assert.equal(defaultPickerSection(null), "running");
  assert.equal(defaultPickerSection(session), "running");
});

test("window picker filtering matches title, process, and app identity without mutating source order", () => {
  assert.deepEqual(
    filterWindowCandidates(pickerCandidates, "windowsmail").map((candidate) => candidate.id),
    ["minimized"],
  );
  assert.deepEqual(
    filterWindowCandidates(pickerCandidates, "notepad").map((candidate) => candidate.id),
    ["notepad"],
  );
  assert.equal(candidateSearchText(pickerCandidates[3]).includes("vault.exe"), true);
  assert.deepEqual(pickerCandidates.map((candidate) => candidate.id), [
    "notepad", "admin", "minimized", "protected",
  ]);
});

test("candidate cards give unavailable windows useful placeholders and keyboard-readable reasons", () => {
  const minimized = candidateCardPresentation(pickerCandidates[2]);
  assert.equal(minimized.attachable, true);
  assert.equal(minimized.thumbnail.state, "placeholder");
  assert.equal(minimized.thumbnail.label, "Minimized");
  assert.match(minimized.status, /Attach.*restore/i);

  const protectedWindow = candidateCardPresentation(pickerCandidates[3], "error");
  assert.equal(protectedWindow.attachable, false);
  assert.match(protectedWindow.status, /does not permit/);
  assert.ok(protectedWindow.badges.some((badge) => badge.label === "captureProtected"));

  assert.deepEqual(candidateThumbnailState(pickerCandidates[0], "error"), {
    state: "placeholder",
    icon: "alert",
    label: "Preview unavailable",
  });
});

test("candidate text stays data and thumbnail paths encode opaque IDs", () => {
  const presentation = candidateCardPresentation({
    id: 'candidate/"<tag>',
    title: '<img src=x onerror="bad">',
    processName: "safe.exe",
    attachable: true,
  });
  assert.equal(presentation.title, '<img src=x onerror="bad">');
  assert.equal(presentation.identity, "safe.exe");
  assert.equal(
    windowThumbnailUrl('candidate/"<tag>'),
    "/api/v1/windows/windows/candidate%2F%22%3Ctag%3E/thumbnail?maximumDimension=240",
  );
});

test("thumbnail generations reject stale work after a refresh or picker close", () => {
  const first = nextThumbnailGeneration();
  const refreshed = nextThumbnailGeneration(first);
  assert.equal(isCurrentThumbnailGeneration(refreshed, first), false);
  assert.equal(isCurrentThumbnailGeneration(refreshed, refreshed), true);
});

/* --------------------------------------------------------------------------------------------
 * App session and window tabs
 * ------------------------------------------------------------------------------------------ */

const session = {
  id: "session-1",
  displayName: "Notepad",
  origin: "catalog",
  selectedWindowId: "w2",
  windows: [
    { id: "w1", title: "Untitled - Notepad", correlation: "launchedProcess" },
    { id: "w2", title: "Save As", correlation: "ownedDialog", selected: true },
    { id: "w3", title: "Find", correlation: "sameProcess", minimized: true },
  ],
};

test("every authorized window becomes its own tab, in host order", () => {
  const tabs = buildWindowTabs(session);
  assert.deepEqual(tabs.map((tab) => tab.id), ["w1", "w2", "w3"]);
  assert.deepEqual(tabs.map((tab) => tab.selected), [false, true, false]);
  assert.equal(tabs[1].correlation, "Dialog owned by the app");
  assert.equal(sessionOriginLabel(session.origin), "Launched from the app catalog");
});

test("tab state distinguishes live, minimized, elevated, and off-screen windows", () => {
  const tabs = buildWindowTabs({
    windows: [
      { id: "a", title: "Live" },
      { id: "b", title: "Small", minimized: true },
      { id: "c", title: "Admin", elevated: true },
      { id: "d", title: "Cloaked", cloaked: true },
    ],
  });
  assert.deepEqual(tabs.map((tab) => tab.state), ["live", "minimized", "elevated", "hidden"]);
  assert.deepEqual(tabs.map((tab) => tab.capturable), [true, false, true, false]);
  assert.equal(tabs[1].status, "Minimized");
});

test("an untitled window still gets a readable tab", () => {
  assert.equal(buildWindowTabs({ windows: [{ id: "a", title: "   " }] })[0].label, "Untitled window");
});

test("a new correlated window appears as a new tab rather than merging into an old one", () => {
  const before = buildWindowTabs(session);
  const after = buildWindowTabs({
    ...session,
    windows: [
      ...session.windows,
      { id: "w4", title: "Save As", correlation: "ownedDialog" },
    ],
  });
  const changes = diffWindowTabs(before, after);
  assert.deepEqual(changes.added.map((tab) => tab.id), ["w4"]);
  assert.deepEqual(changes.removed, []);
  assert.equal(after.filter((tab) => tab.label === "Save As").length, 2);
});

test("a retitled window keeps its tab, and a closed one loses it", () => {
  const before = buildWindowTabs(session);
  const after = buildWindowTabs({
    ...session,
    windows: [
      { id: "w1", title: "notes.txt - Notepad", correlation: "launchedProcess" },
      { id: "w3", title: "Find", correlation: "sameProcess" },
    ],
  });
  const changes = diffWindowTabs(before, after);
  assert.deepEqual(changes.added, []);
  assert.deepEqual(changes.removed.map((tab) => tab.id), ["w2"]);
  assert.deepEqual(changes.renamed.map((tab) => tab.id), ["w1"]);
  assert.deepEqual(changes.restated.map((tab) => tab.id), ["w3"]);
});

test("a window restored outside the panel brings its own stream back", () => {
  const before = buildWindowTabs({
    selectedWindowId: "w1",
    windows: [{ id: "w1", title: "Notepad", minimized: true }],
  });
  const after = buildWindowTabs({
    selectedWindowId: "w1",
    windows: [{ id: "w1", title: "Notepad" }],
  });
  const changes = diffWindowTabs(before, after);
  const revived = changes.restated.some((tab) => tab.id === "w1" && tab.capturable);
  assert.equal(revived, true);
  assert.equal(before[0].capturable, false);
});

test("the host's selection wins, and a lost selection falls back to a capturable window", () => {
  const tabs = buildWindowTabs(session);
  assert.equal(resolveSelectedTab(tabs, "w1").id, "w1");
  assert.equal(resolveSelectedTab(tabs, "gone").id, "w2");
  const minimizedFirst = buildWindowTabs({
    windows: [
      { id: "m", title: "Minimized", minimized: true },
      { id: "n", title: "Live" },
    ],
  });
  assert.equal(resolveSelectedTab(minimizedFirst, null).id, "n");
  assert.equal(resolveSelectedTab([], "w1"), null);
});

/* --------------------------------------------------------------------------------------------
 * Stream lifecycle
 * ------------------------------------------------------------------------------------------ */

test("a resize or DPI change is a clean reconnect, not a failure", () => {
  for (const reason of ["contentSizeChanged", "dpiChanged"]) {
    const outcome = describeStreamEnd({ type: "end", reason, reconnect: true });
    assert.equal(outcome.reconnect, true, reason);
    assert.equal(outcome.kind, "resizing");
  }
});

test("minimize, close, and capture failure each stop the stream for a stated reason", () => {
  assert.deepEqual(
    ["minimized", "windowClosed", "captureFailed", "encoderFailed", "hostStopping"].map(
      (reason) => describeStreamEnd({ reason }).kind,
    ),
    ["minimized", "closed", "capture-failed", "encoder-failed", "disconnected"],
  );
  assert.equal(describeStreamEnd({ reason: "minimized" }).reconnect, false);
  assert.equal(
    describeStreamEnd({ reason: "captureFailed", detail: "GPU reset" }).message,
    "GPU reset",
  );
});

test("a minimized window offers exactly one action, and it is restore", () => {
  const presentation = stageStatusPresentation("minimized", { windowName: "Save As" });
  assert.equal(presentation.action.id, "restore");
  assert.match(presentation.title, /Save As is minimized/);
  assert.match(presentation.detail, /no place to click/);
});

test("a launched app with no window yet is a waiting state, not a controlled one", () => {
  const presentation = stageStatusPresentation("pending", { appName: "Notepad" });
  assert.equal(presentation.action.id, "attach");
  assert.match(presentation.detail, /positively matched/);
});

test("protected content points at the inspector rather than pretending to capture", () => {
  const presentation = stageStatusPresentation("protected", { windowName: "Vault" });
  assert.equal(presentation.action.id, "inspect");
  assert.match(presentation.detail, /display affinity/);
});

test("degraded capture sources are named rather than silently accepted", () => {
  assert.equal(captureSourceLabel("windowsGraphicsCapture"), "Windows.Graphics.Capture");
  assert.equal(isDegradedCaptureSource("windowsGraphicsCapture"), false);
  assert.equal(isDegradedCaptureSource("printWindow"), true);
  assert.equal(captureSourceLabel("png"), "Screenshots (fallback)");
});

/* --------------------------------------------------------------------------------------------
 * Coordinates
 * ------------------------------------------------------------------------------------------ */

test("a wide window letterboxes inside a tall box, and the reverse", () => {
  const wide = letterboxRect(1600, 900, 800, 800);
  assert.equal(Math.round(wide.width), 800);
  assert.equal(Math.round(wide.height), 450);
  assert.equal(Math.round(wide.top), 175);
  assert.equal(Math.round(wide.left), 0);

  const tall = letterboxRect(600, 1200, 800, 800);
  assert.equal(Math.round(tall.width), 400);
  assert.equal(Math.round(tall.height), 800);
  assert.equal(Math.round(tall.left), 200);
  assert.equal(letterboxRect(100, 100, 0, 500).scale, 0);
});

test("a CSS pointer position becomes a capture pixel, never a rendered one", () => {
  const geometry = { contentWidth: 1600, contentHeight: 900, captureWidth: 1600, captureHeight: 900 };
  const rect = { left: 40, top: 20, width: 800, height: 450 };
  const point = captureFromClientPoint({ clientX: 440, clientY: 245, rect, geometry });
  assert.equal(point.x, 800);
  assert.equal(point.y, 450);
  assert.equal(point.inside, true);
  assert.equal(point.captureWidth, 1600);
  assert.equal(point.captureHeight, 900);
});

test("a scaled stream maps into its own delivered pixels, not the window's", () => {
  const geometry = { contentWidth: 1600, contentHeight: 900, captureWidth: 800, captureHeight: 450 };
  const rect = { left: 0, top: 0, width: 400, height: 225 };
  const point = captureFromClientPoint({ clientX: 200, clientY: 112.5, rect, geometry });
  assert.equal(point.x, 400);
  assert.equal(point.y, 225);
  assert.equal(point.captureWidth, 800, "the request must say which image these numbers are in");
});

test("a position outside the picture is reported and clamped, never sent as-is", () => {
  const geometry = { contentWidth: 100, contentHeight: 100, captureWidth: 100, captureHeight: 100 };
  const rect = { left: 0, top: 0, width: 100, height: 100 };
  const beyond = captureFromClientPoint({ clientX: 140, clientY: -10, rect, geometry });
  assert.equal(beyond.inside, false);
  assert.equal(beyond.x, 99.5);
  assert.equal(beyond.y, 0);
  const collapsed = captureFromClientPoint({
    clientX: 5,
    clientY: 5,
    rect: { left: 0, top: 0, width: 0, height: 0 },
    geometry,
  });
  assert.equal(collapsed.inside, false);
});

test("every coordinate request carries the transform token and the capture size", () => {
  const frame = inputFrame({
    transformVersion: "abc123",
    captureWidth: 800,
    captureHeight: 450,
    contentWidth: 1600,
    contentHeight: 900,
  });
  assert.deepEqual(frame, { transformVersion: "abc123", captureWidth: 800, captureHeight: 450 });
  assert.equal(inputFrame({ captureWidth: 800 }), null, "no token means no coordinate request");
  assert.equal(inputFrame(null), null);
});

test("wheel deltas become notches whichever unit the browser used", () => {
  assert.equal(wheelNotches(100, 0), 1);
  assert.equal(wheelNotches(3, 1), 1);
  assert.equal(wheelNotches(1, 2), 3);
});

/* --------------------------------------------------------------------------------------------
 * Errors
 * ------------------------------------------------------------------------------------------ */

test("a stale transform means re-measure, never resend the same coordinates", () => {
  const stale = { code: WINDOWS_ERROR_CODES.transformStale };
  assert.equal(isStaleTransformError(stale), true);
  assert.equal(requiresWindowRefresh(stale), true);
  assert.match(inputErrorMessage(stale), /moved/i);

  const changed = { code: WINDOWS_ERROR_CODES.identityChanged };
  assert.equal(isStaleTransformError(changed), true);
});

test("out-of-bounds and minimized refresh the window; a lost session refreshes the session", () => {
  assert.equal(requiresWindowRefresh({ code: WINDOWS_ERROR_CODES.outOfBounds }), true);
  assert.equal(requiresWindowRefresh({ code: WINDOWS_ERROR_CODES.minimized }), true);
  assert.equal(requiresWindowRefresh({ code: WINDOWS_ERROR_CODES.foregroundRefused }), false);
  assert.equal(requiresSessionRefresh({ code: WINDOWS_ERROR_CODES.sessionNotFound }), true);
  assert.equal(requiresSessionRefresh({ code: WINDOWS_ERROR_CODES.notAuthorized }), true);
  assert.equal(requiresSessionRefresh({ code: WINDOWS_ERROR_CODES.transformStale }), false);
});

test("refusals a person will hit are worded for a person", () => {
  assert.match(
    inputErrorMessage({ code: WINDOWS_ERROR_CODES.foregroundRefused }),
    /refused to bring the window forward/,
  );
  assert.match(inputErrorMessage({ code: WINDOWS_ERROR_CODES.elevated }), /elevated/);
  assert.equal(inputErrorMessage({ message: "boom" }), "boom");
});

/* --------------------------------------------------------------------------------------------
 * UI Automation
 * ------------------------------------------------------------------------------------------ */

const button = {
  role: "button",
  controlType: "button",
  properties: { name: "Save", automationId: "saveButton", enabled: true },
  supportedActions: { invoke: true, focus: true },
};
const password = {
  role: "field",
  controlType: "edit",
  properties: { name: "Password", password: true, value: "should-never-appear" },
  supportedActions: { setValue: true, focus: true },
};

test("plain inspector text is a friendly name substring query", () => {
  const compiled = compileUiQuery("save");
  assert.equal(compiled.error, null);
  assert.deepEqual(compiled.selector, {
    automationId: null,
    controlType: null,
    role: null,
    name: "save",
    value: null,
    exact: false,
    index: null,
    ancestors: [],
    path: [],
  });
  assert.deepEqual(uiQueryChips(compiled), [
    { field: "Name", operator: "contains", value: "save" },
  ]);
});

test("rich inspector syntax mixes exact server clauses with local contains refinement", () => {
  const compiled = compileUiQuery('id=SAVE and type=button and name contains "draft" and index=1');
  assert.equal(compiled.error, null);
  assert.equal(compiled.selector.automationId, "SAVE");
  assert.equal(compiled.selector.controlType, "button");
  assert.equal(compiled.selector.exact, true);
  assert.equal(compiled.selector.index, null);
  assert.deepEqual(compiled.filters, [
    { field: "name", label: "Name", operator: "contains", value: "draft" },
  ]);

  const result = refineUiQueryResult({
    totalMatches: 3,
    matches: [
      { element: { properties: { name: "Draft one" } } },
      { element: { properties: { name: "Draft two" } } },
      { element: { properties: { name: "Other" } } },
    ],
  }, compiled);
  assert.equal(result.totalMatches, 1);
  assert.equal(result.matches[0].element.properties.name, "Draft two");
});

test("inspector query errors explain the grammar without losing the typed query", () => {
  assert.match(compileUiQuery("colour=red").error, /Unknown field/);
  assert.match(compileUiQuery("constructor=red").error, /Unknown field/);
  assert.match(compileUiQuery("__proto__=red").error, /Unknown field/);
  assert.match(compileUiQuery("type contains button").error, /supports =/);
  assert.match(compileUiQuery("index=-1").error, /zero or greater/);
  assert.match(compileUiQuery('name="unterminated').error, /Close the quoted value/);
});

test("repeated query fields are refined instead of silently overwritten", () => {
  const compiled = compileUiQuery("name contains save and name contains draft");
  assert.equal(compiled.selector.name, "save");
  assert.deepEqual(compiled.filters, [
    { field: "name", label: "Name", operator: "contains", value: "draft" },
  ]);
  const refined = refineUiQueryResult({
    totalMatches: 2,
    matches: [
      { element: { properties: { name: "Save draft" } } },
      { element: { properties: { name: "Save final" } } },
    ],
  }, compiled);
  assert.equal(refined.totalMatches, 1);
  assert.equal(refined.matches[0].element.properties.name, "Save draft");
});

test("inspector autocomplete teaches fields, operators, and known values", () => {
  assert.equal(uiQuerySuggestions("na")[0].insertText, "name contains ");
  assert.deepEqual(
    uiQuerySuggestions("name").map((suggestion) => suggestion.insertText),
    ["name=", "name contains "],
  );
  assert.equal(uiQuerySuggestions("type=but")[0].insertText, "type=button");
  const accepted = applyUiQuerySuggestion(
    "role=field and na",
    uiQuerySuggestions("role=field and na")[0],
  );
  assert.equal(accepted.value, "role=field and name contains ");
  assert.equal(accepted.cursor, accepted.value.length);
});

test("only the actions an element actually supports are offered", () => {
  assert.deepEqual(availableUiActions(button).map((action) => action.id), ["invoke", "focus"]);
  assert.deepEqual(availableUiActions({}).map((action) => action.id), []);
});

test("a password control never offers set value and never reveals its value", () => {
  assert.equal(isPasswordElement(password), true);
  assert.deepEqual(availableUiActions(password).map((action) => action.id), ["focus"]);
  assert.equal(uiElementLabel(password), "Password field");
  assert.equal(uiElementValue(password), null);
  assert.equal(uiElementValue({ properties: { value: "plain" } }), "plain");
});

test("truncated and timed-out traversals say so instead of looking complete", () => {
  const warnings = snapshotWarnings({ truncated: true, timedOut: true, nodeCount: 500 });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /truncated at 500 nodes/);
  assert.match(warnings[1], /ran out of time/);
  assert.deepEqual(snapshotWarnings({ nodeCount: 12 }), []);
});

test("multiple matches are an ambiguity to resolve, never a list to act on", () => {
  const many = findResultPresentation({ matches: [{ element: button }, { element: button }], totalMatches: 2 });
  assert.equal(many.ambiguous, true);
  assert.match(many.message, /Add id=/);

  const one = findResultPresentation({ matches: [{ element: button }], totalMatches: 1 });
  assert.equal(one.ambiguous, false);
  assert.equal(one.tone, "ok");
  assert.equal(one.message, "");

  const none = findResultPresentation({ matches: [], totalMatches: 0 });
  assert.equal(none.tone, "warning");
  assert.match(none.message, /No element matched/);
});

test("client-refined results disclose when the bounded server result may be incomplete", () => {
  const presentation = findResultPresentation({
    matches: [{ element: button }],
    totalMatches: 1,
    filterIncomplete: true,
  });
  assert.equal(presentation.tone, "warning");
  assert.match(presentation.message, /exact clause/);
});

/* --------------------------------------------------------------------------------------------
 * Agent activity
 * ------------------------------------------------------------------------------------------ */

const panel = { sessionId: "s", instanceId: "i", windowId: "w2" };

test("activity is drawn only for this panel, this surface, and this window", () => {
  const base = { kind: "tap", surface: WINDOWS_SURFACE, sessionId: "s", instanceId: "i", deviceId: "w2" };
  assert.equal(isActivityForWindow(base, panel), true);
  assert.equal(isActivityForWindow({ ...base, surface: "mobile" }, panel), false);
  assert.equal(isActivityForWindow({ ...base, instanceId: "other" }, panel), false);
  assert.equal(isActivityForWindow({ ...base, deviceId: "w1" }, panel), false);
  assert.equal(isActivityForWindow({ ...base, sessionId: undefined }, panel), false);
  assert.equal(isActivityForWindow(base, { ...panel, windowId: null }), false);
  assert.equal(isActivityForWindow(null, panel), false);
});

test("typed text is never displayed, only counted", () => {
  assert.equal(activityLabel({ kind: "text", characterCount: 12 }), "Typed 12 characters");
  assert.equal(activityLabel({ kind: "text", characterCount: 1 }), "Typed 1 character");
  assert.equal(activityLabel({ kind: "wheel" }), "Scroll");
  assert.equal(activityLabel({ kind: "semantic", detail: "invoke button 'Save'" }), "invoke button 'Save'");
});
