import { AnnexBParser } from "../annexb.js";
import {
  activityLabel,
  applyUiQuerySuggestion,
  availableUiActions,
  captureFromClientPoint,
  captureSourceLabel,
  candidateCardPresentation,
  catalogSourceWarning,
  correlationLabel,
  compileUiQuery,
  defaultPickerSection,
  describeStreamEnd,
  filterWindowCandidates,
  findResultPresentation,
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
  buildWindowTabs,
  diffWindowTabs,
  featureLabel,
  sessionOriginLabel,
  SESSION_KEYS,
  snapshotWarnings,
  stageStatusPresentation,
  uiElementLabel,
  uiElementValue,
  uiQueryChips,
  uiQuerySuggestions,
  wheelNotches,
  windowThumbnailUrl,
  WINDOWS_SURFACE,
} from "./windows-state.js";

const elements = {
  selector: document.querySelector("#app-selector"),
  selectorTitle: document.querySelector("#selector-title"),
  selectorSubtitle: document.querySelector("#selector-subtitle"),
  popover: document.querySelector("#app-popover"),
  tabCatalog: document.querySelector("#tab-catalog"),
  tabRunning: document.querySelector("#tab-running"),
  panelCatalog: document.querySelector("#panel-catalog"),
  panelRunning: document.querySelector("#panel-running"),
  catalogSearch: document.querySelector("#catalog-search"),
  catalogList: document.querySelector("#catalog-list"),
  catalogEmpty: document.querySelector("#catalog-empty"),
  catalogWarning: document.querySelector("#catalog-warning"),
  windowSearch: document.querySelector("#window-search"),
  windowList: document.querySelector("#window-list"),
  windowEmpty: document.querySelector("#window-empty"),
  openExecutable: document.querySelector("#open-executable"),
  inspectButton: document.querySelector("#inspect-button"),
  screenshotButton: document.querySelector("#screenshot-button"),
  revealButton: document.querySelector("#reveal-button"),
  refreshButton: document.querySelector("#refresh-button"),
  releaseButton: document.querySelector("#release-button"),
  preflight: document.querySelector("#preflight"),
  preflightTitle: document.querySelector("#preflight-title"),
  preflightDetail: document.querySelector("#preflight-detail"),
  preflightDetails: document.querySelector("#preflight-details"),
  preflightDialog: document.querySelector("#preflight-dialog"),
  preflightFeatures: document.querySelector("#preflight-features"),
  preflightEnvironment: document.querySelector("#preflight-environment"),
  tabstrip: document.querySelector("#tabstrip"),
  tabs: document.querySelector("#tabs"),
  stage: document.querySelector("#stage"),
  viewport: document.querySelector("#viewport"),
  canvas: document.querySelector("#screen"),
  overlay: document.querySelector("#overlay"),
  overlayEyebrow: document.querySelector("#overlay-eyebrow"),
  overlayTitle: document.querySelector("#overlay-title"),
  overlayDetail: document.querySelector("#overlay-detail"),
  overlayAction: document.querySelector("#overlay-action"),
  overlayActionText: document.querySelector("#overlay-action-text"),
  automation: document.querySelector("#automation"),
  automationCursor: document.querySelector("#automation-cursor"),
  automationLabel: document.querySelector("#automation-label"),
  inspector: document.querySelector("#inspector"),
  inspectorClose: document.querySelector("#inspector-close"),
  queryForm: document.querySelector("#ui-query-form"),
  queryInput: document.querySelector("#ui-query-input"),
  queryClear: document.querySelector("#ui-query-clear"),
  queryHelpButton: document.querySelector("#ui-query-help"),
  queryHelpPopover: document.querySelector("#ui-query-help-popover"),
  querySuggestions: document.querySelector("#ui-query-suggestions"),
  queryChips: document.querySelector("#ui-query-chips"),
  queryHint: document.querySelector("#query-hint"),
  queryExamples: [...document.querySelectorAll(".query-example")],
  findButton: document.querySelector("#find-button"),
  findStatus: document.querySelector("#find-status"),
  findResults: document.querySelector("#find-results"),
  queryEmpty: document.querySelector("#inspector-query-empty"),
  resultsTab: document.querySelector("#inspector-results-tab"),
  treeTab: document.querySelector("#inspector-tree-tab"),
  resultsPanel: document.querySelector("#inspector-results-panel"),
  treePanel: document.querySelector("#inspector-tree-panel"),
  matchCount: document.querySelector("#match-count"),
  scopeDetails: document.querySelector("#scope-details"),
  snapshotDepth: document.querySelector("#snapshot-depth"),
  snapshotNodes: document.querySelector("#snapshot-nodes"),
  snapshotTimeout: document.querySelector("#snapshot-timeout"),
  snapshotButton: document.querySelector("#snapshot-button"),
  snapshotStatus: document.querySelector("#snapshot-status"),
  snapshotTree: document.querySelector("#snapshot-tree"),
  actionBar: document.querySelector("#action-bar"),
  actionTargetLabel: document.querySelector("#action-target-label"),
  actionTargetDetail: document.querySelector("#action-target-detail"),
  actionValueField: document.querySelector("#action-value-field"),
  actionValue: document.querySelector("#action-value"),
  actionScrollField: document.querySelector("#action-scroll-field"),
  actionDirection: document.querySelector("#action-direction"),
  actionAmount: document.querySelector("#action-amount"),
  actionButtons: document.querySelector("#action-buttons"),
  actionStatus: document.querySelector("#action-status"),
  inputStatus: document.querySelector("#input-status"),
  streamMode: document.querySelector("#stream-mode"),
  streamFps: document.querySelector("#stream-fps"),
  captureSource: document.querySelector("#capture-source"),
  captureSize: document.querySelector("#capture-size"),
  transformVersion: document.querySelector("#transform-version"),
  executableDialog: document.querySelector("#executable-dialog"),
  executableForm: document.querySelector("#executable-form"),
  executablePath: document.querySelector("#executable-path"),
  executableArguments: document.querySelector("#executable-arguments"),
  executableWorkingDirectory: document.querySelector("#executable-working-directory"),
  executableError: document.querySelector("#executable-error"),
  toast: document.querySelector("#toast"),
};

/**
 * The host adapter, when one is present. GitHub serves this renderer over loopback HTTP and there is
 * nothing to adapt; VS Code installs a transport that forwards the same requests through its
 * extension host. Either way the renderer only ever names its own product's routes.
 */
const transport = window.mobileCanvasTransport || null;

/**
 * Socket channels, not paths. The renderer says which of its own two channels it wants and each host
 * decides where that is; a webview must never be able to hand its host an arbitrary route.
 */
const SOCKET_ROUTES = {
  video: "/ws/windows/video",
  events: "/ws/windows/events",
};

const API = "/api/v1/windows";
const SESSION_POLL_MS = 2500;
const PNG_POLL_MS = 700;
const RECONNECT_DELAY_MS = 180;
const DRAG_THRESHOLD_PX = 3;
const WHEEL_FLUSH_MS = 60;
const AUTOMATION_IDLE_MS = 2600;
const TOAST_MS = 4000;
const THUMBNAIL_CONCURRENCY = 4;

const state = {
  preflight: null,
  selection: null,
  session: null,
  sessionSignature: "",
  tabs: [],
  selectedWindowId: null,
  geometry: null,
  descriptor: null,
  socket: null,
  parser: null,
  decoder: null,
  decoderTimestamp: 0,
  pngTimer: null,
  pngBusy: false,
  reconnectTimer: null,
  sessionTimer: null,
  frameCounter: 0,
  frameClock: 0,
  framePainted: false,
  canvasContext: null,
  streamMode: "idle",
  panelVisible: !document.hidden,
  released: false,
  catalog: null,
  candidates: null,
  catalogQuery: "",
  candidateQuery: "",
  candidateGeneration: 0,
  candidateAbortController: null,
  candidateThumbnails: new Map(),
  candidateCards: new Map(),
  pointer: null,
  pointerQueue: Promise.resolve(),
  pendingMove: null,
  moveInFlight: false,
  heldButtons: new Set(),
  wheel: null,
  wheelTimer: null,
  inputStatusTimer: null,
  toastTimer: null,
  match: null,
  inspectorOpen: false,
  inspectorView: "results",
  snapshotRoot: null,
  queryCompiled: null,
  querySuggestions: [],
  querySuggestionIndex: -1,
  automationTimer: null,
  activitySocket: null,
  activityRetry: null,
};

/* ---------------------------------------------------------------------------------------------
 * Transport
 * ------------------------------------------------------------------------------------------ */

let bootstrapExchange = null;

async function api(path, options = {}) {
  let response = await sendApiRequest(path, options);
  if (
    response.status === 401
    && !transport
    && path !== "/api/v1/auth/bootstrap"
    && await exchangeBootstrapGrant()
  ) {
    response = await sendApiRequest(path, options);
  }
  return requireSuccessfulResponse(response);
}

async function sendApiRequest(path, options = {}) {
  const request = {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  };
  return transport ? await transport.api(path, request) : await fetch(path, request);
}

async function requireSuccessfulResponse(response) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({
      message: `${response.status} ${response.statusText}`,
    }));
    const error = new Error(payload.message || "The Windows App host refused the request.");
    error.code = payload.code;
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  return response;
}

async function getJson(path, options) {
  const response = await api(path, options);
  return response ? await response.json() : null;
}

function postJson(path, body) {
  return api(path, {
    method: "POST",
    body: JSON.stringify(body ?? {}),
  }).then((response) => (response ? response.json() : null));
}

async function bootstrap() {
  if (transport) {
    const context = await transport.bootstrap();
    sessionStorage.setItem(SESSION_KEYS.session, context.sessionId || "");
    sessionStorage.setItem(SESSION_KEYS.instance, context.instanceId || "");
    sessionStorage.setItem(SESSION_KEYS.surface, context.surface || WINDOWS_SURFACE);
    if (context.surface && context.surface !== WINDOWS_SURFACE) {
      throw new Error("This panel was authorized for another product surface.");
    }
    return;
  }
  await exchangeBootstrapGrant();
}

function exchangeBootstrapGrant() {
  bootstrapExchange ??= performBootstrapExchange().finally(() => {
    bootstrapExchange = null;
  });
  return bootstrapExchange;
}

async function performBootstrapExchange() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const secret = fragment.get("bootstrap");
  if (!secret) return false;
  const sessionId = fragment.get("sessionId");
  const instanceId = fragment.get("instanceId");
  // A Windows panel is only ever opened with an explicit surface. An absent or different one is a
  // grant for another product, and this renderer must not try to use it.
  const surface = fragment.get("surface");
  if (surface !== WINDOWS_SURFACE) {
    throw new Error("This canvas URL was not issued for the Windows App surface.");
  }
  sessionStorage.setItem(SESSION_KEYS.session, sessionId || "");
  sessionStorage.setItem(SESSION_KEYS.instance, instanceId || "");
  sessionStorage.setItem(SESSION_KEYS.surface, surface);
  const response = await sendApiRequest("/api/v1/auth/bootstrap", {
    method: "POST",
    body: JSON.stringify({ secret, sessionId, instanceId, surface }),
  });
  await requireSuccessfulResponse(response);
  return true;
}

function createSocket(channel, query) {
  if (transport?.createSocket) return transport.createSocket(channel, query);
  const route = SOCKET_ROUTES[channel];
  if (!route) throw new Error(`Unknown Windows App channel: ${channel}`);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${protocol}//${location.host}${route}${query ? `?${query}` : ""}`);
}

function panelIdentity() {
  return {
    sessionId: sessionStorage.getItem(SESSION_KEYS.session) || "",
    instanceId: sessionStorage.getItem(SESSION_KEYS.instance) || "",
  };
}

/* ---------------------------------------------------------------------------------------------
 * Preflight
 * ------------------------------------------------------------------------------------------ */

async function loadPreflight() {
  try {
    state.preflight = await getJson(`${API}/capabilities`);
  } catch (error) {
    state.preflight = {
      ready: false,
      platformSupported: true,
      code: error.code,
      detail: error.message,
      features: [],
    };
  }
  renderPreflight();
}

function renderPreflight() {
  const presentation = preflightPresentation(state.preflight);
  elements.preflight.classList.toggle("hidden", presentation.ready && presentation.tone === "ok");
  elements.preflight.dataset.tone = presentation.tone;
  setText(elements.preflightTitle, presentation.title);
  setText(elements.preflightDetail, presentation.detail ?? "");
  const blocked = !presentation.ready;
  elements.selector.disabled = blocked;
  if (blocked) {
    // Nothing can be driven until the host says it can drive something, so the stage explains the
    // reason instead of showing an app picker that would fail on its first request.
    stopStream();
    showStage("no-session", {
      tone: presentation.tone,
      title: presentation.title,
      detail: presentation.detail,
      busy: presentation.busy === true,
      action: null,
    });
    elements.viewport.dataset.status = "blocked";
  }
}

function showPreflightDetails() {
  const features = state.preflight?.features ?? [];
  elements.preflightFeatures.replaceChildren(...features.map((feature) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = featureLabel(feature.name);
    const badge = document.createElement("span");
    badge.className = `badge ${feature.available ? "success" : "warning"}`;
    badge.textContent = feature.available ? "available" : "unavailable";
    badge.title = feature.detail ?? "";
    item.append(name, badge);
    return item;
  }));
  const environment = state.preflight?.environment;
  const parts = [];
  if (state.preflight?.helperPath) parts.push(`Helper: ${state.preflight.helperPath}`);
  if (state.preflight?.helperVersion) parts.push(`Version ${state.preflight.helperVersion}`);
  if (state.preflight?.signatureStatus) parts.push(`Signature ${state.preflight.signatureStatus}`);
  if (environment?.operatingSystem) parts.push(environment.operatingSystem);
  if (environment) {
    parts.push(`Session ${environment.sessionId}${environment.interactive ? " (interactive)" : ""}`);
    parts.push(`Integrity ${environment.integrityLevel}`);
  }
  setText(elements.preflightEnvironment, parts.join(" · "));
  elements.preflightDialog.showModal();
}

/* ---------------------------------------------------------------------------------------------
 * App picker
 * ------------------------------------------------------------------------------------------ */

function openPopover() {
  elements.popover.classList.remove("hidden");
  elements.selector.setAttribute("aria-expanded", "true");
  showPopoverPanel(defaultPickerSection(state.session));
  void loadCatalog();
  void loadCandidates();
}

function closePopover() {
  const restoreFocus = elements.popover.contains(document.activeElement);
  clearCandidateThumbnails();
  elements.popover.classList.add("hidden");
  elements.selector.setAttribute("aria-expanded", "false");
  if (restoreFocus) requestAnimationFrame(() => elements.selector.focus());
}

function showPopoverPanel(which) {
  const catalog = which === "catalog";
  elements.tabCatalog.classList.toggle("is-active", catalog);
  elements.tabRunning.classList.toggle("is-active", !catalog);
  elements.tabCatalog.setAttribute("aria-selected", String(catalog));
  elements.tabRunning.setAttribute("aria-selected", String(!catalog));
  elements.panelCatalog.classList.toggle("hidden", !catalog);
  elements.panelRunning.classList.toggle("hidden", catalog);
  (catalog ? elements.catalogSearch : elements.windowSearch).focus();
}

async function loadCatalog() {
  const query = elements.catalogSearch.value.trim();
  state.catalogQuery = query;
  elements.catalogList.setAttribute("aria-busy", "true");
  try {
    const search = new URLSearchParams({ limit: "60" });
    if (query) search.set("text", query);
    const result = await getJson(`${API}/apps?${search}`);
    if (state.catalogQuery !== query) return;
    state.catalog = organizeCatalog(result);
    renderCatalog();
  } catch (error) {
    showToast(error.message, "danger");
  } finally {
    elements.catalogList.setAttribute("aria-busy", "false");
  }
}

function renderCatalog() {
  const organized = state.catalog;
  const entries = organized?.entries ?? [];
  elements.catalogEmpty.classList.toggle("hidden", entries.length > 0);
  const warning = catalogSourceWarning(organized);
  elements.catalogWarning.classList.toggle("hidden", !warning);
  setText(elements.catalogWarning, warning ?? "");

  elements.catalogList.replaceChildren(...entries.map(({ entry, ambiguous, detail }) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "entry";
    const title = document.createElement("span");
    title.className = "entry-title";
    const label = document.createElement("span");
    label.textContent = entry.displayName || entry.id;
    title.append(label);
    const kind = document.createElement("span");
    kind.className = "badge";
    kind.textContent = entry.kind === "packaged" ? "packaged" : "desktop";
    title.append(kind);
    if (ambiguous) {
      const flag = document.createElement("span");
      flag.className = "badge warning";
      flag.textContent = `${(entry.ambiguousWith?.length ?? 0) + 1} apps share this name`;
      title.append(flag);
    }
    const subtitle = document.createElement("span");
    subtitle.className = "entry-detail";
    subtitle.textContent = detail;
    subtitle.title = detail;
    button.append(title, subtitle);
    button.addEventListener("click", () => void launchCatalogEntry(entry));
    item.append(button);
    return item;
  }));

  if (organized?.truncated) {
    const note = document.createElement("li");
    note.className = "popover-note";
    note.textContent = `Showing ${entries.length} of ${organized.total} matches. Narrow the search.`;
    elements.catalogList.append(note);
  }
}

async function loadCandidates() {
  const generation = clearCandidateThumbnails();
  const controller = new AbortController();
  state.candidateAbortController = controller;
  // This synchronous render replaces revoked URLs before the browser has a chance to repaint.
  renderCandidates();
  elements.windowList.setAttribute("aria-busy", "true");
  try {
    const candidates = await getJson(`${API}/windows`, { signal: controller.signal });
    if (!isCurrentThumbnailGeneration(state.candidateGeneration, generation)) return;
    state.candidates = candidates;
    renderCandidates();
    void loadCandidateThumbnails(
      filterWindowCandidates(state.candidates?.windows, elements.windowSearch.value),
      generation,
    );
  } catch (error) {
    if (error.name !== "AbortError") showToast(error.message, "danger");
  } finally {
    if (isCurrentThumbnailGeneration(state.candidateGeneration, generation)) {
      elements.windowList.setAttribute("aria-busy", "false");
    }
  }
}

function renderCandidates() {
  const windows = filterWindowCandidates(state.candidates?.windows, elements.windowSearch.value);
  elements.windowEmpty.classList.toggle("hidden", windows.length > 0);
  state.candidateCards.clear();
  elements.windowList.replaceChildren(...windows.map((window) => {
    const thumbnail = state.candidateThumbnails.get(window.id);
    const presentation = candidateCardPresentation(window, thumbnail?.state);
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "window-card";
    button.setAttribute("aria-pressed", String(presentation.attached));
    button.setAttribute("aria-disabled", String(!presentation.attachable));
    button.dataset.disabled = String(!presentation.attachable);
    button.setAttribute(
      "aria-label",
      [presentation.title, presentation.identity, presentation.status].filter(Boolean).join(". "),
    );
    const media = document.createElement("span");
    media.className = "window-card-media";
    renderCandidateThumbnail(media, presentation, thumbnail?.url);
    const content = document.createElement("span");
    content.className = "window-card-content";
    const title = document.createElement("span");
    title.className = "window-card-title";
    const label = document.createElement("span");
    label.textContent = presentation.title;
    title.append(label);
    for (const badgePresentation of presentation.badges) {
      const badge = document.createElement("span");
      badge.className = `badge ${badgePresentation.tone}`;
      badge.textContent = badgePresentation.label;
      title.append(badge);
    }
    const detail = document.createElement("span");
    detail.className = "window-card-detail";
    detail.textContent = presentation.identity;
    detail.title = presentation.identity;
    const status = document.createElement("span");
    status.className = "window-card-status";
    status.textContent = presentation.status;
    content.append(title, detail, status);
    button.append(media, content);
    button.addEventListener("click", () => {
      if (presentation.attachable) void attachCandidate(window);
    });
    state.candidateCards.set(window.id, { media, window });
    item.append(button);
    return item;
  }));
}

function createPickerIcon(iconName) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.classList.add("icon");
  icon.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${iconName}`);
  icon.append(use);
  return icon;
}

function renderCandidateThumbnail(media, presentation, url) {
  media.replaceChildren();
  media.dataset.state = presentation.thumbnail.state;
  if (presentation.thumbnail.state === "ready" && url) {
    const image = document.createElement("img");
    image.src = url;
    image.alt = "";
    media.append(image);
    return;
  }
  const placeholder = document.createElement("span");
  placeholder.className = "window-thumbnail-placeholder";
  placeholder.append(createPickerIcon(presentation.thumbnail.icon));
  const label = document.createElement("span");
  label.textContent = presentation.thumbnail.label;
  placeholder.append(label);
  media.append(placeholder);
}

function clearCandidateThumbnails() {
  state.candidateGeneration = nextThumbnailGeneration(state.candidateGeneration);
  state.candidateAbortController?.abort();
  state.candidateAbortController = null;
  for (const thumbnail of state.candidateThumbnails.values()) {
    if (thumbnail.url) URL.revokeObjectURL(thumbnail.url);
  }
  state.candidateThumbnails.clear();
  state.candidateCards.clear();
  return state.candidateGeneration;
}

async function loadCandidateThumbnails(candidates, generation) {
  const loadable = candidates.filter((candidate) => (
    candidateCardPresentation(candidate).attachable && !state.candidateThumbnails.has(candidate.id)
  ));
  for (const candidate of loadable) state.candidateThumbnails.set(candidate.id, { state: "loading" });
  renderCandidates();
  const workers = Array.from(
    { length: Math.min(THUMBNAIL_CONCURRENCY, loadable.length) },
    () => loadCandidateThumbnailWorker(loadable, generation),
  );
  await Promise.all(workers);
}

async function loadCandidateThumbnailWorker(queue, generation) {
  while (queue.length > 0 && isCurrentThumbnailGeneration(state.candidateGeneration, generation)) {
    const candidate = queue.shift();
    if (!candidate) return;
    try {
      const response = await api(windowThumbnailUrl(candidate.id), {
        signal: state.candidateAbortController?.signal,
      });
      const blob = await response.blob();
      if (!isCurrentThumbnailGeneration(state.candidateGeneration, generation)) continue;
      const url = URL.createObjectURL(blob);
      if (!isCurrentThumbnailGeneration(state.candidateGeneration, generation)) {
        URL.revokeObjectURL(url);
        continue;
      }
      state.candidateThumbnails.set(candidate.id, { state: "ready", url });
    } catch (error) {
      if (!isCurrentThumbnailGeneration(state.candidateGeneration, generation)) return;
      if (error.name === "AbortError") return;
      state.candidateThumbnails.set(candidate.id, { state: "error" });
    }
    updateCandidateThumbnail(candidate.id);
  }
}

function updateCandidateThumbnail(candidateId) {
  const card = state.candidateCards.get(candidateId);
  if (!card) return;
  const thumbnail = state.candidateThumbnails.get(candidateId);
  renderCandidateThumbnail(
    card.media,
    candidateCardPresentation(card.window, thumbnail?.state),
    thumbnail?.url,
  );
}

/* ---------------------------------------------------------------------------------------------
 * Session lifecycle
 * ------------------------------------------------------------------------------------------ */

async function launchCatalogEntry(entry) {
  closePopover();
  setInputStatus("pending", `Launching ${entry.displayName}`);
  showStage("connecting", { appName: entry.displayName, detail: "Starting the app." });
  try {
    const session = await postJson(`${API}/session/launch`, {
      entryId: entry.id,
      correlationTimeout: 12,
    });
    adoptSession(session);
  } catch (error) {
    reportSessionError(error);
  }
}

async function launchExecutable({ executablePath, args, workingDirectory }) {
  setInputStatus("pending", "Launching executable");
  showStage("connecting", { appName: executablePath, detail: "Starting the executable." });
  const session = await postJson(`${API}/session/launch-executable`, {
    executablePath,
    arguments: args,
    workingDirectory: workingDirectory || null,
    correlationTimeout: 12,
  });
  adoptSession(session);
}

async function attachCandidate(candidate) {
  closePopover();
  setInputStatus("pending", `Attaching to ${candidate.title || "window"}`);
  showStage("connecting", { windowName: candidate.title, detail: "Attaching to the window." });
  try {
    const session = await postJson(`${API}/session/attach`, { candidateId: candidate.id });
    adoptSession(session);
  } catch (error) {
    reportSessionError(error);
  }
}

async function releaseSession() {
  stopStream();
  try {
    await postJson(`${API}/session/release`, {});
  } catch (error) {
    showToast(error.message, "danger");
  }
  state.session = null;
  state.tabs = [];
  state.selectedWindowId = null;
  state.geometry = null;
  applyGeometry(null);
  renderSessionNow();
  showToast("Released. The app itself keeps running.", "ok");
}

function reportSessionError(error) {
  showStage("error", { detail: error.message });
  setInputStatus("error", error.message);
  showToast(error.message, "danger");
}

async function refreshSession({ restartStream = true } = {}) {
  if (state.released) return;
  try {
    const selection = await getJson(`${API}/session`);
    state.selection = selection;
    adoptSession(selection?.hasSelection ? selection.session : null, { restartStream });
  } catch (error) {
    // Only a host that says this panel has no session drops the session view. A transient failure
    // is reported and retried by the poll, because tearing the tabs down on a blip would look like
    // the app closed.
    if (requiresSessionRefresh(error)) {
      adoptSession(null, { restartStream });
      return;
    }
    showToast(error.message, "danger");
  }
}

/** A cheap identity for "the session as the panel is currently drawing it". */
function sessionSignature(session, tabs, selectedId) {
  return [
    session?.id ?? "",
    session?.displayName ?? "",
    session?.pendingCode ?? "",
    selectedId ?? "",
    ...tabs.map((tab) => `${tab.id}:${tab.label}:${tab.state}`),
  ].join("|");
}

/**
 * Takes a fresh view of the app session.
 *
 * New windows appear as new tabs on their own: the host only reports a window once it has positively
 * correlated it with this session, so following its list is safe. Nothing here merges windows, and a
 * tab is only ever identified by its opaque window ID, so two windows of the same app with the same
 * title stay two tabs instead of quietly becoming one.
 */
function adoptSession(session, { restartStream = true } = {}) {
  const previous = state.tabs;
  state.session = session ?? null;
  state.tabs = buildWindowTabs(session);
  const changes = diffWindowTabs(previous, state.tabs);
  const selected = resolveSelectedTab(state.tabs, state.selectedWindowId);
  const changedWindow = selected?.id !== state.selectedWindowId;
  state.selectedWindowId = selected?.id ?? null;

  // The session is polled, so most passes change nothing. Re-rendering the tab strip anyway would
  // move focus out of whichever tab the keyboard was on every couple of seconds.
  const signature = sessionSignature(session, state.tabs, state.selectedWindowId);
  if (signature !== state.sessionSignature) {
    state.sessionSignature = signature;
    renderSession();
  }
  announceWindowChanges(changes, previous.length > 0);
  if (!session) {
    stopStream();
    showStage("no-session");
    return;
  }
  if (session.pendingCode && state.tabs.length === 0) {
    stopStream();
    showStage("pending", {
      appName: session.displayName,
      detail: session.pendingDetail,
    });
    return;
  }
  if (!selected) {
    stopStream();
    showStage("closed", { appName: session.displayName });
    return;
  }
  // A window the user restored from the taskbar changes state without changing selection, and its
  // stream already ended when it was minimized. Restart on that transition so the stage comes back
  // on its own, but never poll-retry a window that failed for a stated reason.
  const revived = changes.restated.some((tab) => tab.id === selected.id && tab.capturable);
  if (changedWindow || restartStream || revived) startStream();
}

function announceWindowChanges(changes, hadWindows) {
  if (!hadWindows) return;
  if (changes.added.length === 1) {
    showToast(`New window: ${changes.added[0].label}`, "ok");
  } else if (changes.added.length > 1) {
    showToast(`${changes.added.length} new windows`, "ok");
  }
  if (changes.removed.length === 1) {
    showToast(`Closed: ${changes.removed[0].label}`);
  }
}

function renderSessionNow() {
  state.sessionSignature = sessionSignature(state.session, state.tabs, state.selectedWindowId);
  renderSession();
}

function renderSession() {
  const session = state.session;
  const selected = state.tabs.find((tab) => tab.id === state.selectedWindowId) ?? null;
  const hasSession = Boolean(session);

  setText(elements.selectorTitle, session?.displayName || "No app attached");
  setText(
    elements.selectorSubtitle,
    hasSession
      ? [sessionOriginLabel(session.origin), selected ? selected.correlation : "No window yet"].join(" · ")
      : "Launch or attach a Windows app",
  );

  elements.tabstrip.classList.toggle("hidden", state.tabs.length === 0);
  elements.tabs.replaceChildren(...state.tabs.map((tab) => createTabButton(tab)));

  elements.releaseButton.disabled = !hasSession;
  elements.revealButton.disabled = !selected;
  elements.screenshotButton.disabled = !selected;
  elements.inspectButton.disabled = !selected;
  if (!selected && state.inspectorOpen) toggleInspector(false);

  updateViewTitle(session, selected);
}

function createTabButton(tab) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tab";
  button.role = "tab";
  button.dataset.state = tab.state;
  button.setAttribute("aria-selected", String(tab.id === state.selectedWindowId));
  button.title = `${tab.label} — ${tab.status}. ${tab.correlation}.`;

  const dot = document.createElement("span");
  dot.className = "tab-state";
  const label = document.createElement("span");
  label.className = "tab-label";
  label.textContent = tab.label;
  button.append(dot, label);

  if (!tab.capturable) {
    const badge = document.createElement("span");
    badge.className = `badge ${tab.minimized ? "warning" : ""}`.trim();
    badge.textContent = tab.status.toLowerCase();
    button.append(badge);
  }

  button.addEventListener("click", () => void selectWindow(tab.id));
  return button;
}

async function selectWindow(windowId) {
  if (!windowId) return;
  try {
    const list = await postJson(`${API}/session/windows/select`, { windowId });
    state.selectedWindowId = windowId;
    if (list) {
      state.tabs = buildWindowTabs({
        windows: list.windows,
        selectedWindowId: list.selectedWindowId,
      });
    }
    renderSessionNow();
    startStream();
  } catch (error) {
    showToast(error.message, "danger");
    void refreshSession();
  }
}

async function windowAction(action) {
  if (!state.selectedWindowId) return;
  try {
    const result = await postJson(`${API}/session/windows/${action}`, {
      windowId: state.selectedWindowId,
    });
    if (result && result.success === false) {
      showToast(result.detail || `Windows refused to ${action} the window.`, "danger");
      return;
    }
    if (action === "restore") {
      await refreshSession();
    }
  } catch (error) {
    showToast(error.message, "danger");
  }
}

/* ---------------------------------------------------------------------------------------------
 * Stage and live video
 * ------------------------------------------------------------------------------------------ */

function selectedTab() {
  return state.tabs.find((tab) => tab.id === state.selectedWindowId) ?? null;
}

function showStage(kind, overrides = {}) {
  const tab = selectedTab();
  const presentation = {
    ...stageStatusPresentation(kind, {
      appName: state.session?.displayName,
      windowName: tab?.label,
      detail: overrides.detail,
    }),
    ...overrides,
  };
  elements.overlay.classList.remove("hidden");
  elements.overlay.dataset.tone = presentation.tone;
  elements.overlay.dataset.busy = String(presentation.busy === true);
  setText(elements.overlayEyebrow, presentation.eyebrow ?? "");
  setText(elements.overlayTitle, presentation.title ?? "");
  setText(elements.overlayDetail, presentation.detail ?? "");
  const action = presentation.action ?? null;
  elements.overlayAction.classList.toggle("hidden", !action);
  if (action) {
    elements.overlayAction.dataset.action = action.id;
    setText(elements.overlayActionText, action.label);
  }
  elements.viewport.dataset.status = kind === "no-session" ? "idle" : "blocked";
}

function hideStage() {
  elements.overlay.classList.add("hidden");
  elements.viewport.dataset.status = state.automationTimer ? "automating" : "streaming";
}

function startStream() {
  stopStream();
  const tab = selectedTab();
  if (!state.panelVisible || !tab || state.released) return;
  if (tab.minimized) {
    showStage("minimized");
    return;
  }
  if (!tab.capturable) {
    showStage("closed", { detail: "This window is not on screen." });
    return;
  }

  showStage("connecting");
  setStreamMode("connecting");
  state.frameClock = performance.now();

  if (!("VideoDecoder" in window)) {
    startPngFallback("PNG");
    return;
  }

  const query = new URLSearchParams({
    windowId: tab.id,
    fps: "30",
    scale: "1",
  });
  let socket;
  try {
    socket = createSocket("video", query);
  } catch (error) {
    showStreamFailure(error);
    return;
  }
  state.socket = socket;
  socket.binaryType = "arraybuffer";
  const parser = createParser();
  state.parser = parser;

  socket.addEventListener("message", (event) => {
    if (state.socket !== socket) return;
    try {
      if (typeof event.data === "string") {
        handleStreamMessage(JSON.parse(event.data));
        return;
      }
      parser.push(new Uint8Array(event.data));
    } catch (error) {
      if (state.socket === socket) showStreamFailure(error);
    }
  });
  socket.addEventListener("open", () => {
    if (state.socket === socket) setStreamMode("H.264");
  });
  socket.addEventListener("error", () => {
    if (state.socket === socket) startPngFallback("PNG");
  });
  socket.addEventListener("close", () => {
    if (state.socket === socket && !state.pngTimer && !state.reconnectTimer && !state.released) {
      startPngFallback("PNG");
    }
  });
}

function handleStreamMessage(message) {
  if (message?.type === "end") {
    handleStreamEnd(message);
    return;
  }
  state.descriptor = message;
  applyGeometry(message.geometry);
  applyCaptureSource(message);
  setStreamMode(message.encoding === "h264-annexb" ? "H.264" : message.encoding || "H.264");
  if (message.status === "protected") {
    stopStream();
    showStage("protected");
  }
}

/**
 * A stream ends for a stated reason, and the reason decides what happens next.
 *
 * A resize or DPI change is a clean restart: the decoder cannot be handed differently shaped frames,
 * so the socket is reopened for a fresh descriptor and keyframe rather than feeding it a mismatch.
 * Everything else is a state to show, not a loop to retry.
 */
function handleStreamEnd(end) {
  const outcome = describeStreamEnd(end);
  if (outcome.reconnect && state.panelVisible && !state.released) {
    setStreamMode("reconnecting");
    showStage("resizing", { detail: outcome.message });
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      startStream();
    }, RECONNECT_DELAY_MS);
    return;
  }

  if (
    (outcome.kind === "capture-failed" || outcome.kind === "encoder-failed")
    && state.panelVisible
    && !state.released
  ) {
    stopStream();
    showStage("connecting", {
      detail: `${outcome.message || "The video stream stopped."} Switching to screenshot polling.`,
    });
    startPngFallback("PNG");
    return;
  }

  stopStream();
  if (outcome.kind === "minimized" || outcome.kind === "closed") {
    void refreshSession({ restartStream: false });
  }
  showStage(outcome.kind, { detail: outcome.message || undefined });
}

function createParser() {
  return new AnnexBParser({
    onCodec: (codec) => configureDecoder(codec),
    onAccessUnit: (unit) => decodeAccessUnit(unit),
  });
}

function configureDecoder(codec) {
  if (state.decoder) return;
  state.decoder = new VideoDecoder({
    output: drawVideoFrame,
    error: () => startPngFallback("PNG"),
  });
  state.decoder.configure({
    codec,
    // The helper's Media Foundation encoder is configured for low delay and no frame reordering, so
    // decode order is presentation order and the decoder never has to hold a frame back.
    optimizeForLatency: true,
    hardwareAcceleration: "prefer-hardware",
    avc: { format: "annexb" },
  });
  state.decoderTimestamp = 0;
}

function decodeAccessUnit({ type, data }) {
  if (!state.decoder) return;
  const duration = Math.round(1_000_000 / (state.descriptor?.framesPerSecond || 30));
  try {
    state.decoder.decode(new EncodedVideoChunk({
      type,
      timestamp: state.decoderTimestamp ?? 0,
      duration,
      data,
    }));
    state.decoderTimestamp = (state.decoderTimestamp ?? 0) + duration;
  } catch {
    startPngFallback("PNG");
  }
}

function drawVideoFrame(frame) {
  // H.264 codes in 16-pixel macroblocks, so a frame whose real size is not a multiple of 16 carries
  // padding the visible rectangle excludes. Passing the source rectangle explicitly keeps that crop
  // unambiguous rather than leaving it to the implementation.
  const visible = frame.visibleRect ?? {
    x: 0,
    y: 0,
    width: frame.codedWidth,
    height: frame.codedHeight,
  };
  drawSource(frame, visible.x, visible.y, visible.width, visible.height);
  frame.close();
  hideStage();
  state.framePainted = true;
  countFrame();
}

function drawSource(source, sourceX, sourceY, sourceWidth, sourceHeight) {
  if (elements.canvas.width !== sourceWidth || elements.canvas.height !== sourceHeight) {
    elements.canvas.width = sourceWidth;
    elements.canvas.height = sourceHeight;
    state.canvasContext = null;
    fitStage();
  }
  canvasContext().drawImage(
    source,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );
}

function canvasContext() {
  state.canvasContext ??= elements.canvas.getContext("2d", { alpha: false, desynchronized: true });
  return state.canvasContext;
}

/**
 * Sizes the drawn picture so the stage letterboxes instead of stretching.
 *
 * The element's CSS box is set to the fitted rectangle, which is what makes pointer mapping a pure
 * ratio: the bounding rectangle the browser reports is exactly the image, with no bars to subtract.
 */
function fitStage() {
  const width = elements.canvas.width;
  const height = elements.canvas.height;
  const box = elements.stage.getBoundingClientRect();
  const available = {
    width: Math.max(0, box.width - 20),
    height: Math.max(0, box.height - 20),
  };
  const fitted = letterboxRect(width, height, available.width, available.height);
  if (fitted.width <= 0 || fitted.height <= 0) return;
  elements.canvas.style.width = `${Math.round(fitted.width)}px`;
  elements.canvas.style.height = `${Math.round(fitted.height)}px`;
}

function applyGeometry(geometry) {
  state.geometry = geometry ?? null;
  if (!geometry) {
    setText(elements.captureSize, "—");
    setText(elements.transformVersion, "—");
    return;
  }
  setText(
    elements.captureSize,
    `${geometry.contentWidth}×${geometry.contentHeight} @${Math.round(geometry.dpi ?? 96)} dpi`,
  );
  const token = geometry.transformVersion ?? "";
  setText(elements.transformVersion, token ? `${token.slice(0, 8)}…` : "—");
  elements.transformVersion.title = token;
  if (
    geometry.captureWidth
    && geometry.captureHeight
    && (elements.canvas.width !== geometry.captureWidth
      || elements.canvas.height !== geometry.captureHeight)
    && !state.framePainted
  ) {
    elements.canvas.width = geometry.captureWidth;
    elements.canvas.height = geometry.captureHeight;
    state.canvasContext = null;
  }
  fitStage();
}

function applyCaptureSource(descriptor) {
  const source = descriptor?.source ?? null;
  setText(elements.captureSource, source ? captureSourceLabel(source) : "—");
  elements.captureSource.title = descriptor?.sourceDetail ?? "";
  elements.captureSource.parentElement.classList.toggle(
    "is-degraded",
    Boolean(source) && isDegradedCaptureSource(source),
  );
}

function showStreamFailure(error) {
  stopStream();
  showStage("error", { detail: error.message || String(error) });
  setStreamMode("offline");
  setInputStatus("error", "Live view unavailable");
}

function stopStream() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  if (state.parser) {
    state.parser.dispose();
    state.parser = null;
  }
  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    socket.close();
  }
  if (state.decoder) {
    state.decoder.close();
    state.decoder = null;
  }
  if (state.pngTimer) {
    clearTimeout(state.pngTimer);
    state.pngTimer = null;
  }
  state.frameCounter = 0;
  state.framePainted = false;
  state.decoderTimestamp = 0;
  setStreamFps(0);
  setStreamMode("idle");
}

/**
 * Screenshot polling, for a browser with no WebCodecs H.264 decoder and for a window whose capture
 * or encoder stopped. It reads exactly the same descriptor the stream sends, so the coordinate space
 * and transform token do not change when the transport does.
 */
function startPngFallback(label) {
  const tab = selectedTab();
  if (!state.panelVisible || state.released || !tab || !tab.capturable) return;
  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    socket.close();
  }
  if (state.decoder) {
    state.decoder.close();
    state.decoder = null;
  }
  if (state.pngTimer || state.pngBusy) return;

  setStreamMode(label);
  applyCaptureSource({ source: "png", sourceDetail: "Screenshot polling fallback." });
  const capture = async () => {
    state.pngTimer = null;
    state.pngBusy = true;
    try {
      const shot = await captureScreenshot();
      const bitmap = await createImageBitmap(shot.blob);
      drawSource(bitmap, 0, 0, bitmap.width, bitmap.height);
      bitmap.close();
      if (shot.descriptor) {
        state.descriptor = shot.descriptor;
        applyGeometry(shot.descriptor.geometry);
      }
      hideStage();
      countFrame();
    } catch (error) {
      if (requiresSessionRefresh(error)) {
        await refreshSession({ restartStream: false });
      }
      showStage("disconnected", { detail: error.message });
    } finally {
      state.pngBusy = false;
      const current = selectedTab();
      if (state.panelVisible && !state.released && current?.capturable && !state.socket) {
        state.pngTimer = setTimeout(capture, PNG_POLL_MS);
      }
    }
  };
  state.pngTimer = setTimeout(capture, 0);
}

async function captureScreenshot({ scale = 1 } = {}) {
  const windowId = state.selectedWindowId;
  if (!windowId) throw new Error("No window is selected.");
  const search = new URLSearchParams({ scale: String(scale) });
  const response = await api(
    `${API}/session/windows/${encodeURIComponent(windowId)}/screenshot?${search}`,
  );
  const header = response.headers.get("x-windows-capture-descriptor");
  return { blob: await response.blob(), descriptor: decodeDescriptor(header) };
}

/** The descriptor rides beside the PNG in a base64 header, so the image stays an image. */
function decodeDescriptor(header) {
  if (!header) return null;
  try {
    const binary = atob(header);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function countFrame() {
  state.frameCounter += 1;
  const now = performance.now();
  if (now - state.frameClock < 1000) return;
  setStreamFps((state.frameCounter * 1000) / (now - state.frameClock));
  state.frameCounter = 0;
  state.frameClock = now;
}

function setStreamMode(mode) {
  state.streamMode = mode;
  setText(elements.streamMode, mode);
}

function setStreamFps(fps) {
  setText(elements.streamFps, fps > 0 ? fps.toFixed(0) : "0");
}

/* ---------------------------------------------------------------------------------------------
 * Human input
 * ------------------------------------------------------------------------------------------ */

const BUTTONS = { 0: "left", 1: "middle", 2: "right" };

/**
 * Where a browser pointer event lands in the captured image.
 *
 * Rendered pixels are never sent anywhere: the position is converted into the delivered capture
 * image's own pixels and travels with that image's size and transform token, so the host does the
 * conversion into desktop coordinates and can refuse a request measured against a window that has
 * since moved.
 */
function capturePoint(event) {
  return captureFromClientPoint({
    clientX: event.clientX,
    clientY: event.clientY,
    rect: elements.canvas.getBoundingClientRect(),
    geometry: state.geometry,
  });
}

function requireFrame() {
  const frame = inputFrame(state.geometry);
  if (!frame) {
    setInputStatus("error", "No live geometry yet. Wait for the window to appear.");
    return null;
  }
  return frame;
}

function inputPath(kind) {
  return `${API}/session/windows/${encodeURIComponent(state.selectedWindowId)}/input/${kind}`;
}

async function sendInput(kind, payload, label) {
  if (!state.selectedWindowId) return null;
  setInputStatus("pending", label);
  try {
    const result = await postJson(inputPath(kind), payload);
    if (result && result.success === false) {
      setInputStatus("error", inputErrorMessage({ code: result.code, message: result.detail }));
      return result;
    }
    setInputStatus("ok", label);
    return result;
  } catch (error) {
    setInputStatus("error", inputErrorMessage(error));
    await recoverFromInputError(error);
    return null;
  }
}

/**
 * A refused coordinate request is never retried with the same numbers.
 *
 * A stale transform means the window moved, resized, changed DPI, or minimized since the picture the
 * coordinates were read off. Sending them again would click wherever that place is now, so the
 * geometry is re-read and the stream restarted to produce a fresh token instead.
 */
async function recoverFromInputError(error) {
  if (requiresSessionRefresh(error)) {
    await refreshSession();
    return;
  }
  if (!requiresWindowRefresh(error)) return;
  cancelPointer();
  try {
    const geometry = await getJson(
      `${API}/session/windows/${encodeURIComponent(state.selectedWindowId)}/geometry`,
    );
    applyGeometry(geometry);
  } catch {
    await refreshSession({ restartStream: false });
    return;
  }
  if (isStaleTransformError(error) || state.geometry?.minimized) {
    startStream();
  }
}

function attachStageInput() {
  const canvas = elements.canvas;

  canvas.addEventListener("pointerdown", (event) => {
    if (!canInteract()) return;
    canvas.focus();
    event.preventDefault();
    const point = capturePoint(event);
    if (!point.inside) return;
    canvas.setPointerCapture(event.pointerId);
    state.pointer = {
      id: event.pointerId,
      button: BUTTONS[event.button] ?? "left",
      start: point,
      dragging: false,
      modifiers: modifiersFrom(event),
    };
  });

  canvas.addEventListener("pointermove", (event) => {
    const pointer = state.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    const point = capturePoint(event);
    if (!pointer.dragging) {
      const distance = Math.hypot(point.x - pointer.start.x, point.y - pointer.start.y);
      if (distance < DRAG_THRESHOLD_PX) return;
      pointer.dragging = true;
      state.heldButtons.add(pointer.button);
      queuePointer("down", pointer.start, pointer);
    }
    queueMove(point, pointer);
  });

  const finish = (event) => {
    const pointer = state.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    state.pointer = null;
    if (canvas.hasPointerCapture?.(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    const point = capturePoint(event);
    if (pointer.dragging) {
      queuePointer("up", point, pointer);
      state.heldButtons.delete(pointer.button);
      return;
    }
    // Windows composes a double click from two real clicks inside its own double-click time, exactly
    // as a mouse does. The count: 2 form of this request exists for an agent that only gets one shot.
    const frame = requireFrame();
    if (!frame) return;
    void sendInput(
      "click",
      {
        ...frame,
        x: point.x,
        y: point.y,
        button: pointer.button,
        count: 1,
        modifiers: pointer.modifiers,
      },
      pointer.button === "right" ? "Right click" : "Click",
    );
  };

  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", () => cancelPointer());
  canvas.addEventListener("lostpointercapture", () => {
    if (state.pointer?.dragging) cancelPointer();
  });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  canvas.addEventListener("wheel", (event) => {
    if (!canInteract()) return;
    event.preventDefault();
    const point = capturePoint(event);
    if (!point.inside) return;
    state.wheel ??= { x: point.x, y: point.y, deltaX: 0, deltaY: 0 };
    state.wheel.x = point.x;
    state.wheel.y = point.y;
    // A wheel event's positive deltaY scrolls the content down; Windows counts a positive notch as
    // scrolling up, so the sign is inverted once here rather than in every caller.
    state.wheel.deltaY -= wheelNotches(event.deltaY, event.deltaMode);
    state.wheel.deltaX += wheelNotches(event.deltaX, event.deltaMode);
    clearTimeout(state.wheelTimer);
    state.wheelTimer = setTimeout(flushWheel, WHEEL_FLUSH_MS);
  }, { passive: false });

  canvas.addEventListener("keydown", (event) => {
    if (!canInteract()) return;
    const key = mapKey(event);
    if (!key) return;
    event.preventDefault();
    const frame = requireFrame();
    if (!frame) return;
    if (key.text !== undefined) {
      void sendInput("text", { ...frame, text: key.text }, "Type");
      return;
    }
    void sendInput(
      "key",
      { ...frame, keys: [key.name], action: "press", modifiers: key.modifiers },
      key.modifiers.length > 0 ? `Key ${[...key.modifiers, key.name].join("+")}` : `Key ${key.name}`,
    );
  });

  canvas.addEventListener("paste", (event) => {
    if (!canInteract()) return;
    const text = event.clipboardData?.getData("text");
    if (!text) return;
    event.preventDefault();
    const frame = requireFrame();
    if (!frame) return;
    void sendInput("text", { ...frame, text }, "Paste");
  });

  canvas.addEventListener("blur", () => cancelPointer());
}

function canInteract() {
  const tab = selectedTab();
  return Boolean(tab && tab.capturable && state.geometry?.transformVersion && !state.released);
}

function modifiersFrom(event) {
  const modifiers = [];
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");
  if (event.metaKey) modifiers.push("win");
  return modifiers;
}

const NAMED_KEYS = {
  Enter: "enter",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  Escape: "escape",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  Insert: "insert",
  ContextMenu: "apps",
  " ": "space",
};

/**
 * Turns a browser key event into either a chord or literal text.
 *
 * A bare printable key is typed as text, so accents, dead keys, and shifted symbols arrive as the
 * character the user meant rather than as a guess about their keyboard layout. Anything with a
 * non-shift modifier, or a named key, is sent as a chord using the documented key vocabulary.
 */
function mapKey(event) {
  if (event.key === "Dead" || event.isComposing) return null;
  const modifiers = modifiersFrom(event).filter((modifier) => modifier !== "shift");
  const named = NAMED_KEYS[event.key];
  if (named) {
    return { name: named, modifiers: modifiersFrom(event) };
  }
  if (/^F\d{1,2}$/.test(event.key)) {
    return { name: event.key.toLowerCase(), modifiers: modifiersFrom(event) };
  }
  if (event.key.length !== 1) return null;
  if (modifiers.length > 0) {
    return { name: event.key.toLowerCase(), modifiers: modifiersFrom(event) };
  }
  return { text: event.key, modifiers: [] };
}

/**
 * One serialized queue for every pointer message of a gesture, so a press, its moves, and its
 * release reach Windows in the order they happened rather than racing each other.
 */
function enqueuePointer(task) {
  state.pointerQueue = state.pointerQueue.then(task).catch(() => undefined);
  return state.pointerQueue;
}

function queuePointer(action, point, pointer) {
  enqueuePointer(() => {
    const frame = inputFrame(state.geometry);
    if (!frame) return undefined;
    return sendInput(
      "pointer",
      {
        ...frame,
        x: point.x,
        y: point.y,
        action,
        button: pointer.button,
        modifiers: pointer.modifiers,
      },
      action === "down" ? "Press" : action === "up" ? "Release" : "Drag",
    );
  });
}

/**
 * Pointer moves are coalesced: only the newest position is worth sending, and a queue of stale
 * points would drag through places the pointer has already left. While a move is in flight, later
 * moves replace the pending one instead of adding to the queue.
 */
function queueMove(point, pointer) {
  state.pendingMove = { point, pointer };
  if (state.moveInFlight) return;
  state.moveInFlight = true;
  enqueuePointer(async () => {
    state.moveInFlight = false;
    const pending = state.pendingMove;
    state.pendingMove = null;
    if (!pending) return;
    const frame = inputFrame(state.geometry);
    if (!frame) return;
    await sendInput(
      "pointer",
      {
        ...frame,
        x: pending.point.x,
        y: pending.point.y,
        action: "move",
        button: pending.pointer.button,
        modifiers: pending.pointer.modifiers,
      },
      "Drag",
    );
  });
}

/**
 * Releases anything still held.
 *
 * A pointer that went down and never came up would leave a real mouse button held on the user's
 * desktop, so losing capture, hiding the panel, or a refused request all end the gesture explicitly.
 */
function cancelPointer() {
  state.pendingMove = null;
  const pointer = state.pointer;
  state.pointer = null;
  const held = [...state.heldButtons];
  state.heldButtons.clear();
  if (held.length === 0 || !state.selectedWindowId) return;
  const point = pointer?.start ?? { x: 0, y: 0 };
  for (const button of held) {
    queuePointer("up", point, { button, modifiers: [] });
  }
}

function flushWheel() {
  const wheel = state.wheel;
  state.wheel = null;
  state.wheelTimer = null;
  if (!wheel || (wheel.deltaX === 0 && wheel.deltaY === 0)) return;
  const frame = inputFrame(state.geometry);
  if (!frame) return;
  void sendInput(
    "wheel",
    {
      ...frame,
      x: wheel.x,
      y: wheel.y,
      deltaY: roundNotches(wheel.deltaY),
      deltaX: roundNotches(wheel.deltaX),
      modifiers: [],
    },
    "Scroll",
  );
}

function roundNotches(value) {
  return Math.round(value * 100) / 100;
}

function setInputStatus(status, message) {
  elements.inputStatus.dataset.status = status;
  setText(elements.inputStatus, message);
  clearTimeout(state.inputStatusTimer);
  if (status === "ok" || status === "error") {
    state.inputStatusTimer = setTimeout(() => {
      elements.inputStatus.dataset.status = "idle";
      setText(elements.inputStatus, "Ready");
    }, 2200);
  }
}

/* ---------------------------------------------------------------------------------------------
 * Agent activity
 * ------------------------------------------------------------------------------------------ */

/**
 * The agent activity channel.
 *
 * The host addresses each event to one panel on one surface, and this renderer additionally refuses
 * an event for a window it is not showing. The label never carries typed text: the host reports a
 * character count for this surface, because a Windows canvas types into the user's real session.
 */
function connectActivity() {
  clearTimeout(state.activityRetry);
  if (!state.panelVisible || state.released) return;
  let socket;
  try {
    socket = createSocket("events");
  } catch {
    return;
  }
  state.activitySocket = socket;
  socket.addEventListener("message", (event) => {
    if (state.activitySocket !== socket || typeof event.data !== "string") return;
    let activity;
    try {
      activity = JSON.parse(event.data);
    } catch {
      return;
    }
    const { sessionId, instanceId } = panelIdentity();
    if (!isActivityForWindow(activity, { sessionId, instanceId, windowId: state.selectedWindowId })) {
      return;
    }
    showAutomation(activity);
  });
  const retry = () => {
    if (state.activitySocket !== socket) return;
    state.activitySocket = null;
    clearTimeout(state.activityRetry);
    state.activityRetry = setTimeout(connectActivity, 1500);
  };
  socket.addEventListener("close", retry);
  socket.addEventListener("error", retry);
}

function disconnectActivity() {
  clearTimeout(state.activityRetry);
  const socket = state.activitySocket;
  state.activitySocket = null;
  socket?.close();
}

function showAutomation(activity) {
  elements.automation.classList.remove("hidden");
  elements.viewport.dataset.status = "automating";
  setText(elements.automationLabel, activityLabel(activity));
  const rect = elements.canvas.getBoundingClientRect();
  const viewport = elements.viewport.getBoundingClientRect();
  const width = state.geometry?.contentWidth || elements.canvas.width || 1;
  const height = state.geometry?.contentHeight || elements.canvas.height || 1;
  if (typeof activity.x === "number" && typeof activity.y === "number") {
    const left = rect.left - viewport.left + (activity.x / width) * rect.width;
    const top = rect.top - viewport.top + (activity.y / height) * rect.height;
    elements.automationCursor.style.transform = `translate(${left}px, ${top}px)`;
    elements.automationCursor.classList.remove("hidden");
  } else {
    elements.automationCursor.classList.add("hidden");
  }
  elements.automationCursor.dataset.pressed = String(
    activity.kind === "tap" || activity.kind === "pointer" || activity.kind === "drag",
  );
  setInputStatus("agent", activityLabel(activity));
  clearTimeout(state.automationTimer);
  state.automationTimer = setTimeout(endAutomation, AUTOMATION_IDLE_MS);
}

function endAutomation() {
  clearTimeout(state.automationTimer);
  state.automationTimer = null;
  elements.automation.classList.add("hidden");
  if (elements.viewport.dataset.status === "automating") {
    elements.viewport.dataset.status = state.framePainted ? "streaming" : "idle";
  }
  setInputStatus("idle", "Ready");
}

/* ---------------------------------------------------------------------------------------------
 * UI Automation inspector
 * ------------------------------------------------------------------------------------------ */

function toggleInspector(open) {
  const next = open ?? !state.inspectorOpen;
  const restoreFocus = !next
    && elements.inspector.contains(document.activeElement)
    && !elements.inspectButton.disabled;
  state.inspectorOpen = next;
  elements.inspector.classList.toggle("hidden", !state.inspectorOpen);
  elements.inspectButton.setAttribute("aria-pressed", String(state.inspectorOpen));
  fitStage();
  if (state.inspectorOpen) {
    requestAnimationFrame(() => elements.queryInput.focus());
  } else {
    closeQuerySuggestions();
    toggleQueryHelp(false);
    if (restoreFocus) requestAnimationFrame(() => elements.inspectButton.focus());
  }
}

function uiPath(suffix) {
  return `${API}/session/windows/${encodeURIComponent(state.selectedWindowId)}/ui/${suffix}`;
}

function setInspectorView(view) {
  state.inspectorView = view === "tree" ? "tree" : "results";
  const tree = state.inspectorView === "tree";
  elements.resultsTab.classList.toggle("is-active", !tree);
  elements.resultsTab.setAttribute("aria-selected", String(!tree));
  elements.resultsTab.tabIndex = tree ? -1 : 0;
  elements.treeTab.classList.toggle("is-active", tree);
  elements.treeTab.setAttribute("aria-selected", String(tree));
  elements.treeTab.tabIndex = tree ? 0 : -1;
  elements.resultsPanel.classList.toggle("hidden", tree);
  elements.treePanel.classList.toggle("hidden", !tree);
  if (tree && elements.snapshotTree.childElementCount === 0) void dumpTree();
}

function toggleQueryHelp(open) {
  const visible = open ?? elements.queryHelpPopover.classList.contains("hidden");
  elements.queryHelpPopover.classList.toggle("hidden", !visible);
  elements.queryHelpButton.setAttribute("aria-expanded", String(visible));
}

function updateQueryDraft({ suggest = true, clearResults = true } = {}) {
  const compiled = compileUiQuery(elements.queryInput.value);
  state.queryCompiled = compiled;
  elements.queryClear.classList.toggle("hidden", elements.queryInput.value.length === 0);
  elements.queryChips.replaceChildren(...uiQueryChips(compiled).map((chip) => {
    const element = document.createElement("span");
    element.className = "query-chip";
    const field = document.createElement("strong");
    field.textContent = chip.field;
    const operator = document.createElement("span");
    operator.textContent = chip.operator;
    const value = document.createElement("code");
    value.textContent = chip.value;
    element.append(field, operator, value);
    return element;
  }));
  elements.queryChips.classList.toggle("hidden", compiled.clauses.length === 0);

  if (compiled.error) setNote(elements.findStatus, compiled.error, "danger");
  else if (clearResults) setNote(elements.findStatus, "", "");
  if (clearResults) {
    elements.findResults.replaceChildren();
    elements.queryEmpty.classList.toggle("hidden", elements.queryInput.value.length > 0);
    elements.matchCount.classList.add("hidden");
    state.match = null;
    elements.actionBar.classList.add("hidden");
  }
  if (suggest) updateQuerySuggestions();
  return compiled;
}

function updateQuerySuggestions() {
  state.querySuggestions = uiQuerySuggestions(
    elements.queryInput.value,
    elements.queryInput.selectionStart ?? elements.queryInput.value.length,
  );
  state.querySuggestionIndex = -1;
  renderQuerySuggestions();
}

function renderQuerySuggestions() {
  elements.querySuggestions.replaceChildren(...state.querySuggestions.map((suggestion, index) => {
    const item = document.createElement("li");
    item.setAttribute("role", "option");
    item.id = `ui-query-suggestion-${index}`;
    item.setAttribute("aria-selected", String(index === state.querySuggestionIndex));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "query-suggestion";
    button.tabIndex = -1;
    const label = document.createElement("code");
    label.textContent = suggestion.label;
    const detail = document.createElement("span");
    detail.textContent = suggestion.detail;
    button.append(label, detail);
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => acceptQuerySuggestion(index));
    item.append(button);
    return item;
  }));
  const open = state.querySuggestions.length > 0 && document.activeElement === elements.queryInput;
  elements.querySuggestions.classList.toggle("hidden", !open);
  elements.queryInput.setAttribute("aria-expanded", String(open));
  if (open && state.querySuggestionIndex >= 0) {
    elements.queryInput.setAttribute(
      "aria-activedescendant",
      `ui-query-suggestion-${state.querySuggestionIndex}`,
    );
  } else {
    elements.queryInput.removeAttribute("aria-activedescendant");
  }
}

function moveQuerySuggestion(direction) {
  if (state.querySuggestions.length === 0) updateQuerySuggestions();
  if (state.querySuggestions.length === 0) return;
  state.querySuggestionIndex = (
    state.querySuggestionIndex + direction + state.querySuggestions.length
  ) % state.querySuggestions.length;
  renderQuerySuggestions();
  elements.querySuggestions.children[state.querySuggestionIndex]?.scrollIntoView({ block: "nearest" });
}

function acceptQuerySuggestion(index = state.querySuggestionIndex) {
  const suggestion = state.querySuggestions[index < 0 ? 0 : index];
  if (!suggestion) return false;
  const accepted = applyUiQuerySuggestion(elements.queryInput.value, suggestion);
  elements.queryInput.value = accepted.value;
  elements.queryInput.setSelectionRange(accepted.cursor, accepted.cursor);
  updateQueryDraft();
  return true;
}

function closeQuerySuggestions() {
  state.querySuggestions = [];
  state.querySuggestionIndex = -1;
  elements.querySuggestions.replaceChildren();
  elements.querySuggestions.classList.add("hidden");
  elements.queryInput.setAttribute("aria-expanded", "false");
  elements.queryInput.removeAttribute("aria-activedescendant");
}

async function findElements() {
  if (!state.selectedWindowId) return;
  const compiled = updateQueryDraft({ suggest: false, clearResults: true });
  closeQuerySuggestions();
  if (compiled.error) return;
  if (!compiled.selector) {
    setNote(elements.findStatus, "Type a name or add a field filter to search.", "warning");
    return;
  }
  setInspectorView("results");
  setNote(elements.findStatus, "Searching…", "");
  elements.queryForm.setAttribute("aria-busy", "true");
  elements.findButton.disabled = true;
  try {
    const raw = await postJson(uiPath("find"), {
      selector: compiled.selector,
      limit: compiled.filters.length > 0 ? 100 : 50,
      maximumDepth: numberValue(elements.snapshotDepth, 12),
      maximumNodes: numberValue(elements.snapshotNodes, 500),
      timeoutMilliseconds: numberValue(elements.snapshotTimeout, 5000),
    });
    renderFindResult(refineUiQueryResult(raw, compiled));
  } catch (error) {
    setNote(elements.findStatus, error.message, "danger");
    elements.findResults.replaceChildren();
  } finally {
    elements.queryForm.removeAttribute("aria-busy");
    elements.findButton.disabled = false;
  }
}

function renderFindResult(result) {
  const presentation = findResultPresentation(result);
  elements.queryEmpty.classList.add("hidden");
  const sourceTotal = result?.sourceTotalMatches ?? result?.totalMatches ?? presentation.matches.length;
  elements.matchCount.textContent = sourceTotal === presentation.matches.length
    ? String(sourceTotal)
    : `${presentation.matches.length}/${sourceTotal}`;
  elements.matchCount.classList.toggle("hidden", presentation.matches.length === 0);
  const warnings = snapshotWarnings(result?.metadata);
  setNote(
    elements.findStatus,
    [presentation.message, ...warnings].join(" "),
    warnings.length > 0 ? "warning" : presentation.tone,
  );
  elements.findResults.replaceChildren(...presentation.matches.map((match) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "match";
    button.setAttribute("aria-pressed", "false");
    const title = document.createElement("span");
    title.className = "entry-title";
    const label = document.createElement("span");
    label.textContent = uiElementLabel(match.element);
    title.append(label);
    const role = document.createElement("span");
    role.className = "badge";
    role.textContent = match.element.role;
    title.append(role);
    if (isPasswordElement(match.element)) {
      const badge = document.createElement("span");
      badge.className = "badge warning";
      badge.textContent = "password";
      title.append(badge);
    }
    const detail = document.createElement("span");
    detail.className = "entry-detail";
    detail.textContent = describeSelector(match.selector);
    button.append(title, detail);
    button.addEventListener("click", () => {
      for (const other of elements.findResults.querySelectorAll(".match")) {
        other.setAttribute("aria-pressed", "false");
      }
      button.setAttribute("aria-pressed", "true");
      selectMatch(match, presentation.ambiguous);
    });
    item.append(button);
    return item;
  }));
  if (presentation.matches.length === 1 && !presentation.ambiguous) {
    elements.findResults.querySelector(".match")?.setAttribute("aria-pressed", "true");
    selectMatch(presentation.matches[0], false);
  } else if (presentation.matches.length === 0) {
    elements.actionBar.classList.add("hidden");
  }
}

function describeSelector(selector) {
  const parts = [];
  if (selector?.automationId) parts.push(`#${selector.automationId}`);
  if (selector?.controlType) parts.push(selector.controlType);
  if (selector?.name) parts.push(`"${selector.name}"`);
  if (Number.isInteger(selector?.index)) parts.push(`[${selector.index}]`);
  if (selector?.path?.length) parts.push(`path ${selector.path.join(",")}`);
  return parts.join(" ") || "qualified selector";
}

function selectMatch(match, ambiguous) {
  state.match = match;
  elements.actionBar.classList.remove("hidden");
  setText(elements.actionTargetLabel, uiElementLabel(match.element));
  const value = uiElementValue(match.element);
  setText(
    elements.actionTargetDetail,
    [
      match.element.role,
      value ? `value “${value}”` : null,
      match.element.properties?.enabled === false ? "disabled" : null,
      isPasswordElement(match.element) ? "password control — value never read or written" : null,
      ambiguous ? "ambiguous: acting will be refused until the selector is unique" : null,
    ].filter(Boolean).join(" · "),
  );

  const actions = availableUiActions(match.element);
  elements.actionButtons.replaceChildren(...actions.map((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = action.id === "invoke" ? "button primary" : "button";
    button.textContent = action.label;
    button.addEventListener("click", () => void runUiAction(action.id));
    return button;
  }));
  if (actions.length === 0) {
    const note = document.createElement("span");
    note.className = "inspector-note";
    note.textContent = isPasswordElement(match.element)
      ? "No action is offered for a password control."
      : "This element exposes no semantic action. Use the live stage instead.";
    elements.actionButtons.replaceChildren(note);
  }
  elements.actionValueField.classList.toggle(
    "hidden",
    !actions.some((action) => action.id === "setValue"),
  );
  elements.actionScrollField.classList.toggle(
    "hidden",
    !actions.some((action) => action.id === "scroll"),
  );
  setNote(elements.actionStatus, "", "");
}

async function runUiAction(action) {
  if (!state.match || !state.selectedWindowId) return;
  setNote(elements.actionStatus, `Running ${action}…`, "");
  try {
    const result = await postJson(uiPath("action"), {
      action,
      selector: state.match.selector,
      value: action === "setValue" ? elements.actionValue.value : null,
      scroll: action === "scroll"
        ? { direction: elements.actionDirection.value, amount: elements.actionAmount.value }
        : null,
      maximumDepth: numberValue(elements.snapshotDepth, 12),
      maximumNodes: numberValue(elements.snapshotNodes, 500),
      timeoutMilliseconds: numberValue(elements.snapshotTimeout, 5000),
    });
    if (result?.success) {
      setNote(elements.actionStatus, `${action} succeeded.`, "ok");
    } else {
      setNote(
        elements.actionStatus,
        result?.detail || `${action} was refused (${result?.code ?? "unknown"}).`,
        "danger",
      );
    }
  } catch (error) {
    setNote(elements.actionStatus, error.message, "danger");
  }
}

async function dumpTree() {
  if (!state.selectedWindowId) return;
  setNote(elements.snapshotStatus, "Reading the tree…", "");
  const search = new URLSearchParams({
    maximumDepth: String(numberValue(elements.snapshotDepth, 12)),
    maximumNodes: String(numberValue(elements.snapshotNodes, 500)),
    timeoutMilliseconds: String(numberValue(elements.snapshotTimeout, 5000)),
  });
  try {
    const snapshot = await getJson(`${uiPath("snapshot")}?${search}`);
    state.snapshotRoot = snapshot?.root ?? null;
    const warnings = snapshotWarnings(snapshot?.metadata);
    setNote(
      elements.snapshotStatus,
      [`${snapshot?.metadata?.nodeCount ?? 0} nodes.`, ...warnings].join(" "),
      warnings.length > 0 ? "warning" : "ok",
    );
    elements.snapshotTree.replaceChildren();
    if (snapshot?.root) {
      elements.snapshotTree.append(renderTreeNode(snapshot.root, 0));
      const first = elements.snapshotTree.querySelector(".tree-node");
      if (first) first.tabIndex = 0;
    }
    else {
      setNote(
        elements.snapshotStatus,
        "This window exposes no UI Automation tree. Use the live stage and screenshots instead.",
        "warning",
      );
    }
  } catch (error) {
    setNote(elements.snapshotStatus, error.message, "danger");
  }
}

function renderTreeNode(element, depth) {
  const container = document.createElement("div");
  const row = document.createElement("button");
  row.type = "button";
  row.className = "tree-node";
  row.style.paddingLeft = `${depth * 12}px`;
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(depth + 1));
  row.setAttribute("aria-selected", "false");
  row.tabIndex = -1;
  if ((element.children?.length ?? 0) > 0) row.setAttribute("aria-expanded", "true");
  if (isPasswordElement(element)) row.classList.add("is-password");
  const role = document.createElement("span");
  role.className = "tree-role";
  role.textContent = element.role;
  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = uiElementLabel(element);
  row.append(role, name);
  if (element.properties?.automationId) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = element.properties.automationId;
    row.append(badge);
  }
  row.addEventListener("click", () => {
    for (const other of elements.snapshotTree.querySelectorAll(".tree-node")) {
      other.setAttribute("aria-selected", "false");
      other.tabIndex = -1;
    }
    row.setAttribute("aria-selected", "true");
    row.tabIndex = 0;
    const selector = selectorForElement(element);
    selectMatch(
      { element, selector },
      countTreeSelectorMatches(state.snapshotRoot, selector) !== 1,
    );
  });
  row.addEventListener("keydown", (event) => {
    const items = [...elements.snapshotTree.querySelectorAll(".tree-node")];
    const current = items.indexOf(row);
    let next = null;
    if (event.key === "ArrowDown") next = items[current + 1];
    else if (event.key === "ArrowUp") next = items[current - 1];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if (event.key === "Enter" || event.key === " ") row.click();
    if (next) {
      event.preventDefault();
      row.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    }
  });
  container.append(row);
  if ((element.children?.length ?? 0) > 0) {
    const group = document.createElement("div");
    group.setAttribute("role", "group");
    for (const child of element.children) group.append(renderTreeNode(child, depth + 1));
    container.append(group);
  }
  return container;
}

function countTreeSelectorMatches(root, selector) {
  if (!root) return 0;
  const expected = (value) => String(value ?? "").toLocaleLowerCase();
  let count = 0;
  const visit = (element) => {
    const properties = element.properties ?? {};
    const matches = (
      (!selector.automationId || expected(properties.automationId) === expected(selector.automationId))
      && (!selector.controlType || expected(element.controlType) === expected(selector.controlType))
      && (!selector.role || expected(element.role) === expected(selector.role))
      && (!selector.name || expected(properties.name) === expected(selector.name))
    );
    if (matches) count += 1;
    for (const child of element.children ?? []) visit(child);
  };
  visit(root);
  return count;
}

/**
 * The selector a tree node stands for. Runtime IDs are never used: they are valid only inside the
 * snapshot that produced them, and an action has to re-resolve against the live tree.
 */
function selectorForElement(element) {
  return {
    automationId: element.properties?.automationId ?? null,
    controlType: element.controlType ?? null,
    role: element.role ?? null,
    name: isPasswordElement(element) ? null : element.properties?.name ?? null,
    value: null,
    exact: true,
    ancestors: [],
    path: [],
    index: null,
  };
}

/* ---------------------------------------------------------------------------------------------
 * Screenshot
 * ------------------------------------------------------------------------------------------ */

async function saveScreenshot() {
  try {
    const shot = await captureScreenshot();
    const tab = selectedTab();
    const name = `${(tab?.label ?? "window").replace(/[^\w.-]+/g, "-").slice(0, 40) || "window"}.png`;
    if (transport?.saveBlob) {
      const saved = await transport.saveBlob(shot.blob, name);
      if (saved) showToast("Screenshot saved.", "ok");
      return;
    }
    const url = URL.createObjectURL(shot.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast("Screenshot saved.", "ok");
  } catch (error) {
    showToast(error.message, "danger");
  }
}

/* ---------------------------------------------------------------------------------------------
 * Presentation helpers
 * ------------------------------------------------------------------------------------------ */

function updateViewTitle(session, tab) {
  if (!transport?.setViewTitle) return;
  transport.setViewTitle(
    tab?.label || session?.displayName || "Windows App",
    session ? [session.displayName, tab?.status].filter(Boolean).join(" · ") : "No app attached",
  );
}

function setText(element, value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (element.textContent !== text) element.textContent = text;
}

function setNote(element, message, tone) {
  element.classList.toggle("hidden", !message);
  element.dataset.tone = tone ?? "";
  setText(element, message ?? "");
}

function numberValue(input, fallback) {
  const value = Number(input.value);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function showToast(message, tone = "") {
  if (!message) return;
  elements.toast.classList.remove("hidden");
  elements.toast.dataset.tone = tone;
  setText(elements.toast, message);
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => elements.toast.classList.add("hidden"), TOAST_MS);
}

/* ---------------------------------------------------------------------------------------------
 * Panel lifecycle
 * ------------------------------------------------------------------------------------------ */

function setPanelVisible(visible) {
  if (state.panelVisible === visible) return;
  state.panelVisible = visible;
  if (!visible) {
    cancelPointer();
    stopStream();
    disconnectActivity();
    stopSessionPolling();
    return;
  }
  connectActivity();
  startSessionPolling();
  void refreshSession();
}

function startSessionPolling() {
  stopSessionPolling();
  state.sessionTimer = setInterval(() => {
    if (!state.panelVisible || state.released) return;
    void refreshSession({ restartStream: false });
  }, SESSION_POLL_MS);
}

function stopSessionPolling() {
  clearInterval(state.sessionTimer);
  state.sessionTimer = null;
}

function attachChrome() {
  elements.selector.addEventListener("click", () => {
    if (elements.popover.classList.contains("hidden")) openPopover();
    else closePopover();
  });
  document.addEventListener("pointerdown", (event) => {
    if (
      !elements.popover.classList.contains("hidden")
      && !elements.popover.contains(event.target)
      && !elements.selector.contains(event.target)
    ) closePopover();
    if (
      !elements.queryHelpPopover.classList.contains("hidden")
      && !elements.queryHelpPopover.contains(event.target)
      && !elements.queryHelpButton.contains(event.target)
    ) toggleQueryHelp(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.popover.classList.contains("hidden")) closePopover();
    if (event.key === "Escape" && !elements.queryHelpPopover.classList.contains("hidden")) {
      toggleQueryHelp(false);
      elements.queryHelpButton.focus();
    }
  });

  elements.tabCatalog.addEventListener("click", () => showPopoverPanel("catalog"));
  elements.tabRunning.addEventListener("click", () => showPopoverPanel("running"));
  elements.catalogSearch.addEventListener("input", debounce(() => void loadCatalog(), 180));
  elements.windowSearch.addEventListener("input", () => {
    renderCandidates();
    void loadCandidateThumbnails(
      filterWindowCandidates(state.candidates?.windows, elements.windowSearch.value),
      state.candidateGeneration,
    );
  });

  elements.openExecutable.addEventListener("click", () => {
    closePopover();
    setNote(elements.executableError, "", "");
    elements.executableDialog.showModal();
  });
  elements.executableForm.addEventListener("submit", (event) => {
    if (event.submitter?.value !== "launch") return;
    const executablePath = elements.executablePath.value.trim();
    if (!executablePath) {
      event.preventDefault();
      setNote(elements.executableError, "An absolute executable path is required.", "danger");
      return;
    }
    const args = elements.executableArguments.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const workingDirectory = elements.executableWorkingDirectory.value.trim();
    launchExecutable({ executablePath, args, workingDirectory }).catch((error) => {
      reportSessionError(error);
    });
  });

  elements.refreshButton.addEventListener("click", () => {
    void loadPreflight();
    void refreshSession();
  });
  elements.releaseButton.addEventListener("click", () => void releaseSession());
  elements.revealButton.addEventListener("click", () => void windowAction("reveal"));
  elements.screenshotButton.addEventListener("click", () => void saveScreenshot());
  elements.inspectButton.addEventListener("click", () => toggleInspector());
  elements.inspectorClose.addEventListener("click", () => toggleInspector(false));
  elements.queryForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void findElements();
  });
  elements.queryInput.addEventListener("input", () => updateQueryDraft());
  elements.queryInput.addEventListener("focus", () => updateQuerySuggestions());
  elements.queryInput.addEventListener("blur", () => {
    setTimeout(() => {
      if (!elements.querySuggestions.contains(document.activeElement)) closeQuerySuggestions();
    }, 0);
  });
  elements.queryInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveQuerySuggestion(event.key === "ArrowDown" ? 1 : -1);
    } else if (
      event.key === "Tab"
      && !event.shiftKey
      && state.querySuggestionIndex >= 0
    ) {
      event.preventDefault();
      acceptQuerySuggestion();
    } else if (event.key === "Enter" && state.querySuggestionIndex >= 0) {
      event.preventDefault();
      acceptQuerySuggestion();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      closeQuerySuggestions();
    }
  });
  elements.queryClear.addEventListener("click", () => {
    elements.queryInput.value = "";
    updateQueryDraft();
    elements.queryInput.focus();
  });
  elements.queryHelpButton.addEventListener("click", () => {
    closeQuerySuggestions();
    toggleQueryHelp();
  });
  for (const example of elements.queryExamples) {
    example.addEventListener("click", () => {
      elements.queryInput.value = example.dataset.query ?? "";
      toggleQueryHelp(false);
      updateQueryDraft({ suggest: false });
      void findElements();
    });
  }
  elements.resultsTab.addEventListener("click", () => setInspectorView("results"));
  elements.treeTab.addEventListener("click", () => setInspectorView("tree"));
  for (const [index, tab] of [elements.resultsTab, elements.treeTab].entries()) {
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = index === 0 ? elements.treeTab : elements.resultsTab;
      setInspectorView(index === 0 ? "tree" : "results");
      next.focus();
    });
  }
  elements.snapshotButton.addEventListener("click", () => void dumpTree());
  elements.preflightDetails.addEventListener("click", () => showPreflightDetails());

  elements.overlayAction.addEventListener("click", () => {
    switch (elements.overlayAction.dataset.action) {
      case "choose-app":
        openPopover();
        break;
      case "attach":
        openPopover();
        showPopoverPanel("running");
        break;
      case "restore":
        void windowAction("restore");
        break;
      case "refresh":
        void refreshSession();
        break;
      case "inspect":
        toggleInspector(true);
        break;
      case "retry-stream":
      default:
        startStream();
        break;
    }
  });

  window.addEventListener("resize", debounce(fitStage, 80));
  document.addEventListener("visibilitychange", () => setPanelVisible(!document.hidden));
  window.addEventListener("blur", () => cancelPointer());
  transport?.onVisibilityChanged?.((visible) => setPanelVisible(visible));
  transport?.onRefreshRequested?.(() => {
    void loadPreflight();
    void refreshSession();
  });
}

function debounce(callback, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}

attachChrome();
attachStageInput();
// Say what the panel is doing before the first request answers, so it is never briefly blank.
renderPreflight();

bootstrap()
  .then(loadPreflight)
  .then(() => refreshSession())
  .then(() => {
    connectActivity();
    startSessionPolling();
  })
  .catch((error) => {
    showStage("error", { detail: error.message });
    showToast(error.message, "danger");
  });
