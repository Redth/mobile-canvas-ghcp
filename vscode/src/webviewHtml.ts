import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { type SurfaceConfig, type SurfaceId } from "./surfaces";

/**
 * Per-surface webview template: the prepared host HTML to load, plus the two markers that host page
 * carries and the shared assets that replace them. Only these differ between surfaces; the CSP,
 * nonce, host theme override, and transport shim are identical for both.
 */
interface WebviewSurfaceAssets {
  htmlPath: string;
  styleMarker: string;
  styleAsset: readonly string[];
  scriptMarker: string;
  scriptAsset: readonly string[];
}

const WEBVIEW_ASSETS: Record<SurfaceId, WebviewSurfaceAssets> = {
  mobile: {
    htmlPath: "dist/web/index.html",
    styleMarker: '<link rel="stylesheet" href="/device-canvas.css">',
    styleAsset: ["dist", "web", "device-canvas.css"],
    scriptMarker: '<script type="module" src="/device-canvas.js"></script>',
    scriptAsset: ["dist", "web", "device-canvas.js"],
  },
  windows: {
    htmlPath: "dist/web/windows/index.html",
    styleMarker: '<link rel="stylesheet" href="/windows/windows-canvas.css">',
    styleAsset: ["dist", "web", "windows", "windows-canvas.css"],
    scriptMarker: '<script type="module" src="/windows/windows-canvas.js"></script>',
    scriptAsset: ["dist", "web", "windows", "windows-canvas.js"],
  },
};

export function createWebviewHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  surface: SurfaceConfig,
): string {
  const assets = WEBVIEW_ASSETS[surface.id];
  const htmlPath = context.asAbsolutePath(assets.htmlPath);
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, ...assets.styleAsset),
  );
  const hostStyleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "vscode-theme.css"),
  );
  const sharedScriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, ...assets.scriptAsset),
  );
  const hostThemeUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "vscode-theme.js"),
  );
  const transportUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "vscode-transport.js"),
  );
  const nonce = createNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} blob: data:`,
  ].join("; ");

  let html = readFileSync(htmlPath, "utf8");
  html = replaceOnce(
    html,
    '<meta charset="utf-8">',
    `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`,
  );
  html = replaceOnce(
    html,
    assets.styleMarker,
    `<link rel="stylesheet" href="${styleUri}">\n  `
      + `<link rel="stylesheet" href="${hostStyleUri}">`,
  );
  html = replaceOnce(
    html,
    assets.scriptMarker,
    `<script nonce="${nonce}" src="${hostThemeUri}"></script>\n  `
      + `<script nonce="${nonce}" src="${transportUri}"></script>\n  `
      + `<script nonce="${nonce}" type="module" src="${sharedScriptUri}"></script>`,
  );
  return html;
}

function replaceOnce(source: string, marker: string, replacement: string): string {
  const first = source.indexOf(marker);
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`Expected exactly one webview template marker: ${marker}`);
  }
  return source.replace(marker, replacement);
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}
