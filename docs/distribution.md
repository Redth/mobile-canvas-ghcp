# How the executable ships

Mobile Canvas is a JavaScript canvas extension in front of a Native AOT .NET
executable. This describes how that executable reaches a machine, and why it is
committed to the repository rather than downloaded or installed separately.

## What a plugin install actually does

A Copilot plugin install is a **plain file copy**. Verified against a real
install directory:

- `~/.copilot/installed-plugins/*/` contains no `node_modules`, so
  **`npm install` never runs**. A declared npm dependency is never fetched.
- `@github/copilot-sdk` resolves because the app injects it from
  `~/.copilot/pkg/<platform>/<version>/copilot-sdk`, not from the extension.
- Installed plugins are not git checkouts, so there is no `git lfs` step and no
  build step.
- The extension manifest has **no field for per-platform binaries**. The docs
  describe an extension only as a directory holding `package.json`, an entry
  file, and optional artifacts.
- A plugin's `extensions` field names **container directories**. The loader
  scans each container's immediate child directories for `extension.mjs`; it
  does not load an entrypoint placed directly at the configured path. The
  plugin therefore exposes `extensions/mobile-canvas/extension.mjs`, which
  imports the shared root entrypoint used by source installs.

The consequences are strict:

1. Whatever is committed is exactly what users get.
2. An npm package would never be downloaded, so npm is not a delivery channel.
3. Per-architecture selection has to happen at **runtime**, in JavaScript, using
   `process.platform` and `process.arch`.

## The approach

Prebuilt Native AOT binaries are committed under `runtimes/`, gzipped, one
directory per .NET runtime identifier:

```
runtimes/
  manifest.json
  osx-arm64/mobile-canvas.gz
  osx-arm64/mobile-screencap.gz
  osx-x64/mobile-canvas.gz
  osx-x64/mobile-screencap.gz
```

`manifest.json` is keyed by `${process.platform}-${process.arch}` so the
resolver does a direct lookup with no platform mapping table at runtime:

```json
{
  "version": "0.1.0",
  "runtimes": {
    "darwin-arm64": {
      "rid": "osx-arm64",
      "executable": "mobile-canvas",
      "id": "<sha256 of mobile-canvas>",
      "files": {
        "mobile-canvas": { "archive": "...", "sha256": "...", "size": 26260560 }
      }
    }
  }
}
```

On first use `lib/runtime.mjs` gunzips the archives for the current platform
into `~/.mobile-canvas/runtimes/<platform>-<arch>-<hash>/`, verifies each
SHA-256, and marks them executable.

Measured: **56 ms** on a cold start, **0 ms** once extracted.

### Why gzip

- 26 MB becomes 9.9 MB, so both macOS architectures cost ~21 MB instead of 52 MB.
- gzip is byte-exact, so the **adhoc code signature macOS requires on arm64
  survives** the round trip. Verified with `codesign -v`.
- It **launders `com.apple.quarantine`**. A user who installs from a downloaded
  archive would otherwise get quarantined executables; because these are written
  by our own process, Gatekeeper does not flag them.
- Node has `zlib` built in, so this adds no dependency.

### What the size actually costs

All six runtimes are 62 MB compressed, and every one ships to every user because
a plugin install is a plain git clone. Only the matching runtime is ever
extracted, so a Windows user unpacks 29 MB and never touches the other five.

The real cost is history, not checkout size. Git keeps every version of a binary
forever and these do not delta-compress, so each release adds roughly another
62 MB permanently. That is affordable for occasional releases and is not
affordable for per-commit binary updates -- only refresh `runtimes/` when cutting
a release, never as part of ordinary development.

### Why the cache is content-addressed

The directory name embeds the executable's own SHA-256. A rebuilt binary
therefore lands in a new directory automatically, so an upgrade can never serve
a stale cache and there is no version number to keep in sync.

Extraction stages into a temporary directory and then renames it into place.
`rename` is atomic, so a canvas panel and an MCP server starting at the same
moment cannot produce a half-written executable; whichever loses the race adopts
the winner's directory.

## Resolution order

`lib/runtime.mjs` is the single resolver, shared by the canvas extension and the
MCP server so both always run the same build:

1. `$MOBILE_CANVAS_COMMAND`
2. `<extension>/bin/mobile-canvas` — a local build, so contributors do not have
   to re-bundle to test a change
3. the bundled `runtimes/` archive for this platform
4. `~/.local/bin`, then `~/.dotnet/tools`
5. bare `mobile-canvas` on `PATH`

If the platform is not bundled, the error names the platform, lists what the
build does ship, and points at the global tool.

### MCP goes through a shim

`.mcp.json` cannot name a bundled path directly, because the executable does not
exist until the archive is extracted. It runs `scripts/mcp.mjs`, which resolves
and then `spawn`s with `stdio: "inherit"` — the transport is the real file
descriptors, so the shim cannot corrupt a message. Diagnostics go to stderr,
because stdout is the JSON-RPC channel.

## Code signing, Gatekeeper, and permissions

**No Developer ID certificate, provisioning profile, or notarization is
required.** That is a consequence of the packaging, not an oversight, so it is
worth recording why.

The binaries are **adhoc, linker-signed**, which is what the Native AOT linker
emits:

```
CodeDirectory v=20400 flags=0x20002(adhoc,linker-signed)
Signature=adhoc
TeamIdentifier=not set
```

Apple Silicon refuses to execute an *unsigned* Mach-O at all, so the adhoc
signature is mandatory — but it is also sufficient, because **Gatekeeper only
assesses files carrying `com.apple.quarantine`**. Notarization is checked at
that same gate. No quarantine, no assessment, no notarization requirement.

Both halves of that were tested rather than assumed:

| | `spctl` | Result |
|---|---|---|
| Binary with quarantine set | rejected | `Killed: 9`, exit 137 |
| Same binary, extracted from the bundle | rejected | runs, exit 0 |

`spctl` rejects both — neither is notarized — yet only the quarantined one is
killed. **This is exactly why the binaries ship gzipped.** Extraction writes a
new file from our own process, and quarantine does not propagate through that,
so the executable is clean even when every shipped archive is quarantined. That
was verified by setting a Safari-style quarantine attribute on the archives and
confirming the extracted binaries carried none and ran.

The Copilot plugin installer does not currently quarantine anything, but a user
downloading a source ZIP would be, and that is an install path we do not
control. Shipping raw binaries would hand those users a `SIGKILL`.

### Direct framebuffer capture and fallback permissions

The primary iOS video path reads the simulator's CoreSimulator IOSurface
directly and encodes it with VideoToolbox. It does **not** need Screen Recording,
Accessibility, a visible Simulator.app window, or either TCC prompt.

ScreenCaptureKit remains the first fallback for private-framework compatibility.
That path needs Screen Recording and reads window geometry through Accessibility.
Neither grant attaches to our binary: macOS attributes TCC to the **responsible
process**, meaning the application that spawned it.

That matters because the extraction cache is content-addressed, so every rebuild
lands at a new path with a new cdhash. If TCC keyed on our binary, permissions
would reset on every update. It does not — a copy of the helper at a path that
had never been granted anything, and a re-signed copy with a different cdhash,
both reported `screenRecordingGranted: true`.

So a user who wants the ScreenCaptureKit fallback grants Screen Recording once
to the app hosting the canvas, and updates never disturb it.
`mobile-screencap framebuffer-doctor` preflights both fallback grants without
prompting. If the private framebuffer API changes, capture falls through to
ScreenCaptureKit and then idb rather than failing.

## Supported platforms

Native AOT **cannot cross-compile between operating systems** -- the compiler
refuses with "Cross-OS native compilation is not supported" -- so each OS needs
its own runner. Architectures *within* one OS do cross-compile, which is why one
macOS machine produces both `osx-` slices.

| Platform | iOS Simulator | Android emulator | Video |
|---|---|---|---|
| macOS | full | full | H.264 via VideoToolbox |
| Windows | unavailable | full | PNG polling |
| Linux | unavailable | full | PNG polling |

iOS needs `simctl` and `idb`, so it is macOS-only and always will be.

Android is fully functional everywhere -- `AndroidSdkLocator` already resolves
`.exe`, `.bat` and Windows SDK layouts -- but H.264 encoding goes through the
macOS VideoToolbox helper. Where that is absent the backend reports
`liveStream: false` and the canvas falls back to screenshot polling, so video
degrades instead of breaking. Device listing, lifecycle, tap/swipe/type and
screenshots are unaffected.

Making Windows and Linux video first-class means adding a portable encoder --
Media Foundation and VA-API being the natural counterparts to VideoToolbox.

## Verifying a build

```console
$ mobile-canvas --version
mobile-canvas 0.1.0-preview.1+04d869a665085a68f6bc7a8257348b09ba2f927c (osx-arm64)
```

Source Link appends the commit, so a user can identify exactly which build a
bundled binary came from. That commit is the one the binary was **built from**,
which is necessarily the parent of the commit that adds it to `runtimes/` — an
artifact cannot contain its own hash. Expect it to trail `git log` by one.

## Releasing

```bash
./scripts/release.sh   # builds both architectures, re-bundles, verifies
git commit -am "Refresh bundled runtimes"
```

Native AOT cross-compiles between macOS architectures, so one machine produces
both slices and both get the identical universal Swift helper.

`.github/workflows/release.yml` does the same on demand and opens a PR.
`scripts/verify-bundle.mjs` checks every archive on any host — the resolver only
checksums the architecture it extracts, so a corrupt archive for another
platform would otherwise stay invisible until a user on that platform hit it.
CI also warns when `runtimes/` has drifted behind `src/`.
