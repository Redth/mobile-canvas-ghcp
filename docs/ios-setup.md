# Set up iOS Simulator support

Mobile Canvas only needs Xcode when you want to use iOS Simulators. Android-only
workflows can use Mobile Canvas without installing or configuring Xcode.

## Install Xcode and a Simulator runtime

1. Install the full Xcode application from the Mac App Store or
   [Apple Developer downloads](https://developer.apple.com/download/all/).
2. Open Xcode once and complete any license or component installation prompts.
3. In **Xcode > Settings > Components**, install at least one iOS Simulator
   runtime.

Apple's standalone Command Line Tools package is not enough because it does not
include CoreSimulator, Simulator.app, or Device Hub.

## Select the full Xcode developer directory

If Xcode is installed in `/Applications/Xcode.app`, select it system-wide:

```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

To select Xcode only for the process that launches Mobile Canvas, set
`DEVELOPER_DIR` instead:

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
```

Verify that `simctl` is available and can list installed devices:

```bash
xcrun simctl list --json
```

If that command fails, confirm that the selected path belongs to the full Xcode
application rather than `/Library/Developer/CommandLineTools`.

## Optional accessibility and video fallbacks

The bundled `mobile-screencap` helper provides the primary iOS input and video
paths. Install Meta's `idb` package only when you need the accessibility
hierarchy, compatibility input, or the final video fallback:

```bash
brew tap facebook/fb
brew trust facebook/fb
brew install facebook/fb/idb
export IDB_COMPANION_PATH="$(brew --prefix idb-companion)/bin/idb_companion"
```

Screen Recording and Accessibility permissions are only required when Mobile
Canvas must use its ScreenCaptureKit fallback. The canvas will offer direct
links to the relevant macOS settings when those permissions are needed.
