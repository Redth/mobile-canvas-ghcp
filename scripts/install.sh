#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DESTINATION="${HOME}/.copilot/extensions/mobile-canvas"

# A release bundle keeps the binaries beside the manifest; a source checkout
# leaves them under .build/. Accept either so the same script serves both.
for candidate in "${REPO_ROOT}" "${REPO_ROOT}/.build/bin"; do
  if [[ -x "${candidate}/mobile-canvas" ]]; then
    BINARY_DIR="${candidate}"
    break
  fi
done

mkdir -p "${DESTINATION}"
chmod 700 "${HOME}/.copilot" "${HOME}/.copilot/extensions" "${DESTINATION}" 2>/dev/null || true
install -m 600 "${REPO_ROOT}/extension.mjs" "${DESTINATION}/extension.mjs"
install -m 600 "${REPO_ROOT}/package.json" "${DESTINATION}/package.json"

# Prefer bundling the native binary inside the extension directory. This keeps
# the canvas UI and the host that serves it on the same release, and avoids
# depending on PATH or on a writable ~/.local/bin.
if [[ -n "${BINARY_DIR:-}" ]]; then
  mkdir -p "${DESTINATION}/bin"
  install -m 700 "${BINARY_DIR}/mobile-canvas" "${DESTINATION}/bin/mobile-canvas"
  # The screen capture helper is a separate executable and is required for live
  # video on macOS. A stale copy fails at stream start rather than at install.
  if [[ -x "${BINARY_DIR}/mobile-screencap" ]]; then
    install -m 700 "${BINARY_DIR}/mobile-screencap" "${DESTINATION}/bin/mobile-screencap"
  fi
  RESOLVED="${DESTINATION}/bin/mobile-canvas"
elif [[ -n "${MOBILE_CANVAS_COMMAND:-}" && -x "${MOBILE_CANVAS_COMMAND}" ]]; then
  RESOLVED="${MOBILE_CANVAS_COMMAND}"
elif command -v mobile-canvas >/dev/null 2>&1; then
  RESOLVED="$(command -v mobile-canvas)"
elif [[ -x "${HOME}/.dotnet/tools/mobile-canvas" ]]; then
  RESOLVED="${HOME}/.dotnet/tools/mobile-canvas"
elif command -v dotnet >/dev/null 2>&1; then
  printf '%s' "mobile-canvas is not installed. Install the .NET global tool now? [y/N] "
  read -r answer
  case "${answer}" in
    y|Y|yes|YES)
      dotnet tool install --global MobileCanvas.Tool
      RESOLVED="${HOME}/.dotnet/tools/mobile-canvas"
      ;;
    *)
      printf '%s\n' "Installation cancelled; no executable was downloaded." >&2
      exit 1
      ;;
  esac
else
  printf '%s\n' "mobile-canvas is not installed and the .NET SDK is unavailable." >&2
  printf '%s\n' "Run scripts/build.sh, or install a release, then rerun this installer." >&2
  exit 1
fi

"${RESOLVED}" host start >/dev/null
printf '%s\n' "Installed the Mobile Canvas extension at ${DESTINATION}"
printf '%s\n' "Using executable ${RESOLVED}"
printf '%s\n' "Restart or reload GitHub Copilot to discover the canvas."
