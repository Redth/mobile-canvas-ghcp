# Mobile Canvas for VS Code

Mobile Canvas adds a live iOS Simulator and Android emulator view to the VS Code
Activity Bar. It also registers the bundled Mobile Canvas MCP server with
Copilot Chat, so the editor and agent operate on the same local device.

## Install

Download `mobile-canvas-vscode.vsix` from the CI artifact for a release or pull
request, then run:

```bash
code --install-extension mobile-canvas-vscode.vsix
```

Reload VS Code and open **Mobile** from the Activity Bar. No separate
Mobile Canvas or .NET tool installation is required.

## Features

- Live H.264 video where supported, with PNG polling as a fallback.
- Pointer, keyboard, lifecycle, screenshot, and recording controls.
- Automatic `mobile_device_*` tool registration in Copilot Chat.
- Attachable `#mobileDevice`, `#mobileScreenshot`, and `#mobileUiTree` chat tools
  for the device selected in the Mobile view.
- MCP actions automatically select the device shown in the VS Code view.
- Live VS Code theme colors and a view title that follows the selected device.
- Bundled native runtimes for macOS, Windows, and Linux.

The extension runs in the local UI extension host, including while the current
workspace is remote. It is not supported in `vscode.dev`.

## Platform requirements

- iOS requires macOS, Xcode Simulator runtimes, and `idb_companion`.
- Android requires the Android SDK tools and `adb` on `PATH`.
- macOS may request Screen Recording and Accessibility permission for live iOS
  video and input.

All host traffic remains on loopback. The webview receives neither the host
control token nor its authenticated cookie; VS Code's extension host relays the
local HTTP and WebSocket traffic.

See the [project documentation](https://github.com/Redth/mobile-canvas-ghcp/blob/main/docs/vscode.md)
for development, troubleshooting, and manual MCP setup.
