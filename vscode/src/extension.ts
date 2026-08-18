import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { registerChatTools, registerWindowsChatTools } from "./chatTools";
import { VIEW_ID, VIEW_INSTANCE_ID, MobileCanvasViewProvider } from "./viewProvider";
import {
  WINDOWS_VIEW_ID,
  WINDOWS_VIEW_INSTANCE_ID,
  WindowsCanvasViewProvider,
} from "./windowsViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Mobile Canvas");
  const viewSessionId = randomUUID();
  const refreshSignal = createRefreshSignal(context);
  const viewProvider = new MobileCanvasViewProvider(
    context,
    output,
    refreshSignal,
    viewSessionId,
  );
  const version = (context.extension.packageJSON as { version: string }).version;

  // The Windows App is a Windows-only sibling product. Everything it contributes is registered only
  // on win32 and behind the `mobileCanvas.windowsSupported` context key so a macOS or Linux VS Code
  // registers nothing Windows-specific and its activity-bar container stays hidden.
  const windowsSupported = process.platform === "win32";
  void vscode.commands.executeCommand(
    "setContext",
    "mobileCanvas.windowsSupported",
    windowsSupported,
  );

  context.subscriptions.push(
    output,
    viewProvider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, viewProvider),
    vscode.commands.registerCommand("mobileCanvas.open", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.mobileCanvas");
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand("mobileCanvas.refresh", () =>
      viewProvider.refresh(),
    ),
    ...registerChatTools(viewProvider),
  );

  // The Windows MCP tools take a session and instance the model cannot know; the proxy injects the
  // Windows view's identity for them. Only advertise that instance to the bridge on Windows.
  let windowsInstanceId: string | undefined;
  if (windowsSupported) {
    const windowsOutput = vscode.window.createOutputChannel("Windows App");
    // A dedicated refresh signal keeps the Windows view isolated from Mobile view notifications.
    const windowsRefreshSignal = createRefreshSignal(context);
    const windowsViewProvider = new WindowsCanvasViewProvider(
      context,
      windowsOutput,
      windowsRefreshSignal,
      viewSessionId,
    );
    windowsInstanceId = WINDOWS_VIEW_INSTANCE_ID;
    context.subscriptions.push(
      windowsOutput,
      windowsViewProvider,
      vscode.window.registerWebviewViewProvider(WINDOWS_VIEW_ID, windowsViewProvider),
      vscode.commands.registerCommand("windowsCanvas.open", async () => {
        await vscode.commands.executeCommand("workbench.view.extension.windowsCanvas");
        await vscode.commands.executeCommand(`${WINDOWS_VIEW_ID}.focus`);
      }),
      vscode.commands.registerCommand("windowsCanvas.refresh", () =>
        windowsViewProvider.refresh(),
      ),
      ...registerWindowsChatTools(windowsViewProvider),
    );
  }

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider("mobileCanvas.mcp", {
      provideMcpServerDefinitions: () => [
        createMcpDefinition(
          context.extensionUri,
          context.asAbsolutePath("dist/scripts/mcp-vscode.mjs"),
          version,
          viewSessionId,
          refreshSignal,
          windowsInstanceId,
        ),
      ],
    }),
  );
}

export function createMcpDefinition(
  extensionUri: vscode.Uri,
  script: string,
  version: string,
  sessionId: string,
  refreshSignal: string,
  windowsInstanceId?: string,
): vscode.McpStdioServerDefinition {
  const args = [
    script,
    "--session",
    sessionId,
    "--instance",
    VIEW_INSTANCE_ID,
  ];
  // Appended, so the existing (mobile-only) argument order is unchanged when no Windows view exists.
  if (windowsInstanceId) {
    args.push("--windows-instance", windowsInstanceId);
  }
  const definition = new vscode.McpStdioServerDefinition(
    "Mobile Canvas",
    process.execPath,
    args,
    {
      ELECTRON_RUN_AS_NODE: "1",
      MOBILE_CANVAS_VSCODE_REFRESH_SIGNAL: refreshSignal,
    },
    version,
  );
  definition.cwd = extensionUri;
  return definition;
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
