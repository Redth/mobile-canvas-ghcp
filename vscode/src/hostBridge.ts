import { execFile } from "node:child_process";
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import WebSocket, { type RawData } from "ws";
import type {
  ExtensionMessage,
  SocketChannel,
  WebviewMessage,
} from "./messages";

const execFileAsync = promisify(execFile);
const REQUEST_TIMEOUT_MS = 120_000;
const API_REQUEST_TIMEOUT_MS = 6 * 60_000;
const ALLOWED_METHODS = new Set(["GET", "POST", "DELETE"]);

interface CanvasOpenResult {
  url: string;
  title?: string;
}

interface HostConnection {
  baseUrl: URL;
  cookie: string;
}

interface MessageSink {
  postMessage(message: ExtensionMessage): Thenable<boolean>;
}

interface LogSink {
  appendLine(value: string): void;
}

export interface SelectedDeviceContext {
  selection: unknown;
  deviceId: string;
  deviceLabel: string;
}

export class HostBridge implements vscode.Disposable {
  private readonly sockets = new Map<string, WebSocket>();
  private connection: HostConnection | undefined;
  private connectPromise: Promise<HostConnection> | undefined;
  private disposed = false;
  private signalOffset = 0;
  private selectionToRestore: string | undefined;

  constructor(
    private readonly command: string,
    private readonly sessionId: string,
    private readonly instanceId: string,
    private readonly webview: MessageSink,
    private readonly output: LogSink,
    private readonly refreshSignal?: string,
  ) {
    if (refreshSignal) {
      this.signalOffset = readFileSync(refreshSignal, "utf8").length;
      watchFile(refreshSignal, { interval: 250 }, this.onRefreshSignal);
    }
  }

  async handleMessage(message: WebviewMessage): Promise<void> {
    if (this.disposed) {
      return;
    }

    try {
      switch (message.type) {
        case "ready":
          await this.connect();
          await this.post({
            type: "context",
            sessionId: this.sessionId,
            instanceId: this.instanceId,
          });
          break;
        case "api":
          await this.forwardApi(message);
          break;
        case "socket-open":
          await this.openSocket(message.id, message.channel, message.query);
          break;
        case "socket-close":
          this.closeSocket(message.id);
          break;
        case "save":
          await this.save(message.id, message.suggestedName, message.bytes);
          break;
        case "copy":
          await vscode.env.clipboard.writeText(message.text);
          await this.post({ type: "operation-result", id: message.id });
          break;
      }
    } catch (error) {
      const text = errorMessage(error);
      if ("id" in message) {
        await this.post({ type: "operation-error", id: message.id, message: text });
      } else {
        await this.post({ type: "fatal", message: text });
      }
      this.output.appendLine(`Mobile Canvas: ${text}`);
    }
  }

  async setVisible(visible: boolean): Promise<void> {
    if (!visible) {
      this.closeSockets();
    }
    await this.post({ type: "visibility", visible });
  }

  async restart(): Promise<void> {
    this.selectionToRestore = await this.readSelectedDeviceId();
    await this.closeCanvas();
    this.invalidateConnection();
  }

  async getSelectedDeviceContext(): Promise<SelectedDeviceContext> {
    const selection = await this.getJson("/api/v1/selection");
    if (!isRecord(selection) || selection.hasSelection !== true || !isRecord(selection.device)) {
      throw new Error("Select a device in the Mobile view before attaching its context.");
    }
    const deviceId = selection.device.id;
    if (typeof deviceId !== "string" || !deviceId) {
      throw new Error("The selected Mobile device does not have a valid identifier.");
    }
    const label = selection.device.name;
    return {
      selection,
      deviceId,
      deviceLabel: typeof label === "string" && label ? label : deviceId,
    };
  }

  async getSelectedScreenshot(): Promise<{
    context: SelectedDeviceContext;
    bytes: Uint8Array;
  }> {
    const context = await this.getSelectedDeviceContext();
    const response = await this.get(
      `/api/v1/devices/${encodeURIComponent(context.deviceId)}/screenshot`,
    );
    const contentType = response.headers.get("content-type")?.split(";", 1)[0];
    if (contentType !== "image/png") {
      throw new Error(
        `Mobile Canvas returned ${contentType ?? "an unknown content type"} for the screenshot.`,
      );
    }
    return {
      context,
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }

  async getSelectedUiTree(): Promise<{
    context: SelectedDeviceContext;
    tree: unknown;
  }> {
    const context = await this.getSelectedDeviceContext();
    return {
      context,
      tree: await this.getJson(
        `/api/v1/devices/${encodeURIComponent(context.deviceId)}/ui`,
      ),
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.refreshSignal) {
      unwatchFile(this.refreshSignal, this.onRefreshSignal);
    }
    this.closeSockets();
    void this.closeCanvas().catch((error) => {
      this.output.appendLine(`Mobile Canvas close failed: ${errorMessage(error)}`);
    });
  }

  private async connect(): Promise<HostConnection> {
    if (this.disposed) {
      throw new Error("The Mobile Canvas view is closed.");
    }
    const pending = this.connectPromise ??= this.openCanvas();
    try {
      const connection = await pending;
      if (this.connectPromise === pending) {
        this.connection = connection;
      }
      return connection;
    } catch (error) {
      if (this.connectPromise === pending) {
        this.connectPromise = undefined;
        this.connection = undefined;
      }
      throw error;
    }
  }

  private async openCanvas(): Promise<HostConnection> {
    const { stdout } = await execFileAsync(
      this.command,
      [
        "canvas",
        "open",
        "--session",
        this.sessionId,
        "--instance",
        this.instanceId,
        "--json",
      ],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: REQUEST_TIMEOUT_MS,
      },
    );
    const result = JSON.parse(stdout) as CanvasOpenResult;
    const canvasUrl = new URL(result.url);
    if (canvasUrl.protocol !== "http:" || !isLoopback(canvasUrl.hostname)) {
      throw new Error("The Mobile Canvas host must use a loopback HTTP address.");
    }
    const secret = canvasUrl.hash
      ? new URLSearchParams(canvasUrl.hash.slice(1)).get("bootstrap")
      : null;
    if (!secret) {
      throw new Error("The Mobile Canvas host did not return a bootstrap secret.");
    }

    const sessionId = new URLSearchParams(canvasUrl.hash.slice(1)).get("sessionId");
    const instanceId = new URLSearchParams(canvasUrl.hash.slice(1)).get("instanceId");
    if (sessionId !== this.sessionId || instanceId !== this.instanceId) {
      throw new Error("The Mobile Canvas host returned a mismatched panel identity.");
    }

    const baseUrl = new URL(canvasUrl.origin);
    const response = await fetch(new URL("/api/v1/auth/bootstrap", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, sessionId, instanceId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Mobile Canvas bootstrap failed: ${response.status} ${response.statusText}`,
      );
    }

    const setCookie = response.headers.get("set-cookie");
    const cookie = setCookie?.split(";", 1)[0];
    if (!cookie?.startsWith("mobile_device_session=")) {
      throw new Error("The Mobile Canvas host did not establish a panel session.");
    }

    const connection = { baseUrl, cookie };
    await this.restoreSelection(connection);
    return connection;
  }

  private async forwardApi(
    message: Extract<WebviewMessage, { type: "api" }>,
  ): Promise<void> {
    const method = (message.method ?? "GET").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(`Unsupported Mobile Canvas HTTP method: ${method}`);
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const connection = await this.connect();
      const url = this.apiUrl(message.path, connection);
      const headers: Record<string, string> = { Cookie: connection.cookie };
      if (message.body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: message.body,
          signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
        });
        if (response.status === 401 && attempt === 0) {
          this.invalidateConnection(connection);
          continue;
        }
        const body = response.status === 204 || response.status === 205 || response.status === 304
          ? null
          : await response.arrayBuffer();
        const responseHeaders = Object.fromEntries(response.headers.entries());
        delete responseHeaders["set-cookie"];
        delete responseHeaders["set-cookie2"];
        await this.post({
          type: "api-result",
          id: message.id,
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body,
        });
        return;
      } catch (error) {
        this.invalidateConnection(connection);
        if (method === "GET" && attempt === 0 && isConnectionFailure(error)) {
          continue;
        }
        await this.post({
          type: "api-error",
          id: message.id,
          message: errorMessage(error),
        });
        return;
      }
    }
  }

  private async get(path: string): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const connection = await this.connect();
      try {
        const response = await fetch(this.apiUrl(path, connection), {
          headers: { Cookie: connection.cookie },
          signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
        });
        if (response.status === 401 && attempt === 0) {
          this.invalidateConnection(connection);
          continue;
        }
        if (!response.ok) {
          throw new Error(
            `Mobile Canvas request failed: ${response.status} ${response.statusText}`,
          );
        }
        return response;
      } catch (error) {
        if (!isConnectionFailure(error) || attempt > 0) {
          throw error;
        }
        this.invalidateConnection(connection);
      }
    }
    throw new Error("Mobile Canvas could not reconnect to its local host.");
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.get(path);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0];
    if (contentType !== "application/json") {
      throw new Error(
        `Mobile Canvas returned ${contentType ?? "an unknown content type"} instead of JSON.`,
      );
    }
    return response.json();
  }

  private async openSocket(
    id: string,
    channel: SocketChannel,
    query?: string,
  ): Promise<void> {
    const connection = await this.connect();
    if (channel !== "video" && channel !== "events") {
      throw new Error(`Unsupported Mobile Canvas socket channel: ${String(channel)}`);
    }
    this.closeSocket(id);
    const url = this.apiUrl(`/ws/${channel}`, connection);
    url.search = query ?? "";
    url.protocol = "ws:";
    const socket = new WebSocket(url, { headers: { Cookie: connection.cookie } });
    this.sockets.set(id, socket);
    let opened = false;

    socket.on("open", () => {
      opened = true;
      void this.post({ type: "socket-opened", id });
    });
    socket.on("message", (data, isBinary) => {
      if (
        channel === "events"
        && (
          isBinary
          || !isEventForCanvas(data.toString(), this.sessionId, this.instanceId)
        )
      ) return;
      const payload = isBinary ? toArrayBuffer(data) : data.toString();
      void this.post({ type: "socket-message", id, data: payload });
    });
    socket.on("error", (error) => {
      if (!opened) {
        this.invalidateConnection(connection);
      }
      void this.post({ type: "socket-error", id, message: error.message });
    });
    socket.on("close", (code, reason) => {
      if (this.sockets.get(id) !== socket) {
        return;
      }
      this.sockets.delete(id);
      void this.post({
        type: "socket-closed",
        id,
        code,
        reason: reason.toString(),
      });
    });
  }

  private closeSocket(id: string): void {
    const socket = this.sockets.get(id);
    if (!socket) {
      return;
    }
    socket.terminate();
  }

  private closeSockets(): void {
    for (const socket of this.sockets.values()) {
      socket.terminate();
    }
  }

  private async save(
    id: string,
    suggestedName: string,
    bytes: ArrayBuffer,
  ): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const base = folder?.scheme === "file" ? folder : vscode.Uri.file(homedir());
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(base, basename(suggestedName)),
      filters: { PNG: ["png"] },
    });
    if (!target) {
      await this.post({ type: "operation-result", id, cancelled: true });
      return;
    }
    await vscode.workspace.fs.writeFile(target, new Uint8Array(bytes));
    await this.post({ type: "operation-result", id });
  }

  private apiUrl(path: string, connection: HostConnection): URL {
    if (
      !path.startsWith("/api/v1/") && !path.startsWith("/ws/")
    ) {
      throw new Error(`Invalid Mobile Canvas host path: ${path}`);
    }
    const url = new URL(path, connection.baseUrl);
    const validPath = path.startsWith("/api/v1/")
      ? url.pathname.startsWith("/api/v1/")
      : url.pathname === "/ws/video" || url.pathname === "/ws/events";
    if (url.origin !== connection.baseUrl.origin || !validPath) {
      throw new Error("Mobile Canvas requests must remain on the local host.");
    }
    return url;
  }

  private async closeCanvas(): Promise<void> {
    this.closeSockets();
    if (!this.connectPromise) {
      return;
    }

    try {
      await this.connectPromise;
    } catch {
      return;
    }
    await execFileAsync(
      this.command,
      [
        "canvas",
        "close",
        "--session",
        this.sessionId,
        "--instance",
        this.instanceId,
        "--json",
      ],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: REQUEST_TIMEOUT_MS,
      },
    );
  }

  private async readSelectedDeviceId(): Promise<string | undefined> {
    if (!this.connectPromise) return undefined;
    try {
      const connection = await this.connectPromise;
      const response = await fetch(this.apiUrl("/api/v1/selection", connection), {
        headers: { Cookie: connection.cookie },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(
          `selection query failed: ${response.status} ${response.statusText}`,
        );
      }
      const selection = await response.json() as {
        hasSelection?: boolean;
        device?: { id?: string };
      };
      return selection.hasSelection && typeof selection.device?.id === "string"
        ? selection.device.id
        : undefined;
    } catch (error) {
      this.output.appendLine(
        `Mobile Canvas could not preserve the selection: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  private async restoreSelection(connection: HostConnection): Promise<void> {
    const deviceId = this.selectionToRestore;
    this.selectionToRestore = undefined;
    if (!deviceId) return;
    try {
      const response = await fetch(this.apiUrl("/api/v1/selection", connection), {
        method: "POST",
        headers: {
          Cookie: connection.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deviceId }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(
          `selection restore failed: ${response.status} ${response.statusText}`,
        );
      }
    } catch (error) {
      this.output.appendLine(
        `Mobile Canvas could not restore ${deviceId}: ${errorMessage(error)}`,
      );
    }
  }

  private invalidateConnection(connection?: HostConnection): void {
    if (connection && this.connection !== connection) {
      return;
    }
    this.closeSockets();
    this.connection = undefined;
    this.connectPromise = undefined;
  }

  private post(message: ExtensionMessage): Thenable<boolean> {
    return this.webview.postMessage(message);
  }

  private readonly onRefreshSignal = (): void => {
    if (this.disposed) return;
    try {
      const content = readFileSync(this.refreshSignal!, "utf8");
      if (content.length < this.signalOffset) {
        this.signalOffset = 0;
      }
      const pending = content.slice(this.signalOffset);
      const completeLength = pending.lastIndexOf("\n") + 1;
      if (completeLength === 0) return;
      this.signalOffset += completeLength;

      for (const line of pending.slice(0, completeLength).split("\n")) {
        if (!line) continue;
        const signal = JSON.parse(line) as {
          type?: unknown;
          activity?: unknown;
        };
        const message = signal.type === "refresh"
          ? { type: "refresh" } as const
          : signal.type === "automation" && isAutomationActivity(signal.activity)
            ? { type: "automation", activity: signal.activity } as const
            : undefined;
        if (!message) {
          throw new Error("The VS Code view signal has an invalid payload.");
        }
        void Promise.resolve(this.post(message)).catch((error) => {
          this.output.appendLine(
            `Mobile Canvas view notification failed: ${errorMessage(error)}`,
          );
        });
      }
    } catch (error) {
      if (!this.disposed) {
        this.output.appendLine(
          `Mobile Canvas view signal failed: ${errorMessage(error)}`,
        );
      }
    }
  };
}

function toArrayBuffer(data: RawData): ArrayBuffer {
  if (data instanceof ArrayBuffer) {
    return data;
  }

  const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) {
      return stderr;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function isConnectionFailure(error: unknown): boolean {
  return error instanceof TypeError;
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1"
    || hostname === "localhost"
    || hostname === "::1"
    || hostname === "[::1]";
}

function isAutomationActivity(value: unknown): value is {
  kind: string;
  deviceId: string;
  x?: number;
  y?: number;
  endX?: number;
  endY?: number;
  duration?: number;
  detail?: string;
} {
  if (!value || typeof value !== "object") return false;
  const activity = value as Record<string, unknown>;
  if (
    typeof activity.kind !== "string"
    || typeof activity.deviceId !== "string"
    || activity.deviceId.length === 0
  ) return false;
  for (const property of ["x", "y", "endX", "endY", "duration"]) {
    const field = activity[property];
    if (field !== undefined && typeof field !== "number") return false;
  }
  return activity.detail === undefined || typeof activity.detail === "string";
}

function isEventForCanvas(
  payload: string,
  sessionId: string,
  instanceId: string,
): boolean {
  try {
    const activity = JSON.parse(payload) as {
      sessionId?: unknown;
      instanceId?: unknown;
    };
    return activity.sessionId === sessionId && activity.instanceId === instanceId;
  } catch {
    return false;
  }
}
