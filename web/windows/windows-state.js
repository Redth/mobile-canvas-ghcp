/**
 * Shared Windows App canvas state.
 *
 * Everything in this module is pure: no DOM, no fetch, no globals. Both hosts run the same
 * renderer, so the rules that decide what a tab says, which window is streaming, where a click
 * lands, and whether an error means "refresh the geometry" live here where they can be tested in
 * Node rather than inferred from a browser.
 */

/** The product surface this renderer is authorized for. */
export const WINDOWS_SURFACE = "windows";

/** Session storage keys. They are surface-prefixed so a shared origin cannot mix the two panels. */
export const SESSION_KEYS = {
  session: "windows-canvas-session",
  instance: "windows-canvas-instance",
  surface: "windows-canvas-surface",
};

/** Machine-readable failures this renderer reacts to rather than merely reports. */
export const WINDOWS_ERROR_CODES = {
  transformStale: "windows_input_transform_stale",
  outOfBounds: "windows_input_out_of_bounds",
  foregroundRefused: "windows_input_foreground_refused",
  minimized: "windows_window_minimized",
  windowNotFound: "windows_window_not_found",
  identityChanged: "windows_window_identity_changed",
  notAuthorized: "windows_window_not_authorized",
  sessionNotFound: "windows_session_not_found",
  captureProtected: "windows_capture_protected",
  captureUnavailable: "windows_capture_unavailable",
  elevated: "windows_target_elevated",
  ambiguousEntry: "windows_catalog_entry_ambiguous",
  ambiguousElement: "windows_uia_element_ambiguous",
  helperMissing: "windows_helper_missing",
  platformUnsupported: "windows_platform_unsupported",
  rateLimited: "windows_input_rate_limited",
};

/** Stream end reasons the host states explicitly, from WindowsStreamEndReasons. */
export const STREAM_END_REASONS = {
  clientClosed: "clientClosed",
  contentSizeChanged: "contentSizeChanged",
  dpiChanged: "dpiChanged",
  minimized: "minimized",
  windowClosed: "windowClosed",
  captureFailed: "captureFailed",
  encoderFailed: "encoderFailed",
  hostStopping: "hostStopping",
};

const CAPTURE_SOURCE_LABELS = {
  windowsGraphicsCapture: "Windows.Graphics.Capture",
  printWindow: "PrintWindow (degraded)",
  png: "Screenshots (fallback)",
};

const CORRELATION_LABELS = {
  launchedProcess: "Launched by this panel",
  sameProcess: "Same process as the app",
  appUserModelId: "Same packaged app identity",
  packageFamily: "Same package family",
  ownedDialog: "Dialog owned by the app",
  attached: "Attached by you",
};

const ORIGIN_LABELS = {
  catalog: "Launched from the app catalog",
  executable: "Launched from an executable path",
  attach: "Attached to a running window",
};

/**
 * Whether the host reported that Windows automation can run here at all. A preflight that is not
 * ready is a state to explain, never a reason to render an empty panel with no cause.
 */
export function preflightPresentation(preflight) {
  if (!preflight) {
    return {
      ready: false,
      tone: "warning",
      title: "Checking Windows support",
      detail: "Asking the local host what this machine can do.",
      busy: true,
    };
  }
  if (preflight.ready) {
    const unavailable = (preflight.features ?? []).filter((feature) => !feature.available);
    return {
      ready: true,
      tone: unavailable.length > 0 ? "warning" : "ok",
      title: "Windows automation ready",
      detail: unavailable.length > 0
        ? `${unavailable.map((feature) => featureLabel(feature.name)).join(", ")} unavailable.`
        : `Helper ${preflight.helperVersion ?? "present"}${
          preflight.signatureStatus ? ` (${preflight.signatureStatus})` : ""}.`,
      features: preflight.features ?? [],
    };
  }
  if (preflight.platformSupported === false) {
    return {
      ready: false,
      tone: "neutral",
      title: "Windows apps need a Windows host",
      detail: preflight.detail
        || "This canvas controls desktop apps in the current Windows session.",
      features: preflight.features ?? [],
    };
  }
  return {
    ready: false,
    tone: "danger",
    title: preflight.code === WINDOWS_ERROR_CODES.helperMissing
      ? "The Windows helper is missing"
      : "Windows automation is not ready",
    detail: [preflight.detail, preflight.helperPath ? `Looked in ${preflight.helperPath}.` : null]
      .filter(Boolean)
      .join(" "),
    code: preflight.code,
    features: preflight.features ?? [],
  };
}

export function featureLabel(name) {
  switch (name) {
    case "shellAppCatalog": return "App catalog";
    case "uiAutomation": return "UI Automation";
    case "windowsGraphicsCapture": return "Window capture";
    case "mediaFoundationH264": return "H.264 encoding";
    case "sendInput": return "Keyboard and pointer";
    default: return name;
  }
}

/* --------------------------------------------------------------------------------------------
 * App catalog
 * ------------------------------------------------------------------------------------------ */

/**
 * Whether an entry shares its friendly name with another installed app. Ambiguity is shown, never
 * resolved: picking the first "Settings" is how automation drives the wrong build.
 */
export function isAmbiguousEntry(entry) {
  return (entry?.ambiguousWith?.length ?? 0) > 0;
}

/**
 * What distinguishes one catalog entry from another with the same name. Packaged apps are named by
 * their app identity, classic apps by the executable that would actually start.
 */
export function catalogEntryDetail(entry) {
  if (!entry) return "";
  const parts = [];
  if (entry.kind === "packaged") {
    parts.push(entry.appUserModelId || entry.packageFamilyName || "Packaged app");
  } else if (entry.executablePath) {
    parts.push(entry.executablePath);
  }
  if (entry.publisher) parts.push(entry.publisher);
  if (parts.length === 0) {
    const provenance = entry.provenance?.[0];
    if (provenance?.shortcutPath) parts.push(provenance.shortcutPath);
    else if (provenance?.source) parts.push(provenance.source);
  }
  return parts.join(" · ");
}

/**
 * Groups a catalog answer for display: entries whose friendly name is shared are kept together and
 * flagged, so the person choosing sees the collision instead of a list that looks unique.
 */
export function organizeCatalog(result) {
  const entries = result?.entries ?? [];
  const byName = new Map();
  for (const entry of entries) {
    const key = (entry.displayName ?? "").toLowerCase();
    byName.set(key, (byName.get(key) ?? 0) + 1);
  }
  return {
    entries: entries.map((entry) => ({
      entry,
      ambiguous: isAmbiguousEntry(entry) || (byName.get((entry.displayName ?? "").toLowerCase()) ?? 0) > 1,
      detail: catalogEntryDetail(entry),
    })),
    total: result?.totalMatches ?? entries.length,
    truncated: result?.truncated === true,
    incompleteSources: (result?.sources ?? []).filter((source) => source.supported === false),
  };
}

/** A one-line explanation when a catalog source could not answer, so "not installed" is never guessed. */
export function catalogSourceWarning(organized) {
  const sources = organized?.incompleteSources ?? [];
  if (sources.length === 0) return null;
  return `${sources.map((source) => source.name).join(", ")} could not be read, so this list may be `
    + "incomplete. Apps with no Shell, shortcut, or App Paths registration must be launched by path.";
}

/* --------------------------------------------------------------------------------------------
 * Open-window picker
 * ------------------------------------------------------------------------------------------ */

/** The attach view is the useful first step whether the panel has a session or not. */
export function defaultPickerSection() {
  return "running";
}

export function candidateTitle(candidate) {
  const title = String(candidate?.title ?? "").trim();
  return title || "Untitled window";
}

export function candidateIdentity(candidate) {
  const process = String(candidate?.processName ?? "").trim();
  if (process) return process;
  const app = String(candidate?.appUserModelId ?? "").trim();
  if (app) return app;
  const path = String(candidate?.processPath ?? "").trim();
  return path || "Windows app";
}

export function candidateSearchText(candidate) {
  return [
    candidateTitle(candidate),
    candidate?.processName,
    candidate?.appUserModelId,
    candidate?.processPath,
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

function candidateUnavailableReason(candidate) {
  if (candidate?.minimized) return "This window is minimized. Restore it before attaching.";
  if (candidate?.elevated) return "This elevated window cannot be attached from this panel.";
  return candidate?.unattachableDetail || "This window is unavailable to attach.";
}

/**
 * Filters by every useful identity, then keeps attachable windows first. The opaque candidate ID is
 * deliberately not part of search or ordering: it is transport identity, not a person-facing name.
 */
export function filterWindowCandidates(candidates, query = "") {
  const normalized = String(query).trim().toLocaleLowerCase();
  return [...(candidates ?? [])]
    .filter((candidate) => !normalized || candidateSearchText(candidate).includes(normalized))
    .sort((left, right) => {
      const leftAttachable = candidateAttachable(left) ? 0 : 1;
      const rightAttachable = candidateAttachable(right) ? 0 : 1;
      if (leftAttachable !== rightAttachable) return leftAttachable - rightAttachable;
      return candidateTitle(left).localeCompare(candidateTitle(right), undefined, { sensitivity: "base" })
        || candidateIdentity(left).localeCompare(candidateIdentity(right), undefined, { sensitivity: "base" });
    });
}

export function candidateAttachable(candidate) {
  // Minimized windows cannot produce a preview, but the host deliberately allows attaching them
  // so the resulting session can restore the authorized window.
  return candidate?.attachable === true && !candidate.elevated;
}

/**
 * Decides the media state before DOM creation. A thumbnail is only requested for an attachable,
 * visible candidate; known impossible captures are always represented by an explanatory placeholder.
 */
export function candidateThumbnailState(candidate, loadedState = "idle") {
  if (candidate?.minimized) return { state: "placeholder", icon: "window", label: "Minimized" };
  if (candidate?.elevated) return { state: "placeholder", icon: "shield", label: "Elevated" };
  if (!candidateAttachable(candidate)) {
    return { state: "placeholder", icon: "alert", label: candidate?.unattachableCode || "Unavailable" };
  }
  if (loadedState === "ready") return { state: "ready", icon: "camera", label: "Window preview" };
  if (loadedState === "error") return { state: "placeholder", icon: "alert", label: "Preview unavailable" };
  return { state: "loading", icon: "camera", label: "Loading preview" };
}

/** Safe, fixed API route for a candidate thumbnail; the only dynamic segment is URL encoded. */
export function windowThumbnailUrl(candidateId, maximumDimension = 240) {
  const dimension = Math.max(96, Math.min(640, Math.round(Number(maximumDimension) || 240)));
  return `/api/v1/windows/windows/${encodeURIComponent(String(candidateId ?? ""))}`
    + `/thumbnail?maximumDimension=${dimension}`;
}

/** A generation token lets asynchronous image work prove it still belongs to the visible picker. */
export function nextThumbnailGeneration(generation = 0) {
  return Number.isSafeInteger(generation) && generation >= 0 ? generation + 1 : 1;
}

export function isCurrentThumbnailGeneration(activeGeneration, requestGeneration) {
  return activeGeneration === requestGeneration;
}

/**
 * All copy and states for one card. Renderer code consumes this data with textContent, never HTML.
 */
export function candidateCardPresentation(candidate, thumbnailState = "idle") {
  const attachable = candidateAttachable(candidate);
  const badges = [];
  if (candidate?.attached) badges.push({ tone: "accent", label: "Attached" });
  if (candidate?.minimized) badges.push({ tone: "warning", label: "Minimized" });
  if (candidate?.elevated) badges.push({ tone: "warning", label: "Elevated" });
  if (!attachable && !candidate?.minimized && !candidate?.elevated) {
    badges.push({ tone: "danger", label: candidate?.unattachableCode || "Unavailable" });
  }
  const status = attachable
    ? candidate?.minimized
      ? "Attach to this minimized window, then restore it"
      : "Attach to this window"
    : candidateUnavailableReason(candidate);
  return {
    id: candidate?.id ?? "",
    title: candidateTitle(candidate),
    identity: candidateIdentity(candidate),
    attachable,
    attached: candidate?.attached === true,
    badges,
    status,
    thumbnail: candidateThumbnailState(candidate, thumbnailState),
  };
}

/* --------------------------------------------------------------------------------------------
 * App session and window tabs
 * ------------------------------------------------------------------------------------------ */

export function sessionOriginLabel(origin) {
  return ORIGIN_LABELS[origin] ?? "Attached app";
}

export function correlationLabel(correlation) {
  return CORRELATION_LABELS[correlation] ?? "Correlated window";
}

/**
 * How a window's tab reads. `capture` is what the stage can actually do with it, which is not the
 * same question as whether the panel is allowed to drive it: an elevated window may be visible and
 * still refuse input.
 */
export function windowTabState(window) {
  if (!window) return "unknown";
  if (window.minimized) return "minimized";
  if (window.elevated) return "elevated";
  if (window.cloaked) return "hidden";
  return "live";
}

export function windowTabLabel(window) {
  const title = (window?.title ?? "").trim();
  return title.length > 0 ? title : "Untitled window";
}

export function windowTabStatusLabel(window) {
  switch (windowTabState(window)) {
    case "minimized": return "Minimized";
    case "elevated": return "Elevated";
    case "hidden": return "Not on screen";
    default: return "Live";
  }
}

export function canCaptureWindow(window) {
  return Boolean(window) && !window.minimized && !window.cloaked;
}

/**
 * Turns a session into the tab strip.
 *
 * The order the host reports is preserved so a new dialog appears beside the window that owns it,
 * and nothing is merged: two windows of the same app with the same title stay two tabs, because
 * conflating them would send input to whichever one happened to sort first.
 */
export function buildWindowTabs(session) {
  const windows = session?.windows ?? [];
  const selectedId = session?.selectedWindowId
    ?? windows.find((window) => window.selected)?.id
    ?? null;
  return windows.map((window) => ({
    id: window.id,
    label: windowTabLabel(window),
    state: windowTabState(window),
    status: windowTabStatusLabel(window),
    correlation: correlationLabel(window.correlation),
    selected: window.id === selectedId,
    minimized: window.minimized === true,
    elevated: window.elevated === true,
    capturable: canCaptureWindow(window),
    window,
  }));
}

/**
 * What changed between two views of a session's windows.
 *
 * The host adds a window only once it has positively correlated it, so following the additions is
 * safe. Identity is the opaque window ID and nothing else: a retitled window is the same tab, and a
 * new window that happens to share a title is a new tab.
 */
export function diffWindowTabs(previous, next) {
  const before = new Map((previous ?? []).map((tab) => [tab.id, tab]));
  const after = new Map((next ?? []).map((tab) => [tab.id, tab]));
  const added = (next ?? []).filter((tab) => !before.has(tab.id));
  const removed = (previous ?? []).filter((tab) => !after.has(tab.id));
  const renamed = (next ?? []).filter((tab) => {
    const original = before.get(tab.id);
    return original !== undefined && original.label !== tab.label;
  });
  const restated = (next ?? []).filter((tab) => {
    const original = before.get(tab.id);
    return original !== undefined && original.state !== tab.state;
  });
  return { added, removed, renamed, restated };
}

/**
 * Which window the stage should be showing.
 *
 * The host's selection wins, because it is what an agent's calls resolve against. Only when the
 * selected window disappears does the renderer fall back, and then to the first tab that can
 * actually be captured rather than to a minimized one that would show nothing.
 */
export function resolveSelectedTab(tabs, requestedId) {
  const list = tabs ?? [];
  if (list.length === 0) return null;
  const requested = list.find((tab) => tab.id === requestedId);
  if (requested) return requested;
  return list.find((tab) => tab.selected)
    ?? list.find((tab) => tab.capturable)
    ?? list[0];
}

/* --------------------------------------------------------------------------------------------
 * Live stage geometry and coordinates
 * ------------------------------------------------------------------------------------------ */

/**
 * The largest rectangle with the source's aspect ratio that fits in a box.
 *
 * A window is any shape, so the stage letterboxes rather than stretching: a click has to land where
 * the picture says it will, and a distorted picture makes every coordinate a lie.
 */
export function letterboxRect(sourceWidth, sourceHeight, boxWidth, boxHeight) {
  const width = Math.max(1, Number(sourceWidth) || 1);
  const height = Math.max(1, Number(sourceHeight) || 1);
  const availableWidth = Math.max(0, Number(boxWidth) || 0);
  const availableHeight = Math.max(0, Number(boxHeight) || 0);
  if (availableWidth === 0 || availableHeight === 0) {
    return { width: 0, height: 0, left: 0, top: 0, scale: 0 };
  }
  const scale = Math.min(availableWidth / width, availableHeight / height);
  const rendered = { width: width * scale, height: height * scale };
  return {
    width: rendered.width,
    height: rendered.height,
    left: (availableWidth - rendered.width) / 2,
    top: (availableHeight - rendered.height) / 2,
    scale,
  };
}

/**
 * Turns a CSS pointer position into a point in the delivered capture image.
 *
 * This is the only place browser pixels are allowed to become coordinates, and they never become
 * API coordinates directly: the result is expressed in the capture image's own pixels and is always
 * sent together with that image's size and transform token, so the host converts rather than
 * assuming the browser and the window agree about anything.
 */
export function captureFromClientPoint({ clientX, clientY, rect, geometry }) {
  const width = Math.max(1, geometry?.captureWidth || geometry?.contentWidth || 1);
  const height = Math.max(1, geometry?.captureHeight || geometry?.contentHeight || 1);
  const boxWidth = rect?.width ?? 0;
  const boxHeight = rect?.height ?? 0;
  if (boxWidth <= 0 || boxHeight <= 0) {
    return { x: 0, y: 0, inside: false, captureWidth: width, captureHeight: height };
  }
  const rawX = ((clientX - (rect.left ?? 0)) / boxWidth) * width;
  const rawY = ((clientY - (rect.top ?? 0)) / boxHeight) * height;
  const inside = rawX >= 0 && rawY >= 0 && rawX <= width && rawY <= height;
  return {
    // Half a pixel in from the far edge: a click at exactly the width is outside the image.
    x: clamp(rawX, 0, width - 0.5),
    y: clamp(rawY, 0, height - 0.5),
    inside,
    captureWidth: width,
    captureHeight: height,
  };
}

/**
 * The transform-bearing fields every coordinate request carries. Sending the capture size beside the
 * token is what lets the host scale a half-size stream's coordinates instead of the browser guessing.
 */
export function inputFrame(geometry) {
  if (!geometry?.transformVersion) return null;
  return {
    transformVersion: geometry.transformVersion,
    captureWidth: geometry.captureWidth || geometry.contentWidth || 0,
    captureHeight: geometry.captureHeight || geometry.contentHeight || 0,
  };
}

/** A wheel event's notches. Browsers report pixels, lines, or pages; Windows counts notches. */
export function wheelNotches(delta, deltaMode) {
  const value = Number(delta) || 0;
  if (deltaMode === 1) return value / 3;
  if (deltaMode === 2) return value * 3;
  return value / 100;
}

export function captureSourceLabel(source) {
  return CAPTURE_SOURCE_LABELS[source] ?? source ?? "unknown";
}

export function isDegradedCaptureSource(source) {
  return source !== "windowsGraphicsCapture";
}

/* --------------------------------------------------------------------------------------------
 * Stream lifecycle
 * ------------------------------------------------------------------------------------------ */

/**
 * A stream always ends for a stated reason, and the reason decides what happens next. A resize or
 * DPI change means reconnect immediately for a fresh descriptor and keyframe; feeding differently
 * shaped frames to the existing decoder would only produce a corrupt picture.
 */
export function describeStreamEnd(end) {
  const reason = end?.reason ?? STREAM_END_REASONS.clientClosed;
  switch (reason) {
    case STREAM_END_REASONS.contentSizeChanged:
      return { reconnect: true, kind: "resizing", message: "The window changed size." };
    case STREAM_END_REASONS.dpiChanged:
      return { reconnect: true, kind: "resizing", message: "The window moved to a different display scale." };
    case STREAM_END_REASONS.minimized:
      return { reconnect: false, kind: "minimized", message: "The window is minimized." };
    case STREAM_END_REASONS.windowClosed:
      return { reconnect: false, kind: "closed", message: "The window closed." };
    case STREAM_END_REASONS.captureFailed:
      return {
        reconnect: false,
        kind: "capture-failed",
        message: end?.detail || "Capture stopped unexpectedly.",
      };
    case STREAM_END_REASONS.encoderFailed:
      return {
        reconnect: false,
        kind: "encoder-failed",
        message: end?.detail || "The video encoder stopped.",
      };
    case STREAM_END_REASONS.hostStopping:
      return { reconnect: false, kind: "disconnected", message: "The local host is shutting down." };
    default:
      return { reconnect: end?.reconnect === true, kind: "closed", message: end?.detail ?? "" };
  }
}

/** Whether a stream end is the host asking for a clean restart rather than reporting a failure. */
export function shouldReconnectStream(end) {
  return describeStreamEnd(end).reconnect || end?.reconnect === true;
}

/**
 * What the stage shows when it is not showing a picture. Every state names a cause and, where the
 * user can do something about it, the one action that fixes it.
 */
export function stageStatusPresentation(kind, { appName, windowName, detail } = {}) {
  const subject = (windowName || appName || "the window").trim();
  switch (kind) {
    case "no-session":
      return {
        tone: "accent",
        eyebrow: "No app attached",
        title: "Choose a Windows app",
        detail: detail
          || "Launch an installed app, start one by path, or attach to a window that is already open.",
        action: { id: "choose-app", label: "Choose an app" },
      };
    case "pending":
      return {
        tone: "warning",
        eyebrow: "Waiting for a window",
        title: `${subject} started but has not shown a window yet`,
        detail: detail
          || "Nothing is controlled until a window can be positively matched to this app. Attach one explicitly if it never appears.",
        action: { id: "attach", label: "Attach a window" },
        busy: true,
      };
    case "connecting":
      return {
        tone: "accent",
        eyebrow: "Live view",
        title: `Connecting to ${subject}`,
        detail: detail || "Starting a local capture of this window.",
        busy: true,
      };
    case "resizing":
      return {
        tone: "accent",
        eyebrow: "Live view",
        title: "Reconnecting after a size change",
        detail: detail || "A new keyframe is on the way.",
        busy: true,
      };
    case "minimized":
      return {
        tone: "warning",
        eyebrow: "Paused",
        title: `${subject} is minimized`,
        detail: detail || "A minimized window has no visible content to capture and no place to click.",
        action: { id: "restore", label: "Restore window" },
      };
    case "elevated":
      return {
        tone: "warning",
        eyebrow: "Unsupported",
        title: `${subject} runs elevated`,
        detail: detail
          || "Windows blocks input from a lower-integrity process. Capture may still work; control does not.",
      };
    case "protected":
      return {
        tone: "warning",
        eyebrow: "Protected content",
        title: `${subject} excludes itself from capture`,
        detail: detail
          || "The app sets display affinity to keep its content out of screen captures. Use the UI Automation tree instead.",
        action: { id: "inspect", label: "Open inspector" },
      };
    case "closed":
      return {
        tone: "neutral",
        eyebrow: "Window closed",
        title: `${subject} is gone`,
        detail: detail || "Pick another window, or release this app session.",
        action: { id: "refresh", label: "Refresh windows" },
      };
    case "capture-failed":
    case "encoder-failed":
      return {
        tone: "danger",
        eyebrow: "Capture stopped",
        title: "Couldn't keep the live view running",
        detail: detail || "Retry the stream, or fall back to screenshots.",
        action: { id: "retry-stream", label: "Try again" },
      };
    case "disconnected":
      return {
        tone: "warning",
        eyebrow: "Connection interrupted",
        title: "Live view disconnected",
        detail: detail || "The app is probably still running. Reconnect to resume.",
        action: { id: "retry-stream", label: "Reconnect" },
      };
    case "error":
    default:
      return {
        tone: "danger",
        eyebrow: "Something went wrong",
        title: "Couldn't show this window",
        detail: detail || "An unexpected error interrupted the connection.",
        action: { id: "retry-stream", label: "Try again" },
      };
  }
}

/* --------------------------------------------------------------------------------------------
 * Errors
 * ------------------------------------------------------------------------------------------ */

/**
 * A stale transform means the window moved, resized, changed DPI, or minimized between the picture
 * the coordinates were read off and the request. The answer is always to re-measure, and never to
 * resend the same coordinates: they now point somewhere else on the desktop.
 */
export function isStaleTransformError(error) {
  return error?.code === WINDOWS_ERROR_CODES.transformStale
    || error?.code === WINDOWS_ERROR_CODES.identityChanged;
}

export function requiresWindowRefresh(error) {
  return isStaleTransformError(error)
    || error?.code === WINDOWS_ERROR_CODES.windowNotFound
    || error?.code === WINDOWS_ERROR_CODES.minimized
    || error?.code === WINDOWS_ERROR_CODES.outOfBounds;
}

export function requiresSessionRefresh(error) {
  return error?.code === WINDOWS_ERROR_CODES.sessionNotFound
    || error?.code === WINDOWS_ERROR_CODES.notAuthorized;
}

/** Short, human wording for the failures a person acting in the panel will actually hit. */
export function inputErrorMessage(error) {
  switch (error?.code) {
    case WINDOWS_ERROR_CODES.transformStale:
      return "The window moved. Re-measuring before the next action.";
    case WINDOWS_ERROR_CODES.identityChanged:
      return "This window is no longer the one that was authorized.";
    case WINDOWS_ERROR_CODES.outOfBounds:
      return "That point is outside the window.";
    case WINDOWS_ERROR_CODES.foregroundRefused:
      return "Windows refused to bring the window forward, so nothing was sent.";
    case WINDOWS_ERROR_CODES.minimized:
      return "The window is minimized. Restore it first.";
    case WINDOWS_ERROR_CODES.elevated:
      return "This window runs elevated and cannot be driven from here.";
    case WINDOWS_ERROR_CODES.rateLimited:
      return "Too many input requests at once. Slowing down.";
    default:
      return error?.message || "The action failed.";
  }
}

/* --------------------------------------------------------------------------------------------
 * UI Automation
 * ------------------------------------------------------------------------------------------ */

/** Which semantic actions an element currently offers, in a stable presentation order. */
export function availableUiActions(element) {
  const supported = element?.supportedActions ?? {};
  return [
    { id: "invoke", label: "Invoke", available: supported.invoke === true },
    { id: "focus", label: "Focus", available: supported.focus === true },
    { id: "toggle", label: "Toggle", available: supported.toggle === true },
    { id: "select", label: "Select", available: supported.select === true },
    { id: "expand", label: "Expand", available: supported.expand === true },
    { id: "collapse", label: "Collapse", available: supported.collapse === true },
    { id: "scroll", label: "Scroll", available: supported.scroll === true },
    {
      id: "setValue",
      label: "Set value",
      available: supported.setValue === true && element?.properties?.password !== true,
    },
  ].filter((action) => action.available);
}

/** A password control is never read and never written through this panel. */
export function isPasswordElement(element) {
  return element?.properties?.password === true;
}

export function uiElementLabel(element) {
  if (!element) return "";
  if (isPasswordElement(element)) return "Password field";
  const properties = element.properties ?? {};
  return properties.name || properties.automationId || properties.className || element.role || "Element";
}

export function uiElementValue(element) {
  if (!element || isPasswordElement(element)) return null;
  return element.properties?.value ?? null;
}

/**
 * How a bounded traversal ended. Truncation and timeouts are reported rather than hidden, because a
 * partial tree that looks complete is how an agent concludes a control does not exist.
 */
export function snapshotWarnings(metadata) {
  const warnings = [];
  if (metadata?.truncated) {
    warnings.push(
      `Tree truncated at ${metadata.nodeCount ?? metadata.maximumNodes} nodes. Raise the node limit or search instead of dumping.`,
    );
  }
  if (metadata?.timedOut) {
    warnings.push("The provider ran out of time. Some branches are missing.");
  }
  if (metadata?.detail) warnings.push(metadata.detail);
  return warnings;
}

/**
 * A find result's disposition. Multiple matches are an ambiguity to resolve, never a list to act on
 * blindly, so the panel says so instead of acting on the first one.
 */
export function findResultPresentation(result) {
  const matches = result?.matches ?? [];
  const total = result?.totalMatches ?? matches.length;
  if (total === 0) {
    return {
      tone: "warning",
      message: "No element matched. Loosen the selector or dump the tree to see what is there.",
      ambiguous: false,
      matches,
    };
  }
  if (total > 1) {
    return {
      tone: "warning",
      message: `${total} elements match. Add an automation ID, name, or explicit index before acting.`,
      ambiguous: true,
      matches,
    };
  }
  return { tone: "ok", message: "One match.", ambiguous: false, matches };
}

/* --------------------------------------------------------------------------------------------
 * Agent activity
 * ------------------------------------------------------------------------------------------ */

/**
 * Whether an activity event belongs to this panel and this window.
 *
 * The host already addresses events to one canvas context on one surface; this is the client's own
 * gate. A Windows panel additionally refuses an event for a window it is not showing, because the
 * cursor would otherwise be drawn over an unrelated picture.
 */
export function isActivityForWindow(activity, { sessionId, instanceId, windowId }) {
  if (!activity || typeof activity !== "object") return false;
  if (activity.surface !== WINDOWS_SURFACE) return false;
  if (!activity.sessionId || !activity.instanceId) return false;
  if (activity.sessionId !== sessionId || activity.instanceId !== instanceId) return false;
  return Boolean(windowId) && activity.deviceId === windowId;
}

/**
 * The label an activity indicator shows.
 *
 * Typed text is never displayed. The host already refuses to publish it for this surface, and this
 * is the second place that promise is kept: a Windows canvas types into the user's real session,
 * where the same field could hold a password.
 */
export function activityLabel(activity) {
  switch (activity?.kind) {
    case "text":
      return `Typed ${activity.characterCount ?? 0} character${activity.characterCount === 1 ? "" : "s"}`;
    case "key":
      return activity.detail ? `Key ${activity.detail}` : "Key";
    case "pointer":
      return "Pointer";
    case "drag":
      return "Drag";
    case "wheel":
      return "Scroll";
    case "screenshot":
      return "Screenshot";
    case "semantic":
      return activity.detail || "UI action";
    case "tap":
      return activity.detail || "Click";
    default:
      return "Agent activity";
  }
}

function clamp(value, minimum, maximum) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(value, minimum), maximum);
}
