#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DESTINATION="${HOME}/.copilot/extensions/mobile-canvas"

case "$(uname -m)" in
  arm64|aarch64) HOST_RID="osx-arm64" ;;
  *)             HOST_RID="osx-x64" ;;
esac

mkdir -p "${DESTINATION}"
chmod 700 "${HOME}/.copilot" "${HOME}/.copilot/extensions" "${DESTINATION}" 2>/dev/null || true

install -m 600 "${REPO_ROOT}/extension.mjs" "${DESTINATION}/extension.mjs"
install -m 600 "${REPO_ROOT}/package.json" "${DESTINATION}/package.json"

# extension.mjs imports the shared resolver, so lib/ is part of the payload
# rather than an optional extra.
mkdir -p "${DESTINATION}/lib"
install -m 600 "${REPO_ROOT}/lib/runtime.mjs" "${DESTINATION}/lib/runtime.mjs"

# The canvas tab icon is read from disk by the host, so it has to travel with the
# extension rather than being embedded in the binary like the web assets are.
mkdir -p "${DESTINATION}/assets"
install -m 600 "${REPO_ROOT}/assets/icon.png" "${DESTINATION}/assets/icon.png"

# A locally built binary wins so a contributor testing a change does not have to
# re-bundle first. Otherwise the checked-in runtimes/ bundle is copied and the
# resolver extracts the right architecture on first use.
BUILD_DIR="${REPO_ROOT}/.build/bin/${HOST_RID}"
if [[ -x "${BUILD_DIR}/mobile-canvas" ]]; then
  rm -rf "${DESTINATION}/runtimes"
  mkdir -p "${DESTINATION}/bin"
  install -m 700 "${BUILD_DIR}/mobile-canvas" "${DESTINATION}/bin/mobile-canvas"
  if [[ -x "${BUILD_DIR}/mobile-screencap" ]]; then
    install -m 700 "${BUILD_DIR}/mobile-screencap" "${DESTINATION}/bin/mobile-screencap"
  fi
  SOURCE_LABEL="local build (${HOST_RID})"
elif [[ -f "${REPO_ROOT}/runtimes/manifest.json" ]]; then
  rm -rf "${DESTINATION}/bin" "${DESTINATION}/runtimes"
  cp -R "${REPO_ROOT}/runtimes" "${DESTINATION}/runtimes"
  SOURCE_LABEL="bundled runtimes"
else
  printf '%s\n' "No binary found. Run scripts/build.sh, then rerun this installer." >&2
  exit 1
fi

# Resolving here rather than at first canvas open turns a packaging mistake into
# an install-time failure instead of a broken panel.
RESOLVED="$(cd "${DESTINATION}" && node -e 'import("./lib/runtime.mjs").then(m=>console.log(m.resolveCommand().command))')"

"${RESOLVED}" host start >/dev/null

printf '%s\n' "Installed the Mobile Canvas extension at ${DESTINATION}"
printf '%s\n' "Executable source: ${SOURCE_LABEL}"
printf '%s\n' "Using executable ${RESOLVED}"
printf '%s\n' "Restart or reload GitHub Copilot to discover the canvas."
