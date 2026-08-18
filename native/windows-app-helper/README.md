# Windows App Helper

`windows-app-helper.exe` is the Windows-only native companion for Windows App
Canvas operations. It is a Unicode console executable with an embedded
Per-Monitor DPI Aware v2 manifest. CMake builds one architecture at a time with
MSVC:

```bash
cmake -S native/windows-app-helper -B .build/native/windows-app-helper/win-x64 -A x64
cmake --build .build/native/windows-app-helper/win-x64 --config Release
ctest --test-dir .build/native/windows-app-helper/win-x64 -C Release --output-on-failure
```

Every JSON command writes exactly one JSON object to stdout and writes structured
JSON only to stderr on failure. Every payload carries `schemaVersion`, and the
managed host refuses a version it does not know rather than binding half of it.

`screenshot` and `capture` are the two exceptions, and they invert the streams
rather than mixing them: stdout carries nothing but binary image or Annex-B
bytes, and stderr carries newline-delimited JSON status lines. That is the whole
framing contract, so there is no length prefix or escape sequence to get wrong.

```text
windows-app-helper.exe capabilities --json
windows-app-helper.exe catalog --json
windows-app-helper.exe windows --json
windows-app-helper.exe launch --json --id <catalog-entry-id>
windows-app-helper.exe uia-snapshot --json < request.json
windows-app-helper.exe uia-find --json < request.json
windows-app-helper.exe uia-action --json < request.json
windows-app-helper.exe uia-wait --json < request.json
windows-app-helper.exe screenshot --json < request.json > frame.png
windows-app-helper.exe capture --json < request.json > stream.h264
```

## capabilities

Probes AppsFolder Shell catalog support, UI Automation, the Windows 10 version
1903 `GraphicsCaptureItem` interop API, Media Foundation H.264 encoders,
`SendInput`, and this executable's Authenticode trust result. It also reports
the Windows logon session and integrity level the helper itself runs in, because
a helper in session 0 has no desktop and must say so rather than return an empty
window list that reads like a quiet machine.

## catalog

Normalizes launchable apps from three documented sources, in this order:

| Source | Mechanism | Launch provenance |
|---|---|---|
| `appsFolder` | `FOLDERID_AppsFolder` enumerated through `IEnumShellItems`, with `System.AppUserModel.ID` read per item | Shell item identity list |
| `startMenuShortcuts` | `FOLDERID_Programs` and `FOLDERID_CommonPrograms` walked for `.lnk` files, resolved with `IShellLink` | Shortcut path, resolved executable, arguments, working directory |
| `appPaths` | `HKCU`/`HKLM` `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths` | Registry key and resolved executable |

Each source reports `supported`, `count`, and an `hresult`, so a source this
machine refused is visible instead of looking like an app that is not installed.

Entry identifiers are the first 128 bits of a SHA-256 over the source and its
launch provenance. They are deterministic across runs and processes, opaque, and
derived from provenance rather than from a friendly name, so two apps that share
a display name never collide and the host can store an identifier and launch it
later. Rows are deduplicated within a source by AUMID, then by executable plus
arguments, then by provenance path. Rows are deliberately **not** merged across
sources here: the host merges them into one catalog entry that keeps every
launch route, and that merge is where product-level deduplication happens.

Two limits are intentional and documented rather than worked around:

- Apps with no Shell, package, shortcut, or App Paths registration are not
  discoverable. They must be started through the host's explicit executable
  launch. No directory is crawled looking for executables to pass off as an
  installed-app catalog.
- Package family name is derived from the documented
  `<PackageFamilyName>!<ApplicationId>` AUMID form rather than from a separate
  shell property, so a shell that does not surface that property still yields
  packaged identity. `packageFullName` is reported only for windows, where it
  comes from the process through `GetPackageFullName`.

## windows

Enumerates visible top-level windows with `EnumWindows` and reports, per window:
handle, owning process ID, process creation `FILETIME`, Windows session ID,
title, class, DWM extended frame bounds, visible/minimized/cloaked/tool-window
state, owner handle, process image path, AUMID and package identity, integrity
level and RID, whether the window is elevated relative to this helper, and how
much of the owning process the helper could actually read (`identityAccess`).

The handle is reported because the host stores it as one third of a window's
identity, along with the process ID and the process creation time. It is never
something a caller may supply: the host mints its own opaque per-panel
identifiers and re-proves all three before it acts.

A window's own `System.AppUserModel.ID` overrides its host process identity,
which is what makes a packaged app hosted by `ApplicationFrameHost.exe`
attributable to the app rather than to the frame host.

## launch

Takes one opaque catalog identifier and nothing else. The helper re-resolves the
identifier against the live catalog and launches the entry it named:

- `appsFolder` entries are invoked through `ShellExecuteExW` with
  `SEE_MASK_INVOKEIDLIST` on the item's own identity list, which runs the same
  default verb the Start menu does.
- `startMenuShortcuts` entries invoke the `.lnk` itself, so the shortcut's own
  target, arguments, and working directory apply.
- `appPaths` entries invoke the resolved executable.

No caller-supplied path, command line, Shell verb, URL, or `runas` request can
reach `ShellExecuteExW`; `--id` is rejected unless it is lowercase hexadecimal.
The reported `processId` and `processStartFileTime` are a correlation hint, not
an authorization: packaged activation frequently reports no process at all, and
the host only authorizes a window once it can positively attribute one.

## UI Automation

The four `uia-*` commands take exactly `--json` and one schema-versioned JSON
object on standard input. They are private managed-to-helper commands: the
input's `handle` is a live HWND supplied only after the host has resolved and
revalidated an opaque, panel-scoped window ID. No HTTP route, CLI command, MCP
tool, or selector accepts a raw handle.

Every operation runs on a dedicated MTA worker with UI Automation connection and
transaction timeouts, a managed outer timeout, and bounded output. Snapshot and
query defaults are depth 12, 500 nodes, and five seconds; hard maxima are depth
32, 5000 nodes, and 30 seconds. A depth/node/output limit returns
`metadata.truncated: true`; timeouts return `metadata.timedOut: true` rather
than silently returning a partial success.

`uia-snapshot` returns a normalized physical-pixel tree with name, Automation
ID, class, framework, state, and supported semantic actions. It uses cache
requests and bulk child retrieval. UIA providers that expose only a root or no
supported patterns are reported as sparse trees, not invented controls.

`uia-find`, `uia-action`, and `uia-wait` use selectors in this order:

1. Automation ID plus control type/role;
2. control type/role plus name or non-secret value;
3. explicitly qualified ancestry, ordinal index, or child path.

Actions and waits enumerate and resolve the selector immediately before use.
An action never chooses the first match: no match returns
`windows_uia_element_not_found`, and multiple matches return
`windows_uia_element_ambiguous`. Pattern absence returns
`windows_uia_capability_unavailable`.

Supported actions are `invoke`, `setValue`, `select`, `toggle`, `expand`,
`collapse`, `scroll`, and `focus`. `setValue` always refuses password controls.
Password Value pattern data and Text pattern content are never requested for
output; action input is sent through stdin rather than a visible process command
line and is never echoed in a result.

`uia-wait` supports `exists`, `notExists`, and property/state conditions with
bounded polling. Property waits support only non-secret `name`, `enabled`,
`offscreen`, `focusable`, `focused`, and `value`; password values are rejected.

## Capture

`screenshot` and `capture` both take exactly `--json` and one schema-versioned
JSON request on stdin. The request carries the raw `HWND` the guarded managed
bridge resolved from an opaque, panel-scoped capability; the handle is an input
here and never an authorization anywhere else.

```json
{"schemaVersion":1,"handle":66052,
 "screenshot":{"scale":1,"maximumDimension":0,"includeCursor":false,
               "timeoutMilliseconds":10000}}
```

```json
{"schemaVersion":1,"handle":66052,
 "capture":{"framesPerSecond":30,"scale":1,"averageBitrate":12000000,
            "includeCursor":false,"timeoutMilliseconds":10000}}
```

Both use picker-free `IGraphicsCaptureItemInterop::CreateForWindow` on a
Direct3D 11 device, a free-threaded `Direct3D11CaptureFramePool` where the build
offers one, and prompt `Close()` on every frame. Frames are polled and drained
so the newest one is always the one encoded and stale frames never queue behind
the encoder. `IGraphicsCaptureSession2` through `5` are feature-detected and
reported; none is required, and the system capture border is never switched off.

The visible crop is the Desktop Window Manager's extended frame bounds, because
a top-level window's rectangle extends past its visible edge by an invisible
resize border. That crop is also the canonical coordinate space: geometry is
reported in selected-window-relative physical capture pixels together with the
content, capture, surface, frame, client, and screen rectangles, the DPI, and
the minimized state, so a screenshot and a live stream describe exactly the same
space.

`screenshot` writes one PNG through the Windows Imaging Component and one
`type: "descriptor"` line. `capture` writes one `descriptor` line, then raw
Annex-B H.264 with no container, then one `type: "end"` line carrying a
structured reason. Encoding is Media Foundation: the Video Processor MFT scales
and converts BGRA to NV12 on the GPU, and the H.264 MFT is preferred on the same
adapter frames were captured on, with a software encoder as a stated fallback.
B-frames are off, low latency is on, and the group of pictures is one second, so
a reconnecting browser gets a picture immediately.

A stream ends rather than adapting when the window resizes, changes DPI, is
minimized, or closes: an H.264 decoder cannot be handed frames of a different
size, so the honest move is to stop, say why, and let the browser reconnect for
a fresh descriptor and keyframe. Status values are `ok`, `minimized`,
`protected`, `closed`, `unavailable`, and `error`; end reasons are
`contentSizeChanged`, `dpiChanged`, `minimized`, `windowClosed`,
`captureFailed`, `encoderFailed`, and `clientClosed`.

## Signing

Development builds are intentionally unsigned and report
`features.authenticodeSignature.valid: false` with `status: "unsigned"`.
Public release artifacts must be Authenticode-signed **after** compiling and
**before** `scripts/bundle.mjs` computes their checksums. CI deliberately does
not contain signing credentials or claim that an unsigned build is signed.
