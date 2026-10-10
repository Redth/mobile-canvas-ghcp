import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRuntimeMobileBackend } from "./runtime-backend.mjs";
import { mobileErrorResult } from "./mobile-backend.mjs";
import { MobileAilohaError } from "./mobile-projection.mjs";
import { DESTRUCTIVE_CONSENT_SCHEMA, destructiveConsentResult } from "./destructive-consent.mjs";

const ACTIONS = Object.freeze({
  mobile_device_catalog: "get_device_catalog",
  mobile_device_create: "create_device",
  mobile_device_list: "list_devices",
  mobile_device_get: "get_device",
  mobile_device_get_selected: "get_selected_device",
  mobile_device_select: "select_device",
  mobile_device_boot: "boot_device",
  mobile_device_shutdown: "shutdown_device",
  mobile_device_restart: "restart_device",
  mobile_device_erase: "erase_device",
  mobile_device_delete: "delete_device",
  mobile_device_display: "get_display_geometry",
  mobile_device_tap: "tap_device",
  mobile_device_long_press: "long_press_device",
  mobile_device_swipe: "swipe_device",
  mobile_device_recording_start: "start_recording",
  mobile_device_recording_status: "get_recording_status",
  mobile_device_recording_stop: "stop_recording",
});
const GEOMETRY_TOOLS = new Set(["mobile_device_tap", "mobile_device_long_press", "mobile_device_swipe"]);
const CONTEXT_TOOLS = new Set(["mobile_device_get_selected", "mobile_device_select"]);

export async function ailohaMcpCatalog({ boundScope } = {}) {
  const catalog = JSON.parse(await readFile(new URL("./mcp-catalog.json", import.meta.url), "utf8"));
  const nullable = (schema) => {
    if (!schema || typeof schema !== "object") return;
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      if (["nativeId", "pixelWidth", "pixelHeight", "scale"].includes(key)) {
        value.type = [...new Set([...(Array.isArray(value.type) ? value.type : [value.type]), "null"])];
      }
      nullable(value);
    }
    nullable(schema.items);
  };
  return catalog.tools.map((original) => {
    const tool = structuredClone(original);
    tool.execution = { taskSupport: "forbidden" };
    nullable(tool.outputSchema);
    const supported = Object.hasOwn(ACTIONS, tool.name) || tool.name === "mobile_device_screenshot";
    tool.description += supported
      ? " Ailoha opt-in: uses the explicitly bound view/Target Host only; capability evidence is required."
      : " Ailoha opt-in: this broader feature is positively unsupported and never routes to legacy.";
    if (tool.name === "mobile_device_delete" || tool.name === "mobile_device_erase") {
      tool.description += " Requires genuine client form elicitation for this captured context/target; unsupported clients fail explicitly. confirm=true alone is not authorization.";
    }
    if (GEOMETRY_TOOLS.has(tool.name)) {
      Object.assign(tool.inputSchema.properties, {
        surfaceId: { type: "string", description: "Opaque surface ID from the observed Ailoha display." },
        geometryRevision: { type: "integer", minimum: 0, maximum: 0xffffffff, description: "Observed Ailoha surface geometry revision." },
        coordinate: { type: "string", enum: ["window", "screen"], description: "Observed logical coordinate space, not encoded pixels." },
      });
    }
    if (tool.name === "mobile_device_select") {
      tool.inputSchema.properties.surfaceId = {
        type: "string", description: "Explicit opaque Ailoha surface ID when the target has multiple surfaces.",
      };
    }
    if (tool.name === "mobile_device_create") {
      tool.inputSchema.properties.platform.description =
        "Mobile platform ios or android (case-insensitive); defaults to ios and must match the returned catalog choices.";
    }
    if (tool.name === "mobile_device_get_selected") {
      Object.assign(tool.outputSchema.properties, {
        scope: {
          type: "object", required: ["sessionId", "viewId"],
          properties: { sessionId: { type: "string" }, viewId: { type: "string" } },
        },
        contextBinding: {
          type: "object", required: ["contextRef", "scopeEpoch", "revision", "ownerProcessId"],
          properties: {
            contextRef: { type: "string" }, scopeEpoch: { type: "string" },
            revision: { type: "string", pattern: "^(0|[1-9][0-9]{0,127})$" },
            ownerProcessId: { type: "integer", minimum: 1 },
          },
        },
      });
    }
    if (boundScope && CONTEXT_TOOLS.has(tool.name)) {
      tool.inputSchema.required = tool.inputSchema.required.filter((key) => key !== "sessionId" && key !== "instanceId");
    }
    return tool;
  });
}

function validateInput(schema, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new MobileAilohaError("invalid_request", "MCP tool arguments must be a JSON object.", 400);
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(input, key)) throw new MobileAilohaError("invalid_request", `MCP argument ${key} is required.`, 400);
  }
  for (const [key, value] of Object.entries(input)) {
    const property = schema.properties?.[key];
    if (!property) throw new MobileAilohaError("invalid_request", "The MCP input contains an unsupported argument.", 400);
    const types = Array.isArray(property.type) ? property.type : [property.type];
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!types.includes(type) && !(types.includes("integer") && Number.isSafeInteger(value))) {
      throw new MobileAilohaError("invalid_request", `MCP argument ${key} has an invalid type.`, 400);
    }
    if ((typeof value === "number" && !Number.isFinite(value))
      || (property.enum && !property.enum.includes(value))
      || (property.minimum !== undefined && value < property.minimum)
      || (property.maximum !== undefined && value > property.maximum)) {
      throw new MobileAilohaError("invalid_request", `MCP argument ${key} is outside its supported range.`, 400);
    }
  }
}

export async function createAilohaMcpDispatcher({
  binding,
  version,
  createBackend = createRuntimeMobileBackend,
  onEvent = () => {},
  selectCreated = false,
  requestElicitation,
}) {
  if (!binding?.contextRef || !binding.scopeEpoch || !binding.scope?.sessionId || !binding.scope?.viewId
    || !Number.isSafeInteger(binding.ownerProcessId) || binding.ownerProcessId < 1) {
    throw new MobileAilohaError(
      "named_context_required",
      "Ailoha MCP opt-in requires --context, --context-epoch, --session, --instance and trusted --owner-process. Open the named Mobile Canvas view first; no first-view inference or legacy fallback is allowed.",
      400,
    );
  }
  const tools = await ailohaMcpCatalog({ boundScope: binding.scope });
  let backendPromise;
  let disposed = false;
  let formElicitation = false;
  const confirmDestructive = Object.assign(
    async (request, { signal }) => destructiveConsentResult(await requestElicitation({
      message: request.message, requestedSchema: DESTRUCTIVE_CONSENT_SCHEMA,
    }, { signal })),
    { isSupported: () => formElicitation && typeof requestElicitation === "function" },
  );
  const backend = () => {
    if (disposed) throw new MobileAilohaError("mcp_closed", "This named Ailoha MCP owner is closed.");
    return backendPromise ??= createBackend({
      scope: binding.scope,
      contextRef: binding.contextRef,
      scopeEpoch: binding.scopeEpoch,
      ownerProcessId: binding.ownerProcessId,
      onEvent,
      ...(requestElicitation ? { confirmDestructive } : {}),
    });
  };
  return Object.freeze({
    async handle(message, { signal } = {}) {
      if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        return { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid MCP JSON-RPC request." } };
      }
      if (message.id === undefined) return null;
      try {
        let result;
        switch (message.method) {
          case "initialize":
            {
              const elicitation = message.params?.capabilities?.elicitation;
              const version = message.params?.protocolVersion;
              formElicitation = ["2025-06-18", "2025-11-25"].includes(version)
                && elicitation !== null && typeof elicitation === "object" && !Array.isArray(elicitation)
                && (Object.keys(elicitation).length === 0
                  || (Object.hasOwn(elicitation, "form") && elicitation.form !== null
                    && typeof elicitation.form === "object" && !Array.isArray(elicitation.form)));
            }
            result = {
              protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "mobile-canvas", version },
              instructions: "Explicit Ailoha opt-in. One named live Mobile Canvas context; target-only capabilities, no app instrumentation required. Unsupported or failed operations never use the legacy engine.",
            };
            break;
          case "ping": result = {}; break;
          case "tools/list": result = { tools }; break;
          case "tools/call": {
            const name = message.params?.name;
            const tool = tools.find((entry) => entry.name === name);
            if (!tool) throw new MobileAilohaError("unknown_tool", "Unknown Mobile Canvas MCP tool.", 400);
            if (message.params?.task) throw new MobileAilohaError("mcp_tasks_unsupported", "MCP task execution is not enabled in this opt-in.", 501);
            const args = message.params.arguments ?? {};
            validateInput(tool.inputSchema, args);
            if (CONTEXT_TOOLS.has(name)) {
              if ((args.sessionId !== undefined && args.sessionId !== binding.scope.sessionId)
                || (args.instanceId !== undefined && args.instanceId !== binding.scope.viewId)) {
                throw new MobileAilohaError("context_scope_mismatch", "MCP input cannot replace its trusted named canvas scope.");
              }
            }
            if (!Object.hasOwn(ACTIONS, name) && name !== "mobile_device_screenshot") {
              throw new MobileAilohaError("capability_not_supported", "This broader Mobile Canvas operation is unsupported in the Ailoha opt-in.", 501);
            }
            if (["mobile_device_erase", "mobile_device_delete"].includes(name) && !confirmDestructive.isSupported()) {
              throw new MobileAilohaError("consent_not_supported", "This MCP client cannot request genuine captured form approval; confirm=true is not authorization.", 501);
            }
            const current = await backend();
            if (name === "mobile_device_screenshot") {
              const { bytes, invocation } = await current.screenshot(args.deviceId);
              result = {
                content: [
                  { type: "text", text: JSON.stringify({ context: invocation }) },
                  { type: "image", mimeType: "image/png", data: Buffer.from(bytes).toString("base64") },
                ],
              };
            } else {
              const value = name === "mobile_device_create"
                ? await current.create({ platform: "ios", ...args }, { selectCreated })
                : await current.invokeAction(ACTIONS[name], args, { signal });
              const output = Array.isArray(value) ? { result: value } : value;
              result = {
                content: [{ type: "text", text: JSON.stringify(output) }],
                ...(output && typeof output === "object" ? { structuredContent: output } : {}),
              };
            }
            break;
          }
          default: return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "MCP method is not supported by this opt-in." } };
        }
        return { jsonrpc: "2.0", id: message.id, result };
      } catch (error) {
        return {
          jsonrpc: "2.0", id: message.id,
          result: { isError: true, content: [{ type: "text", text: JSON.stringify(mobileErrorResult(error)) }] },
        };
      }
    },
    async dispose() {
      disposed = true;
      if (backendPromise) await (await backendPromise).dispose();
    },
  });
}

export function parseAilohaMcpOptions(args) {
  const names = new Map([
    ["--session", "sessionId"], ["--instance", "viewId"], ["--context", "contextRef"],
    ["--context-epoch", "scopeEpoch"], ["--owner-process", "ownerProcessId"],
  ]);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = names.get(args[index]);
    const value = args[++index];
    if (!key || !value || Object.hasOwn(options, key)) {
      throw new MobileAilohaError("invalid_options", "Ailoha MCP requires explicit, non-duplicate named-context options.", 400);
    }
    options[key] = key === "ownerProcessId" ? Number(value) : value;
  }
  return {
    contextRef: options.contextRef, scopeEpoch: options.scopeEpoch,
    ownerProcessId: options.ownerProcessId,
    scope: { sessionId: options.sessionId, viewId: options.viewId },
  };
}

export async function runAilohaMcp(args = process.argv.slice(2), { onEvent, selectCreated = false } = {}) {
  const packageInfo = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8").catch(() =>
    readFile(new URL("../../../package.json", import.meta.url), "utf8")));
  const prompts = new Map();
  const requests = new Map();
  const write = (message) => new Promise((resolve, reject) => process.stdout.write(
    `${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve(),
  ));
  let inputEnded = false;
  const requestElicitation = (params, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted || inputEnded) {
      reject(new MobileAilohaError("consent_cancelled", "The approval channel was retired.", 409));
      return;
    }
    const id = `mobile-canvas-approval-${randomUUID()}`;
    const cleanup = () => {
      prompts.delete(id);
      signal.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      if (!prompts.has(id)) return;
      cleanup();
      reject(new MobileAilohaError("consent_cancelled", "The captured MCP approval was cancelled.", 409));
      if (!inputEnded) void write({
        jsonrpc: "2.0", method: "notifications/cancelled",
        params: { requestId: id, reason: "The captured approval was retired." },
      }).catch(() => process.stderr.write("mobile-canvas: the client did not acknowledge prompt cancellation; approval remains retired.\n"));
    };
    const entry = { resolve, reject, cleanup, cancel };
    prompts.set(id, entry);
    signal.addEventListener("abort", cancel, { once: true });
    void write({ jsonrpc: "2.0", id, method: "elicitation/create", params }).catch(() => {
      if (prompts.get(id) !== entry) return;
      cleanup();
      reject(new MobileAilohaError("consent_prompt_failed", "The MCP client approval request could not be delivered.", 502));
    });
  });
  const dispatcher = await createAilohaMcpDispatcher({
    binding: parseAilohaMcpOptions(args), version: packageInfo.version, onEvent, selectCreated, requestElicitation,
  });
  let buffer = "";
  let pending = 0;
  let queue = Promise.resolve();
  let shutdown = null;
  const close = () => {
    inputEnded = true;
    for (const controller of requests.values()) controller.abort();
    for (const prompt of [...prompts.values()]) prompt.cancel();
    return shutdown ??= dispatcher.dispose();
  };
  const onSignal = () => {
    process.stdin.destroy();
    void close().then(
      () => { process.exitCode = 0; },
      () => {
        process.stderr.write("mobile-canvas: owned Ailoha MCP cleanup failed; no host/device stop was attempted.\n");
        process.exitCode = 1;
      },
    );
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, onSignal);
  const enqueue = (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { message = {}; }
    if (message?.jsonrpc === "2.0" && message.method === undefined
      && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const prompt = prompts.get(message.id);
      if (prompt) {
        prompt.cleanup();
        if (Object.hasOwn(message, "error")) {
          prompt.reject(new MobileAilohaError("consent_prompt_failed", "The MCP client could not collect human approval.", 502));
        } else prompt.resolve(message.result);
      } else process.stderr.write("mobile-canvas: ignored an unsolicited or retired approval response.\n");
      return;
    }
    if (message?.jsonrpc === "2.0" && message.method === "notifications/cancelled") {
      requests.get(message.params?.requestId)?.abort();
      return;
    }
    if (++pending > 32) throw new MobileAilohaError("mcp_queue_limit", "The bounded MCP request queue is full.", 429);
    if (message?.id !== undefined && requests.has(message.id)) {
      throw new MobileAilohaError("mcp_request_duplicate", "The client reused a pending request ID.", 400);
    }
    const controller = new AbortController();
    if (message?.id !== undefined) requests.set(message.id, controller);
    queue = queue.then(async () => {
      try {
        const response = controller.signal.aborted ? {
          jsonrpc: "2.0", id: message?.id ?? null,
          result: { isError: true, content: [{ type: "text", text: JSON.stringify({
            code: "consent_cancelled", message: "The captured MCP request was cancelled before dispatch.", status: 409,
          }) }] },
        } : await dispatcher.handle(message, { signal: controller.signal });
        if (response) await write(response);
      } finally {
        if (message?.id !== undefined && requests.get(message.id) === controller) requests.delete(message.id);
        pending -= 1;
      }
    });
  };
  process.stdin.setEncoding("utf8");
  try {
  for await (const chunk of process.stdin) {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 256 * 1024) throw new MobileAilohaError("mcp_request_limit", "MCP request exceeds the bounded input size.", 413);
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      enqueue(line);
    }
  }
  if (buffer.trim()) enqueue(buffer);
  inputEnded = true;
  for (const prompt of [...prompts.values()]) prompt.cancel();
  await queue;
  } catch (error) {
    if (!shutdown) throw error;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, onSignal);
    await close();
  }
}
