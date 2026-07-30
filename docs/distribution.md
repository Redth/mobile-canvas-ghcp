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

## Supported platforms

Only `osx-arm64` and `osx-x64` are shipped today. This is a capability limit,
not a packaging one: iOS control needs `simctl` and `idb`, and **both** platforms
encode H.264 through the VideoToolbox helper, so Android video is currently
macOS-only too. Adding a platform means solving portable encoding first; the
manifest and resolver already handle any number of entries.

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
