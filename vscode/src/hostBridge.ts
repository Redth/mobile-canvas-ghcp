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
  WorkspaceInspectionState,
  SemanticInspectionState,
} from "./messages";
import type { WorkspaceRootAdapter, WorkspaceRootError } from "./workspaceRoots";

const execFileAsync = promisify(execFile);
const REQUEST_TIMEOUT_MS = 120_000;
const API_REQUEST_TIMEOUT_MS = 6 * 60_000;
const ALLOWED_METHODS = new Set(["GET", "POST", "DELETE"]);

interface CanvasOpenResult {
  url: string;
  title?: string;
  cookieName?: string;
}

export interface AilohaConnectionRef {
  readonly schema?: string;
  readonly serviceId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly processStartedAt: string;
}

export interface AilohaCanvasHost {
  readonly connectionRef?: AilohaConnectionRef;
  openCanvas(input?: { deviceId?: string }): Promise<CanvasOpenResult>;
  closeCanvas(): Promise<void>;
  invokeAction(name: string, input: Record<string, unknown>): Promise<unknown>;
  workspaceInspection?: {
    snapshot(): WorkspaceInspectionState;
    subscribe(listener: (state: WorkspaceInspectionState) => void): () => void;
    bindRoot(path: string, exclusions?: string[]): WorkspaceInspectionState;
    clearRoot(error?: WorkspaceRootError): WorkspaceInspectionState;
    inspect(): Promise<WorkspaceInspectionState>;
    request(method: string, body?: string): Promise<WorkspaceInspectionState>;
    cancel(): WorkspaceInspectionState;
    invalidate(): WorkspaceInspectionState;
    setVisible(visible: boolean): WorkspaceInspectionState;
  };
  semanticInspection?: {
    snapshot(): SemanticInspectionState;
    subscribe(listener: (state: SemanticInspectionState) => void): () => void;
    request(method: string, body?: string): Promise<SemanticInspectionState>;
    invalidate(): SemanticInspectionState;
    setVisible(visible: boolean): SemanticInspectionState;
  };
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
  private readonly openingSockets = new Set<string>();
  private readonly cancelledSockets = new Set<string>();
  // Sockets we tore down on purpose. `ws` aborts a still-connecting handshake by emitting
  // `error` before `close`, and switching devices closes the previous video socket while it
  // is usually still connecting. Without this set our own teardown is indistinguishable from
  // the host going away, so it would invalidate the connection every device switch.
  private readonly discarded = new WeakSet<WebSocket>();
  private connection: HostConnection | undefined;
  private connectPromise: Promise<HostConnection> | undefined;
  private closeTask: Promise<void> | undefined;
  private disposed = false;
  private signalOffset = 0;
  private selectionToRestore: string | undefined;
  private visibilityTask: Promise<void> = Promise.resolve();
  private visibilityNeedsCleanup = false;
  private visible = true;
  private readonly inspectionSubscription?: () => void;
  private readonly semanticSubscription?: () => void;
  private readonly workspaceSubscription?: vscode.Disposable;

  constructor(
    private readonly command: string | undefined,
    private readonly sessionId: string,
    private readonly instanceId: string,
    private readonly webview: MessageSink,
    private readonly output: LogSink,
    private readonly refreshSignal?: string,
    private readonly ailohaHost?: AilohaCanvasHost,
    private readonly onContextReady?: () => void,
    private readonly workspaceRoots?: WorkspaceRootAdapter,
  ) {
    const inspection = ailohaHost?.workspaceInspection;
    if (inspection) {
      this.inspectionSubscription = inspection.subscribe((state) => {
        void Promise.resolve(this.post({ type: "workspace-inspection", state })).then((delivered) => {
          if (!delivered && !this.disposed) this.output.appendLine("Mobile Canvas workspace evidence was declined by its view.");
        }).catch(() => {
          this.output.appendLine("Mobile Canvas workspace evidence could not be delivered to its view.");
        });
      });
      this.workspaceSubscription = workspaceRoots?.onDidChange(() => inspection.clearRoot());
    }
    if (ailohaHost?.semanticInspection) {
      this.semanticSubscription = ailohaHost.semanticInspection.subscribe((state) => {
        void Promise.resolve(this.post({ type: "semantic-inspection", state })).then((delivered) => {
          if (!delivered && !this.disposed) this.output.appendLine("Mobile Canvas semantic inspection was declined by its view.");
        }).catch(() => this.output.appendLine("Mobile Canvas semantic inspection could not be delivered to its view."));
      });
    }
    if (refreshSignal) {
      this.signalOffset = readFileSync(refreshSignal, "utf8").length;
      watchFile(refreshSignal, { interval: 250 }, this.onRefreshSignal);
    }
  }

  get connectionRef(): AilohaConnectionRef | undefined {
    return this.ailohaHost?.connectionRef;
  }

  async handleMessage(message: WebviewMessage): Promise<void> {
    if (this.disposed) {
      return;
    }

    try {
      switch (message.type) {
        case "ready":
          if (this.ailohaHost?.workspaceInspection) {
            await this.post({ type: "workspace-inspection", state: this.ailohaHost.workspaceInspection.snapshot() });
          }
          if (this.ailohaHost?.semanticInspection) {
            await this.post({ type: "semantic-inspection", state: this.ailohaHost.semanticInspection.snapshot() });
          }
          await this.connect();
          if (this.ailohaHost) this.onContextReady?.();
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
        case "socket-send":
          await this.sendSocket(message);
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
      const text = this.ailohaHost ? ailohaErrorMessage(error) : errorMessage(error);
      if (message.type === "socket-open") {
        await this.post({ type: "socket-error", id: message.id, message: text });
        await this.post({ type: "socket-closed", id: message.id, code: 1006, reason: "" });
      } else if (message.type === "socket-send") {
        await this.post({ type: "operation-error", id: message.requestId, message: text });
      } else if ("id" in message) {
        await this.post({ type: "operation-error", id: message.id, message: text });
      } else {
        await this.post({ type: "fatal", message: text });
      }
      this.output.appendLine(`Mobile Canvas: ${text}`);
    }
  }

  async setVisible(visible: boolean): Promise<void> {
    this.visible = visible;
    this.ailohaHost?.workspaceInspection?.setVisible(visible);
    this.ailohaHost?.semanticInspection?.setVisible(visible);
    const previous = this.visibilityTask;
    const task = previous.then(
      () => this.applyVisibility(visible),
      () => this.applyVisibility(visible),
    );
    this.visibilityTask = task;
    return task;
  }

  private async applyVisibility(visible: boolean): Promise<void> {
    if (this.disposed) return;
    if (visible && this.ailohaHost && this.visibilityNeedsCleanup) {
      await this.ailohaHost.closeCanvas();
      this.invalidateConnection();
      this.visibilityNeedsCleanup = false;
    }
    if (!visible) {
      this.closeSockets();
      if (this.ailohaHost) {
        this.visibilityNeedsCleanup = true;
        this.selectionToRestore = await this.readSelectedDeviceId();
        await this.closeCanvas();
        this.invalidateConnection();
        this.visibilityNeedsCleanup = false;
      }
    }
    await this.post({ type: "visibility", visible });
  }

  async restart(): Promise<void> {
    this.ailohaHost?.workspaceInspection?.invalidate();
    this.ailohaHost?.semanticInspection?.invalidate();
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
    this.semanticSubscription?.();
    this.ailohaHost?.workspaceInspection?.setVisible(false);
    this.inspectionSubscription?.();
    this.workspaceSubscription?.dispose();
    if (this.refreshSignal) {
      unwatchFile(this.refreshSignal, this.onRefreshSignal);
    }
    this.closeSockets();
    this.closeTask = this.closeCanvas().catch((error) => {
      this.output.appendLine(`Mobile Canvas close failed: ${errorMessage(error)}`);
    });
  }

  /**
   * Resolves once the asynchronous `canvas close` kicked off by dispose() has settled. A
   * replacement bridge for the same session/instance must await this before opening, or its
   * `canvas open` can race the previous bridge's still-in-flight close and get torn down by it.
   */
  closed(): Promise<void> {
    const host = this.ailohaHost;
    if (host) return (this.closeTask ?? Promise.resolve()).then(() => host.closeCanvas());
    return this.closeTask ?? Promise.resolve();
  }

  private async connect(): Promise<HostConnection> {
    if (this.disposed) {
      throw new Error("The Mobile Canvas view is closed.");
    }
    const pending = this.connectPromise ??= this.openCanvas();
    try {
      const connection = await pending;
      if (this.disposed) throw new Error("The Mobile Canvas view is closed.");
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
    let result: CanvasOpenResult;
    if (this.ailohaHost) {
      result = await this.ailohaHost.openCanvas();
    } else {
      if (!this.command) throw new Error("The legacy Mobile Canvas runtime is unavailable.");
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
      result = JSON.parse(stdout) as CanvasOpenResult;
    }
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
    const cookieName = this.ailohaHost ? result.cookieName : "mobile_device_session";
    if (!cookieName || !cookie?.startsWith(`${cookieName}=`)) {
      throw new Error("The Mobile Canvas host did not establish a panel session.");
    }

    const connection = { baseUrl, cookie };
    await this.restoreSelection(connection);
    return connection;
  }

  private async forwardApi(
    message: Extract<WebviewMessage, { type: "api" }>,
  ): Promise<void> {
    if (this.ailohaHost?.workspaceInspection && message.path.startsWith("/api/v1/workspace/")) {
      await this.forwardWorkspace(message);
      return;
    }
    if (this.ailohaHost?.semanticInspection && message.path.startsWith("/api/v1/semantic/")) {
      await this.forwardSemantic(message);
      return;
    }
    const method = (message.method ?? "GET").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(`Unsupported Mobile Canvas HTTP method: ${method}`);
    }

    for (let attempt = 0; attempt < (this.ailohaHost ? 1 : 2); attempt += 1) {
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
        if (!this.ailohaHost && response.status === 401 && attempt === 0) {
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
        if (!this.ailohaHost && method === "GET" && attempt === 0 && isConnectionFailure(error)) {
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

  private async forwardWorkspace(message: Extract<WebviewMessage, { type: "api" }>): Promise<void> {
    const inspection = this.ailohaHost?.workspaceInspection;
    if (!inspection) throw new Error("Workspace inspection is not available in this host.");
    const method = (message.method ?? "GET").toUpperCase();
    let result: WorkspaceInspectionState | WorkspaceRootError;
    if (message.path === "/api/v1/workspace/inspection" && ["GET", "POST", "DELETE"].includes(method)) {
      try {
        result = await inspection.request(method, message.body);
      } catch (error) {
        result = {
          code: isRecord(error) && typeof error.code === "string" ? error.code : "workspace_request_failed",
          message: ailohaErrorMessage(error),
          status: isRecord(error) && typeof error.status === "number" ? error.status : 500,
        };
      }

    } else if (message.body?.trim() && message.body.trim() !== "{}") {
      result = { code: "workspace_root_authority_required", message: "Renderer requests cannot supply or enlarge the trusted workspace root.", status: 403 };
    } else if (message.path === "/api/v1/workspace/root" && method === "POST") {
      const generation = inspection.snapshot().generation;
      const choice = await this.workspaceRoots?.choose();
      if (this.disposed) return;
      result = !this.visible || generation !== inspection.snapshot().generation ? inspection.snapshot()
        : choice && "path" in choice ? inspection.bindRoot(choice.path)
          : choice && "error" in choice ? inspection.clearRoot(choice.error)
            : this.workspaceRoots ? inspection.snapshot() : inspection.clearRoot({
              code: "workspace_root_unsupported", message: "This host has no trusted workspace-folder adapter.",
            });
    } else {
      result = { code: "workspace_request_unsupported", message: "Use the named read-only workspace inspection routes.", status: 400 };
    }
    const status = "schema" in result ? result.error?.status ?? 200 : result.status ?? 400;
    if (!("schema" in result)) this.output.appendLine(`Mobile Canvas workspace: ${result.code}: ${result.message}`);
    const response = new Response(JSON.stringify(result), { status, headers: { "Content-Type": "application/json" } });
    await this.post({
      type: "api-result", id: message.id, status, statusText: response.statusText,
      headers: Object.fromEntries(response.headers), body: await response.arrayBuffer(),
    });
  }

  private async forwardSemantic(message: Extract<WebviewMessage, { type: "api" }>): Promise<void> {
    const semantic = this.ailohaHost?.semanticInspection;
    if (!semantic) throw new Error("Semantic inspection is unavailable.");
    const method = (message.method ?? "GET").toUpperCase();
    let result: SemanticInspectionState | { code: string; message: string; status: number };
    if (message.path !== "/api/v1/semantic/inspection" || !["GET", "POST", "DELETE"].includes(method)) {
      result = { code: "semantic_request_unsupported", message: "Use the named read-only semantic inspection route.", status: 400 };
    } else {
      try { result = await semantic.request(method, message.body); }
      catch (error) {
        result = {
          code: isRecord(error) && typeof error.code === "string" ? error.code : "semantic_request_failed",
          message: ailohaErrorMessage(error),
          status: isRecord(error) && typeof error.status === "number" ? error.status : 500,
        };
      }
    }
    const status = "schema" in result ? result.error?.status ?? 200 : result.status;
    const response = new Response(JSON.stringify(result), { status, headers: { "Content-Type": "application/json" } });
    await this.post({
      type: "api-result", id: message.id, status, statusText: response.statusText,
      headers: Object.fromEntries(response.headers), body: await response.arrayBuffer(),
    });
  }

  private async get(path: string): Promise<Response> {
    for (let attempt = 0; attempt < (this.ailohaHost ? 1 : 2); attempt += 1) {
      const connection = await this.connect();
      try {
        const response = await fetch(this.apiUrl(path, connection), {
          headers: { Cookie: connection.cookie },
          signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
        });
        if (!this.ailohaHost && response.status === 401 && attempt === 0) {
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
        if (this.ailohaHost || !isConnectionFailure(error) || attempt > 0) {
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
    if (channel !== "video" && channel !== "events") {
      throw new Error(`Unsupported Mobile Canvas socket channel: ${String(channel)}`);
    }
    this.openingSockets.add(id);
    try {
      const connection = await this.connect();
      if (this.cancelledSockets.delete(id)) {
        await this.post({ type: "socket-closed", id, code: 1000, reason: "" });
        return;
      }
      // The connection can be retired while we await it. Its cookie is already dead, so
      // opening against it would only earn a 401 handshake failure that then invalidates
      // whatever connection replaced it. Report the close and let the canvas reopen.
      if (this.connection !== connection) {
        await this.post({ type: "socket-closed", id, code: 1006, reason: "" });
        return;
      }
      this.closeSocket(id);
      const url = this.apiUrl(`/ws/${channel}`, connection);
      url.search = query ?? "";
      url.protocol = "ws:";
      const protocols = this.ailohaHost && channel === "video" ? ["ailoha.video.v1"] : [];
      const socket = new WebSocket(url, protocols, {
        headers: { Cookie: connection.cookie },
        maxPayload: 8 * 1024 * 1024 + 28,
        perMessageDeflate: false,
        followRedirects: false,
        handshakeTimeout: REQUEST_TIMEOUT_MS,
      });
      this.sockets.set(id, socket);
      let opened = false;

      socket.on("open", () => {
        if (this.sockets.get(id) !== socket || this.discarded.has(socket) || this.disposed) return;
        opened = true;
        void this.postSocket({ type: "socket-opened", id, protocol: socket.protocol }, socket);
      });
      socket.on("message", (data, isBinary) => {
        if (this.sockets.get(id) !== socket || this.discarded.has(socket) || this.disposed) return;
        if (
          channel === "events"
          && (
            isBinary
            || !isEventForCanvas(data.toString(), this.sessionId, this.instanceId)
          )
        ) return;
        const payload = isBinary ? toArrayBuffer(data) : data.toString();
        void this.postSocket({ type: "socket-message", id, data: payload }, socket);
      });
      socket.on("error", (error) => {
        // A socket we retired reports the aborted handshake as an error. That is our doing,
        // not a failed connection, and the canvas already moved on from it.
        if (this.discarded.has(socket)) {
          return;
        }
        if (!opened) {
          this.invalidateConnection(connection);
        }
        void this.postSocket({ type: "socket-error", id, message: this.ailohaHost ? "The owned Ailoha panel socket failed." : error.message }, socket);
      });
      socket.on("close", (code, reason) => {
        if (this.sockets.get(id) !== socket) {
          return;
        }
        this.sockets.delete(id);
        void this.postSocket({
          type: "socket-closed",
          id,
          code,
          reason: this.ailohaHost ? "" : reason.toString(),
        }, socket);
      });
    } finally {
      this.openingSockets.delete(id);
      this.cancelledSockets.delete(id);
    }
  }

  private async sendSocket(
    message: Extract<WebviewMessage, { type: "socket-send" }>,
  ): Promise<void> {
    const socket = this.sockets.get(message.id);
    if (!this.ailohaHost || !socket || socket.protocol !== "ailoha.video.v1" || socket.readyState !== WebSocket.OPEN) {
      await this.post({ type: "operation-error", id: message.requestId, message: "The owned Ailoha video channel is not open." });
      return;
    }
    if (typeof message.data !== "string" || Buffer.byteLength(message.data) > 64 * 1024) {
      await this.post({ type: "operation-error", id: message.requestId, message: "Ailoha video controls must be bounded UTF-8 JSON text." });
      return;
    }
    await new Promise<void>((resolve) => {
      socket.send(message.data, (error) => {
        void Promise.resolve(this.post(error
          ? { type: "operation-error", id: message.requestId, message: "The owned Ailoha control send failed." }
          : { type: "operation-result", id: message.requestId })).then(
          (delivered) => {
            if (!delivered) {
              this.output.appendLine("Mobile Canvas: the owned Ailoha renderer declined a control result.");
              this.discard(socket);
            }
            resolve();
          },
          () => {
            this.output.appendLine("Mobile Canvas: the owned Ailoha renderer control result failed.");
            this.discard(socket);
            resolve();
          },
        );
      });
    });
  }

  private async postSocket(message: ExtensionMessage, socket: WebSocket): Promise<void> {
    try {
      const delivered = await this.post(message);
      if (!delivered && this.ailohaHost) {
        this.output.appendLine("Mobile Canvas: the owned Ailoha renderer declined a socket message.");
        if (!this.discarded.has(socket) && socket.readyState !== WebSocket.CLOSED) this.discard(socket);
      }
    } catch {
      this.output.appendLine(this.ailohaHost
        ? "Mobile Canvas: the owned Ailoha renderer socket delivery failed."
        : "Mobile Canvas: renderer socket delivery failed.");
      if (!this.discarded.has(socket) && socket.readyState !== WebSocket.CLOSED) this.discard(socket);
    }
  }

  private closeSocket(id: string): void {
    const socket = this.sockets.get(id);
    if (!socket) {
      if (this.openingSockets.has(id)) {
        this.cancelledSockets.add(id);
      }
      return;
    }
    this.discard(socket);
  }

  private closeSockets(): void {
    for (const id of this.openingSockets) {
      this.cancelledSockets.add(id);
    }
    for (const socket of this.sockets.values()) {
      this.discard(socket);
    }
  }

  // The map entry stays until `close` fires so the canvas still receives `socket-closed`
  // and can settle its own socket state.
  private discard(socket: WebSocket): void {
    this.discarded.add(socket);
    socket.terminate();
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
      if (this.ailohaHost) await this.ailohaHost.closeCanvas();
      return;
    }
    if (this.ailohaHost) {
      await this.ailohaHost.closeCanvas();
      return;
    }
    if (!this.command) throw new Error("The legacy Mobile Canvas runtime is unavailable.");
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
    if (this.disposed) return Promise.resolve(false);
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

function ailohaErrorMessage(error: unknown): string {
  if (isRecord(error) && error.name === "MobileAilohaError" && typeof error.message === "string") {
    return error.message;
  }
  return "The owned Ailoha bridge request failed; the legacy engine was not used.";
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
