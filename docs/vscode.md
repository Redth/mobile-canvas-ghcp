# Using Mobile Canvas from VS Code

The Mobile Canvas VS Code extension provides the live device view and registers
the same MCP tools used by the GitHub Copilot canvas. It is self-contained: the
VSIX includes the web UI and every supported native runtime.

## Install

Install **Mobile Canvas** from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=redth.mobile-canvas)
or search for it in the VS Code Extensions view. The Marketplace selects the
package matching the machine where the extension host runs.

For prerelease testing, download the `mobile-canvas-vscode-platforms-*` artifact
from a successful GitHub Actions run and select the matching VSIX. A larger
`mobile-canvas-vscode-universal-*` artifact is also available. Install it with
either:

```bash
code --install-extension mobile-canvas-vscode.vsix
```

or **Extensions: Install from VSIX...** in the Command Palette. Reload VS Code,
then open **Mobile** from the Activity Bar.

VS Code 1.101 or newer is required. No separate `mobile-canvas` or .NET tool
installation is needed.

## Use the device view and Copilot tools

The Activity Bar view can list, create, boot, select, and interact with local iOS
Simulators and Android emulators. Its video and input behavior matches the
GitHub Copilot canvas, including H.264 streaming and PNG fallback. The view pane
title follows the selected device. In Auto appearance mode, a VS Code-only style
adapter uses the active theme's `--vscode-*` colors and updates live for light,
dark, and high-contrast themes; the GitHub canvas keeps its existing style set.

New devices boot automatically without opening a separate Simulator or Emulator
window. Use **Show device window** in the toolbar when the native window is
needed; Android restarts the emulator to switch from headless to visible mode.

Activation also registers a **Mobile Canvas** MCP server definition with Copilot
Chat. In Agent mode, enable the `mobile_device_*` tools and ask for actions such
as:

```text
Boot an iPhone 16 simulator and tell me its UDID.
Take a screenshot of the booted Android emulator.
Tap the Sign in button, then swipe up.
```

When a tool targets a device, the VS Code view follows that selection and shows
the automation cursor and accent glow. The panel and MCP process remain separate
clients of the same loopback host, so either can be restarted independently.

### Attach the selected device to chat

After selecting a device in the Mobile view, use the paperclip menu or type one
of these references into Copilot Chat:

- `#mobileDevice` adds the selected device record.
- `#mobileScreenshot` captures and adds a current PNG screenshot.
- `#mobileUiTree` adds the current accessibility hierarchy.

These are zero-argument language-model tools, so they appear as normal chat tool
pills and always resolve against the device selected in this VS Code window.
They use the authenticated extension-host bridge; no host cookie or bootstrap
secret is exposed to the chat input or webview.

VS Code's API for arbitrary custom context providers is still proposed, so the
extension uses the stable attachable-tool API instead. The GitHub Copilot canvas
SDK does not currently expose a composer attachment API; its equivalent device,
screenshot, and UI-tree data remains available through canvas actions and MCP.

## Local execution and remote workspaces

The extension declares `extensionKind: ["ui"]`. It therefore runs on the local
machine even when the current workspace is connected through Remote SSH,
Dev Containers, or Codespaces. This is intentional: Xcode, Android emulators,
and the bundled native executable are local-machine resources.

`vscode.dev` is unsupported because a browser extension host cannot launch the
native runtime or reach local simulators.

All Mobile Canvas traffic remains on `127.0.0.1`. The extension host exchanges
the host's panel-scoped reload grant for a rotating cookie, then relays typed HTTP
requests and binary WebSocket frames. Webview JavaScript receives neither the
bootstrap secret nor the authenticated cookie.

## Manual MCP fallback

The live panel is optional. To expose only the tools from an existing
`mobile-canvas` installation, add this to a workspace or user `mcp.json`:

```json
{
  "servers": {
    "mobile-canvas": {
      "type": "stdio",
      "command": "mobile-canvas",
      "args": ["mcp"]
    }
  }
}
```

Open Copilot Chat in Agent mode and enable the `mobile_device_*` tools. This
manual server is not bound to the Activity Bar view, so agent actions will not
change that view's selection.

## Build and test from source

Dependencies are restored through
`https://packagefeedproxy.microsoft.io/npm/`, configured in `vscode/.npmrc`.

```bash
npm ci --prefix vscode --ignore-scripts
npm test --prefix vscode
npm run package --prefix vscode
```

The package command writes `.build/mobile-canvas-vscode.vsix` and verifies that
it contains all six platform runtimes and their archives, the production web
assets, and no test or source-map files. `npm run package:targets --prefix
vscode` additionally creates six platform-specific packages containing only the
matching runtime. VS Code Marketplace selects these packages automatically.

To debug interactively, run **Run Mobile Canvas VS Code Extension** from the
repository's Run and Debug view. The pre-launch task compiles TypeScript and
stages the shared assets before opening an Extension Development Host.

### Packaging layout

`scripts/prepare-vscode.mjs` recreates `vscode/dist/` from committed sources:

```text
vscode/dist/
  web/
  lib/runtime.mjs
  lib/mcp-vscode-proxy.mjs
  scripts/mcp-vscode.mjs
  runtimes/
  LICENSE
```

The extension imports the same content-addressed runtime resolver as the Copilot
plugin. The matching archive is extracted and checksum-verified on first use;
the other platform archives remain compressed.

The MCP definition uses the positional VS Code API constructor:

```ts
new vscode.McpStdioServerDefinition(label, command, args, env, version)
```

Its `cwd` is assigned afterward. Some older documentation showed an
object-literal constructor that does not match the stable `vscode.d.ts` API.
