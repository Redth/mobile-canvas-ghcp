import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { resolveCommand } from "./lib/runtime.mjs";

const execFileAsync = promisify(execFile);

// Resolved lazily and then cached: extracting the bundled binary should happen
// on first use rather than at import time, so a resolution failure surfaces as
// a readable action error instead of preventing the extension from loading.
let resolved = null;
function command() {
  if (!resolved) resolved = resolveCommand();
  return resolved.command;
}

async function runCli(args) {
  try {
    const { stdout } = await execFileAsync(command(), [...args, "--json"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const message = String(error.stderr || error.message || error).trim();
    throw new Error(`Mobile Canvas: ${message}`);
  }
}

function contextArgs(ctx) {
  return ["--session", ctx.sessionId, "--instance", ctx.instanceId];
}

function targetAction(name, description, verb) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        deviceId: {
          type: "string",
          description: "Provider-qualified ID returned by list_devices.",
        },
      },
      required: ["deviceId"],
    },
    handler: (ctx) =>
      runCli(["devices", verb, ctx.input.deviceId, ...contextArgs(ctx)]),
  };
}

const canvas = createCanvas({
  id: "mobile-device",
  displayName: "Mobile Device",
  description: "View, create, boot, and interact with local iOS simulators and Android emulators.",
  inputSchema: {
    type: "object",
    properties: {
      deviceId: {
        type: "string",
        description: "Optional provider-qualified device ID to select after opening.",
      },
    },
  },
  actions: [
    {
      name: "list_devices",
      description:
        "List local iOS simulators and Android emulators with state, capabilities, and the native ID (iOS UDID or Android AVD/serial) used for deployment.",
      handler: () => runCli(["devices", "list"]),
    },
    {
      name: "get_device_catalog",
      description:
        "Get installed runtimes and system images, device types, existing devices, and dependency diagnostics across all platforms.",
      handler: () => runCli(["devices", "catalog"]),
    },
    {
      name: "get_selected_device",
      description:
        "Get the target record and native UDID selected in this canvas. Returns hasSelection=false when no device is chosen yet.",
      handler: (ctx) =>
        runCli(["devices", "selected", ...contextArgs(ctx)]),
    },
    {
      name: "select_device",
      description: "Select a device in this canvas and return its complete deployment target record.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string", description: "Provider-qualified device ID." },
        },
        required: ["deviceId"],
      },
      handler: (ctx) =>
        runCli(["devices", "select", ctx.input.deviceId, ...contextArgs(ctx)]),
    },
    {
      name: "create_device",
      description:
        "Create an iOS simulator or Android emulator from an installed runtime/system image and device type.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Display name for the new device." },
          runtimeId: { type: "string", description: "Runtime ID from get_device_catalog." },
          deviceTypeId: { type: "string", description: "Device type ID from get_device_catalog." },
        },
        required: ["name", "runtimeId", "deviceTypeId"],
      },
      handler: (ctx) => runCli([
        "devices", "create",
        "--name", ctx.input.name,
        "--runtime", ctx.input.runtimeId,
        "--device-type", ctx.input.deviceTypeId,
        ...contextArgs(ctx),
      ]),
    },
    targetAction(
      "boot_device",
      "Boot a shut-down device and wait for it to finish starting. Returns the complete target record, including the native ID used for deployment.",
      "boot",
    ),
    targetAction(
      "shutdown_device",
      "Shut down a booted device. The device is preserved and can be booted again.",
      "shutdown",
    ),
    targetAction(
      "restart_device",
      "Restart a device by shutting it down and booting it again. Contents are preserved.",
      "restart",
    ),
    targetAction(
      "reveal_device",
      "Bring the device's own window to the front on the desktop. Supported on iOS simulators; Android emulators report this as unsupported.",
      "reveal",
    ),
    {
      name: "erase_device",
      description: "Permanently erase device content and settings. Runs only when confirm is true.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string", description: "Provider-qualified device ID." },
          confirm: { type: "boolean", description: "Must be true to authorize erasure." },
        },
        required: ["deviceId", "confirm"],
      },
      handler: (ctx) => {
        if (ctx.input.confirm !== true) throw new Error("erase_device requires confirm: true");
        return runCli(["devices", "erase", ctx.input.deviceId, "--confirm", ...contextArgs(ctx)]);
      },
    },
    {
      name: "delete_device",
      description: "Permanently delete a device. Runs only when confirm is true.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string", description: "Provider-qualified device ID." },
          confirm: { type: "boolean", description: "Must be true to authorize deletion." },
        },
        required: ["deviceId", "confirm"],
      },
      handler: (ctx) => {
        if (ctx.input.confirm !== true) throw new Error("delete_device requires confirm: true");
        return runCli(["devices", "delete", ctx.input.deviceId, "--confirm"]);
      },
    },
    {
      name: "get_device",
      description:
        "Get the full target record for one device by ID, including state, native ID, display geometry, and capabilities.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string", description: "Provider-qualified device ID." },
        },
        required: ["deviceId"],
      },
      handler: (ctx) => runCli(["devices", "get", ctx.input.deviceId]),
    },
    {
      name: "get_display_geometry",
      description:
        "Get a booted device's logical point size, pixel size, scale, and orientation. Call this before tapping or swiping: all input coordinates are logical points, not pixels, so the point size is the coordinate space to aim in.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string", description: "Provider-qualified device ID." },
        },
        required: ["deviceId"],
      },
      handler: (ctx) => runCli(["devices", "display", ctx.input.deviceId]),
    },
    {
      name: "tap_device",
      description: "Tap a booted device at logical point coordinates. Use get_display_geometry to learn the coordinate space.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" },
          x: { type: "number", description: "Horizontal logical point coordinate." },
          y: { type: "number", description: "Vertical logical point coordinate." },
          duration: { type: "number", description: "Optional press duration in seconds." },
        },
        required: ["deviceId", "x", "y"],
      },
      handler: (ctx) => runCli([
        "input", "tap", ctx.input.deviceId,
        "--x", String(ctx.input.x), "--y", String(ctx.input.y),
        "--duration", String(ctx.input.duration || 0),
        ...contextArgs(ctx),
      ]),
    },
    {
      name: "long_press_device",
      description:
        "Press and hold a booted device at logical point coordinates, for context menus, drag handles, and icon rearrangement.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" },
          x: { type: "number", description: "Horizontal logical point coordinate." },
          y: { type: "number", description: "Vertical logical point coordinate." },
          duration: { type: "number", description: "Hold duration in seconds. Defaults to 1." },
        },
        required: ["deviceId", "x", "y"],
      },
      handler: (ctx) => runCli([
        "input", "tap", ctx.input.deviceId,
        "--x", String(ctx.input.x), "--y", String(ctx.input.y),
        "--duration", String(ctx.input.duration || 1),
        ...contextArgs(ctx),
      ]),
    },
    {
      name: "swipe_device",
      description: "Swipe or drag across a booted device in logical point coordinates.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" },
          startX: { type: "number" },
          startY: { type: "number" },
          endX: { type: "number" },
          endY: { type: "number" },
          duration: { type: "number", description: "Gesture duration in seconds." },
        },
        required: ["deviceId", "startX", "startY", "endX", "endY"],
      },
      handler: (ctx) => runCli([
        "input", "swipe", ctx.input.deviceId,
        "--start-x", String(ctx.input.startX), "--start-y", String(ctx.input.startY),
        "--end-x", String(ctx.input.endX), "--end-y", String(ctx.input.endY),
        "--duration", String(ctx.input.duration || 0.35),
        ...contextArgs(ctx),
      ]),
    },
    {
      name: "type_text",
      description: "Type text into the focused control on a booted device.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" },
          text: { type: "string", description: "Text to type or paste." },
        },
        required: ["deviceId", "text"],
      },
      handler: (ctx) =>
        runCli(["input", "type", ctx.input.deviceId, "--text", ctx.input.text, ...contextArgs(ctx)]),
    },
    {
      name: "press_button",
      description:
        "Press a hardware button on a booted device. iOS accepts home, lock, side-button, siri, and apple-pay; Android accepts home, back, apps, power, volume-up, volume-down, and menu.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" },
          button: {
            type: "string",
            enum: [
              "home", "lock", "side-button", "siri", "apple-pay",
              "back", "apps", "power", "volume-up", "volume-down", "menu",
            ],
          },
        },
        required: ["deviceId", "button"],
      },
      handler: (ctx) =>
        runCli(["input", "button", ctx.input.deviceId, "--button", ctx.input.button, ...contextArgs(ctx)]),
    },
    {
      name: "press_key",
      description:
        "Press one keyboard key on a booted device using its USB HID usage code. Common codes: 40 Return, 41 Escape, 42 Backspace, 43 Tab, 79 Right, 80 Left, 81 Down, 82 Up.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" },
          keyCode: { type: "number", description: "USB HID keyboard usage code." },
        },
        required: ["deviceId", "keyCode"],
      },
      handler: (ctx) =>
        runCli(["input", "key", ctx.input.deviceId, "--code", String(ctx.input.keyCode), ...contextArgs(ctx)]),
    },
    {
      name: "rotate_device",
      description: "Rotate a booted device to a new orientation.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" },
          orientation: {
            type: "string",
            enum: ["portrait", "portrait-upside-down", "landscape-left", "landscape-right"],
          },
        },
        required: ["deviceId", "orientation"],
      },
      handler: (ctx) =>
        runCli([
          "input", "rotate", ctx.input.deviceId,
          "--orientation", ctx.input.orientation,
          ...contextArgs(ctx),
        ]),
    },
    {
      name: "take_screenshot",
      description: "Capture a device screenshot and return its persistent local artifact path.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" },
          output: { type: "string", description: "Optional absolute output path." },
        },
        required: ["deviceId"],
      },
      handler: (ctx) => runCli([
        "screenshot", ctx.input.deviceId,
        ...(ctx.input.output ? ["--output", ctx.input.output] : []),
        ...contextArgs(ctx),
      ]),
    },
    {
      name: "start_recording",
      description: "Start a bounded H.264 MP4 recording of a booted device.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" },
          timeoutSeconds: { type: "integer", minimum: 1, maximum: 3600 },
          output: { type: "string", description: "Optional absolute output path." },
        },
        required: ["deviceId"],
      },
      handler: (ctx) => runCli([
        "recording", "start", ctx.input.deviceId,
        "--timeout", String(ctx.input.timeoutSeconds || 180),
        ...(ctx.input.output ? ["--output", ctx.input.output] : []),
      ]),
    },
    {
      name: "stop_recording",
      description: "Stop and finalize a device recording and return its output path.",
      inputSchema: {
        type: "object",
        properties: { deviceId: { type: "string" } },
        required: ["deviceId"],
      },
      handler: (ctx) => runCli(["recording", "stop", ctx.input.deviceId]),
    },
    {
      name: "get_recording_status",
      description: "Get current device recording status and output metadata.",
      inputSchema: {
        type: "object",
        properties: { deviceId: { type: "string" } },
        required: ["deviceId"],
      },
      handler: (ctx) => runCli(["recording", "status", ctx.input.deviceId]),
    },
  ],
  open: async (ctx) => {
    const result = await runCli(["canvas", "open", ...contextArgs(ctx)]);
    if (ctx.input?.deviceId) {
      await runCli([
        "devices", "select", ctx.input.deviceId,
        ...contextArgs(ctx),
      ]);
    }
    return {
      title: result.title || "Mobile Device",
      url: result.url,
      status: "Connected to local Mobile Canvas host",
    };
  },
  onClose: async (ctx) => {
    await runCli(["canvas", "close", ...contextArgs(ctx)]);
  },
});

await joinSession({ canvases: [canvas] });
