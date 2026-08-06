const CONTEXT_TOOLS = new Set([
  "mobile_device_get_selected",
  "mobile_device_select",
]);

const DEVICE_STATE_TOOLS = new Set([
  "mobile_device_boot",
  "mobile_device_delete",
  "mobile_device_erase",
  "mobile_device_recording_start",
  "mobile_device_recording_stop",
  "mobile_device_reveal",
  "mobile_device_restart",
  "mobile_device_rotate",
  "mobile_device_shutdown",
]);

export class McpVsCodeContextProxy {
  #toolsListRequests = new Set();
  #followAfterRequests = new Map();
  #automationRequests = new Map();

  constructor({
    sessionId,
    instanceId,
    selectDevice,
    refreshView = async () => {},
    showAutomation = async () => {},
  }) {
    if (!sessionId || !instanceId) {
      throw new Error("A VS Code session and view instance are required.");
    }
    this.sessionId = sessionId;
    this.instanceId = instanceId;
    this.selectDevice = selectDevice;
    this.refreshView = refreshView;
    this.showAutomation = showAutomation;
  }

  async clientMessage(message) {
    if (Array.isArray(message)) {
      return Promise.all(message.map((entry) => this.clientMessage(entry)));
    }
    if (!message || typeof message !== "object") return message;

    if (message.method === "tools/list" && message.id !== undefined) {
      this.#toolsListRequests.add(idKey(message.id));
      return message;
    }
    if (message.method === "notifications/cancelled") {
      const key = idKey(message.params?.requestId);
      this.#followAfterRequests.delete(key);
      this.#automationRequests.delete(key);
      return message;
    }
    if (message.method !== "tools/call") return message;

    const name = message.params?.name;
    const args = message.params?.arguments;
    if (typeof name !== "string" || !args || typeof args !== "object") {
      return message;
    }

    if (CONTEXT_TOOLS.has(name)) {
      args.sessionId = this.sessionId;
      args.instanceId = this.instanceId;
    }

    if (message.id !== undefined) {
      const key = idKey(message.id);
      if (name === "mobile_device_create") {
        this.#followAfterRequests.set(key, { created: true });
      } else if (
        DEVICE_STATE_TOOLS.has(name)
        && typeof args.deviceId === "string"
        && args.deviceId.length > 0
      ) {
        this.#followAfterRequests.set(key, {
          created: false,
          deleted: name === "mobile_device_delete",
          deviceId: args.deviceId,
        });
      }
      const activity = automationEvent(name, args);
      if (activity) this.#automationRequests.set(key, activity);
    }

    if (
      name !== "mobile_device_select"
      && typeof args.deviceId === "string"
      && args.deviceId.length > 0
    ) {
      await this.selectDevice(args.deviceId, { force: false });
    }
    return message;
  }

  async serverMessage(message) {
    if (Array.isArray(message)) {
      return Promise.all(message.map((entry) => this.serverMessage(entry)));
    }
    if (!message || typeof message !== "object" || message.id === undefined) {
      return message;
    }

    const key = idKey(message.id);
    const follow = this.#followAfterRequests.get(key);
    this.#followAfterRequests.delete(key);
    const activity = this.#automationRequests.get(key);
    this.#automationRequests.delete(key);
    const succeeded =
      message.error === undefined && message.result?.isError !== true;
    if (follow && succeeded) {
      const deviceId = follow.created
        ? resultDeviceId(message.result)
        : follow.deviceId;
      if (deviceId && !follow.deleted) {
        await this.selectDevice(deviceId, { force: true });
      }
      await this.refreshView();
    }
    if (activity && succeeded) {
      await this.showAutomation(
        activity.uiTap ? completeUiTap(activity, message.result) : activity,
      );
    }

    if (!this.#toolsListRequests.delete(key) || !Array.isArray(message.result?.tools)) {
      return message;
    }

    for (const tool of message.result.tools) {
      if (!CONTEXT_TOOLS.has(tool?.name) || !tool.inputSchema) continue;
      if (Array.isArray(tool.inputSchema.required)) {
        tool.inputSchema.required = tool.inputSchema.required.filter(
          (name) => name !== "sessionId" && name !== "instanceId",
        );
      }
      for (const property of ["sessionId", "instanceId"]) {
        if (tool.inputSchema.properties?.[property]) {
          tool.inputSchema.properties[property].description =
            "Provided automatically by the Mobile Canvas VS Code extension.";
        }
      }
    }
    return message;
  }
}

function idKey(id) {
  return `${typeof id}:${String(id)}`;
}

function resultDeviceId(result) {
  const structured = resultObject(result);
  if (typeof structured?.id === "string") return structured.id;
  if (typeof structured?.device?.id === "string") return structured.device.id;
  return undefined;
}

function resultObject(result) {
  const structured = result?.structuredContent;
  if (structured && typeof structured === "object") return structured;
  for (const content of result?.content ?? []) {
    if (content?.type !== "text" || typeof content.text !== "string") continue;
    try {
      const parsed = JSON.parse(content.text);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Human-readable MCP content is not required to contain JSON.
    }
  }
  return undefined;
}

function automationEvent(name, args) {
  const deviceId = args.deviceId;
  if (typeof deviceId !== "string" || deviceId.length === 0) return undefined;

  switch (name) {
    case "mobile_device_tap": {
      const duration = args.duration ?? 0;
      return {
        kind: duration >= 0.45 ? "long-press" : "tap",
        deviceId,
        x: args.x,
        y: args.y,
        duration,
      };
    }
    case "mobile_device_long_press":
      return {
        kind: "long-press",
        deviceId,
        x: args.x,
        y: args.y,
        duration: args.duration ?? 1,
      };
    case "mobile_device_swipe":
      return {
        kind: "swipe",
        deviceId,
        x: args.startX,
        y: args.startY,
        endX: args.endX,
        endY: args.endY,
        duration: args.duration ?? 0.35,
      };
    case "mobile_device_type_text":
      return { kind: "text", deviceId };
    case "mobile_device_press_key":
      return { kind: "key", deviceId, detail: String(args.keyCode) };
    case "mobile_device_press_button":
      return { kind: "button", deviceId, detail: args.button };
    case "mobile_device_rotate":
      return { kind: "rotate", deviceId, detail: args.orientation };
    case "mobile_device_screenshot":
      return { kind: "screenshot", deviceId };
    case "mobile_device_ui_tap":
      return { kind: "tap", deviceId, uiTap: true };
    default:
      return undefined;
  }
}

function completeUiTap(activity, result) {
  const match = resultObject(result)?.match;
  const completed = { ...activity };
  delete completed.uiTap;
  if (typeof match?.centerX === "number") completed.x = match.centerX;
  if (typeof match?.centerY === "number") completed.y = match.centerY;
  if (typeof match?.element?.label === "string") {
    completed.detail = match.element.label;
  }
  return completed;
}
