# Mobile Canvas compatibility baseline

This is the pre-cutover public contract for the GitHub Copilot canvas, VS Code
extension, CLI, and MCP server. It was inspected at Mobile Canvas
`2946d8f26db87e5541b23f6c378dcaa8d20c4a2e` (version `0.1.18`, 2026-10-09).
It records existing behavior, not an Ailoha implementation. See the
[approved integration roadmap](ailoha-integration-roadmap.md) for future work.

## Installed identities and entry points

| Surface | Current identity |
| --- | --- |
| Copilot plugin | Plugin `mobile-canvas`, from `.github/plugin/plugin.json`; installation commands are `/plugin marketplace add Redth/mobile-canvas-ghcp` and `/plugin install mobile-canvas@mobile-canvas-ghcp`. |
| Installed plugin canvas | Canvas ID `mobile-device`, display name `Mobile Device`. |
| Source/local canvas | Canvas ID `mobile-device-local`, display name `Mobile Device (Local)`. Do not register the local ID as the installed plugin canvas. |
| VS Code extension | Publisher/name ID `redth.mobile-canvas`; display name `Mobile Canvas`. |
| VS Code view | Activity Bar container `mobileCanvas`; view `mobileCanvas.deviceView`; displayed view name `Device`. |
| VS Code commands | `mobileCanvas.open` and `mobileCanvas.refresh`. |
| VS Code MCP registration | Definition provider ID `mobileCanvas.mcp`, label `Mobile Canvas`; MCP server name `mobile-canvas`. |
| VS Code chat references | `#mobileDevice`, `#mobileScreenshot`, and `#mobileUiTree`, backed by `mobileCanvas_selectedDevice`, `mobileCanvas_screenshot`, and `mobileCanvas_uiTree`. |
| CLI | Executable/command root `mobile-canvas`; .NET global tool package `MobileCanvas.Tool`. |

Keep the `mobile-canvas` CLI command namespaces and their current meanings:
`host`, `canvas`, `devices`, `input`, `ui`, `app`, `log`, `crashes`, `file`,
`permission`, `app-op`, `presentation`, `settings`, `hardware`, `location`,
`battery`, `network`, `notification`, `sms`, `call`, `biometric`, `clipboard`,
`media`, `screenshot`, `recording`, `mcp`, and `guide`. The current argument
forms and flags are listed in
[`DeviceCli.cs`](../src/MobileCanvas.Tool/DeviceCli.cs); destructive commands
retain their explicit `--confirm` flag.

The canonical installed Copilot workflow is to install the `mobile-canvas`
plugin and open **Mobile Device**. The VS Code workflow is to install
**Mobile Canvas** from the Marketplace and open **Mobile** in the Activity Bar.
The GitHub plugin and VS Code extension are two hosts for this same product;
host-specific IDs above remain distinct and stable through engine migration.

## Generated surface inventory

The existing authoritative extractor is
[`scripts/ailoha-source-manifest.mjs`](../scripts/ailoha-source-manifest.mjs),
invoked with `npm run ailoha:manifest`. It reads the current backend interface,
HTTP/WebSocket route literals, MCP `Name` attributes, and canvas action
declarations; it records sorted inventories in the content-authenticated
`surfaces` object along with the complete source import mapping. Do not replace
it with a second extractor.

At the baseline commit it reports **58 backend operations, 60 HTTP/WebSocket
route paths, 61 MCP tools, and 24 canvas actions**. The exact MCP tool and canvas
action names are checked against
[`tests/scripts/ailoha-compatibility-baseline.json`](../tests/scripts/ailoha-compatibility-baseline.json)
by `tests/scripts/ailoha-source-manifest.test.mjs`. Update the ledger only for
an intentional, reviewed compatibility change. The generated route/operation
lists remain the extractor's detailed inventory; this document does not invent
coverage for untested schema behavior.

The current source snapshot inventory was 275 files and 3,842,017 bytes, with
snapshot SHA-256
`dcc22828debc48c567e1f607b3c4dca75c4869829158510ca64d261efe7c709f`.
Those values identify the pre-change snapshot, not a required hash for later
source edits.

### Canvas actions (24)

```text
boot_device
create_device
delete_device
erase_device
get_device
get_device_catalog
get_display_geometry
get_recording_status
get_selected_device
list_devices
long_press_device
press_button
press_key
restart_device
reveal_device
rotate_device
select_device
shutdown_device
start_recording
stop_recording
swipe_device
take_screenshot
tap_device
type_text
```

### MCP tools (61)

```text
mobile_device_app_install
mobile_device_app_launch
mobile_device_app_list
mobile_device_app_op_list
mobile_device_app_op_set
mobile_device_app_terminate
mobile_device_app_uninstall
mobile_device_battery_set
mobile_device_biometric
mobile_device_boot
mobile_device_call
mobile_device_calls
mobile_device_catalog
mobile_device_clipboard_get
mobile_device_clipboard_set
mobile_device_crash_report
mobile_device_crashes
mobile_device_create
mobile_device_delete
mobile_device_display
mobile_device_erase
mobile_device_file_delete
mobile_device_file_list
mobile_device_file_mkdir
mobile_device_file_pull
mobile_device_file_push
mobile_device_get
mobile_device_get_selected
mobile_device_hardware_get
mobile_device_list
mobile_device_location_clear
mobile_device_location_set
mobile_device_log
mobile_device_long_press
mobile_device_media_add
mobile_device_network_set
mobile_device_notification_push
mobile_device_permission_list
mobile_device_permission_set
mobile_device_presentation_get
mobile_device_presentation_set
mobile_device_press_button
mobile_device_press_key
mobile_device_recording_start
mobile_device_recording_status
mobile_device_recording_stop
mobile_device_restart
mobile_device_reveal
mobile_device_rotate
mobile_device_screenshot
mobile_device_select
mobile_device_settings_get
mobile_device_settings_set
mobile_device_shutdown
mobile_device_sms_send
mobile_device_swipe
mobile_device_tap
mobile_device_type_text
mobile_device_ui_dump
mobile_device_ui_find
mobile_device_ui_tap
```

The old README statement that “all 24 tools” map one-to-one to canvas actions
was inaccurate: the canvas has 24 actions, while MCP currently exposes 61 tools,
including app, file, diagnostics, settings, and device capabilities. See the
MCP tool implementations and generator for current schemas and behavior.

## Selection, identity, and coordinate invariants

- A canvas selection is keyed by both Copilot `sessionId` and canvas `instanceId`.
  It is per canvas view, not a single global selected device. The MCP
  `mobile_device_get_selected` and `mobile_device_select` calls use that pair;
  the VS Code MCP proxy supplies its own pair to those context tools and follows
  successful explicit-device actions into the matching view. Standalone CLI/MCP
  actions can name a target directly.
- `deviceId` is the provider-qualified target selector returned by
  `mobile_device_list`; treat it as an opaque string. Current IDs encode
  platform/provider/native identity, but callers must not synthesize them from
  a UDID or serial. Catalog `runtimeId` and `deviceTypeId` are likewise IDs from
  the catalog.
- `DeviceTarget.nativeId` is provider-native deployment identity. `udid` is
  exposed for iOS; Android deployment uses the emulator serial. Return and
  preserve the full target record so deploy tooling receives that native value;
  do not substitute it for `deviceId`.
- Input coordinates and accessibility frames/centers are **logical points**.
  `get_display_geometry` returns point width/height, pixel width/height, scale,
  and orientation (plus optional corner geometry). Convert canvas pixels to the
  device's point space using current observed geometry; do not send pixel-space
  coordinates to tap/swipe APIs.
- `mobile_device_ui_dump`, `mobile_device_ui_find`, and `mobile_device_ui_tap`
  operate on the provider's system accessibility hierarchy for the whole
  on-screen device, including system UI. They are not an app-agent semantic
  tree. Normalized roles coexist with platform `rawRole`; element frames and
  match centers are logical points. Match `path` values are child-index paths
  within a captured tree, not durable element identifiers. `ui_tap` captures,
  searches, and taps the first match in one operation.

## Destructive actions, recording, and lifecycle

- Erase, device deletion, and app uninstall require explicit confirmation:
  CLI `--confirm`, MCP/canvas `confirm: true`, and the canvas confirmation UI.
  A missing/false confirmation is rejected. Preserve these guards and existing
  result semantics in adapters.
- Recording start is bounded (default 180 seconds; supported timeout is 1 to
  3600 seconds). Explicit stop finalizes and returns the output path; timeout
  also triggers finalization. Platform recording managers attempt finalization
  and clean up on backend disposal, with an explicit abandon/cleanup path if
  finalization fails. A panel close or hide is not a user request to stop a
  device or recording.
- `canvas.close` rotates the browser session while retaining context needed for
  a host-restored renderer. Explicit `canvas.detach` removes that panel's
  selection and session grant. Detaching/closing a panel does not implicitly
  shut down or erase the device. VS Code hides/closes live stream sockets when
  appropriate; recording is controlled through its explicit bounded lifecycle.
- On migration, preserve finalization and cleanup before an owned runtime goes
  idle, dispose streams/input grants, and never stop external hosts or simulators.
  That stronger owned-runtime contract is a roadmap acceptance requirement, not
  a claim that Ailoha migration is already implemented.

## Packaging baseline

- Copilot plugin installation copies packaged files; it does not run npm
  restore/build hooks. Native executables are resolved from packaged runtimes
  or versioned public GitHub Release assets and checked against the runtime
  manifest hashes.
- VS Code publishes a universal package that downloads and verifies its pinned
  runtime, plus self-contained target packages for supported platforms. The
  VSIX verifier checks required production files, runtime manifest/archive
  integrity, and exclusion of tests/source maps.
- Preserve product package IDs and marketplace/install paths. Normal product
  installation must not gain a private feed/token, sibling checkout, local
  build, or .NET SDK runtime prerequisite.
- Any new Ailoha production dependency must be an exact, publicly downloadable,
  tested artifact with provenance verified. Distribution rights must be
  confirmed independently; public availability is not a license grant. The
  current unresolved Ailoha rights gate blocks source modification and
  redistribution.

## Source of truth

| Contract | Current source |
| --- | --- |
| GitHub canvas IDs/actions | [`extension.mjs`](../extension.mjs), [`plugin.json`](../.github/plugin/plugin.json) |
| VS Code IDs, commands, MCP registration, chat tools | [`vscode/package.json`](../vscode/package.json), [`vscode/src/extension.ts`](../vscode/src/extension.ts) |
| MCP names and argument/confirmation contracts | [`src/MobileCanvas.Tool/Mcp/`](../src/MobileCanvas.Tool/Mcp/) |
| CLI commands and help | [`src/MobileCanvas.Tool/DeviceCli.cs`](../src/MobileCanvas.Tool/DeviceCli.cs) |
| Target IDs, geometry, selection and UI schemas | [`src/MobileCanvas.Contracts/`](../src/MobileCanvas.Contracts/), [`src/MobileCanvas.Core/DeviceService.cs`](../src/MobileCanvas.Core/DeviceService.cs) |
| Host HTTP/WebSocket and detach behavior | [`src/MobileCanvas.Tool/DeviceApi.cs`](../src/MobileCanvas.Tool/DeviceApi.cs) |
| Runtime/VSIX packaging | [`docs/distribution.md`](distribution.md), [`scripts/ailoha-source-manifest.mjs`](../scripts/ailoha-source-manifest.mjs) |
