import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { registerChatTools } from "./chatTools";
import { VIEW_ID, VIEW_INSTANCE_ID, MobileCanvasViewProvider } from "./viewProvider";

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
    vscode.lm.registerMcpServerDefinitionProvider("mobileCanvas.mcp", {
      provideMcpServerDefinitions: () => [
        createMcpDefinition(
          context.extensionUri,
          context.asAbsolutePath("dist/scripts/mcp-vscode.mjs"),
          version,
          viewSessionId,
          refreshSignal,
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
    ],
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
