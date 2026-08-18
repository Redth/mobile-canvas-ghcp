import * as vscode from "vscode";
import {
  HostBridge,
  type SelectedDeviceContext,
} from "./hostBridge";
import type { WebviewMessage } from "./messages";
import { resolveMobileCanvas } from "./runtime";
import { MOBILE_SURFACE } from "./surfaces";
import { createWebviewHtml } from "./webviewHtml";

export const VIEW_ID = "mobileCanvas.deviceView";
export const VIEW_INSTANCE_ID = "mobile-canvas-vscode-view";
export const DEFAULT_VIEW_TITLE = "Device";

interface ViewTitleTarget {
  title?: string;
  description?: string;
}

export function applyViewTitle(
  target: ViewTitleTarget,
  title: string,
  description?: string,
  defaultTitle: string = DEFAULT_VIEW_TITLE,
): void {
  target.title = normalizeTitle(title, 80) || defaultTitle;
  target.description = normalizeTitle(description ?? "", 120) || undefined;
}

export class MobileCanvasViewProvider implements vscode.WebviewViewProvider {
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
    this.output.appendLine(`Mobile Canvas runtime: ${runtime.source}`);
    const bridge = new HostBridge(
      MOBILE_SURFACE,
      runtime.command,
      this.sessionId,
      VIEW_INSTANCE_ID,
      webviewView.webview,
      this.output,
      this.refreshSignal,
    );
    this.bridge = bridge;
    const messageSubscription = webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        if (message.type === "view-title") {
          applyViewTitle(webviewView, message.title, message.description);
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
    webviewView.webview.html = createWebviewHtml(this.context, webviewView.webview, MOBILE_SURFACE);
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      return;
    }
    await this.bridge?.restart();
    this.view.webview.html = createWebviewHtml(this.context, this.view.webview, MOBILE_SURFACE);
  }

  getSelectedDeviceContext(): Promise<SelectedDeviceContext> {
    return this.requireBridge().getSelectedDeviceContext();
  }

  getSelectedScreenshot(): Promise<{
    context: SelectedDeviceContext;
    bytes: Uint8Array;
  }> {
    return this.requireBridge().getSelectedScreenshot();
  }

  getSelectedUiTree(): Promise<{
    context: SelectedDeviceContext;
    tree: unknown;
  }> {
    return this.requireBridge().getSelectedUiTree();
  }

  dispose(): void {
    this.bridge?.dispose();
  }

  private requireBridge(): HostBridge {
    if (!this.bridge) {
      throw new Error(
        "Open Mobile from the Activity Bar and select a device before attaching its context.",
      );
    }
    return this.bridge;
  }
}

function normalizeTitle(value: string, maximumLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
}
