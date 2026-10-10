import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { registerChatTools } from "./chatTools";
import { VIEW_ID, VIEW_INSTANCE_ID, MobileCanvasViewProvider } from "./viewProvider";
import { resolveAilohaContextBinding, type AilohaContextBinding } from "./runtime";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Mobile Canvas");
  const viewSessionId = randomUUID();
  const refreshSignal = createRefreshSignal(context);
  const setting = process.env.MOBILE_CANVAS_BACKEND ?? vscode.workspace.getConfiguration("mobileCanvas").get<string>("backend", "legacy");
  if (setting !== "legacy" && setting !== "ailoha") {
    throw new Error("Mobile Canvas backend must be legacy or ailoha; an invalid opt-in never falls back.");
  }
  const backend = setting;
  const mcpChanged = new vscode.EventEmitter<void>();
  const viewProvider = new MobileCanvasViewProvider(
    context,
    output,
    refreshSignal,
    viewSessionId,
    backend,
  );
  const version = (context.extension.packageJSON as { version: string }).version;

  context.subscriptions.push(
    output,
    mcpChanged,
    viewProvider,
    // The canvas is expensive to rebuild: a hidden view otherwise tears the webview down, and
    // coming back re-bootstraps the host session, reloads the catalog, and reconnects the video
    // stream from scratch, which reads as the panel crashing back to its loading state. The page
    // already stops streaming and drops its sockets while hidden (MobileCanvasViewProvider wires
    // onDidChangeVisibility to HostBridge.setVisible, and the page acts on it in setPanelVisible),
    // so retaining the context keeps no capture running.
    vscode.window.registerWebviewViewProvider(VIEW_ID, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("mobileCanvas.open", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.mobileCanvas");
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand("mobileCanvas.refresh", () =>
      viewProvider.refresh(),
    ),
    ...registerChatTools(viewProvider),
    viewProvider.onDidOpenAilohaContext(() => mcpChanged.fire()),
    vscode.lm.registerMcpServerDefinitionProvider("mobileCanvas.mcp", {
      onDidChangeMcpServerDefinitions: mcpChanged.event,
      provideMcpServerDefinitions: async () => {
        const binding = backend === "ailoha" ? await resolveAilohaContextBinding(
          context, { sessionId: viewSessionId, viewId: VIEW_INSTANCE_ID },
        ) : undefined;
        return [createMcpDefinition(
          context.extensionUri,
          context.asAbsolutePath("dist/scripts/mcp-vscode.mjs"),
          version,
          viewSessionId,
          refreshSignal,
          backend,
          binding,
        )];
      },
    }),
  );
}

export function createMcpDefinition(
  extensionUri: vscode.Uri,
  script: string,
  version: string,
  sessionId: string,
  refreshSignal: string,
  backend: "legacy" | "ailoha" = "legacy",
  binding?: AilohaContextBinding,
): vscode.McpStdioServerDefinition {
  const definition = new vscode.McpStdioServerDefinition(
    "Mobile Canvas",
    process.execPath,
    [
      script,
      "--session",
      sessionId,
      "--instance",
      VIEW_INSTANCE_ID,
      ...(backend === "ailoha" ? [
        "--context", requireAilohaBinding(binding).contextRef,
        "--context-epoch", requireAilohaBinding(binding).scopeEpoch,
        "--owner-process", String(requireAilohaBinding(binding).ownerProcessId),
      ] : []),
    ],
    {
      ELECTRON_RUN_AS_NODE: "1",
      MOBILE_CANVAS_VSCODE_REFRESH_SIGNAL: refreshSignal,
      ...(backend === "ailoha" ? { MOBILE_CANVAS_BACKEND: "ailoha" } : {}),
    },
    version,
  );
  definition.cwd = extensionUri;
  return definition;
}

function requireAilohaBinding(binding: AilohaContextBinding | undefined): AilohaContextBinding {
  if (!binding) throw new Error("An explicit named Ailoha view context is required.");
  return binding;
}

function createRefreshSignal(context: vscode.ExtensionContext): string {
  mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
  const path = join(
    context.globalStorageUri.fsPath,
    `refresh-${process.pid}-${randomUUID()}.signal`,
  );
  writeFileSync(path, "", { encoding: "utf8", mode: 0o600 });
  context.subscriptions.push({
    dispose: () => rmSync(path, { force: true }),
  });
  return path;
}

export function deactivate(): void {}
