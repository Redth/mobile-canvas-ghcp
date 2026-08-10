# How the executable ships

Mobile Canvas is a JavaScript canvas extension in front of a Native AOT .NET
executable. This describes how CI builds each platform, how release assets are
verified, and how the Copilot and VS Code hosts obtain the matching runtime.

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

1. There is no install hook that can restore a native package.
2. npm is not a delivery channel for a Copilot plugin.
3. The JavaScript resolver may download a published binary on first use.
4. Per-architecture selection has to happen at **runtime**, using
   `process.platform` and `process.arch`.

## The approach

`runtimes/manifest.json` pins every executable by version, RID, release asset,
uncompressed size, and SHA-256. Release CI publishes each gzip stream as a
GitHub Release asset:

```
mobile-canvas-v0.1.7-osx-arm64.gz
mobile-screencap-v0.1.7-osx-arm64.gz
mobile-canvas-v0.1.7-linux-x64.gz
mobile-canvas-runtime-manifest-v0.1.7.json
SHA256SUMS
```

The repository stores only the manifest, not the archives. The resolver
downloads the versioned asset from the pinned release, verifies the uncompressed
size and SHA-256, and writes it to a content-addressed cache. It never follows a
mutable `latest` URL. Release CI may still place an archive beside the manifest
while creating a self-contained package; the same resolver prefers that local
copy without changing the cache format.

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
        "mobile-canvas": {
          "asset": "mobile-canvas-v0.1.11-osx-arm64.gz",
          "sha256": "...",
          "size": 26260560
        }
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

The legacy universal bundle is roughly 62 MB compressed. Release assets keep
that data out of Git history and let universal packages fetch only the matching
10-13 MB archive. The cache expands only the current RID.

### VS Code packaging

`scripts/prepare-vscode.mjs` stages the shared web UI, runtime resolver, MCP
proxy, and remote-only manifest under `vscode/dist/`; `@vscode/vsce` then
produces a small universal package that uses the verified first-use download
path.

Release CI also runs `vsce package --target` for all six supported VS Code
targets after building the native assets. Those self-contained packages contain
only their matching runtime, and VS Code Marketplace automatically selects the
correct target package.

Installing the VSIX does not extract all binaries. On first use, the shared
resolver verifies and expands only the current platform into the same
content-addressed cache used by the Copilot plugin.

CI runs `scripts/verify-vsix.mjs` after packaging every VSIX. It checks each
archive named by that package's filtered runtime manifest, required production
files, version agreement, local UI extension placement, and the absence of test
and source-map files. Successful CI runs upload the Copilot plugin directory,
the universal VSIX, and all six target-specific VSIXs as separate artifacts.

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
3. an optional packaged `runtimes/` archive for this platform
4. `~/.local/bin`, then `~/.dotnet/tools`
5. the matching versioned GitHub Release asset, verified against the manifest
6. bare `mobile-canvas` on `PATH`

`MOBILE_CANVAS_RUNTIME_BASE_URL` can point first-use downloads at an enterprise
mirror. `MOBILE_CANVAS_CACHE_DIR` can relocate the content-addressed cache.

If the platform is not declared, the error names the platform, lists what the
manifest supports, and points at the global tool.

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

The Copilot plugin installer does not currently quarantine anything. Gzip also
keeps self-contained release packages safe when they are downloaded through a
path that applies quarantine; shipping raw binaries would hand those users a
`SIGKILL`.

### Direct framebuffer capture and fallback permissions

The primary iOS video path reads the simulator's CoreSimulator IOSurface
directly and encodes it with VideoToolbox. It does **not** need Screen Recording,
Accessibility, a visible Simulator.app window, or either TCC prompt.
Rotation uses the same CoreSimulator bridge to send a device-targeted orientation
event and likewise does not automate or depend on Simulator.app.

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
published binary came from. The manifest also records a deterministic hash of
the source inputs used by that build.

## Releasing

`.github/workflows/release.yml` is the canonical release path:

1. Native OS runners build all six RIDs.
2. The bundle job merges and verifies their manifests.
3. `package-runtime-assets.mjs` creates versioned gzip assets and `SHA256SUMS`.
4. CI packages remote and self-contained Copilot plugins and universal VSIXs,
   plus up to six self-contained target VSIXs.
5. A `v*` tag publishes every file to the corresponding GitHub Release.
6. The tagged build opens a follow-up PR with the exact published hashes, which
   differ between Native AOT builds even when their source is identical. A
   manual run can also refresh the manifest and version metadata; generated
   archives remain ignored.

Before merging a distribution change, manually dispatch the workflow with a new
numeric `version`, a unique `prerelease_tag` matching `v*-rc.*`, and `commit`
disabled. This creates an isolated GitHub prerelease from the branch so the
remote Copilot plugin and VSIX can be installed against real release URLs.
Delete the prerelease and tag after the smoke test.

`scripts/verify-bundle.mjs` checks release asset names in a remote manifest and
fully verifies local archives during release packaging. CI also warns when the
manifest source hash has drifted behind `src/`.
