import * as vscode from "vscode";
import type {
  SelectedDeviceContext,
  SelectedWindowsAppContext,
} from "./hostBridge";

export const CHAT_TOOL_NAMES = {
  selectedDevice: "mobileCanvas_selectedDevice",
  screenshot: "mobileCanvas_screenshot",
  uiTree: "mobileCanvas_uiTree",
} as const;

export const WINDOWS_CHAT_TOOL_NAMES = {
  selectedApp: "windowsCanvas_selectedApp",
  screenshot: "windowsCanvas_screenshot",
  uiTree: "windowsCanvas_uiTree",
} as const;

export interface MobileDeviceContextSource {
  getSelectedDeviceContext(): Promise<SelectedDeviceContext>;
  getSelectedScreenshot(): Promise<{
    context: SelectedDeviceContext;
    bytes: Uint8Array;
  }>;
  getSelectedUiTree(): Promise<{
    context: SelectedDeviceContext;
    tree: unknown;
  }>;
}

export function registerChatTools(
  source: MobileDeviceContextSource,
): vscode.Disposable[] {
  return [
    vscode.lm.registerTool(
      CHAT_TOOL_NAMES.selectedDevice,
      new SelectedDeviceTool(source),
    ),
    vscode.lm.registerTool(
      CHAT_TOOL_NAMES.screenshot,
      new ScreenshotTool(source),
    ),
    vscode.lm.registerTool(
      CHAT_TOOL_NAMES.uiTree,
      new UiTreeTool(source),
    ),
  ];
}

class SelectedDeviceTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private readonly source: MobileDeviceContextSource) {}

  async invoke(): Promise<vscode.LanguageModelToolResult> {
    const context = await this.source.getSelectedDeviceContext();
    return new vscode.LanguageModelToolResult([
      jsonTextPart(context.selection),
    ]);
  }

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: "Reading the selected mobile device" };
  }
}

class ScreenshotTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private readonly source: MobileDeviceContextSource) {}

  async invoke(): Promise<vscode.LanguageModelToolResult> {
    const screenshot = await this.source.getSelectedScreenshot();
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `Current screenshot of ${screenshot.context.deviceLabel} (${screenshot.context.deviceId}).`,
      ),
      vscode.LanguageModelDataPart.image(screenshot.bytes, "image/png"),
    ]);
  }

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: "Capturing the selected mobile device" };
  }
}

class UiTreeTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private readonly source: MobileDeviceContextSource) {}

  async invoke(): Promise<vscode.LanguageModelToolResult> {
    const snapshot = await this.source.getSelectedUiTree();
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `Accessibility tree for ${snapshot.context.deviceLabel} (${snapshot.context.deviceId}).`,
      ),
      jsonTextPart(snapshot.tree),
    ]);
  }

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: "Reading the selected device UI tree" };
  }
}

export interface WindowsAppContextSource {
  getSelectedWindowsApp(): Promise<SelectedWindowsAppContext>;
  getSelectedWindowsScreenshot(): Promise<{
    context: SelectedWindowsAppContext;
    bytes: Uint8Array;
  }>;
  getSelectedWindowsUiTree(): Promise<{
    context: SelectedWindowsAppContext;
    tree: unknown;
  }>;
}

export function registerWindowsChatTools(
  source: WindowsAppContextSource,
): vscode.Disposable[] {
  return [
    vscode.lm.registerTool(
      WINDOWS_CHAT_TOOL_NAMES.selectedApp,
      new SelectedWindowsAppTool(source),
    ),
    vscode.lm.registerTool(
      WINDOWS_CHAT_TOOL_NAMES.screenshot,
      new WindowsScreenshotTool(source),
    ),
    vscode.lm.registerTool(
      WINDOWS_CHAT_TOOL_NAMES.uiTree,
      new WindowsUiTreeTool(source),
    ),
  ];
}

class SelectedWindowsAppTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private readonly source: WindowsAppContextSource) {}

  async invoke(): Promise<vscode.LanguageModelToolResult> {
    const context = await this.source.getSelectedWindowsApp();
    return new vscode.LanguageModelToolResult([
      jsonTextPart(context.selection),
    ]);
  }

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: "Reading the attached Windows app" };
  }
}

class WindowsScreenshotTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private readonly source: WindowsAppContextSource) {}

  async invoke(): Promise<vscode.LanguageModelToolResult> {
    const screenshot = await this.source.getSelectedWindowsScreenshot();
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `Current screenshot of ${screenshot.context.windowLabel} (${screenshot.context.windowId}).`,
      ),
      vscode.LanguageModelDataPart.image(screenshot.bytes, "image/png"),
    ]);
  }

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: "Capturing the attached Windows app" };
  }
}

class WindowsUiTreeTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private readonly source: WindowsAppContextSource) {}

  async invoke(): Promise<vscode.LanguageModelToolResult> {
    const snapshot = await this.source.getSelectedWindowsUiTree();
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `UI Automation tree for ${snapshot.context.windowLabel} (${snapshot.context.windowId}).`,
      ),
      jsonTextPart(snapshot.tree),
    ]);
  }

  prepareInvocation(): vscode.PreparedToolInvocation {
    return { invocationMessage: "Reading the attached Windows app UI tree" };
  }
}

function jsonTextPart(value: unknown): vscode.LanguageModelTextPart {
  return new vscode.LanguageModelTextPart(JSON.stringify(value));
}
