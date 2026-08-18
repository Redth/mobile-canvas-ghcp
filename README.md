# Mobile Canvas

<p align="center">
  <a href="#github-copilot-app"><img alt="Install the GitHub Copilot plugin" src="https://img.shields.io/badge/GitHub_Copilot-install_plugin-24292f?logo=githubcopilot&logoColor=white"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=redth.mobile-canvas"><img alt="Install from the Visual Studio Marketplace" src="https://img.shields.io/visual-studio-marketplace/v/redth.mobile-canvas?label=VS%20Marketplace&logo=visualstudiocode"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=redth.mobile-canvas"><img alt="Visual Studio Marketplace installs" src="https://img.shields.io/visual-studio-marketplace/i/redth.mobile-canvas?logo=visualstudiocode"></a>
  <a href="https://github.com/Redth/mobile-canvas-ghcp/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/Redth/mobile-canvas-ghcp/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

View, create, boot, and **interact with** local iOS Simulators and Android
emulators without leaving GitHub Copilot or VS Code. Mobile Canvas gives your
agent the same controls through MCP, so it can deploy, navigate, inspect, and
capture evidence on the device you are watching.

<p align="center">
  <img src="assets/preview.png" width="920" alt="Mobile Canvas showing live iOS and Android devices side by side">
</p>

Live H.264 video at ~58 FPS on iOS and ~50 FPS on Android, with real tap, drag,
scroll, and keyboard input. Everything runs locally on loopback; nothing is
uploaded anywhere.

On Windows the same bundle also ships **Windows App**, a separate canvas and a
separate VS Code view for launching, attaching to, inspecting, and controlling
local Windows desktop apps. It is a sibling product, not a mobile device: see
[Windows apps](#windows-apps).

## Install

### GitHub Copilot app

Add this repository as a Copilot plugin marketplace, install **mobile-canvas**,
then open the **Mobile Device** canvas:

```text
/plugin marketplace add Redth/mobile-canvas-ghcp
/plugin install mobile-canvas@mobile-canvas-ghcp
```

Reload Copilot after installation. The plugin registers the canvas and all
`mobile_device_*` tools together; there is no separate executable download.

The plugin ships two canvases from one install. **Mobile Device** is available
everywhere; **Windows App** registers itself only when Copilot is running on
Windows, so a macOS or Linux install sees exactly what it always has.

<p align="center">
  <img src="assets/github-copilot-canvas.png" width="1100" alt="Mobile Canvas running as a maximized canvas in the GitHub Copilot app">
</p>

### VS Code

<p>
  <a href="https://marketplace.visualstudio.com/items?itemName=redth.mobile-canvas"><img alt="Install Mobile Canvas from the Visual Studio Marketplace" src="https://img.shields.io/badge/Visual_Studio_Marketplace-Install_Mobile_Canvas-007ACC?logo=visualstudiocode&logoColor=white"></a>
</p>

Install **Mobile Canvas** from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=redth.mobile-canvas),
reload VS Code, and open **Mobile** from the Activity Bar. The Marketplace
automatically selects the package matching your platform.

<p align="center">
  <img src="assets/vscode-extension.png" width="900" alt="Mobile Canvas running in the VS Code Activity Bar with a live iOS Simulator">
</p>

The extension includes the native runtimes and registers the
`mobile_device_*` tools with Copilot Chat automatically. No global tool or
`mcp.json` is required. See the [VS Code guide](docs/vscode.md) for remote
workspace behavior, manual MCP setup, and development commands.

On Windows the same extension adds a second Activity Bar item, **Windows**, with
a **Windows App** view. It is hidden on every other platform.

Both hosts still require Xcode for iOS or the Android SDK for Android; see
[Requirements](#requirements).

## Give Copilot hands and eyes

Mobile Canvas lets an agent work on the same device you see. Ask Copilot to
reproduce a bug, navigate a flow, capture evidence, or inspect accessibility
without switching tools or wiring up a separate MCP server.

```text
Boot an iPhone simulator, install my app, and walk through sign in.
Find the Settings button on the Android emulator and tap it.
Take a screenshot of the current screen and describe any layout issues.
```

Agent actions automatically select the target device. An animated cursor and
accent glow make every automated interaction visible, so you can follow along
and take over at any time.

<table>
  <tr>
    <td width="50%"><img src="assets/agent-ios.png" alt="Copilot interacting with an iOS Simulator in Mobile Canvas"></td>
    <td width="50%"><img src="assets/agent-android.png" alt="Copilot interacting with an Android emulator in Mobile Canvas"></td>
  </tr>
</table>

## What it does

**Device management**

- Discover installed runtimes/system images, device types, and existing devices.
- Create and automatically boot devices headlessly, then restart, shut down, show their native
  window, erase, or delete them. Showing an Android emulator restarts it with its window enabled.
- Erase and delete always require an explicit confirmation.

**Live interaction**

- Live Annex-B H.264 decoded with WebCodecs, with automatic PNG polling
  whenever the stream is unavailable.
- Tap, long press, drag, swipe, wheel scroll, text, keys, and device buttons,
  mapped correctly at every view scale and orientation.
- PNG screenshots and bounded video recordings written to disk.

**Agent control**

- 24 MCP tools mirroring the 24 canvas actions one-to-one.
- Every target-changing call returns the full device record, including the
  `udid`/serial you need to hand to a deploy command.
- When an agent drives the device, the canvas shows an accent-coloured glow and
  an animated cursor so a human watching can tell automation from their own
  input.

## Windows apps

On Windows the same install adds a second, separate product: the **Windows App**
canvas and the **Windows** Activity Bar view. It is not a mobile device — launch,
window, and accessibility semantics are materially different — so it has its own
canvas, its own view, its own `/api/v1/windows/` surface, and its own
`windows_app_*` tools. Mobile Canvas is unchanged by it.

- Search installed apps from AppsFolder, packaged app identities, Start Menu
  shortcuts, and App Paths. Apps that share a friendly name are shown as
  ambiguous candidates rather than picked for you, and an app with no
  registration at all is launched by absolute path with a discrete argument list.
- Launch a catalog app, launch an explicit executable, or attach to a window that
  is already open. Launching or attaching authorizes that app session
  immediately; there is no extra per-action prompt.
- Every positively correlated top-level window of that app becomes a tab. New
  windows and dialogs appear on their own; nothing else on the desktop is
  included, and two windows are never conflated.
- The selected tab streams live Annex-B H.264 over the authenticated WebSocket
  and decodes with WebCodecs, falling back to screenshot polling when that is
  unavailable. Minimized windows pause with a restore action, and a resize or DPI
  change reconnects for a fresh keyframe.
- **UI Automation first.** Dump a bounded tree, search it, and invoke, set,
  select, toggle, expand, collapse, scroll, or focus a real control. Screenshot
  clicks and scrolling default to **Focus-free** mode: the captured point is
  hit-tested against UI Automation and acted on without moving the real cursor.
  If an app's UIA provider takes foreground anyway, the host restores the
  previously active window before completing the action.
- Raw dragging, drawing, shortcuts, and typing have no universal HWND-targeted
  Windows API. They are refused in Focus-free mode; **Foreground control** is an
  explicit opt-in that uses global input and may activate the app and move the
  real cursor. Prefer semantic actions whenever the app exposes them.
- Coordinates are window-relative physical capture pixels and always travel with
  the transform token they were measured against. A window that moved, resized,
  changed DPI, or minimized invalidates the token, and the request is refused
  rather than clicked somewhere else.
- Typed text is never echoed into results or into the panel's activity overlay,
  and password control values are never read or written.
- Elevated, protected-content, and other-session windows are reported as
  unsupported or read-only. No elevation workaround is attempted.

```text
mobile-canvas windows capabilities --json
mobile-canvas windows apps --text notepad --json
mobile-canvas windows launch --app <entryId> --session S --instance I --json
mobile-canvas windows ui-find --window <windowId> --control-type button --name Save --session S --instance I
mobile-canvas windows screenshot --window <windowId> --session S --instance I
```

## Requirements

| | Requirement |
|---|---|
| **iOS** | macOS, Xcode with Simulator runtimes, and [`idb_companion`](https://fbidb.io) for input |
| **Android** | Android SDK with `emulator`, `avdmanager`, and `adb` on `PATH` |
| **Windows apps** | Windows 10 version 1903 or later, an interactive desktop session, and the bundled `windows-app-helper.exe` |
| **Optional iOS fallback** | Screen Recording and Accessibility permission for ScreenCaptureKit |

For iOS input, install `idb_companion` from its Homebrew tap. Current Homebrew
versions require explicitly trusting third-party formulae:

```bash
brew tap facebook/fb
brew trust --formula facebook/fb/idb-companion
brew install facebook/fb/idb-companion
```

Then add the installed executable to your shell environment. For zsh:

```bash
echo "export IDB_COMPANION_PATH=\"$(brew --prefix idb-companion)/bin/idb_companion\"" >> ~/.zshrc
source ~/.zshrc
```

Confirm that the configured path points to the executable:

```bash
test -x "$IDB_COMPANION_PATH" && "$IDB_COMPANION_PATH" --version
```

Android emulators must be started with `-gpu host`. A software-rendered AVD
drops video from ~50 FPS to ~3 FPS.

| Platform | iOS Simulator | Android emulator | Windows apps | Video |
|---|---|---|---|---|
| macOS | yes | yes | no | H.264 |
| Windows | no | yes | yes | H.264 for Windows apps; screenshot polling for Android |
| Linux | no | yes | no | screenshot polling |

iOS control requires `simctl` and `idb`, so it is macOS-only. Android works
everywhere; hardware H.264 encoding for Android currently runs through a macOS
helper, so elsewhere that canvas falls back to screenshot polling. Windows app
control requires the Windows session itself, so it is Windows-only and never
registers anywhere else.

## CLI and source installs

### From source

```bash
git clone https://github.com/Redth/mobile-canvas-ghcp
cd mobile-canvas-ghcp
./scripts/build.sh      # Native AOT binary + universal Swift capture helper
./scripts/install.sh    # Installs into ~/.copilot/extensions/mobile-canvas
```

Reload Copilot afterwards so it picks up the extension. Source installs register
as **Mobile Device (Local)** (`mobile-device-local`) and, on Windows,
**Windows App (Local)** (`windows-app-local`), so a development build can coexist
with the marketplace plugin without registering the same canvas ID twice.

### As a .NET global tool

For a plain CLI/MCP install without the canvas:

```bash
dotnet tool install -g MobileCanvas.Tool
```

## Usage

Ask Copilot to open the **Mobile Device** canvas, or open it from the canvas
picker. Select a running device, or create one from an installed runtime.

From the CLI:

```bash
mobile-canvas devices list --json
mobile-canvas devices boot <id> --wait
mobile-canvas input tap <id> --x 100 --y 200
mobile-canvas screenshot <id> --output shot.png
mobile-canvas host status
mobile-canvas guide
```

Every query command accepts `--json` and `--schema`, so output composes safely
with `jq`.

## Agent tools

All 24 tools are available both as canvas actions and as MCP tools named
`mobile_device_*`:

| Group | Tools |
|---|---|
| Discovery | `list`, `get`, `catalog`, `select`, `get_selected`, `display` |
| Lifecycle | `create`, `boot`, `shutdown`, `restart`, `reveal`, `erase`, `delete` |
| Input | `tap`, `long_press`, `swipe`, `type_text`, `press_key`, `press_button`, `rotate` |
| Media | `screenshot`, `recording_start`, `recording_stop`, `recording_status` |

A typical agent flow is `list` → `select` → read `udid` from the result → deploy
your app to that exact device → drive it with the input tools.

On Windows the **Windows App** canvas contributes its own actions, mirrored as
`windows_app_*` MCP tools and `mobile-canvas windows ...` CLI commands. They are
a separate namespace and never accept a raw window handle:

| Group | Actions |
|---|---|
| Discovery | `get_windows_capabilities`, `search_windows_apps`, `list_running_windows` |
| Session | `launch_windows_app`, `launch_windows_executable`, `attach_windows_window`, `get_windows_app_session`, `release_windows_app_session` |
| Windows | `list_windows_app_windows`, `select_windows_app_window`, `reveal_windows_app_window`, `restore_windows_app_window` |
| Semantic UI | `dump_windows_ui_tree`, `find_windows_ui_elements`, `act_on_windows_ui_element`, `wait_for_windows_ui` |
| Visual input | `capture_windows_screenshot`, `get_windows_geometry`, `click_windows_app`, `drag_windows_app`, `scroll_windows_app`, `press_windows_app_key`, `type_windows_app_text` |

A typical Windows flow is `search_windows_apps` → `launch_windows_app` →
`find_windows_ui_elements` → `act_on_windows_ui_element`, dropping to
`capture_windows_screenshot` plus `click_windows_app` only when a control has no
semantic tree.

## VS Code integration

The Marketplace installs a self-contained package on supported desktop targets;
the universal fallback downloads and verifies its pinned runtime on first use.
Agent actions select and animate the same device in the live Activity Bar view.
The view follows the active VS Code theme while preserving the GitHub canvas
appearance elsewhere. Attach the selected device, a fresh screenshot, or its
accessibility tree to chat with `#mobileDevice`, `#mobileScreenshot`, or
`#mobileUiTree`.

On Windows the separate **Windows** view adds `#windowsApp`, `#windowsScreenshot`,
and `#windowsUiTree` for the attached desktop app. Each view has a fixed product
surface with its own allowlisted HTTP routes and socket channels, so neither can
reach the other's endpoints or see the other's activity.

The extension runs locally for Remote SSH, Dev Containers, and Codespaces.
`vscode.dev` is unsupported.

## Architecture

```text
GitHub Copilot app        VS Code extension          CLI / other agent
  ├─ extension.mjs          ├─ Mobile view             └─ mobile-canvas mcp
  └─ windows-extension.mjs  ├─ Windows view (Win only)         │
       │ canvas actions     └─ MCP context proxy               │
       └──────────────────┬───────────────┬────────────────────┘
                          ▼
                  mobile-canvas host     (per-user, per-protocol singleton)
                    ├─ HTTP + WebSocket UI transport
                    ├─ per-panel, per-surface credentials and state
                    ├─ Mobile surface  /  ·  /api/v1/*  ·  /ws/video, /ws/events
                    │    └─ platform backends
                    │         ├─ iOS      simctl + CoreSimulator IOSurface + idb
                    │         └─ Android  emulator gRPC + adb
                    └─ Windows surface  /windows/  ·  /api/v1/windows/*
                         ·  /ws/windows/video, /ws/windows/events
                         └─ windows-app-helper.exe
                              Shell catalog · UI Automation · WGC + Media Foundation
```

Windows apps are deliberately not another `IDeviceBackend`: their launch,
process, window, and accessibility semantics are materially different from
simulator lifecycle, so they get their own contracts, service, routes, and tools
rather than being bent into the mobile model. Both surfaces share the host
process, the loopback listener, the bootstrap flow, the runtime resolver, and the
release bundle, and nothing else.

The host is started on demand, binds only to `127.0.0.1`, and authenticates
canvas panels with a scoped reload grant exchanged for a rotating session cookie.
The grant remains in the URL fragment so a host-restored renderer can reconnect
without exposing the credential in an HTTP request.
Every grant, cookie, and automation event is scoped to one panel and one product
surface, so a panel only receives the activity addressed to it and a credential
issued for another surface cannot reach the device API.
Host state under `~/.mobile-canvas` — including the control token in `host.json`
— is kept owner-only: `0700`/`0600` on Unix, and an inheritance-free ACL that
grants only the current account on Windows.
It exits after an idle grace period and **never** shuts down a device
implicitly, so detaching a panel is always safe.

GitHub Copilot and VS Code releases using the same host protocol share the newest
compatible host. Hosts are isolated under `~/.mobile-canvas/hosts/v<protocol>/`,
so an older installation using the legacy location and future incompatible
protocol versions can run at the same time without replacing each other's
process. A release that makes a backwards-incompatible host API change must bump
`MobileCanvasProtocol.Version`; package versions alone do not create extra hosts.

Video is deliberately split from input on both platforms:

| Concern | iOS | Android |
|---|---|---|
| Frames | CoreSimulator IOSurface (ScreenCaptureKit fallback) | emulator gRPC `streamScreenshot` |
| Encode | VideoToolbox H.264 | same VideoToolbox H.264 |
| Input | idb (touch/keys), CoreSimulator `GSEvent` (rotation) | emulator gRPC `streamInputEvent` |
| Lifecycle | `simctl` | `emulator`/`avdmanager` + gRPC |

Raw Android frames are encoded before they reach the browser, so only ~1-2 Mbps
crosses to the canvas instead of the 41-577 MiB/s the emulator emits.

## Development

```bash
dotnet build MobileCanvas.slnx
dotnet test  tests/MobileCanvas.Tests/MobileCanvas.Tests.csproj
npm ci --prefix vscode --ignore-scripts
npm test --prefix vscode
npm run package --prefix vscode
./scripts/build.sh          # builds one architecture into .build/bin/<rid>
./scripts/release.sh        # rebuilds macOS release assets for local validation
```

Two things to know before you change anything:

- **Web assets are embedded resources.** Any change to `web/` needs a
  republish, not a file copy. Both renderers live there: `web/` is the Mobile
  canvas, `web/windows/` is the Windows App canvas, and `web/annexb.js` is the
  Annex-B framing they share. `extension.mjs` and `windows-extension.mjs` are the
  opposite — they are copied directly and are not part of the binary.
- **`dotnet publish` does not build native helpers.** `scripts/build.sh` builds
  the macOS capture helper and, on Windows, `windows-app-helper.exe` beside the
  managed host. Check the latter with
  `windows-app-helper.exe capabilities --json`; unsigned development builds
  report their signature state diagnostically.

Changing `src/` or `native/` requires the **Release runtimes** workflow. It builds
each Native AOT RID on its native OS, publishes checksummed release assets, and
packages both host extensions from those exact binaries. See
[How the executable ships](docs/distribution.md).

## License

MIT. See [LICENSE](LICENSE).
