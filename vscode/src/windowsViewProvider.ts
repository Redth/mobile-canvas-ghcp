import * as vscode from "vscode";
import {
  HostBridge,
  type SelectedWindowsAppContext,
} from "./hostBridge";
import type { WebviewMessage } from "./messages";
import { resolveMobileCanvas } from "./runtime";
import { WINDOWS_SURFACE } from "./surfaces";
import { applyViewTitle } from "./viewProvider";
import { createWebviewHtml } from "./webviewHtml";

export const WINDOWS_VIEW_ID = "windowsCanvas.appView";
export const WINDOWS_VIEW_INSTANCE_ID = "windows-canvas-vscode-view";
export const DEFAULT_WINDOWS_VIEW_TITLE = "Windows App";

export class WindowsCanvasViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private bridge: HostBridge | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly refreshSignal: string,
    private readonly sessionId: string,
  ) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.bridge?.dispose();
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist", "web"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    const runtime = await resolveMobileCanvas(this.context);
    this.output.appendLine(`Windows App runtime: ${runtime.source}`);
    const bridge = new HostBridge(
      WINDOWS_SURFACE,
      runtime.command,
      this.sessionId,
      WINDOWS_VIEW_INSTANCE_ID,
      webviewView.webview,
      this.output,
      this.refreshSignal,
    );
    this.bridge = bridge;
    const messageSubscription = webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        if (message.type === "view-title") {
          applyViewTitle(
            webviewView,
            message.title,
            message.description,
            DEFAULT_WINDOWS_VIEW_TITLE,
          );
          return;
        }
        void bridge.handleMessage(message);
      },
    );
    const visibilitySubscription = webviewView.onDidChangeVisibility(
      () => void bridge.setVisible(webviewView.visible),
    );
    const disposeSubscription = webviewView.onDidDispose(
      () => {
        if (this.bridge === bridge) {
          this.bridge = undefined;
          this.view = undefined;
        }
        bridge.dispose();
      },
    );
    this.context.subscriptions.push(
      messageSubscription,
      visibilitySubscription,
      disposeSubscription,
    );

    // Attach the bridge before loading the document so its initial ready
    // message cannot be lost while the runtime is resolving.
    webviewView.webview.html = createWebviewHtml(
      this.context,
      webviewView.webview,
      WINDOWS_SURFACE,
    );
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      await vscode.commands.executeCommand(`${WINDOWS_VIEW_ID}.focus`);
      return;
    }
    await this.bridge?.restart();
    this.view.webview.html = createWebviewHtml(
      this.context,
      this.view.webview,
      WINDOWS_SURFACE,
    );
  }

  getSelectedWindowsApp(): Promise<SelectedWindowsAppContext> {
    return this.requireBridge().getSelectedWindowsApp();
  }

  getSelectedWindowsScreenshot(): Promise<{
    context: SelectedWindowsAppContext;
    bytes: Uint8Array;
  }> {
    return this.requireBridge().getSelectedWindowsScreenshot();
  }

  getSelectedWindowsUiTree(): Promise<{
    context: SelectedWindowsAppContext;
    tree: unknown;
  }> {
    return this.requireBridge().getSelectedWindowsUiTree();
  }

  dispose(): void {
    this.bridge?.dispose();
  }

  private requireBridge(): HostBridge {
    if (!this.bridge) {
      throw new Error(
        "Open Windows from the Activity Bar and attach an app before attaching its context.",
      );
    }
    return this.bridge;
  }
}
