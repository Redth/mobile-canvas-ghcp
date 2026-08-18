#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DESTINATION="${HOME}/.copilot/extensions/mobile-canvas"

case "$(uname -m)" in
  arm64|aarch64) HOST_ARCH="arm64" ;;
  *)             HOST_ARCH="x64" ;;
esac
case "$(uname -s)" in
  Darwin)               HOST_OS="osx" ;;
  MINGW*|MSYS*|CYGWIN*) HOST_OS="win" ;;
  *)                    HOST_OS="osx" ;;
esac
HOST_RID="${HOST_OS}-${HOST_ARCH}"

mkdir -p "${DESTINATION}"
chmod 700 "${HOME}/.copilot" "${HOME}/.copilot/extensions" "${DESTINATION}" 2>/dev/null || true

install -m 600 "${REPO_ROOT}/extension.mjs" "${DESTINATION}/extension.mjs"
# The Windows App canvas ships from the same source install and registers only on Windows; the
# module still needs to be present on every host so its extension process can join and no-op.
install -m 600 "${REPO_ROOT}/windows-extension.mjs" "${DESTINATION}/windows-extension.mjs"
install -m 600 "${REPO_ROOT}/package.json" "${DESTINATION}/package.json"

# extension.mjs imports the shared resolver, so lib/ is part of the payload
# rather than an optional extra.
mkdir -p "${DESTINATION}/lib"
install -m 600 "${REPO_ROOT}/lib/runtime.mjs" "${DESTINATION}/lib/runtime.mjs"
install -m 600 "${REPO_ROOT}/lib/runtime-assets.mjs" "${DESTINATION}/lib/runtime-assets.mjs"
install -m 600 "${REPO_ROOT}/lib/windows-app-helper.mjs" "${DESTINATION}/lib/windows-app-helper.mjs"

# The canvas tab icon is read from disk by the host, so it has to travel with the
# extension rather than being embedded in the binary like the web assets are.
mkdir -p "${DESTINATION}/assets"
install -m 600 "${REPO_ROOT}/assets/icon.png" "${DESTINATION}/assets/icon.png"

# A locally built binary wins so a contributor testing a change does not have to
# publish first. Otherwise the checked-in manifest is copied and the resolver
# downloads the right architecture on first use.
BUILD_DIR="${REPO_ROOT}/.build/bin/${HOST_RID}"
EXECUTABLE="mobile-canvas"
[[ "${HOST_OS}" == "win" ]] && EXECUTABLE="mobile-canvas.exe"
HAS_LOCAL_BUILD=false
if [[ "${HOST_OS}" == "win" ]]; then
  [[ -f "${BUILD_DIR}/${EXECUTABLE}" ]] && HAS_LOCAL_BUILD=true
else
  [[ -x "${BUILD_DIR}/${EXECUTABLE}" ]] && HAS_LOCAL_BUILD=true
fi
if [[ "${HAS_LOCAL_BUILD}" == true ]]; then
  rm -rf "${DESTINATION}/runtimes"
  mkdir -p "${DESTINATION}/bin"
  install -m 700 "${BUILD_DIR}/${EXECUTABLE}" "${DESTINATION}/bin/${EXECUTABLE}"
  if [[ "${HOST_OS}" == "win" ]]; then
    [[ -f "${BUILD_DIR}/windows-app-helper.exe" ]] || {
      printf '%s\n' "Local Windows build is missing windows-app-helper.exe. Run scripts/build.sh again." >&2
      exit 1
    }
    install -m 700 \
      "${BUILD_DIR}/windows-app-helper.exe" \
      "${DESTINATION}/bin/windows-app-helper.exe"
  elif [[ -x "${BUILD_DIR}/mobile-screencap" ]]; then
    install -m 700 "${BUILD_DIR}/mobile-screencap" "${DESTINATION}/bin/mobile-screencap"
  fi
  SOURCE_LABEL="local build (${HOST_RID})"
elif [[ -f "${REPO_ROOT}/runtimes/manifest.json" ]]; then
  rm -rf "${DESTINATION}/bin" "${DESTINATION}/runtimes"
  cp -R "${REPO_ROOT}/runtimes" "${DESTINATION}/runtimes"
  SOURCE_LABEL="runtime manifest"
else
  printf '%s\n' "No binary found. Run scripts/build.sh, then rerun this installer." >&2
  exit 1
fi

# Resolving here rather than at first canvas open turns a packaging mistake into
# an install-time failure instead of a broken panel.
RESOLVED="$(
  cd "${DESTINATION}"
  node --input-type=module -e \
    'const m = await import("./lib/runtime.mjs"); console.log((await m.resolveCommand()).command)'
)"

"${RESOLVED}" host start >/dev/null

printf '%s\n' "Installed the Mobile Canvas extension at ${DESTINATION}"
printf '%s\n' "Executable source: ${SOURCE_LABEL}"
printf '%s\n' "Using executable ${RESOLVED}"
printf '%s\n' "Restart or reload GitHub Copilot to discover the canvas."
