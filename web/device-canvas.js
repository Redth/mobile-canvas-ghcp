import { creatablePlatforms, createOptions } from "./create-device-options.js";
import {
  clearStoredDeviceId,
  organizeDiagnostics,
  readStoredDeviceId,
  resumeAuthenticatedPanel,
  storeDeviceId,
} from "./canvas-state.js";

const elements = {
  list: document.querySelector("#device-list"),
  diagnostics: document.querySelector("#diagnostics"),
  diagnosticNotices: document.querySelector("#diagnostic-notices"),
  selector: document.querySelector("#device-selector"),
  popover: document.querySelector("#device-popover"),
  selectorName: document.querySelector("#selector-name"),
  selectorDetail: document.querySelector("#selector-detail"),
  selectorDot: document.querySelector("#selector-dot"),
  selectorGlyph: document.querySelector(".selector-glyph use"),
  empty: document.querySelector("#empty-state"),
  view: document.querySelector("#device-view"),
  detached: document.querySelector("#detached-state"),
  canvas: document.querySelector("#device-screen"),
  frame: document.querySelector("#device-frame"),
  stage: document.querySelector(".stage"),
  stageViewport: document.querySelector(".stage-viewport"),
  floatBar: document.querySelector(".float-bar"),
  navPill: document.querySelector("#nav-pill"),
  overlay: document.querySelector("#stream-overlay"),
  overlayText: document.querySelector("#stream-overlay-text"),
  fps: document.querySelector("#fps-select"),
  scale: document.querySelector("#scale-select"),
  mode: document.querySelector("#stream-mode"),
  actualFps: document.querySelector("#actual-fps"),
  encodeSize: document.querySelector("#encode-size"),
  captureSource: document.querySelector("#capture-source"),
  geometry: document.querySelector("#geometry"),
  udid: document.querySelector("#udid"),
  udidLabel: document.querySelector("#udid-label"),
  createDialog: document.querySelector("#create-dialog"),
  createForm: document.querySelector("#create-form"),
  createRuntime: document.querySelector("#create-runtime"),
  createDeviceType: document.querySelector("#create-device-type"),
  createKicker: document.querySelector("#create-kicker"),
  createPlatform: document.querySelector("#create-platform"),
  createPlatformField: document.querySelector("#create-platform-field"),
  createName: document.querySelector("#create-name"),
  createSubmit: document.querySelector("#create-submit"),
  confirmDialog: document.querySelector("#confirm-dialog"),
  confirmTitle: document.querySelector("#confirm-title"),
  confirmMessage: document.querySelector("#confirm-message"),
  confirmSubmit: document.querySelector("#confirm-submit"),
  toast: document.querySelector("#toast"),
  record: document.querySelector("#record-button"),
  copyUdid: document.querySelector("#copy-udid"),
  inputIndicator: document.querySelector("#input-indicator"),
  automationCursor: document.querySelector("#automation-cursor"),
  automationPointer: document.querySelector(".automation-pointer"),
  automationRipple: document.querySelector(".automation-ripple"),
  automationLive: document.querySelector("#automation-live"),
  inputStatus: document.querySelector("#input-status"),
  inputLatency: document.querySelector("#input-latency"),
  inputLatencyWrap: document.querySelector("#input-latency-wrap"),
  inputStateDot: document.querySelector("#input-state-dot"),
  statusPill: document.querySelector(".status-pill"),
  linkChip: document.querySelector("#link-chip"),
  linkDetails: document.querySelector("#link-details"),
  settingsDialog: document.querySelector("#settings-dialog"),
  dataDialog: document.querySelector("#data-dialog"),
};

const transport = window.mobileCanvasTransport || null;
let bootstrapExchange = null;
let panelVisibilityVersion = 0;

const state = {
  catalog: null,
  selected: null,
  display: null,
  socket: null,
  decoder: null,
  pngTimer: null,
  frameCounter: 0,
  frameClock: performance.now(),
  parser: null,
  framePainted: false,
  pointer: null,
  wheel: null,
  wheelTimer: null,
  inputIndicatorTimer: null,
  inputQueue: Promise.resolve(),
  recording: false,
  detached: false,
  activeScale: null,
  scaleTimer: null,
  canvasContext: null,
  createPlatform: null,
  streamMode: "idle",
  actualFps: 0,
  linkExpanded: false,
  selectionTarget: null,
  selectionVersion: 0,
  followTarget: null,
  panelVisible: !document.hidden,
};

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
  return transport
    ? await transport.api(path, request)
    : await fetch(path, request);
}

async function requireSuccessfulResponse(response) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({
      message: `${response.status} ${response.statusText}`,
    }));
    const error = new Error(payload.message || "Mobile Canvas request failed.");
    error.code = payload.code;
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  return response;
}

async function bootstrap() {
  if (transport) {
    const context = await transport.bootstrap();
    sessionStorage.setItem("mobile-canvas-session", context.sessionId || "");
    sessionStorage.setItem("mobile-canvas-instance", context.instanceId || "");
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
  sessionStorage.setItem("mobile-canvas-session", sessionId || "");
  sessionStorage.setItem("mobile-canvas-instance", instanceId || "");
  const response = await sendApiRequest("/api/v1/auth/bootstrap", {
    method: "POST",
    body: JSON.stringify({ secret, sessionId, instanceId }),
  });
  await requireSuccessfulResponse(response);
  // Copilot reloads a persisted renderer without calling the provider's open callback. The scoped
  // fragment is therefore retained so this page can exchange it for a fresh browser session.
  return true;
}

async function refresh() {
  if (state.detached) return;
  elements.list.setAttribute("aria-busy", "true");
  try {
    await loadCatalog();

    if (state.selected) {
      const updated = state.catalog.devices.find((device) => device.id === state.selected.id);
      if (updated) {
        await selectDevice(updated, false);
        return;
      }
      state.selected = null;
    }

    const selectionResponse = await api("/api/v1/selection");
    const selection = await selectionResponse.json();
    if (selection?.hasSelection && selection.device) {
      await selectDevice(selection.device, false);
      return;
    }

    const storedDeviceId = readStoredDeviceId(localStorage, canvasInstanceId());
    const storedDevice = state.catalog.devices.find((device) => device.id === storedDeviceId);
    if (storedDevice) {
      await selectDevice(storedDevice, true);
      return;
    }
    if (storedDeviceId) clearStoredDeviceId(localStorage, canvasInstanceId());

    const booted = state.catalog.devices.find((device) => device.state === "booted");
    if (booted) {
      await selectDevice(booted, true);
      return;
    }

    showEmptySelection();
  } finally {
    elements.list.removeAttribute("aria-busy");
  }
}

async function loadCatalog() {
  const response = await api("/api/v1/catalog");
  state.catalog = await response.json();
  renderDiagnostics();
  renderDeviceList();
  populateCreateOptions();
}

function renderDiagnostics() {
  const { notices, popover } = organizeDiagnostics(state.catalog?.diagnostics);
  elements.diagnostics.classList.toggle("hidden", popover.length === 0);
  elements.diagnostics.textContent = popover.map((check) => check.message).join(" ");

  elements.diagnosticNotices.replaceChildren(
    ...notices.map((notice) => {
      const item = document.createElement("div");
      item.className = "diagnostic-notice";

      const copy = document.createElement("div");
      copy.className = "diagnostic-notice-copy";
      const title = document.createElement("strong");
      title.className = "diagnostic-notice-title";
      title.textContent = notice.name;
      const message = document.createElement("span");
      message.textContent = notice.message;
      copy.append(title, message);

      const actions = document.createElement("div");
      actions.className = "diagnostic-notice-actions";
      for (const action of notice.actions) {
        const button = document.createElement("button");
        button.className = "button diagnostic-action-button";
        button.type = "button";
        button.textContent = action.label;
        button.addEventListener("click", () => {
          runBusy(button, async () => {
            await api(`/api/v1/host/settings/${encodeURIComponent(action.target)}`, {
              method: "POST",
            });
            showToast(`${action.label.replace(/^Open /, "")} settings opened`);
          }).catch(showError);
        });
        actions.append(button);
      }

      item.append(copy, actions);
      return item;
    }),
  );
  elements.diagnosticNotices.classList.toggle("hidden", notices.length === 0);
}

/**
 * Platform presentation lives in one table so a new backend only has to be named here. `label` is
 * the group heading, `noun` keeps prose ("New simulator" vs "New emulator") honest, and `icon`
 * picks the sprite.
 */
const PLATFORMS = {
  ios: {
    label: "iOS Simulators",
    shortLabel: "iOS",
    noun: "simulator",
    icon: "#icon-ios",
    provider: "CoreSimulator",
  },
  android: {
    label: "Android Emulators",
    shortLabel: "Android",
    noun: "emulator",
    icon: "#icon-android",
    provider: "Android Emulator",
  },
};

const PLATFORM_ORDER = ["ios", "android"];

function platformInfo(platform) {
  return PLATFORMS[platform] || { label: "Devices", noun: "device", icon: "#icon-device", provider: "" };
}

function capitalize(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

/** Platforms that actually reported something, in a stable order, so headings never flicker. */
function availablePlatforms() {
  const seen = new Set();
  for (const device of state.catalog?.devices || []) seen.add(device.platform);
  for (const runtime of state.catalog?.runtimes || []) seen.add(runtime.platform);
  const known = PLATFORM_ORDER.filter((platform) => seen.has(platform));
  const extra = [...seen].filter((platform) => platform && !PLATFORM_ORDER.includes(platform)).sort();
  return [...known, ...extra];
}

function renderDeviceList() {
  const devices = state.catalog?.devices || [];
  elements.list.replaceChildren();

  // Every group is headed, including on a single-platform machine: the heading now carries the
  // count, so dropping it would leave the menu with no total at all.
  for (const platform of availablePlatforms()) {
    const group = devices.filter((device) => device.platform === platform);
    if (group.length === 0) continue;

    const heading = document.createElement("div");
    heading.className = "device-group";
    heading.setAttribute("role", "presentation");
    heading.innerHTML = `
      <span>${escapeHtml(platformInfo(platform).label)}</span>
      <span class="count">${group.length}</span>`;
    elements.list.append(heading);

    for (const device of group) elements.list.append(createDeviceCard(device));
  }
}

function createDeviceCard(device) {
  const card = document.createElement("button");
  const selected = state.selected?.id === device.id;
  card.type = "button";
  card.className = `device-card ${device.state} ${selected ? "selected" : ""}`;
  card.setAttribute("role", "option");
  card.setAttribute("aria-selected", String(selected));
  card.title = device.udid || device.nativeId || device.name;
  card.innerHTML = `
    <span class="device-glyph" aria-hidden="true">
      <svg class="icon"><use href="${platformInfo(device.platform).icon}"></use></svg>
    </span>
    <span class="device-copy">
      <span class="device-name">${escapeHtml(device.name)}</span>
      <span class="device-detail">${escapeHtml(describeDevice(device))}</span>
    </span>
    <span class="device-trailing">
      <span class="state-dot" aria-hidden="true"></span>
    </span>`;
  card.addEventListener("click", () => {
    closeDevicePopover();
    selectDevice(device, true).catch(showError);
  });
  return card;
}

/** OS version plus power state, shown on the card instead of the raw UDID or serial. */
function describeDevice(device) {
  const version = device.osVersion || device.runtimeName || "";
  const platform = device.platform === "android" ? "Android" : "iOS";
  // simctl reports a bare number such as "26.5"; qualify it so the platform reads clearly.
  const label = /^[\d.]+$/.test(version) ? `${platform} ${version}` : version || platform;
  return `${label} \u00b7 ${device.state}`;
}

function updateSelectorDisplay(device) {
  transport?.setViewTitle?.(
    device?.name || "Device",
    device ? describeDevice(device) : undefined,
  );
  if (!device) {
    const platforms = availablePlatforms();
    elements.selectorName.textContent =
      platforms.length === 1 ? platformInfo(platforms[0]).label : "Devices";
    elements.selectorDetail.textContent = "No device selected";
    elements.selectorDot.className = "state-dot";
    elements.selectorGlyph.setAttribute(
      "href",
      platforms.length === 1 ? platformInfo(platforms[0]).icon : "#icon-device");
    return;
  }
  elements.selectorName.textContent = device.name;
  elements.selectorDetail.textContent = describeDevice(device);
  elements.selectorDot.className = `state-dot ${device.state === "booted" ? "ready" : ""}`;
  elements.selectorGlyph.setAttribute("href", platformInfo(device.platform).icon);
}

function openDevicePopover() {
  elements.popover.classList.remove("hidden");
  elements.selector.setAttribute("aria-expanded", "true");
}

function closeDevicePopover() {
  elements.popover.classList.add("hidden");
  elements.selector.setAttribute("aria-expanded", "false");
}

async function selectDevice(device, persist) {
  const selectionVersion = ++state.selectionVersion;
  // Recorded before the first await so a selection announcement that races this request can tell it
  // is watching work already under way rather than starting a second switch to the same device.
  state.selectionTarget = device.id;
  stopStream();
  if (persist) {
    setInputStatus("pending", "Selecting device");
    const response = await api("/api/v1/selection", {
      method: "POST",
      body: JSON.stringify({ deviceId: device.id }),
    });
    device = await response.json();
  }
  if (selectionVersion !== state.selectionVersion) return;

  state.selected = device;
  storeDeviceId(localStorage, canvasInstanceId(), device.id);
  // A cursor left over from the previous device would point at coordinates that no longer mean
  // anything, so drop the overlay whenever the selection changes.
  endAutomation();
  // The canvas keeps its last painted frame, so without this the previous device's screen shows
  // through under the "Starting live view..." overlay as though it belonged to the new one.
  clearScreen();
  elements.empty.classList.add("hidden");
  elements.detached.classList.add("hidden");
  elements.view.classList.remove("hidden");
  updateSelectorDisplay(device);
  elements.canvas.setAttribute("aria-label", `Interactive screen for ${device.name}`);
  elements.udid.value = device.udid || device.nativeId || "—";
  elements.udid.title = elements.udid.value;
  renderDeviceList();
  updateControlAvailability();

  if (device.state === "booted") {
    const displayResponse = await api(`/api/v1/devices/${encodeURIComponent(device.id)}/display`);
    const display = await displayResponse.json();
    if (
      selectionVersion !== state.selectionVersion
      || state.selected?.id !== device.id
    ) return;
    state.display = display;
    elements.geometry.value =
      `${state.display.pointWidth}x${state.display.pointHeight} pt @${state.display.scale}x`;
    fitDeviceScreen();
    setInputStatus("ready", "Input ready");
    startStream();
    await updateRecordingStatus(device.id, selectionVersion);
  } else {
    state.display = null;
    showOverlay(`${capitalize(platformInfo(state.selected?.platform).noun)} is powered off`);
    setStreamMode("offline");
    setActualFps(0);
    setInputStatus("ready", `Boot the ${platformInfo(state.selected?.platform).noun} to interact`);
  }
}

function showEmptySelection() {
  state.selectionVersion += 1;
  state.selectionTarget = null;
  stopStream();
  endAutomation();
  state.selected = null;
  state.display = null;
  elements.view.classList.add("hidden");
  elements.detached.classList.add("hidden");
  elements.empty.classList.remove("hidden");
  setStreamMode("idle");
  setActualFps(0);
  elements.geometry.value = "—";
  applyCaptureSource(null);
  elements.udid.value = "—";
  elements.udid.title = "";
  updateSelectorDisplay(null);
  renderDeviceList();
  updateControlAvailability();
}

/**
 * Toolbar/action gating. A backend advertises what it can actually do per instance, so an action it
 * cannot perform is hidden rather than shown broken. An AVD without a gRPC endpoint, for example,
 * cannot record.
 */
const ACTION_CAPABILITY = {
  boot: "boot",
  home: "button",
  back: "button",
  apps: "button",
  lock: "button",
  rotate: "rotate",
  screenshot: "screenshot",
  record: "recording",
  restart: "restart",
  shutdown: "shutdown",
  reveal: "reveal",
};

const IDENTIFIER_LABELS = {
  ios: { label: "Simulator UDID", copy: "Copy simulator UDID", copied: "Simulator UDID copied" },
  android: { label: "Emulator ID", copy: "Copy emulator ID", copied: "Emulator ID copied" },
};

function identifierLabels(platform) {
  return IDENTIFIER_LABELS[platform] ||
    { label: "Device ID", copy: "Copy device ID", copied: "Device ID copied" };
}

/** The noun for whatever is selected, so prose reads "Erase emulator" on Android. */
function selectedNoun() {
  return platformInfo(state.selected?.platform).noun;
}

function updateControlAvailability() {
  const booted = state.selected?.state === "booted";
  const capabilities = state.selected?.capabilities || {};
  for (const button of document.querySelectorAll("[data-action]")) {
    const action = button.dataset.action;
    const capability = ACTION_CAPABILITY[action];
    // Back and Recents are Android hardware keys with no iOS equivalent, so they are gated on the
    // platform as well as on the backend's capability flags.
    const wrongPlatform = Boolean(
      state.selected && button.dataset.platform && button.dataset.platform !== state.selected.platform);
    button.hidden = wrongPlatform ||
      Boolean(state.selected && capability && capabilities[capability] === false);

    const needsBooted =
      ["home", "back", "apps", "lock", "rotate", "screenshot", "record", "restart", "shutdown"].includes(action);
    button.disabled = !state.selected ||
      (action === "boot" ? booted : needsBooted && !booted);

    if (action === "reveal") {
      const description = state.selected?.platform === "android"
        ? "Show emulator window (restarts emulator)"
        : "Show simulator in Simulator.app";
      button.title = description;
      button.setAttribute("aria-label", description);
    }
  }

  // A pill of entirely hidden buttons would still draw its border and eat a grid row.
  elements.navPill.classList.toggle(
    "hidden",
    !Array.from(elements.navPill.querySelectorAll("[data-action]")).some((button) => !button.hidden));

  const erase = document.querySelector("#erase-button");
  const remove = document.querySelector("#delete-button");
  erase.disabled = !state.selected;
  remove.disabled = !state.selected;

  const identifier = identifierLabels(state.selected?.platform);
  elements.udidLabel.textContent = identifier.label;
  elements.copyUdid.title = identifier.copy;
  elements.copyUdid.setAttribute("aria-label", identifier.copy);
  elements.copyUdid.disabled = !state.selected;
}

const MAX_SCREEN_WIDTH = 480;
// How far the hardware side button reaches past the frame's right edge at its hover size. Kept at
// or under the stage's narrowest horizontal padding so the button is never clipped.
const SIDE_BUTTON_REACH = 8;
const AUTO_SCALE_MIN = 0.35;
const AUTO_SCALE_MAX = 1;
const AUTO_SCALE_STEP = 0.05;
// Assume a Retina panel even when devicePixelRatio reports 1, and encode a little above the physical
// pixel count. Under-sampling is immediately visible as a soft image, whereas over-sampling only
// costs encode and decode time, so the asymmetry is worth paying for.
const AUTO_SCALE_MIN_DPR = 2;
const AUTO_SCALE_HEADROOM = 1.25;

/**
 * Encoding the full framebuffer (1125x2436 on a 3x phone) for a canvas that renders a few hundred CSS
 * pixels wide spends encode and decode time on detail the downscale throws away. Matching the encode
 * size to what is actually rendered, with headroom, keeps the image sharp while keeping both ends
 * cheap. Quality under motion is governed by StreamOptions.AverageBitrate rather than by scale.
 */
function resolveScale() {
  const requested = elements.scale.value;
  if (requested !== "auto") return Number(requested);

  const sourceWidth = state.display?.pixelWidth;
  const renderedWidth = elements.canvas.getBoundingClientRect().width;
  if (!sourceWidth || !renderedWidth) return AUTO_SCALE_MAX;

  const density = Math.max(window.devicePixelRatio || 1, AUTO_SCALE_MIN_DPR);
  const targetWidth = renderedWidth * density * AUTO_SCALE_HEADROOM;
  const stepped = Math.ceil(targetWidth / sourceWidth / AUTO_SCALE_STEP) * AUTO_SCALE_STEP;
  return Math.min(AUTO_SCALE_MAX, Math.max(AUTO_SCALE_MIN, Number(stepped.toFixed(2))));
}

function renderEncodeSize() {
  if (!elements.encodeSize) return;
  const scale = state.activeScale;
  const source = state.display?.pixelWidth;
  if (!scale || !source) {
    elements.encodeSize.textContent = "—";
    renderLinkHealth();
    return;
  }

  const width = Math.round(state.display.pixelWidth * scale);
  const height = Math.round(state.display.pixelHeight * scale);
  elements.encodeSize.textContent = `${width}x${height}`;
  elements.encodeSize.title = `Encoding at ${Math.round(scale * 100)}% of the ${state.display.pixelWidth}x${state.display.pixelHeight} framebuffer`;
  renderLinkHealth();
}

/*
 * Latency, frame rate, encode size and transport collapse into one traffic light. H.264 delivering
 * frames is green, the PNG fallback or a half-starved stream is amber, and anything not delivering
 * is red. The numbers stay one click away rather than permanently occupying the pill.
 */
const LINK_HEALTH = {
  "H.264": "good",
  PNG: "fair",
  connecting: "fair",
  idle: "poor",
  offline: "poor",
};

const LINK_HEALTH_LABEL = { good: "healthy", fair: "degraded", poor: "not streaming" };

/** Below half the requested rate the stream is visibly stuttering, which is worth flagging amber. */
const STARVED_FPS_RATIO = 0.5;
const IDLE_NAL_FLUSH_MS = 120;

function setStreamMode(mode) {
  state.streamMode = mode;
  elements.mode.textContent = mode;
  renderLinkHealth();
}

function setActualFps(fps) {
  state.actualFps = fps;
  elements.actualFps.textContent = `${fps.toFixed(1)} FPS`;
  renderLinkHealth();
}

function renderLinkHealth() {
  const chip = elements.linkChip;
  if (!chip) return;

  let health = LINK_HEALTH[state.streamMode] || "poor";
  const target = Number(elements.fps.value) || 0;
  // The Android emulator only sends a frame when the screen changes, so an idle stream sitting at
  // zero is perfectly healthy and the frame rate cannot stand in for liveness. What green has to
  // mean is that a picture actually arrived; the rate only demotes a stream that is visibly
  // struggling to keep up while frames are genuinely flowing.
  if (health === "good" &&
      (!state.framePainted || (target > 0 && state.actualFps > 0 &&
        state.actualFps < target * STARVED_FPS_RATIO))) {
    health = "fair";
  }
  chip.dataset.health = health;

  const summary = [
    state.streamMode,
    state.actualFps > 0 ? `${state.actualFps.toFixed(0)} FPS` : null,
    elements.encodeSize.textContent !== "—" ? elements.encodeSize.textContent : null,
  ].filter(Boolean).join(" · ");

  chip.title = `Live view ${LINK_HEALTH_LABEL[health]} — ${summary}`;
  chip.setAttribute(
    "aria-label",
    `${state.linkExpanded ? "Hide" : "Show"} stream details. Live view ${LINK_HEALTH_LABEL[health]}, ${summary}.`,
  );
}

function setLinkExpanded(expanded) {
  state.linkExpanded = expanded;
  elements.statusPill.classList.toggle("is-expanded", expanded);
  elements.linkChip.setAttribute("aria-expanded", String(expanded));
  // The collapsed panel is only clipped to zero width, so it stays in the accessibility tree
  // without this and screen readers would read four values that are not on screen.
  elements.linkDetails.setAttribute("aria-hidden", String(!expanded));
  renderLinkHealth();
}

/**
 * Restarting the stream tears down and recreates the companion video session, so only do it when
 * the auto scale actually lands in a different bucket rather than on every resize observation.
 */
function reconcileAutoScale() {
  if (elements.scale.value !== "auto" || !state.socket) return;
  if (resolveScale() === state.activeScale) return;
  clearTimeout(state.scaleTimer);
  state.scaleTimer = setTimeout(() => {
    if (elements.scale.value === "auto" && resolveScale() !== state.activeScale) startStream();
  }, 400);
}

/**
 * Size the screen in CSS pixels so it always fits the stage while preserving the device aspect ratio.
 * A canvas has no intrinsic layout scaling, and percentage max-height cannot resolve against the
 * auto-height frame, so the fit is computed here instead of in CSS. Pointer mapping reads the
 * resulting bounding rect, so it stays correct at every size.
 *
 * The tool pills float over the top of the stage, so the frame is fitted twice: once against the
 * full height, and again with the pills reserved only if the first result would actually run into
 * them. On a wide canvas the pills sit clear of the frame's sides and the top space is given back.
 */
function fitDeviceScreen() {
  const stage = elements.stageViewport;
  if (!stage) return;

  const aspect = state.display?.pointWidth && state.display?.pointHeight
    ? state.display.pointWidth / state.display.pointHeight
    : elements.canvas.width / elements.canvas.height;
  if (!Number.isFinite(aspect) || aspect <= 0) return;

  const frameStyle = getComputedStyle(elements.frame);
  const chromeX = parseFloat(frameStyle.paddingLeft) + parseFloat(frameStyle.paddingRight) +
    parseFloat(frameStyle.borderLeftWidth) + parseFloat(frameStyle.borderRightWidth);
  const chromeY = parseFloat(frameStyle.paddingTop) + parseFloat(frameStyle.paddingBottom) +
    parseFloat(frameStyle.borderTopWidth) + parseFloat(frameStyle.borderBottomWidth);

  // clientHeight excludes neither padding nor the reserve we may have written on a previous pass,
  // so measure the unreserved height once and drive both passes from it.
  const fullHeight = stage.clientHeight;
  const unreserved = measureFit(aspect, stage.clientWidth - chromeX, fullHeight - chromeY);
  if (!unreserved) return;

  const reserve = pillReserve(unreserved.width + chromeX, unreserved.height + chromeY, stage);
  const fitted = reserve <= 0
    ? unreserved
    : measureFit(aspect, stage.clientWidth - chromeX, fullHeight - reserve - chromeY) || unreserved;

  stage.style.setProperty("--stage-top-reserve", `${reserve}px`);
  elements.canvas.style.width = `${Math.floor(fitted.width)}px`;
  elements.canvas.style.height = `${Math.floor(fitted.height)}px`;
  applyScreenRadius(fitted.width);
  reconcileAutoScale();
}

/** Largest width/height with the given aspect that fits the box, capped so phones stay life-sized. */
function measureFit(aspect, availableWidth, availableHeight) {
  if (availableWidth <= 0 || availableHeight <= 0) return null;
  let width = Math.min(availableWidth, MAX_SCREEN_WIDTH);
  let height = width / aspect;
  if (height > availableHeight) {
    height = availableHeight;
    width = height * aspect;
  }
  return { width, height };
}

/** Vertical space the floating pills need, or 0 when a centred frame of this size clears them. */
function pillReserve(frameWidth, frameHeight, stage) {
  const pills = Array.from(elements.floatBar?.querySelectorAll(".tool-pill") || []);
  if (pills.length === 0) return 0;

  const gap = 8;
  const stageRect = stage.getBoundingClientRect();
  const pillBottom = Math.max(...pills.map((pill) => pill.getBoundingClientRect().bottom));

  // Where the frame would land if it were centred in the unreserved viewport. The side button hangs
  // off the right edge, so the right pill has to clear that too rather than just the frame.
  const frameLeft = stageRect.left + (stageRect.width - frameWidth) / 2;
  const frameRight = frameLeft + frameWidth + SIDE_BUTTON_REACH;
  const frameTop = stageRect.top + (stageRect.height - frameHeight) / 2;
  if (frameTop >= pillBottom + gap) return 0;

  const clearsSides = pills.every((pill) => {
    const rect = pill.getBoundingClientRect();
    return rect.right + gap <= frameLeft || rect.left - gap >= frameRight;
  });
  if (clearsSides) return 0;

  return Math.max(0, Math.ceil(pillBottom + gap - stageRect.top));
}

/**
 * Turn the panel's measured corner radius into CSS pixels for the size the screen is drawn at, so
 * the crop tracks the real hardware instead of a fixed guess. Unknown radii keep the old default.
 */
function applyScreenRadius(renderedWidth) {
  const points = state.display?.cornerRadius;
  const pointWidth = state.display?.pointWidth;
  const known = Number.isFinite(points) && points >= 0 && Number.isFinite(pointWidth) && pointWidth > 0;

  elements.frame.style.setProperty(
    "--screen-radius",
    known ? `${(points * (renderedWidth / pointWidth)).toFixed(2)}px` : "16px");
  elements.frame.dataset.cornerCurve = state.display?.cornerCurve || "circular";
}

/**
 * The screen's only status surface. `busy` adds a spinner and an animated ellipsis, so waiting reads
 * as progress; terminal messages stay plain text and end the motion.
 */
function showOverlay(message, { busy = false } = {}) {
  elements.overlayText.textContent = message;
  elements.overlay.dataset.busy = busy ? "true" : "false";
  elements.overlay.classList.remove("hidden");
}

function startStream() {
  stopStream();
  if (!state.panelVisible || !state.selected || state.selected.state !== "booted") return;

  showOverlay("Connecting", { busy: true });
  setStreamMode("connecting");
  state.frameClock = performance.now();

  if (!("VideoDecoder" in window) || !state.selected.capabilities.liveStream) {
    startPngFallback("PNG");
    return;
  }

  state.activeScale = resolveScale();
  renderEncodeSize();
  const query = new URLSearchParams({
    deviceId: state.selected.id,
    fps: elements.fps.value,
    scale: state.activeScale,
  });
  const socket = createSocket("video", query);
  state.socket = socket;
  socket.binaryType = "arraybuffer";
  const parser = new AnnexBDecoder();
  state.parser = parser;

  socket.addEventListener("message", (event) => {
    if (state.socket !== socket) return;
    if (typeof event.data === "string") {
      const descriptor = JSON.parse(event.data);
      parser.setSource(descriptor.source);
      if (descriptor.display) {
        state.display = descriptor.display;
        elements.geometry.value =
          `${state.display.pointWidth}x${state.display.pointHeight} pt @${state.display.scale}x`;
        fitDeviceScreen();
        renderEncodeSize();
      }
      setStreamMode("H.264");
      applyCaptureSource(descriptor);
      return;
    }
    parser.push(new Uint8Array(event.data));
  });
  socket.addEventListener("open", () => {
    if (state.socket === socket) setStreamMode("H.264");
  });
  socket.addEventListener("error", () => {
    if (state.socket === socket) startPngFallback("PNG");
  });
  socket.addEventListener("close", () => {
    if (state.socket === socket && !state.pngTimer && !state.detached) {
      startPngFallback("PNG");
    }
  });
}

function stopStream() {
  // The parser holds a pending flush timer that would otherwise fire into a closed decoder.
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
  state.activeScale = null;
  clearTimeout(state.scaleTimer);
  setActualFps(0);
  renderEncodeSize();
}

class AnnexBDecoder {
  constructor() {
    this.buffer = new Uint8Array();
    this.prefix = [];
    this.timestamp = 0;
    this.codec = "avc1.64001f";
    this.source = null;
    this.idleTimer = null;
    this.draining = false;
  }

  setSource(source) {
    this.source = source || null;
  }

  push(bytes) {
    this.buffer = concatBytes([this.buffer, bytes]);
    const starts = findStartCodes(this.buffer);
    if (starts.length >= 2) {
      for (let index = 0; index < starts.length - 1; index++) {
        this.handleNal(this.buffer.slice(starts[index], starts[index + 1]));
      }
      this.buffer = this.buffer.slice(starts.at(-1));
    }
    this.armIdleFlush();
  }

  /**
   * Nothing about a paused stream is visible without this.
   *
   * A NAL unit ends where the next one begins, so the trailing slice always has to wait for more
   * bytes to prove it is complete. idb also encodes B-frames, so its decoder holds output back until
   * more input arrives. A gap in that stream is the only available signal that the producer is done,
   * so it drains both. The native framebuffer, ScreenCaptureKit, and emulator encoders disable frame
   * reordering; flushing those decoders would instead make WebKit require a new keyframe and reject
   * the next delta frame. On a moving picture the timer is rearmed long before it can fire.
   */
  armIdleFlush() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.flush(), IDLE_NAL_FLUSH_MS);
  }

  flush() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    // Anything shorter than a start code plus a header byte cannot be decoded, and re-buffering it
    // is harmless because the next push concatenates onto it.
    if (this.buffer.length >= 5) {
      const nal = this.buffer;
      this.buffer = new Uint8Array();
      this.handleNal(nal);
    }
    if (this.source === "idb") this.drainDecoder();
  }

  drainDecoder() {
    const decoder = state.decoder;
    if (this.draining || !decoder || decoder.state !== "configured") return;
    this.draining = true;
    // flush() rejects with AbortError when the decoder is reset or closed mid-drain, which happens
    // routinely when the stream restarts, so a rejection here is not worth surfacing.
    decoder.flush()
      .catch(() => {})
      .finally(() => { this.draining = false; });
  }

  dispose() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.buffer = new Uint8Array();
  }

  handleNal(nal) {
    const prefixLength = nal[2] === 1 ? 3 : 4;
    const type = nal[prefixLength] & 0x1f;
    if (type === 7 && nal.length >= prefixLength + 4) {
      this.codec = `avc1.${[nal[prefixLength + 1], nal[prefixLength + 2], nal[prefixLength + 3]]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")}`;
      this.ensureDecoder();
    }
    if (type === 1 || type === 5) {
      this.ensureDecoder();
      const accessUnit = concatBytes([...this.prefix, nal]);
      this.prefix = [];
      const duration = Math.round(1_000_000 / Number(elements.fps.value));
      try {
        state.decoder.decode(new EncodedVideoChunk({
          type: type === 5 ? "key" : "delta",
          timestamp: this.timestamp,
          duration,
          data: accessUnit,
        }));
        this.timestamp += duration;
      } catch {
        startPngFallback("PNG");
      }
    } else {
      this.prefix.push(nal);
    }
  }

  ensureDecoder() {
    if (state.decoder) return;
    state.decoder = new VideoDecoder({
      output: drawVideoFrame,
      error: () => startPngFallback("PNG"),
    });
    state.decoder.configure({
      codec: this.codec,
      // idb encodes High profile with B-frames (has_b_frames=1), so decode order is not presentation
      // order and the decoder has to hold a frame back to reorder. The native encoders disable frame
      // reordering and can use the low-latency path without temporally scrambling motion.
      optimizeForLatency: this.source !== "idb",
      hardwareAcceleration: "prefer-hardware",
      avc: { format: "annexb" },
    });
  }
}

function clearScreen() {
  elements.canvas.width = 300;
  elements.canvas.height = 150;
  state.canvasContext = null;
}

function drawVideoFrame(frame) {
  // H.264 codes in 16-pixel macroblocks, so a frame whose real size is not a multiple of 16 carries
  // padding that the visible rectangle excludes. The short drawImage overload leaves that crop up to
  // the implementation, and WebKit blits the padded coded buffer, which showed up as a strip of
  // garbage down the right edge. Passing the source rectangle explicitly makes the crop unambiguous.
  const visible = frame.visibleRect ?? {
    x: 0,
    y: 0,
    width: frame.codedWidth,
    height: frame.codedHeight,
  };
  drawScreenSource(
    frame,
    visible.x,
    visible.y,
    visible.width,
    visible.height,
  );
  frame.close();
  elements.overlay.classList.add("hidden");
  if (!state.framePainted) {
    state.framePainted = true;
    renderLinkHealth();
  }
  countFrame();
}

/**
 * CoreSimulator keeps its IOSurface in the device's native portrait geometry. Simulator.app normally
 * rotates that surface while displaying it, but a headless direct orientation event has no app window
 * transform to capture. The emulator stream can likewise lag one frame shape behind its sensor. Rotate
 * only when the source and reported display aspects disagree, so native landscape frames stay untouched.
 */
function drawScreenSource(source, sourceX, sourceY, sourceWidth, sourceHeight) {
  const displayLandscape = state.display?.pointWidth > state.display?.pointHeight;
  const sourceLandscape = sourceWidth > sourceHeight;
  const rotation = displayLandscape !== sourceLandscape
    ? (state.display?.orientation === "landscape-right" ? 90 : -90)
    : 0;
  const width = rotation === 0 ? sourceWidth : sourceHeight;
  const height = rotation === 0 ? sourceHeight : sourceWidth;

  if (elements.canvas.width !== width || elements.canvas.height !== height) {
    elements.canvas.width = width;
    elements.canvas.height = height;
    state.canvasContext = null;
    fitDeviceScreen();
  }

  const context = canvasContext();
  context.save();
  if (rotation < 0) {
    context.translate(0, height);
    context.rotate(-Math.PI / 2);
  } else if (rotation > 0) {
    context.translate(width, 0);
    context.rotate(Math.PI / 2);
  }
  context.drawImage(
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
  context.restore();
}

// The stream can silently degrade to idb when ScreenCaptureKit is unavailable, which reads as a
// quality regression rather than a fixable permission problem. Name the active backend, and carry
// the reason in the tooltip so a denied TCC prompt explains itself.
const CAPTURE_SOURCE_LABELS = {
  framebuffer: "Simulator framebuffer",
  screencapturekit: "ScreenCaptureKit",
  idb: "idb (fallback)",
  png: "Screenshots (fallback)",
};
const PRIMARY_CAPTURE_SOURCES = new Set(["framebuffer", "screencapturekit", "emulator-grpc"]);

function applyCaptureSource(descriptor) {
  if (!elements.captureSource) return;
  if (!descriptor) {
    elements.captureSource.value = "—";
    elements.captureSource.title = "";
    elements.captureSource.classList.remove("field-degraded");
    return;
  }
  const source = descriptor.source || "unknown";
  elements.captureSource.value = CAPTURE_SOURCE_LABELS[source] || source;
  elements.captureSource.title = descriptor.sourceDetail || elements.captureSource.value;
  elements.captureSource.classList.toggle("field-degraded", !PRIMARY_CAPTURE_SOURCES.has(source));
}

function canvasContext() {
  state.canvasContext ??= elements.canvas.getContext("2d", { alpha: false, desynchronized: true });
  return state.canvasContext;
}

function startPngFallback(label) {
  if (
    !state.panelVisible
    || state.detached
    || !state.selected
    || state.selected.state !== "booted"
  ) return;
  applyCaptureSource({ source: "png", sourceDetail: "Screenshot polling fallback." });
  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    socket.close();
  }
  if (state.decoder) {
    state.decoder.close();
    state.decoder = null;
  }
  if (state.pngTimer) return;

  setStreamMode(label);
  const capture = async () => {
    state.pngTimer = null;
    try {
      const response = await api(`/api/v1/devices/${encodeURIComponent(state.selected.id)}/screenshot`);
      const bitmap = await createImageBitmap(await response.blob());
      drawScreenSource(bitmap, 0, 0, bitmap.width, bitmap.height);
      bitmap.close();
      elements.overlay.classList.add("hidden");
      countFrame();
    } catch (error) {
      showOverlay(error.message);
    } finally {
      if (
        state.panelVisible
        && !state.detached
        && state.selected?.state === "booted"
        && !state.socket
      ) {
        state.pngTimer = setTimeout(capture, 750);
      }
    }
  };
  state.pngTimer = setTimeout(capture, 0);
}

function countFrame() {
  state.frameCounter++;
  const now = performance.now();
  if (now - state.frameClock < 1000) return;

  const fps = state.frameCounter * 1000 / (now - state.frameClock);
  setActualFps(fps);
  state.frameCounter = 0;
  state.frameClock = now;
}

async function lifecycle(action) {
  const device = state.selected;
  if (!device) return;

  const disruptive = action !== "reveal" || device.platform === "android";
  const label = action === "reveal" ? "Show device window" : formatAction(action);
  if (disruptive) {
    stopStream();
    showOverlay(`${label} in progress`, { busy: true });
  }

  const response = await api(
    `/api/v1/devices/${encodeURIComponent(device.id)}/${action}`,
    { method: "POST" },
  );
  state.selected = await response.json();
  await refresh();
  showToast(`${label} complete`);
}

function sendInput(kind, payload, label = formatAction(kind)) {
  if (!state.selected || state.selected.state !== "booted") {
    return Promise.reject(new Error(`Boot the ${selectedNoun()} before sending input.`));
  }

  const operation = async () => {
    const started = performance.now();
    setInputStatus("pending", `${label} in progress`);
    try {
      await api(`/api/v1/devices/${encodeURIComponent(state.selected.id)}/input/${kind}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const elapsed = Math.round(performance.now() - started);
      setInputStatus("success", `${label} sent`, `${elapsed} ms`);
    } catch (error) {
      setInputStatus("error", `${label} failed`);
      throw error;
    }
  };

  const pending = state.inputQueue.then(operation, operation);
  state.inputQueue = pending.catch(() => undefined);
  return pending;
}

async function rotateDevice() {
  const target = state.display?.orientation?.startsWith("landscape")
    ? "portrait"
    : "landscape-left";
  const deviceId = state.selected.id;

  await sendInput("rotate", { orientation: target }, "Rotate");

  // Both platforms acknowledge the rotation request before their display geometry changes. Wait for
  // the new orientation so the replacement stream and pointer mapping start with the right dimensions.
  for (let attempt = 0; attempt < 20 && state.selected?.id === deviceId; attempt++) {
    const response = await api(`/api/v1/devices/${encodeURIComponent(deviceId)}/display`);
    const display = await response.json();
    state.display = display;
    elements.geometry.value =
      `${display.pointWidth}x${display.pointHeight} pt @${display.scale}x`;

    const settled = target === "portrait"
      ? display.orientation === "portrait"
      : display.orientation?.startsWith("landscape");
    if (settled) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  startStream();
  fitDeviceScreen();
}

function setInputStatus(status, message, latency = "") {
  elements.inputStateDot.className = `status-dot ${status}`;
  elements.inputStatus.textContent = message;
  elements.inputLatency.textContent = latency;
  elements.inputLatencyWrap.classList.toggle("hidden", latency === "");
}

function logicalPoint(event) {
  const bounds = elements.canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(
      state.display.pointWidth,
      (event.clientX - bounds.left) / bounds.width * state.display.pointWidth,
    )),
    y: Math.max(0, Math.min(
      state.display.pointHeight,
      (event.clientY - bounds.top) / bounds.height * state.display.pointHeight,
    )),
  };
}

/*
 * Remote-control presentation.
 *
 * The host publishes an event for every input that arrived on the control token, which means an
 * agent, the CLI, or the canvas extension issued it. The person's own taps authenticate with a
 * session cookie and are never published, so local input can never light up the overlay.
 *
 * The overlay stays up for IDLE_MS after the last event rather than clearing per command, because
 * an agent typically fires a burst (tap, screenshot, tap) and flickering between each one would be
 * worse than useless. Every event resets the timer.
 */
const AUTOMATION_IDLE_MS = 2600;
const AUTOMATION_TRAVEL_MS = 260;

const automation = {
  socket: null,
  idleTimer: null,
  pressTimer: null,
  retryTimer: null,
  active: false,
  point: null,
  selectionGeneration: 0,
};

function connectAutomationEvents() {
  clearTimeout(automation.retryTimer);
  if (!state.panelVisible || state.detached) return;
  let socket;
  try {
    socket = createSocket("events");
  } catch {
    scheduleAutomationReconnect();
    return;
  }
  automation.socket = socket;

  socket.addEventListener("open", () => {
    if (automation.socket === socket) {
      void reconcileCanvasSelection(socket).catch(showError);
    }
  });
  socket.addEventListener("message", async (event) => {
    if (automation.socket !== socket) return;
    let activity;
    try {
      activity = JSON.parse(event.data);
    } catch {
      return;
    }
    // Events reach every canvas on the host, so a panel first works out whether it is the audience.
    const addressed = addressedToThisCanvas(activity);
    if (transport && !addressed) return;
    if (addressed) {
      if (activity.kind === "selection") {
        automation.selectionGeneration += 1;
      }
      // The host points a canvas at whatever device an agent addresses. Following that here is what
      // keeps the panel from sitting on the device the person last picked while work happens
      // somewhere else.
      await followSelection(activity.deviceId).catch(showError);
    }
    if (activity.kind === "selection") return;
    if (!state.selected || activity.deviceId !== state.selected.id) return;
    handleAutomationEvent(activity);
  });

  // The events channel is presentation only. If it drops, retry quietly and keep the device usable
  // rather than surfacing an error the user cannot act on.
  socket.addEventListener("close", () => {
    if (automation.socket !== socket) return;
    automation.socket = null;
    endAutomation();
    scheduleAutomationReconnect();
  });
  socket.addEventListener("error", () => socket.close());
}

function scheduleAutomationReconnect() {
  clearTimeout(automation.retryTimer);
  if (!state.panelVisible || state.detached) return;
  automation.retryTimer = setTimeout(connectAutomationEvents, 2000);
}

/**
 * True when an event names this panel. Events without a canvas identity came from the bare CLI, which
 * is not speaking on any panel's behalf, so those never move a selection.
 */
function addressedToThisCanvas(activity) {
  if (!activity.sessionId || !activity.instanceId) {
    return transport?.followUnscopedAutomation === true;
  }
  return activity.sessionId === sessionStorage.getItem("mobile-canvas-session") &&
    activity.instanceId === sessionStorage.getItem("mobile-canvas-instance");
}

async function followSelection(deviceId) {
  if (!deviceId || state.detached) return;
  if (state.selectionTarget === deviceId || state.selected?.id === deviceId) return;

  state.followTarget = deviceId;
  let device = state.catalog?.devices?.find((entry) => entry.id === deviceId);
  if (!device) {
    // A device the agent created moments ago is not in the catalog this panel loaded.
    await loadCatalog();
    // A later announcement overtook this one while the catalog loaded; that one wins.
    if (state.followTarget !== deviceId) return;
    device = state.catalog?.devices?.find((entry) => entry.id === deviceId);
  }
  if (device) await selectDevice(device, false);
}

async function reconcileAnnouncedSelection(deviceId, guard = () => true) {
  if (!deviceId || state.detached) return;
  state.followTarget = deviceId;
  await loadCatalog();
  if (!guard() || state.followTarget !== deviceId) return;
  const device = state.catalog?.devices?.find((entry) => entry.id === deviceId);
  if (device) {
    await selectDevice(device, false);
  } else {
    await refresh();
  }
}

async function reconcileCanvasSelection(socket) {
  const generation = automation.selectionGeneration;
  const response = await api("/api/v1/selection");
  const selection = await response.json();
  if (
    automation.socket !== socket
    || automation.selectionGeneration !== generation
  ) return;
  if (selection?.hasSelection && selection.device) {
    await reconcileAnnouncedSelection(
      selection.device.id,
      () =>
        automation.socket === socket
        && automation.selectionGeneration === generation,
    );
  } else {
    await refresh();
  }
}

function handleAutomationEvent(activity) {
  beginAutomation();
  announceAutomation(activity);

  switch (activity.kind) {
    case "tap":
      moveAutomationCursor(activity.x, activity.y);
      clickAutomationCursor(AUTOMATION_TRAVEL_MS);
      break;
    case "long-press":
      moveAutomationCursor(activity.x, activity.y);
      pressAutomationCursor(AUTOMATION_TRAVEL_MS, Math.max(300, (activity.duration || 1) * 1000));
      break;
    case "swipe":
      animateAutomationSwipe(activity);
      break;
    case "touch":
      // Streamed gestures arrive as individual points, so track them without a click animation.
      moveAutomationCursor(activity.x, activity.y, 90);
      setAutomationPressed(activity.detail !== "up");
      break;
    default:
      // Text, keys, buttons, rotation and screenshots have no on-screen point. The frame glow alone
      // conveys that the agent is still working.
      break;
  }
}

function beginAutomation() {
  clearTimeout(automation.idleTimer);
  automation.idleTimer = setTimeout(endAutomation, AUTOMATION_IDLE_MS);
  if (automation.active) return;
  automation.active = true;
  elements.frame.classList.add("is-automated");
}

function endAutomation() {
  clearTimeout(automation.idleTimer);
  clearTimeout(automation.pressTimer);
  automation.active = false;
  automation.point = null;
  elements.frame.classList.remove("is-automated");
  elements.automationCursor.classList.remove("is-visible", "is-pressed", "is-moving");
  elements.automationLive.textContent = "";
}

/** Converts a device logical point into frame-relative pixels, the inverse of logicalPoint(). */
function automationOffset(x, y) {
  if (!state.display?.pointWidth || !state.display?.pointHeight) return null;
  const canvasBounds = elements.canvas.getBoundingClientRect();
  const frameBounds = elements.frame.getBoundingClientRect();
  return {
    x: canvasBounds.left - frameBounds.left + (x / state.display.pointWidth) * canvasBounds.width,
    y: canvasBounds.top - frameBounds.top + (y / state.display.pointHeight) * canvasBounds.height,
  };
}

function moveAutomationCursor(x, y, travelMs = AUTOMATION_TRAVEL_MS) {
  if (typeof x !== "number" || typeof y !== "number") return;
  const offset = automationOffset(x, y);
  if (!offset) return;

  const cursor = elements.automationCursor;
  const first = !automation.point;
  automation.point = offset;

  // The first appearance must not slide in from the corner, so place it before fading in.
  cursor.classList.toggle("is-moving", !first);
  cursor.style.setProperty("--automation-travel", `${travelMs}ms`);
  cursor.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
  cursor.classList.add("is-visible");
}

function setAutomationPressed(pressed) {
  elements.automationCursor.classList.toggle("is-pressed", pressed);
}

/** Presses after the cursor has travelled, so the ripple lands with the cursor rather than ahead of it. */
function pressAutomationCursor(delayMs, holdMs) {
  clearTimeout(automation.pressTimer);
  automation.pressTimer = setTimeout(() => {
    setAutomationPressed(true);
    playAutomationRipple();
    automation.pressTimer = setTimeout(() => setAutomationPressed(false), holdMs);
  }, delayMs);
}

function clickAutomationCursor(delayMs) {
  pressAutomationCursor(delayMs, 140);
}

function playAutomationRipple() {
  const ripple = elements.automationRipple;
  ripple.classList.remove("is-clicking");
  // Force a reflow so a repeated click restarts the animation instead of being ignored.
  void ripple.offsetWidth;
  ripple.classList.add("is-clicking");
}

function animateAutomationSwipe(activity) {
  const travel = AUTOMATION_TRAVEL_MS;
  const gesture = Math.max(160, (activity.duration || 0.35) * 1000);
  moveAutomationCursor(activity.x, activity.y, travel);
  clearTimeout(automation.pressTimer);
  automation.pressTimer = setTimeout(() => {
    setAutomationPressed(true);
    playAutomationRipple();
    moveAutomationCursor(activity.endX, activity.endY, gesture);
    automation.pressTimer = setTimeout(() => setAutomationPressed(false), gesture);
  }, travel);
}

function announceAutomation(activity) {
  const noun = selectedNoun();
  const detail = activity.detail ? ` ${activity.detail}` : "";
  const messages = {
    tap: "Agent tapped the screen",
    "long-press": "Agent pressed and held the screen",
    swipe: "Agent swiped the screen",
    touch: "",
    text: `Agent typed${detail}`,
    key: "Agent pressed a key",
    button: `Agent pressed${detail}`,
    rotate: `Agent rotated the ${noun}${detail}`,
    screenshot: `Agent captured a screenshot`,
  };
  const message = messages[activity.kind];
  // Streamed touch points would flood a live region, so they announce nothing.
  if (message) elements.automationLive.textContent = message;
}

function positionInputIndicator(clientX, clientY) {
  const frameBounds = elements.frame.getBoundingClientRect();
  elements.inputIndicator.style.left = `${clientX - frameBounds.left}px`;
  elements.inputIndicator.style.top = `${clientY - frameBounds.top}px`;
}

function showInputIndicator(clientX, clientY) {
  clearTimeout(state.inputIndicatorTimer);
  positionInputIndicator(clientX, clientY);
  elements.inputIndicator.className = "input-indicator active";
  elements.frame.classList.add("is-interacting");
}

function settleInputIndicator(success) {
  elements.frame.classList.remove("is-interacting");
  elements.inputIndicator.className = `input-indicator ${success ? "sent" : "failed"}`;
  clearTimeout(state.inputIndicatorTimer);
  state.inputIndicatorTimer = setTimeout(() => {
    elements.inputIndicator.className = "input-indicator";
  }, 560);
}

function cancelPointer() {
  // Never leave a finger pressed on the device: an abandoned touch blocks all later input.
  if (liveTouch.active && state.pointer) {
    endTouch(state.pointer.point, "Gesture");
  }
  state.pointer = null;
  elements.frame.classList.remove("is-interacting");
  elements.inputIndicator.className = "input-indicator";
}

// Live gestures bypass the sendInput queue: they need coalescing (drop stale points rather than
// queueing them) so a slow send can never build a backlog that lags behind the real cursor.
const liveTouch = {
  active: false,
  pending: null,
  inflight: false,
  sent: 0,
  started: 0,
  finish: null,
};

function postTouch(point, phase) {
  return api(`/api/v1/devices/${encodeURIComponent(state.selected.id)}/input/touch`, {
    method: "POST",
    body: JSON.stringify({ x: point.x, y: point.y, phase }),
  });
}

function beginTouch(point, label) {
  if (!state.selected || state.selected.state !== "booted") {
    showError(new Error(`Boot the ${selectedNoun()} before sending input.`));
    return false;
  }
  liveTouch.active = true;
  liveTouch.pending = null;
  liveTouch.finish = null;
  liveTouch.sent = 0;
  liveTouch.started = performance.now();
  setInputStatus("pending", label);
  // Every phase of a gesture runs as one serial chain. Concurrent requests can arrive out of
  // order, and because a move is delivered as a second press, a release that overtakes the last
  // move would leave the device with a finger still down and ignoring all later input.
  liveTouch.inflight = true;
  postTouch(point, "down").catch(() => undefined).then(pumpTouch);
  return true;
}

// Keep at most one request in flight. Newer positions replace older ones, so the device always
// chases the current cursor instead of replaying a queue of stale points.
function pumpTouch() {
  const next = liveTouch.pending;
  liveTouch.pending = null;
  if (next && liveTouch.active) {
    liveTouch.sent += 1;
    postTouch(next, "move").catch(() => undefined).then(pumpTouch);
    return;
  }

  liveTouch.inflight = false;
  const finish = liveTouch.finish;
  if (finish) {
    liveTouch.finish = null;
    finish();
  }
}

function moveTouch(point) {
  if (!liveTouch.active) return;
  liveTouch.pending = point;
  if (liveTouch.inflight) return;
  liveTouch.inflight = true;
  pumpTouch();
}

function endTouch(point, label) {
  if (!liveTouch.active) return;
  liveTouch.active = false;
  liveTouch.pending = null;
  const elapsed = Math.round(performance.now() - liveTouch.started);
  const release = () =>
    postTouch(point, "up")
      .then(() => {
        setInputStatus("success", `${label} sent`, `${elapsed} ms`);
        settleInputIndicator(true);
      })
      .catch((error) => {
        setInputStatus("error", `${label} failed`);
        settleInputIndicator(false);
        showError(error);
      });

  if (liveTouch.inflight) liveTouch.finish = release;
  else release();
}

elements.canvas.addEventListener("pointerdown", (event) => {
  if (!state.display || (event.pointerType === "mouse" && event.button !== 0)) return;
  event.preventDefault();
  elements.canvas.focus();
  elements.canvas.setPointerCapture(event.pointerId);
  const point = logicalPoint(event);
  state.pointer = {
    id: event.pointerId,
    point,
    moved: false,
    started: performance.now(),
  };
  showInputIndicator(event.clientX, event.clientY);
  if (!beginTouch(point, "Touch down")) {
    state.pointer = null;
  }
});

elements.canvas.addEventListener("pointermove", (event) => {
  if (state.pointer?.id !== event.pointerId || !state.display) return;
  event.preventDefault();
  positionInputIndicator(event.clientX, event.clientY);
  const point = logicalPoint(event);
  if (Math.hypot(point.x - state.pointer.point.x, point.y - state.pointer.point.y) >= 1) {
    state.pointer.moved = true;
  }
  moveTouch(point);
});

elements.canvas.addEventListener("pointerup", (event) => {
  if (state.pointer?.id !== event.pointerId || !state.display) return;
  event.preventDefault();
  const pointer = state.pointer;
  const end = logicalPoint(event);
  const duration = (performance.now() - pointer.started) / 1000;
  const distance = Math.hypot(end.x - pointer.point.x, end.y - pointer.point.y);
  state.pointer = null;
  if (elements.canvas.hasPointerCapture(event.pointerId)) {
    elements.canvas.releasePointerCapture(event.pointerId);
  }
  positionInputIndicator(event.clientX, event.clientY);

  const label = distance >= 6 ? "Drag" : duration > 0.45 ? "Long press" : "Tap";
  endTouch(end, label);
});

elements.canvas.addEventListener("pointercancel", cancelPointer);
elements.canvas.addEventListener("contextmenu", (event) => event.preventDefault());

// A wheel is not a touch, so scrolling is driven as a virtual finger: press down on the first
// event, track accumulated delta as movement, and lift after the wheel goes quiet. This scrolls
// while the user is still turning the wheel rather than replaying one swipe afterwards.
elements.canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (!state.display) return;

  const point = logicalPoint(event);
  if (!state.wheel) {
    // Start mid-screen so there is travel available in both directions before clamping.
    const origin = { x: point.x, y: state.display.pointHeight / 2 };
    state.wheel = { origin, cursor: { ...origin } };
    if (!beginTouch(origin, "Scroll")) {
      state.wheel = null;
      return;
    }
  }

  const delta = event.deltaY || event.deltaX;
  state.wheel.cursor = {
    x: state.wheel.origin.x,
    y: Math.max(1, Math.min(
      state.display.pointHeight - 1,
      state.wheel.cursor.y - delta,
    )),
  };
  showInputIndicator(event.clientX, event.clientY);
  moveTouch(state.wheel.cursor);

  clearTimeout(state.wheelTimer);
  state.wheelTimer = setTimeout(flushWheel, 90);
}, { passive: false });

function flushWheel() {
  const wheel = state.wheel;
  state.wheel = null;
  state.wheelTimer = null;
  if (!wheel) {
    settleInputIndicator(true);
    return;
  }
  endTouch(wheel.cursor, "Scroll");
}

const keyCodes = {
  Enter: 40,
  Escape: 41,
  Backspace: 42,
  Tab: 43,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82,
};

elements.canvas.addEventListener("keydown", (event) => {
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;

  if (keyCodes[event.key]) {
    event.preventDefault();
    sendInput("key", { keyCode: keyCodes[event.key] }, event.key).catch(showError);
  } else if (event.key.length === 1) {
    event.preventDefault();
    sendInput("text", { text: event.key }, "Type").catch(showError);
  }
});

elements.canvas.addEventListener("paste", (event) => {
  const text = event.clipboardData?.getData("text");
  if (!text) return;
  event.preventDefault();
  sendInput("text", { text }, "Paste").catch(showError);
});

document.querySelector("#refresh-button").addEventListener("click", (event) => {
  runBusy(event.currentTarget, refresh).catch(showError);
});

elements.selector.addEventListener("click", () => {
  if (elements.popover.classList.contains("hidden")) {
    openDevicePopover();
  } else {
    closeDevicePopover();
  }
});

document.addEventListener("pointerdown", (event) => {
  if (elements.popover.classList.contains("hidden")) return;
  if (event.target.closest(".selector-wrap")) return;
  closeDevicePopover();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDevicePopover();
});

for (const button of [document.querySelector("#create-button"), document.querySelector(".empty-create")]) {
  button.addEventListener("click", () => {
    closeDevicePopover();
    elements.createDialog.showModal();
  });
}

document.querySelector("#create-close").addEventListener("click", () => elements.createDialog.close());
document.querySelector("#create-cancel").addEventListener("click", () => elements.createDialog.close());
elements.fps.addEventListener("change", startStream);
elements.scale.addEventListener("change", startStream);

elements.linkChip.addEventListener("click", () => setLinkExpanded(!state.linkExpanded));
setLinkExpanded(false);

/*
 * The canvas provider protocol exposes no theme hint, so "auto" defers to
 * prefers-color-scheme there. Hosts with a native theme can load an adapter that
 * remaps the same semantic tokens while this preference remains set to auto.
 */
const THEME_STORAGE_KEY = "mobile-canvas-theme";

function applyTheme(choice) {
  if (choice === "light" || choice === "dark") {
    document.documentElement.setAttribute("data-theme", choice);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === choice));
  }
}

for (const button of document.querySelectorAll("[data-theme-choice]")) {
  button.addEventListener("click", () => {
    const choice = button.dataset.themeChoice;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, choice);
    } catch {
      // Storage can be unavailable in a restricted webview; the choice still applies.
    }
    applyTheme(choice);
  });
}

let storedTheme = "auto";
try {
  storedTheme = localStorage.getItem(THEME_STORAGE_KEY) || "auto";
} catch {
  storedTheme = "auto";
}
applyTheme(storedTheme);

if ("ResizeObserver" in window) {
  // Observe the border box: fitDeviceScreen() writes padding-top on this element, and a content-box
  // observation would see that write as a resize and re-enter.
  const stage = elements.stageViewport;
  if (stage) new ResizeObserver(() => fitDeviceScreen()).observe(stage, { box: "border-box" });
} else {
  window.addEventListener("resize", fitDeviceScreen);
}

for (const button of document.querySelectorAll("[data-action]")) {
  button.addEventListener("click", () => runBusy(button, async () => {
    switch (button.dataset.action) {
      case "boot":
        await lifecycle("boot");
        break;
      case "home":
        await sendInput("button", { button: "home" }, "Home");
        break;
      case "back":
        await sendInput("button", { button: "back" }, "Back");
        break;
      case "apps":
        await sendInput("button", { button: "apps" }, "Recents");
        break;
      case "lock":
        await sendInput("button", { button: "lock" }, "Lock");
        break;
      case "rotate":
        await rotateDevice();
        break;
      case "screenshot":
        await downloadScreenshot();
        break;
      case "record":
        await toggleRecording();
        break;
      case "restart":
      case "shutdown":
      case "reveal":
        await lifecycle(button.dataset.action);
        break;
      case "detach":
        await detach();
        break;
      case "settings":
        elements.settingsDialog.showModal();
        break;
      case "data":
        elements.dataDialog.showModal();
        break;
      default:
        throw new Error(`Unknown action '${button.dataset.action}'.`);
    }
  }).catch(showError));
}

// Switching platform swaps in a platform-appropriate default name, but only until the user has
// typed something of their own.
elements.createName.addEventListener("input", () => {
  elements.createName.dataset.edited = "1";
});
elements.createRuntime.addEventListener("change", populateCreateOptions);

elements.createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runBusy(elements.createSubmit, async () => {
    const response = await api("/api/v1/devices", {
      method: "POST",
      body: JSON.stringify({
        platform: state.createPlatform || "ios",
        name: elements.createName.value,
        runtimeId: elements.createRuntime.value,
        deviceTypeId: elements.createDeviceType.value,
      }),
    });
    state.selected = await response.json();
    elements.createDialog.close();
    await refresh();
    showToast(`${state.selected.name} created and started`);
  }).catch(showError);
});

document.querySelector("#erase-button").addEventListener("click", async (event) => {
  const trigger = event.currentTarget;
  // Stacking a second modal on the data dialog would leave the destructive sheet visible behind the
  // confirmation, so hand the top layer over first.
  elements.dataDialog.close();
  if (!await requestConfirmation({
    title: `Erase ${state.selected.name}?`,
    message: `All content and settings on this ${selectedNoun()} will be permanently removed.`,
    action: `Erase ${selectedNoun()}`,
  })) return;

  runBusy(trigger, async () => {
    const response = await api(`/api/v1/devices/${encodeURIComponent(state.selected.id)}/erase`, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
    state.selected = await response.json();
    await refresh();
    showToast(`${capitalize(selectedNoun())} erased`);
  }).catch(showError);
});

document.querySelector("#delete-button").addEventListener("click", async (event) => {
  const trigger = event.currentTarget;
  const noun = selectedNoun();
  elements.dataDialog.close();
  if (!await requestConfirmation({
    title: `Delete ${state.selected.name}?`,
    message: `The ${selectedNoun()} and all of its data will be permanently deleted.`,
    action: `Delete ${selectedNoun()}`,
  })) return;

  runBusy(trigger, async () => {
    await api(`/api/v1/devices/${encodeURIComponent(state.selected.id)}`, {
      method: "DELETE",
      body: JSON.stringify({ confirm: true }),
    });
    stopStream();
    state.selected = null;
    elements.view.classList.add("hidden");
    elements.empty.classList.remove("hidden");
    await refresh();
    showToast(`${capitalize(noun)} deleted`);
  }).catch(showError);
});

elements.copyUdid.addEventListener("click", async () => {
  const identifier = identifierLabels(state.selected?.platform);
  try {
    const value = state.selected.udid || state.selected.nativeId;
    if (transport?.copyText) await transport.copyText(value);
    else await navigator.clipboard.writeText(value);
    showToast(identifier.copied);
  } catch (error) {
    showError(new Error(`Could not copy the ${identifier.label}: ${error.message}`));
  }
});

async function runBusy(button, operation) {
  if (button.getAttribute("aria-busy") === "true") return;
  button.setAttribute("aria-busy", "true");
  button.disabled = true;
  try {
    await operation();
  } finally {
    button.removeAttribute("aria-busy");
    button.disabled = false;
    updateControlAvailability();
  }
}

async function downloadScreenshot() {
  const response = await api(`/api/v1/devices/${encodeURIComponent(state.selected.id)}/screenshot`);
  const blob = await response.blob();
  const suggestedName =
    `${state.selected.name.replaceAll(/\W+/g, "-").toLowerCase()}-${Date.now()}.png`;
  if (transport?.saveBlob) {
    if (await transport.saveBlob(blob, suggestedName)) showToast("Screenshot saved");
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedName;
  link.click();
  URL.revokeObjectURL(url);
  showToast("Screenshot saved");
}

async function updateRecordingStatus(
  deviceId = state.selected?.id,
  selectionVersion = state.selectionVersion,
) {
  if (!deviceId) return;
  const response = await api(`/api/v1/devices/${encodeURIComponent(deviceId)}/recording`);
  const status = await response.json();
  if (
    selectionVersion !== state.selectionVersion
    || state.selected?.id !== deviceId
  ) return;
  setRecordingState(status.isRecording);
}

function setRecordingState(isRecording) {
  state.recording = isRecording;
  elements.record.classList.toggle("recording", isRecording);
  elements.record.setAttribute("aria-label", isRecording ? "Stop recording" : "Start recording");
  elements.record.title = isRecording ? "Stop recording" : "Start recording";
}

async function toggleRecording() {
  const operation = state.recording ? "stop" : "start";
  const response = await api(
    `/api/v1/devices/${encodeURIComponent(state.selected.id)}/recording/${operation}`,
    {
      method: "POST",
      ...(state.recording ? {} : { body: JSON.stringify({ timeoutSeconds: 180 }) }),
    },
  );
  const status = await response.json();
  setRecordingState(status.isRecording);
  showToast(
    state.recording
      ? "Recording started"
      : `Recording saved to ${status.outputPath}`,
  );
}

async function detach() {
  state.selectionVersion += 1;
  state.selectionTarget = null;
  stopStream();
  endAutomation();
  // Detach means this panel is done with the device. Clearing the reference first makes the close
  // handler treat this as intentional rather than a dropped connection worth retrying.
  const socket = automation.socket;
  automation.socket = null;
  clearTimeout(automation.retryTimer);
  socket?.close();
  await api("/api/v1/canvas/detach", { method: "POST" });
  clearStoredDeviceId(localStorage, canvasInstanceId());
  state.detached = true;
  transport?.setViewTitle?.("Device", "Detached");
  elements.view.classList.add("hidden");
  elements.empty.classList.add("hidden");
  elements.detached.classList.remove("hidden");
}

/**
 * Rebuilds the create dialog for one platform. The catalog is merged across backends, so runtimes
 * and device types must be filtered or an iOS runtime would be offered alongside an Android device
 * profile and the create call would fail well after the user committed to it.
 */
function populateCreateOptions() {
  const platforms = creatablePlatforms(state.catalog);
  if (!platforms.includes(state.createPlatform)) {
    state.createPlatform = platforms.includes(state.selected?.platform)
      ? state.selected.platform
      : platforms[0] || null;
  }

  // With one platform installed there is nothing to choose, so the control is hidden rather than
  // shown as a single dead option.
  elements.createPlatformField.classList.toggle("hidden", platforms.length < 2);
  elements.createPlatform.replaceChildren();
  for (const platform of platforms) {
    const info = platformInfo(platform);
    const option = document.createElement("button");
    option.type = "button";
    option.className = `segmented-option ${platform === state.createPlatform ? "selected" : ""}`;
    option.setAttribute("role", "radio");
    option.setAttribute("aria-checked", String(platform === state.createPlatform));
    option.setAttribute("aria-label", info.label);
    option.innerHTML = `
      <svg class="icon" aria-hidden="true"><use href="${info.icon}"></use></svg>
      ${escapeHtml(info.shortLabel)}`;
    option.addEventListener("click", () => {
      state.createPlatform = platform;
      populateCreateOptions();
    });
    elements.createPlatform.append(option);
  }

  const platform = state.createPlatform;
  const info = platformInfo(platform);
  elements.createKicker.textContent = info.provider || "No creatable devices";

  const priorRuntimeId = elements.createRuntime.value;
  const { runtimes } = createOptions(state.catalog, platform, priorRuntimeId);
  const selectedRuntimeId = runtimes.some((runtime) => runtime.id === priorRuntimeId)
    ? priorRuntimeId
    : runtimes[0]?.id;
  elements.createRuntime.innerHTML = runtimes.length > 0
    ? runtimes
      .map((runtime) => `<option value="${escapeHtml(runtime.id)}">${escapeHtml(runtime.name)}</option>`)
      .join("")
    : '<option value="">No compatible runtime installed</option>';
  elements.createRuntime.value = selectedRuntimeId || "";
  elements.createRuntime.disabled = runtimes.length === 0;

  const { deviceTypes } = createOptions(state.catalog, platform, selectedRuntimeId);
  const priorDeviceTypeId = elements.createDeviceType.value;
  elements.createDeviceType.innerHTML = deviceTypes.length > 0
    ? deviceTypes
      .map((type) => `<option value="${escapeHtml(type.id)}">${escapeHtml(type.name)}</option>`)
      .join("")
    : '<option value="">No compatible device type found</option>';
  if (deviceTypes.some((type) => type.id === priorDeviceTypeId))
    elements.createDeviceType.value = priorDeviceTypeId;
  elements.createDeviceType.disabled = deviceTypes.length === 0;
  elements.createSubmit.disabled = runtimes.length === 0 || deviceTypes.length === 0;

  if (!elements.createName.dataset.edited)
    elements.createName.value = platform === "android" ? "Test Android" : "Test iPhone";
}

function requestConfirmation({ title, message, action }) {
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmSubmit.textContent = action;
  elements.confirmDialog.returnValue = "";
  elements.confirmDialog.showModal();
  return new Promise((resolve) => {
    elements.confirmDialog.addEventListener(
      "close",
      () => resolve(elements.confirmDialog.returnValue === "confirm"),
      { once: true },
    );
  });
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.className = `toast ${isError ? "error" : ""}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.add("hidden"), 3500);
}

function showError(error) {
  showToast(error.message || String(error), true);
}

function formatAction(value) {
  return String(value)
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function concatBytes(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function createSocket(channel, query) {
  if (transport?.createSocket) return transport.createSocket(channel, query);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(
    `${protocol}//${location.host}/ws/${channel}${query ? `?${query}` : ""}`,
  );
}

function canvasInstanceId() {
  const instanceId = sessionStorage.getItem("mobile-canvas-instance");
  if (!instanceId) {
    throw new Error("Mobile Canvas has no active panel identity.");
  }
  return instanceId;
}

function setPanelVisible(visible) {
  if (state.panelVisible === visible) return;
  const visibilityVersion = ++panelVisibilityVersion;
  state.panelVisible = visible;
  if (!visible) {
    stopStream();
    clearTimeout(automation.retryTimer);
    const socket = automation.socket;
    automation.socket = null;
    socket?.close();
    endAutomation();
    return;
  }
  if (!state.detached) {
    if (transport) {
      startStream();
      connectAutomationEvents();
      return;
    }
    const isActive = () =>
      panelVisibilityVersion === visibilityVersion
      && state.panelVisible
      && !state.detached;
    void resumeAuthenticatedPanel({
      authenticate: () => api("/api/v1/status"),
      isActive,
      resume: () => {
        startStream();
        connectAutomationEvents();
      },
    }).catch((error) => {
      if (isActive()) showError(error);
    });
  }
}

document.addEventListener("visibilitychange", () => setPanelVisible(!document.hidden));
transport?.onVisibilityChanged?.(setPanelVisible);
let transportRefresh = Promise.resolve();
transport?.onRefreshRequested?.(() => {
  if (!state.detached) {
    transportRefresh = transportRefresh.then(refresh).catch(showError);
  }
});
transport?.onAutomationRequested?.((activity) => {
  void transportRefresh
    .then(() => handleScopedAutomation(activity))
    .catch(showError);
});

async function handleScopedAutomation(activity) {
  if (!activity?.deviceId || state.detached) return;
  automation.selectionGeneration += 1;
  await followSelection(activity.deviceId);
  if (state.selected?.id === activity.deviceId) {
    handleAutomationEvent(activity);
  }
}

function findStartCodes(bytes) {
  const starts = [];
  for (let index = 0; index < bytes.length - 3; index++) {
    if (bytes[index] === 0 && bytes[index + 1] === 0 &&
        (bytes[index + 2] === 1 || (bytes[index + 2] === 0 && bytes[index + 3] === 1))) {
      starts.push(index);
      index += bytes[index + 2] === 1 ? 2 : 3;
    }
  }
  return starts;
}

bootstrap()
  .then(refresh)
  .then(connectAutomationEvents)
  .catch(showError);
