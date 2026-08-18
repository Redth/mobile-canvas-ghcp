import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sep } from "node:path";
import { promisify } from "node:util";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { resolveCommand } from "./lib/runtime.mjs";

const execFileAsync = promisify(execFile);
const extensionPath = process.env.EXTENSION_PATH || fileURLToPath(import.meta.url);
const isPluginInstall = extensionPath.includes(`${sep}installed-plugins${sep}`);

// The Windows App canvas is its own surface with its own IDs. They must stay unique across the
// bundle so they never collide with the sibling canvas this plugin also ships.
const canvasId = isPluginInstall ? "windows-app" : "windows-app-local";
const canvasName = isPluginInstall ? "Windows App" : "Windows App (Local)";

// Windows desktop automation only means something on Windows: there is no window server, no UI
// Automation provider, and no desktop window to capture on macOS or Linux. The plugin still ships a
// single bundle for every platform, so on a non-Windows host the extension joins the session
// cleanly but registers no canvas at all rather than advertising a surface it could never drive.
const supported = process.platform === "win32";

// Resolved lazily and then cached: extracting the bundled binary should happen
// on first use rather than at import time, so a resolution failure surfaces as
// a readable action error instead of preventing the extension from loading.
let resolved = null;
async function command() {
  if (!resolved) resolved = resolveCommand();
  const current = resolved;
  try {
    return (await current).command;
  } catch (error) {
    if (resolved === current) resolved = null;
    throw error;
  }
}

async function runCli(args) {
  try {
    const { stdout } = await execFileAsync(await command(), [...args, "--json"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const message = String(error.stderr || error.message || error).trim();
    throw new Error(`Windows App: ${message}`);
  }
}

function contextArgs(ctx) {
  return ["--session", ctx.sessionId, "--instance", ctx.instanceId];
}

// A repeatable option, appended once per supplied value. Empty or missing lists add nothing, so a
// caller that omits arguments or modifiers never sends a bare `--arg`/`--modifier`.
function repeated(flag, values) {
  return Array.isArray(values) ? values.flatMap((value) => [flag, String(value)]) : [];
}

// A single value option, appended only when the caller supplied it. Numbers are stringified so an
// absent option is skipped rather than serialized as `--flag undefined`.
function optional(flag, value) {
  return value === undefined || value === null ? [] : [flag, String(value)];
}

// A boolean flag, appended only when explicitly true. A false or missing value adds nothing.
function toggle(flag, value) {
  return value === true ? [flag] : [];
}

// The window-relative capture selector shared by the three UI Automation verbs. `exact` defaults to
// true; passing exact:false sends `--contains`, which the backend reads as a non-exact match.
function selectorArgs(input) {
  return [
    ...optional("--automation-id", input.automationId),
    ...optional("--control-type", input.controlType),
    ...optional("--role", input.role),
    ...optional("--name", input.name),
    ...optional("--match-value", input.matchValue),
    ...toggle("--contains", input.exact === false),
    ...optional("--index", input.index),
    ...(Array.isArray(input.path) && input.path.length > 0
      ? ["--path", input.path.join(",")]
      : []),
  ];
}

const selectorProperties = {
  automationId: {
    type: "string",
    description:
      "Automation ID. Pair it with controlType as the preferred, most stable selector.",
  },
  controlType: {
    type: "string",
    description: "Normalized control type, for example button, edit, checkbox, or listItem.",
  },
  role: {
    type: "string",
    description: "Normalized semantic role, for example button, field, checkbox, or dialog.",
  },
  name: { type: "string", description: "Accessible name constraint." },
  matchValue: {
    type: "string",
    description: "Non-secret current value constraint. Password control values are never returned.",
  },
  exact: {
    type: "boolean",
    description: "Require exact name/value matching. Set false to match substrings.",
    default: true,
  },
  index: {
    type: "integer",
    minimum: 0,
    description:
      "Explicit zero-based ordinal among otherwise matching elements. Use only to disambiguate a known stable structure; it is never an implicit first match.",
  },
  path: {
    type: "array",
    items: { type: "integer", minimum: 0 },
    description:
      "Last-resort explicit zero-based child indexes from the window root toward the target.",
  },
};

const inputModeProperty = {
  type: "string",
  enum: ["background", "foreground"],
  default: "background",
  description:
    "background preserves the active window and real cursor by using semantic UI Automation where possible; foreground explicitly allows global keyboard and pointer input.",
};

const canvas = createCanvas({
  id: canvasId,
  displayName: canvasName,
  description:
    "Launch, attach to, inspect, and control local Windows desktop apps in a live canvas, with UI Automation and screenshot-guided input.",
  inputSchema: {
    type: "object",
    properties: {
      entryId: {
        type: "string",
        description:
          "Optional catalog entry ID from search_windows_apps to launch after opening.",
      },
      executablePath: {
        type: "string",
        description:
          "Optional absolute path to an executable to launch after opening. A shell command string is never accepted.",
      },
      arguments: {
        type: "array",
        items: { type: "string" },
        description: "Optional arguments passed to executablePath, one array element per argument.",
      },
      workingDirectory: {
        type: "string",
        description: "Optional working directory for executablePath.",
      },
      candidateId: {
        type: "string",
        description:
          "Optional opaque window candidate ID from list_running_windows to attach to after opening.",
      },
      windowId: {
        type: "string",
        description:
          "Optional opaque authorized window ID to select after opening. Never a raw window handle.",
      },
    },
  },
  actions: [
    {
      name: "get_windows_capabilities",
      description:
        "Report whether the Windows App host is ready: helper version, code-signature status, and which capture and automation features this machine offers. Call it first to learn what the host can do before launching or attaching.",
      inputSchema: { type: "object", properties: {} },
      handler: () => runCli(["windows", "capabilities"]),
    },
    {
      name: "search_windows_apps",
      description:
        "Search installed Windows apps by name, returning opaque catalog entry IDs for launch_windows_app. Ambiguous friendly names are reported rather than silently resolved, so automation does not launch the wrong build of an app.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Substring matched against display name, AUMID, package family, and executable.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            description: "Maximum entries to return. Defaults to 100.",
          },
          ambiguousOnly: {
            type: "boolean",
            description: "Return only entries whose friendly name is shared with another entry.",
          },
        },
      },
      handler: (ctx) =>
        runCli([
          "windows",
          "apps",
          ...optional("--text", ctx.input.text),
          ...optional("--limit", ctx.input.limit),
          ...toggle("--ambiguous", ctx.input.ambiguousOnly),
        ]),
    },
    {
      name: "list_running_windows",
      description:
        "List candidate top-level windows currently open on the desktop with opaque candidate IDs, titles, and process names. Use a candidate ID with attach_windows_window; the IDs are never raw window handles.",
      inputSchema: { type: "object", properties: {} },
      handler: (ctx) => runCli(["windows", "list", ...contextArgs(ctx)]),
    },
    {
      name: "launch_windows_app",
      description:
        "Launch an installed app by its catalog entry ID from search_windows_apps and wait for its window to appear. Returns the authorized session with opaque window IDs.",
      inputSchema: {
        type: "object",
        properties: {
          entryId: {
            type: "string",
            description: "Opaque catalog entry ID returned by search_windows_apps.",
          },
          timeoutSeconds: {
            type: "number",
            minimum: 0,
            description: "How long to wait for the launched window to correlate, in seconds. Defaults to 10.",
          },
        },
        required: ["entryId"],
      },
      handler: (ctx) =>
        runCli([
          "windows",
          "launch",
          "--app",
          ctx.input.entryId,
          ...optional("--timeout", ctx.input.timeoutSeconds),
          ...contextArgs(ctx),
        ]),
    },
    {
      name: "launch_windows_executable",
      description:
        "Launch an app from an absolute executable path and wait for its window. Arguments are passed as a discrete list and a shell command string is never accepted, so nothing is interpreted by a shell.",
      inputSchema: {
        type: "object",
        properties: {
          executablePath: {
            type: "string",
            description: "Absolute path to the executable to launch.",
          },
          arguments: {
            type: "array",
            items: { type: "string" },
            description: "Arguments passed to the executable, one array element per argument.",
          },
          workingDirectory: {
            type: "string",
            description: "Optional working directory for the launched process.",
          },
          timeoutSeconds: {
            type: "number",
            minimum: 0,
            description: "How long to wait for the launched window to correlate, in seconds. Defaults to 10.",
          },
        },
        required: ["executablePath"],
      },
      handler: (ctx) =>
        runCli([
          "windows",
          "launch-exe",
          "--path",
          ctx.input.executablePath,
          ...repeated("--arg", ctx.input.arguments),
          ...optional("--working-directory", ctx.input.workingDirectory),
          ...optional("--timeout", ctx.input.timeoutSeconds),
          ...contextArgs(ctx),
        ]),
    },
    {
      name: "attach_windows_window",
      description:
        "Attach to an already-running window by its opaque candidate ID from list_running_windows, granting this canvas authority to inspect and control it. The candidate ID is never a raw window handle.",
      inputSchema: {
        type: "object",
        properties: {
          candidateId: {
            type: "string",
            description: "Opaque window candidate ID returned by list_running_windows.",
          },
        },
        required: ["candidateId"],
      },
      handler: (ctx) =>
        runCli([
          "windows",
          "attach",
          "--window",
          ctx.input.candidateId,
          ...contextArgs(ctx),
        ]),
    },
    {
      name: "get_windows_app_session",
      description:
        "Get the current Windows App session for this canvas: the attached app, its authorized windows, the selected window, and any pending authorization state.",
      inputSchema: { type: "object", properties: {} },
      handler: (ctx) => runCli(["windows", "session", ...contextArgs(ctx)]),
    },
    {
      name: "list_windows_app_windows",
      description:
        "List the windows this canvas is authorized to control, with opaque window IDs, titles, and which one is selected. The IDs are never raw window handles.",
      inputSchema: { type: "object", properties: {} },
      handler: (ctx) => runCli(["windows", "windows", ...contextArgs(ctx)]),
    },
    {
      name: "select_windows_app_window",
      description:
        "Select which authorized window this canvas acts on by its opaque window ID. Subsequent captures and input target the selected window.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: {
            type: "string",
            description: "Opaque authorized window ID from the session. Never a raw window handle.",
          },
        },
        required: ["windowId"],
      },
      handler: (ctx) =>
        runCli(["windows", "select", "--window", ctx.input.windowId, ...contextArgs(ctx)]),
    },
    {
      name: "reveal_windows_app_window",
      description:
        "Bring an authorized window to the foreground on the desktop so it can be seen and captured. Defaults to the selected window when no window ID is given.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: {
            type: "string",
            description: "Optional opaque authorized window ID. Defaults to the selected window.",
          },
        },
      },
      handler: (ctx) =>
        runCli([
          "windows",
          "reveal",
          ...optional("--window", ctx.input.windowId),
          ...contextArgs(ctx),
        ]),
    },
    {
      name: "restore_windows_app_window",
      description:
        "Restore a minimized authorized window so it has a coordinate space to capture and click again. Defaults to the selected window when no window ID is given.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: {
            type: "string",
            description: "Optional opaque authorized window ID. Defaults to the selected window.",
          },
        },
      },
      handler: (ctx) =>
        runCli([
          "windows",
          "restore",
          ...optional("--window", ctx.input.windowId),
          ...contextArgs(ctx),
        ]),
    },
    {
      name: "release_windows_app_session",
      description:
        "Release this canvas's Windows App session, dropping the authority grant over its windows. Launched apps keep running; only this canvas's control over them ends.",
      inputSchema: { type: "object", properties: {} },
      handler: (ctx) => runCli(["windows", "release", ...contextArgs(ctx)]),
    },
    {
      name: "dump_windows_ui_tree",
      description:
        "Read a bounded, current UI Automation tree for an authorized window. Prefer this and the semantic find/act tools over coordinate input. Password values and text-pattern content are never returned.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: {
            type: "string",
            description: "Opaque authorized window ID. Never a raw window handle.",
          },
          maximumDepth: {
            type: "integer",
            minimum: 1,
            maximum: 32,
            description: "Maximum tree depth. Defaults to 12.",
          },
          maximumNodes: {
            type: "integer",
            minimum: 1,
            maximum: 5000,
            description: "Maximum nodes to traverse. Defaults to 500.",
          },
          timeoutMilliseconds: {
            type: "integer",
            minimum: 1,
            maximum: 30000,
            description: "Bounded helper timeout in milliseconds. Defaults to 5000.",
          },
        },
        required: ["windowId"],
      },
      handler: (ctx) =>
        runCli([
          "windows",
          "ui-dump",
          "--window",
          ctx.input.windowId,
          ...optional("--depth", ctx.input.maximumDepth),
          ...optional("--nodes", ctx.input.maximumNodes),
          ...optional("--timeout", ctx.input.timeoutMilliseconds),
          ...contextArgs(ctx),
        ]),
    },
    {
      name: "find_windows_ui_elements",
      description:
        "Find current semantic UI Automation matches in an authorized window. Prefer automationId plus controlType, then controlType plus name/value, then an explicit path or index. Multiple matches are reported, never silently narrowed. Prefer this over coordinate input.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: {
            type: "string",
            description: "Opaque authorized window ID. Never a raw window handle.",
          },
          ...selectorProperties,
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "Maximum matches to return. Defaults to 50.",
          },
        },
        required: ["windowId"],
      },
      handler: (ctx) =>
        runCli([
          "windows",
          "ui-find",
          "--window",
          ctx.input.windowId,
          ...selectorArgs(ctx.input),
          ...optional("--limit", ctx.input.limit),
          ...contextArgs(ctx),
        ]),
    },
    {
      name: "act_on_windows_ui_element",
      description:
        "Re-resolve exactly one semantic UI Automation element and invoke, setValue, select, toggle, expand, collapse, scroll, or focus it. Prefer this over coordinate input: it acts on a real control rather than a place. Zero or multiple matches are errors; setValue refuses password controls and its value is never echoed back.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: {
            type: "string",
            description: "Opaque authorized window ID. Never a raw window handle.",
          },
          action: {
            type: "string",
            enum: ["invoke", "setValue", "select", "toggle", "expand", "collapse", "scroll", "focus"],
            description: "Semantic UI Automation action to perform on the resolved element.",
          },
          ...selectorProperties,
          value: {
            type: "string",
            description:
              "Text for the setValue action only. It is never reflected into results or panel activity.",
          },
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right"],
            description: "Scroll direction for the scroll action only.",
          },
          amount: {
            type: "string",
            enum: ["small", "large"],
            description: "Scroll amount for the scroll action only.",
          },
        },
        required: ["windowId", "action"],
      },
      handler: (ctx) =>
        runCli([
          "windows",
          "ui-act",
          "--window",
          ctx.input.windowId,
          "--action",
          ctx.input.action,
          ...selectorArgs(ctx.input),
          ...optional("--value", ctx.input.value),
          ...optional("--direction", ctx.input.direction),
          ...optional("--amount", ctx.input.amount),
          ...contextArgs(ctx),
        ]),
    },
    {
      name: "wait_for_windows_ui",
      description:
        "Wait with bounded polling for a semantic UI Automation element to exist or not exist, or for one element's non-secret property or state to equal an expected value. The selector is re-enumerated each poll; password values are never observable. Prefer this over sleeping between coordinate actions.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: {
            type: "string",
            description: "Opaque authorized window ID. Never a raw window handle.",
          },
          condition: {
            type: "string",
            enum: ["exists", "notExists", "property", "state"],
            description: "The condition to wait for.",
          },
          ...selectorProperties,
          property: {
            type: "string",
            description:
              "For the property condition: one of name, enabled, offscreen, focusable, focused, or value.",
          },
          expectedValue: {
            type: "string",
            description: "Expected non-secret property or state value.",
          },
          timeoutMilliseconds: {
            type: "integer",
            minimum: 1,
            maximum: 30000,
            description: "Maximum wait duration in milliseconds. Defaults to 5000.",
          },
          pollIntervalMilliseconds: {
            type: "integer",
            minimum: 50,
            description: "Polling interval in milliseconds, at least 50. Defaults to 200.",
          },
        },
        required: ["windowId", "condition"],
      },
      handler: (ctx) =>
        runCli([
          "windows",
          "ui-wait",
          "--window",
          ctx.input.windowId,
          "--condition",
          ctx.input.condition,
          ...selectorArgs(ctx.input),
          ...optional("--property", ctx.input.property),
          ...optional("--expected", ctx.input.expectedValue),
          ...optional("--timeout", ctx.input.timeoutMilliseconds),
          ...optional("--poll", ctx.input.pollIntervalMilliseconds),
          ...contextArgs(ctx),
        ]),
    },
    {
      name: "capture_windows_screenshot",
      description:
        "Capture a PNG of an authorized window and save it to a durable artifact path. Prefer the semantic UI Automation tools for finding and acting on controls; use this when a window has no useful UI Automation tree. Coordinates read off the image are window-relative physical capture pixels, and the returned transformVersion must be passed to any later click, drag, scroll, key, or type call.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: {
            type: "string",
            description: "Opaque authorized window ID. Never a raw window handle.",
          },
          scale: {
            type: "number",
            minimum: 0.1,
            maximum: 1,
            description:
              "Delivered pixels per content pixel, from 0.1 through 1. Leave at 1 so image coordinates are already the canonical space.",
          },
          maxDimension: {
            type: "integer",
            minimum: 0,
            description: "Optional clamp on the longest delivered edge, in pixels. 0 applies no extra clamp.",
          },
          includeCursor: {
            type: "boolean",
            description: "Draw the mouse cursor into the image when this machine allows the choice.",
          },
          output: {
            type: "string",
            description: "Optional absolute output path. Omit to use the artifacts directory.",
          },
        },
        required: ["windowId"],
      },
      handler: (ctx) =>
        runCli([
          "windows",
          "screenshot",
          "--window",
          ctx.input.windowId,
          ...optional("--scale", ctx.input.scale),
          ...optional("--max-dimension", ctx.input.maxDimension),
          ...toggle("--cursor", ctx.input.includeCursor),
          ...optional("--output", ctx.input.output),
          ...contextArgs(ctx),
        ]),
    },
    {
      name: "get_windows_geometry",
      description:
        "Read an authorized window's current geometry and transformVersion without capturing an image. Use it to check whether coordinates from an earlier screenshot are still valid before spending a capture to find out. Prefer the semantic UI Automation tools over coordinates whenever a window exposes a tree.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: {
            type: "string",
            description: "Opaque authorized window ID. Never a raw window handle.",
          },
        },
        required: ["windowId"],
      },
      handler: (ctx) =>
        runCli(["windows", "geometry", "--window", ctx.input.windowId, ...contextArgs(ctx)]),
    },
    {
      name: "click_windows_app",
      description:
        "Click at a window-relative physical capture pixel in an authorized window. Background mode is the default: it hit-tests UI Automation, preserves the prior foreground, and never moves the real cursor. Foreground mode is an explicit raw-input fallback that may activate the app and move the cursor. transformVersion must come from the most recent screenshot, stream descriptor, or geometry read.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: {
            type: "string",
            description: "Opaque authorized window ID. Never a raw window handle.",
          },
          transformVersion: {
            type: "string",
            description:
              "Token from the most recent screenshot, stream descriptor, or geometry read for this window. A stale token is refused rather than clicked.",
          },
          x: {
            type: "number",
            description: "X in capture pixels, measured from the left edge of the window's visible content.",
          },
          y: {
            type: "number",
            description: "Y in capture pixels, measured from the top edge of the window's visible content.",
          },
          button: {
            type: "string",
            enum: ["left", "right", "middle"],
            description: "Pointer button. Right and middle require foreground mode.",
          },
          count: {
            type: "integer",
            minimum: 1,
            maximum: 2,
            description: "1 for a single click, 2 for a double click. Double click requires foreground mode.",
          },
          captureWidth: {
            type: "integer",
            minimum: 0,
            description: "Width of the image the coordinates were read from. 0 means they are content pixels.",
          },
          captureHeight: {
            type: "integer",
            minimum: 0,
            description: "Height of the image the coordinates were read from. 0 means they are content pixels.",
          },
          modifiers: {
            type: "array",
            items: { type: "string" },
            description: "Modifier keys held for the click; modifiers require foreground mode.",
          },
          mode: inputModeProperty,
        },
        required: ["windowId", "transformVersion", "x", "y"],
      },
      handler: (ctx) =>
        runCli([
          "windows",
          "click",
          "--window",
          ctx.input.windowId,
          "--transform",
          ctx.input.transformVersion,
          "--x",
          String(ctx.input.x),
          "--y",
          String(ctx.input.y),
          ...optional("--button", ctx.input.button),
          ...optional("--count", ctx.input.count),
          ...optional("--capture-width", ctx.input.captureWidth),
          ...optional("--capture-height", ctx.input.captureHeight),
          ...repeated("--modifier", ctx.input.modifiers),
          "--mode",
          ctx.input.mode ?? "background",
          ...contextArgs(ctx),
        ]),
    },
    {
      name: "drag_windows_app",
      description:
        "Press, move along an interpolated path, and release in an authorized window. Raw dragging has no universal focus-free Windows API, so mode foreground is required and may activate the app and move the real cursor. Background mode refuses without sending input. Coordinates require the current transformVersion.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: {
            type: "string",
            description: "Opaque authorized window ID. Never a raw window handle.",
          },
          transformVersion: {
            type: "string",
            description:
              "Token from the most recent screenshot, stream descriptor, or geometry read. A stale token is refused rather than dragged.",
          },
          x: { type: "number", description: "Starting X in capture pixels." },
          y: { type: "number", description: "Starting Y in capture pixels." },
          endX: { type: "number", description: "Ending X in capture pixels." },
          endY: { type: "number", description: "Ending Y in capture pixels." },
          button: {
            type: "string",
            enum: ["left", "right", "middle"],
            description: "Pointer button. Defaults to left.",
          },
          durationMilliseconds: {
            type: "integer",
            minimum: 0,
            maximum: 10000,
            description: "How long the drag takes, in milliseconds. Defaults to 250.",
          },
          steps: {
            type: "integer",
            minimum: 2,
            maximum: 256,
            description: "How many intermediate moves to send. Defaults to 24.",
          },
          captureWidth: {
            type: "integer",
            minimum: 0,
            description: "Width of the image the coordinates were read from. 0 means content pixels.",
          },
          captureHeight: {
            type: "integer",
            minimum: 0,
            description: "Height of the image the coordinates were read from. 0 means content pixels.",
          },
          modifiers: {
            type: "array",
            items: { type: "string" },
            description: "Modifier keys held for the drag.",
          },
          mode: inputModeProperty,
        },
        required: ["windowId", "transformVersion", "x", "y", "endX", "endY"],
      },
      handler: (ctx) =>
        runCli([
          "windows",
          "drag",
          "--window",
          ctx.input.windowId,
          "--transform",
          ctx.input.transformVersion,
          "--x",
          String(ctx.input.x),
          "--y",
          String(ctx.input.y),
          "--end-x",
          String(ctx.input.endX),
          "--end-y",
          String(ctx.input.endY),
          ...optional("--button", ctx.input.button),
          ...optional("--duration", ctx.input.durationMilliseconds),
          ...optional("--steps", ctx.input.steps),
          ...optional("--capture-width", ctx.input.captureWidth),
          ...optional("--capture-height", ctx.input.captureHeight),
          ...repeated("--modifier", ctx.input.modifiers),
          "--mode",
          ctx.input.mode ?? "background",
          ...contextArgs(ctx),
        ]),
    },
    {
      name: "scroll_windows_app",
      description:
        "Scroll over a point in an authorized window. Background mode is the default and invokes a UI Automation scroll pattern while preserving the prior foreground. Foreground mode uses the global real pointer and may move it. Deltas are wheel notches; requires the current transformVersion.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: {
            type: "string",
            description: "Opaque authorized window ID. Never a raw window handle.",
          },
          transformVersion: {
            type: "string",
            description:
              "Token from the most recent screenshot, stream descriptor, or geometry read. A stale token is refused rather than scrolled.",
          },
          x: { type: "number", description: "X in capture pixels." },
          y: { type: "number", description: "Y in capture pixels." },
          deltaY: {
            type: "number",
            description: "Vertical wheel notches; positive scrolls up.",
          },
          deltaX: {
            type: "number",
            description: "Horizontal wheel notches; positive scrolls right.",
          },
          captureWidth: {
            type: "integer",
            minimum: 0,
            description: "Width of the image the coordinates were read from. 0 means content pixels.",
          },
          captureHeight: {
            type: "integer",
            minimum: 0,
            description: "Height of the image the coordinates were read from. 0 means content pixels.",
          },
          modifiers: {
            type: "array",
            items: { type: "string" },
            description: "Modifier keys held for the scroll; modifiers require foreground mode.",
          },
          mode: inputModeProperty,
        },
        required: ["windowId", "transformVersion", "x", "y"],
      },
      handler: (ctx) =>
        runCli([
          "windows",
          "wheel",
          "--window",
          ctx.input.windowId,
          "--transform",
          ctx.input.transformVersion,
          "--x",
          String(ctx.input.x),
          "--y",
          String(ctx.input.y),
          ...optional("--delta-y", ctx.input.deltaY),
          ...optional("--delta-x", ctx.input.deltaX),
          ...optional("--capture-width", ctx.input.captureWidth),
          ...optional("--capture-height", ctx.input.captureHeight),
          ...repeated("--modifier", ctx.input.modifiers),
          "--mode",
          ctx.input.mode ?? "background",
          ...contextArgs(ctx),
        ]),
    },
    {
      name: "press_windows_app_key",
      description:
        "Press, hold, or release keys in an authorized window. Raw keyboard input has no universal focus-free Windows API, so mode foreground is required and may activate the app. Background mode refuses without sending input. Prefer act_on_windows_ui_element for buttons and fields. Requires the current transformVersion.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: {
            type: "string",
            description: "Opaque authorized window ID. Never a raw window handle.",
          },
          transformVersion: {
            type: "string",
            description:
              "Token from the most recent screenshot, stream descriptor, or geometry read. A stale token is refused.",
          },
          keys: {
            type: "array",
            items: { type: "string" },
            description: "Key names to act on, in order.",
          },
          action: {
            type: "string",
            enum: ["press", "down", "up"],
            description: "Whether to press (hold then release), hold down, or release the keys.",
          },
          modifiers: {
            type: "array",
            items: { type: "string" },
            description: "Modifier keys held around the whole request, such as ctrl, alt, shift, or win.",
          },
          mode: inputModeProperty,
        },
        required: ["windowId", "transformVersion", "keys"],
      },
      handler: (ctx) =>
        runCli([
          "windows",
          "key",
          "--window",
          ctx.input.windowId,
          "--transform",
          ctx.input.transformVersion,
          ...repeated("--key", ctx.input.keys),
          ...optional("--key-action", ctx.input.action),
          ...repeated("--modifier", ctx.input.modifiers),
          "--mode",
          ctx.input.mode ?? "background",
          ...contextArgs(ctx),
        ]),
    },
    {
      name: "type_windows_app_text",
      description:
        "Type text into whichever control has focus in an authorized window. Raw typing has no universal focus-free Windows API, so mode foreground is required and may activate the app. Background mode refuses without sending input; prefer act_on_windows_ui_element setValue. Text is never echoed back. Requires the current transformVersion.",
      inputSchema: {
        type: "object",
        properties: {
          windowId: {
            type: "string",
            description: "Opaque authorized window ID. Never a raw window handle.",
          },
          transformVersion: {
            type: "string",
            description:
              "Token from the most recent screenshot, stream descriptor, or geometry read. A stale token is refused.",
          },
          text: {
            type: "string",
            description: "Text to type. It is never echoed back into results or panel activity.",
          },
          delayMilliseconds: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description: "Optional per-character delay in milliseconds for apps that drop fast synthetic input.",
          },
          mode: inputModeProperty,
        },
        required: ["windowId", "transformVersion", "text"],
      },
      handler: (ctx) =>
        runCli([
          "windows",
          "type",
          "--window",
          ctx.input.windowId,
          "--transform",
          ctx.input.transformVersion,
          "--text",
          ctx.input.text,
          ...optional("--delay", ctx.input.delayMilliseconds),
          "--mode",
          ctx.input.mode ?? "background",
          ...contextArgs(ctx),
        ]),
    },
  ],
  open: async (ctx) => {
    const result = await runCli(["canvas", "open", "--surface", "windows", ...contextArgs(ctx)]);
    // Optional, best-effort selection applied in a fixed precedence. Any failure here is left to
    // propagate as an action error rather than being swallowed, so a caller learns their attach or
    // launch did not take. A shell command string is never accepted; only discrete, opaque IDs and
    // an absolute executable path with a discrete argument list.
    const input = ctx.input ?? {};
    if (input.windowId) {
      await runCli(["windows", "select", "--window", input.windowId, ...contextArgs(ctx)]);
    } else if (input.candidateId) {
      await runCli(["windows", "attach", "--window", input.candidateId, ...contextArgs(ctx)]);
    } else if (input.entryId) {
      await runCli(["windows", "launch", "--app", input.entryId, ...contextArgs(ctx)]);
    } else if (input.executablePath) {
      await runCli([
        "windows",
        "launch-exe",
        "--path",
        input.executablePath,
        ...repeated("--arg", input.arguments),
        ...optional("--working-directory", input.workingDirectory),
        ...contextArgs(ctx),
      ]);
    }
    return {
      title: result.title || "Windows App",
      url: result.url,
      status: "Connected to local Windows App host",
    };
  },
  // Closing releases the browser session and its auth resources, but never terminates launched
  // apps: an agent that opened Notepad does not lose its work because the panel was closed. Dropping
  // the authority grant over the windows is the explicit release_windows_app_session action.
  onClose: async (ctx) => {
    await runCli(["canvas", "close", "--surface", "windows", ...contextArgs(ctx)]);
  },
});

// The icon is a declaration field that has to be an extension-relative PNG path, but
// createCanvas builds its declaration from a fixed field list that drops anything else, so it
// has to be assigned here. This names the window when a canvas is opened natively; the docked
// tab in the desktop app draws its own glyph from the canvas type and ignores this.
canvas.declaration.icon = "assets/icon.png";

// Register the canvas only on Windows. On every other platform the extension still joins the
// session so its process starts cleanly, but advertises no canvas at all.
await joinSession({ canvases: supported ? [canvas] : [] });
