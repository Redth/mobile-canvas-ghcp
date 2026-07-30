const elements = {
  list: document.querySelector("#device-list"),
  count: document.querySelector("#device-count"),
  diagnostics: document.querySelector("#diagnostics"),
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
  overlay: document.querySelector("#stream-overlay"),
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
};

const state = {
  catalog: null,
  selected: null,
  display: null,
  socket: null,
  decoder: null,
  pngTimer: null,
  frameCounter: 0,
  frameClock: performance.now(),
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
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
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
  const fragment = new URLSearchParams(location.hash.slice(1));
  const secret = fragment.get("bootstrap");
  if (!secret) return;

  const sessionId = fragment.get("sessionId");
  const instanceId = fragment.get("instanceId");
  sessionStorage.setItem("mobile-canvas-session", sessionId || "");
  sessionStorage.setItem("mobile-canvas-instance", instanceId || "");
  await api("/api/v1/auth/bootstrap", {
    method: "POST",
    body: JSON.stringify({ secret, sessionId, instanceId }),
  });
  history.replaceState(null, "", location.pathname);
}

async function refresh() {
  if (state.detached) return;
  elements.list.setAttribute("aria-busy", "true");
  try {
    const response = await api("/api/v1/catalog");
    state.catalog = await response.json();
    renderDiagnostics();
    renderDeviceList();
    populateCreateOptions();

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

function renderDiagnostics() {
  const failures = (state.catalog?.diagnostics || [])
    .flatMap((diagnostic) => diagnostic.checks || [])
    .filter((check) => check.status !== "ok");
  elements.diagnostics.classList.toggle("hidden", failures.length === 0);
  elements.diagnostics.textContent = failures.map((check) => check.message).join(" ");
}

/**
 * Platform presentation lives in one table so a new backend only has to be named here. `label` is
 * the group heading, `noun` keeps prose ("New simulator" vs "New emulator") honest, and `icon`
 * picks the sprite.
 */
const PLATFORMS = {
  ios: { label: "iOS Simulators", noun: "simulator", icon: "#icon-ios", provider: "CoreSimulator" },
  android: { label: "Android Emulators", noun: "emulator", icon: "#icon-android", provider: "Android Emulator" },
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
  elements.count.textContent = String(devices.length);
  elements.list.replaceChildren();

  const platforms = availablePlatforms();
  // A single-platform machine is the common case, and a lone "iOS Simulators" heading directly
  // under a popover already titled "Devices" is pure noise, so headings only appear when they
  // actually separate something.
  const showHeadings = platforms.length > 1;

  for (const platform of platforms) {
    const group = devices.filter((device) => device.platform === platform);
    if (group.length === 0) continue;

    if (showHeadings) {
      const heading = document.createElement("div");
      heading.className = "device-group";
      heading.setAttribute("role", "presentation");
      heading.innerHTML = `
        <span>${escapeHtml(platformInfo(platform).label)}</span>
        <span class="count">${group.length}</span>`;
      elements.list.append(heading);
    }

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
  stopStream();
  if (persist) {
    setInputStatus("pending", "Selecting device");
    const response = await api("/api/v1/selection", {
      method: "POST",
      body: JSON.stringify({ deviceId: device.id }),
    });
    device = await response.json();
  }

  state.selected = device;
  // A cursor left over from the previous device would point at coordinates that no longer mean
  // anything, so drop the overlay whenever the selection changes.
  endAutomation();
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
    state.display = await displayResponse.json();
    elements.geometry.value =
      `${state.display.pointWidth}x${state.display.pointHeight} pt @${state.display.scale}x`;
    fitDeviceScreen();
    setInputStatus("ready", "Input ready");
    startStream();
    await updateRecordingStatus();
  } else {
    state.display = null;
    elements.overlay.textContent = `${capitalize(platformInfo(state.selected?.platform).noun)} is powered off`;
    elements.overlay.classList.remove("hidden");
    elements.mode.textContent = "offline";
    elements.actualFps.textContent = "0 FPS";
    setInputStatus("ready", `Boot the ${platformInfo(state.selected?.platform).noun} to interact`);
  }
}

function showEmptySelection() {
  stopStream();
  endAutomation();
  state.selected = null;
  state.display = null;
  elements.view.classList.add("hidden");
  elements.detached.classList.add("hidden");
  elements.empty.classList.remove("hidden");
  elements.mode.textContent = "idle";
  elements.actualFps.textContent = "0 FPS";
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
 * cannot perform is hidden rather than shown broken -- an Android emulator has no Simulator.app to
 * reveal, and an AVD without a gRPC endpoint cannot record.
 */
const ACTION_CAPABILITY = {
  boot: "boot",
  home: "button",
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
    button.hidden = Boolean(state.selected && capability && capabilities[capability] === false);

    const needsBooted = ["home", "screenshot", "record", "restart", "shutdown"].includes(action);
    button.disabled = !state.selected ||
      (action === "boot" ? booted : needsBooted && !booted);
  }

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
    return;
  }

  const width = Math.round(state.display.pixelWidth * scale);
  const height = Math.round(state.display.pixelHeight * scale);
  elements.encodeSize.textContent = `${width}x${height}`;
  elements.encodeSize.title = `Encoding at ${Math.round(scale * 100)}% of the ${state.display.pixelWidth}x${state.display.pixelHeight} framebuffer`;
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
 */
function fitDeviceScreen() {
  const stage = elements.canvas.closest(".stage-viewport");
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

  const availableWidth = stage.clientWidth - chromeX;
  const availableHeight = stage.clientHeight - chromeY;
  if (availableWidth <= 0 || availableHeight <= 0) return;

  let width = Math.min(availableWidth, MAX_SCREEN_WIDTH);
  let height = width / aspect;
  if (height > availableHeight) {
    height = availableHeight;
    width = height * aspect;
  }

  elements.canvas.style.width = `${Math.floor(width)}px`;
  elements.canvas.style.height = `${Math.floor(height)}px`;
  reconcileAutoScale();
}

function startStream() {
  stopStream();
  if (!state.selected || state.selected.state !== "booted") return;

  elements.overlay.textContent = "Starting live view...";
  elements.overlay.classList.remove("hidden");
  elements.mode.textContent = "connecting";
  state.frameClock = performance.now();

  if (!("VideoDecoder" in window) || !state.selected.capabilities.liveStream) {
    startPngFallback("PNG");
    return;
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  state.activeScale = resolveScale();
  renderEncodeSize();
  const query = new URLSearchParams({
    deviceId: state.selected.id,
    fps: elements.fps.value,
    scale: state.activeScale,
  });
  const socket = new WebSocket(`${protocol}//${location.host}/ws/video?${query}`);
  state.socket = socket;
  socket.binaryType = "arraybuffer";
  const parser = new AnnexBDecoder();

  socket.addEventListener("message", (event) => {
    if (state.socket !== socket) return;
    if (typeof event.data === "string") {
      const descriptor = JSON.parse(event.data);
      if (descriptor.display) {
        state.display = descriptor.display;
        elements.geometry.value =
          `${state.display.pointWidth}x${state.display.pointHeight} pt @${state.display.scale}x`;
        fitDeviceScreen();
        renderEncodeSize();
      }
      elements.mode.textContent = "H.264";
      applyCaptureSource(descriptor);
      return;
    }
    parser.push(new Uint8Array(event.data));
  });
  socket.addEventListener("open", () => {
    if (state.socket === socket) elements.mode.textContent = "H.264";
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
  state.activeScale = null;
  clearTimeout(state.scaleTimer);
  elements.actualFps.textContent = "0 FPS";
  renderEncodeSize();
}

class AnnexBDecoder {
  constructor() {
    this.buffer = new Uint8Array();
    this.prefix = [];
    this.timestamp = 0;
    this.codec = "avc1.64001f";
  }

  push(bytes) {
    this.buffer = concatBytes([this.buffer, bytes]);
    const starts = findStartCodes(this.buffer);
    if (starts.length < 2) return;
    for (let index = 0; index < starts.length - 1; index++) {
      this.handleNal(this.buffer.slice(starts[index], starts[index + 1]));
    }
    this.buffer = this.buffer.slice(starts.at(-1));
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
      // order and the decoder has to hold a frame back to reorder. optimizeForLatency asks it to emit
      // frames with as little buffering as possible, which defeats that reordering and shows up as
      // temporally scrambled motion while static screens still look correct. The reorder depth is one
      // frame, so the latency this costs is far smaller than the artefacts it removes.
      optimizeForLatency: false,
      hardwareAcceleration: "prefer-hardware",
      avc: { format: "annexb" },
    });
  }
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
  const width = visible.width || frame.displayWidth || frame.codedWidth;
  const height = visible.height || frame.displayHeight || frame.codedHeight;
  if (elements.canvas.width !== width || elements.canvas.height !== height) {
    elements.canvas.width = width;
    elements.canvas.height = height;
    state.canvasContext = null;
    fitDeviceScreen();
  }
  // Resizing a canvas invalidates its context, so the cache is cleared above rather than re-fetched
  // on every frame.
  canvasContext().drawImage(
    frame,
    visible.x,
    visible.y,
    visible.width,
    visible.height,
    0,
    0,
    width,
    height,
  );
  frame.close();
  elements.overlay.classList.add("hidden");
  countFrame();
}

// The stream can silently degrade to idb when ScreenCaptureKit is unavailable, which reads as a
// quality regression rather than a fixable permission problem. Name the active backend, and carry
// the reason in the tooltip so a denied TCC prompt explains itself.
const CAPTURE_SOURCE_LABELS = {
  screencapturekit: "ScreenCaptureKit",
  idb: "idb (fallback)",
  png: "Screenshots (fallback)",
};

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
  elements.captureSource.classList.toggle("field-degraded", source !== "screencapturekit");
}

function canvasContext() {
  state.canvasContext ??= elements.canvas.getContext("2d", { alpha: false, desynchronized: true });
  return state.canvasContext;
}

function startPngFallback(label) {
  if (state.detached || !state.selected || state.selected.state !== "booted") return;
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

  elements.mode.textContent = label;
  const capture = async () => {
    state.pngTimer = null;
    try {
      const response = await api(`/api/v1/devices/${encodeURIComponent(state.selected.id)}/screenshot`);
      const bitmap = await createImageBitmap(await response.blob());
      if (elements.canvas.width !== bitmap.width || elements.canvas.height !== bitmap.height) {
        elements.canvas.width = bitmap.width;
        elements.canvas.height = bitmap.height;
        state.canvasContext = null;
        fitDeviceScreen();
      }
      canvasContext().drawImage(bitmap, 0, 0);
      bitmap.close();
      elements.overlay.classList.add("hidden");
      countFrame();
    } catch (error) {
      elements.overlay.textContent = error.message;
      elements.overlay.classList.remove("hidden");
    } finally {
      if (!state.detached && state.selected?.state === "booted" && !state.socket) {
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
  elements.actualFps.textContent = `${fps.toFixed(1)} FPS`;
  state.frameCounter = 0;
  state.frameClock = now;
}

async function lifecycle(action) {
  const device = state.selected;
  if (!device) return;

  if (action !== "reveal") {
    stopStream();
    elements.overlay.textContent = `${formatAction(action)} in progress...`;
    elements.overlay.classList.remove("hidden");
  }

  const response = await api(
    `/api/v1/devices/${encodeURIComponent(device.id)}/${action}`,
    { method: "POST" },
  );
  state.selected = await response.json();
  await refresh();
  showToast(`${formatAction(action)} complete`);
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
};

function connectAutomationEvents() {
  clearTimeout(automation.retryTimer);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  let socket;
  try {
    socket = new WebSocket(`${protocol}//${location.host}/ws/events`);
  } catch {
    scheduleAutomationReconnect();
    return;
  }
  automation.socket = socket;

  socket.addEventListener("message", (event) => {
    if (automation.socket !== socket) return;
    let activity;
    try {
      activity = JSON.parse(event.data);
    } catch {
      return;
    }
    // Several canvases can share one host, so ignore anything aimed at a device we are not showing.
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
  automation.retryTimer = setTimeout(connectAutomationEvents, 2000);
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

/*
 * The canvas provider protocol exposes no theme hint, so "auto" defers to the
 * host webview's prefers-color-scheme. The explicit choices are the escape hatch
 * for hosts that do not propagate the app appearance.
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
  const stage = elements.canvas.closest(".stage-viewport");
  if (stage) new ResizeObserver(() => fitDeviceScreen()).observe(stage);
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
    await lifecycle("boot");
  }).catch(showError);
});

document.querySelector("#erase-button").addEventListener("click", async (event) => {
  if (!await requestConfirmation({
    title: `Erase ${state.selected.name}?`,
    message: `All content and settings on this ${selectedNoun()} will be permanently removed.`,
    action: `Erase ${selectedNoun()}`,
  })) return;

  runBusy(event.currentTarget, async () => {
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
  const noun = selectedNoun();
  if (!await requestConfirmation({
    title: `Delete ${state.selected.name}?`,
    message: `The ${selectedNoun()} and all of its data will be permanently deleted.`,
    action: `Delete ${selectedNoun()}`,
  })) return;

  runBusy(event.currentTarget, async () => {
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
    await navigator.clipboard.writeText(state.selected.udid || state.selected.nativeId);
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
    updateControlAvailability();
  }
}

async function downloadScreenshot() {
  const response = await api(`/api/v1/devices/${encodeURIComponent(state.selected.id)}/screenshot`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.selected.name.replaceAll(/\W+/g, "-").toLowerCase()}-${Date.now()}.png`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("Screenshot saved");
}

async function updateRecordingStatus() {
  const response = await api(`/api/v1/devices/${encodeURIComponent(state.selected.id)}/recording`);
  const status = await response.json();
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
  stopStream();
  endAutomation();
  // Detach means this panel is done with the device. Clearing the reference first makes the close
  // handler treat this as intentional rather than a dropped connection worth retrying.
  const socket = automation.socket;
  automation.socket = null;
  clearTimeout(automation.retryTimer);
  socket?.close();
  await api("/api/v1/canvas/detach", { method: "POST" });
  state.detached = true;
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
  const platforms = availablePlatforms();
  if (!platforms.includes(state.createPlatform)) {
    state.createPlatform = platforms.includes(state.selected?.platform)
      ? state.selected.platform
      : platforms[0] || "ios";
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
    option.innerHTML = `
      <svg class="icon" aria-hidden="true"><use href="${info.icon}"></use></svg>
      ${escapeHtml(info.label)}`;
    option.addEventListener("click", () => {
      state.createPlatform = platform;
      populateCreateOptions();
    });
    elements.createPlatform.append(option);
  }

  const platform = state.createPlatform;
  const info = platformInfo(platform);
  elements.createKicker.textContent = info.provider;

  const runtimes = (state.catalog?.runtimes || [])
    .filter((runtime) => runtime.isAvailable && runtime.platform === platform);
  elements.createRuntime.innerHTML = runtimes
    .map((runtime) => `<option value="${escapeHtml(runtime.id)}">${escapeHtml(runtime.name)}</option>`)
    .join("");

  const deviceTypes = (state.catalog?.deviceTypes || [])
    .filter((type) => !type.platform || type.platform === platform);
  elements.createDeviceType.innerHTML = deviceTypes
    .map((type) => `<option value="${escapeHtml(type.id)}">${escapeHtml(type.name)}</option>`)
    .join("");

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
