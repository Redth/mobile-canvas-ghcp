#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Do NOT name these OS/ARCH. Under Git Bash `OS` is already an exported
# environment variable (`Windows_NT`), and bash keeps the export attribute when
# you assign to an already-exported name. Overwriting it leaks into `dotnet`,
# where MSBuild derives the host OS from `'$(OS)' == 'Windows_NT'`; the host
# then resolves to linux while the target is win, and ILCompiler fails the
# publish with "Cross-OS native compilation is not supported" on a Windows
# machine building a Windows binary.
case "$(uname -m)" in
  arm64|aarch64) HOST_ARCH="arm64" ;;
  *)             HOST_ARCH="x64" ;;
esac
case "$(uname -s)" in
  Darwin)               HOST_OS="osx" ;;
  Linux)                HOST_OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*) HOST_OS="win" ;;
  *)                    HOST_OS="osx" ;;
esac
DEFAULT_RID="${HOST_OS}-${HOST_ARCH}"
RID="${1:-${DEFAULT_RID}}"

# Each architecture publishes to its own directory so a release matrix can build
# several without overwriting each other, and so bundling picks up exactly the
# architecture it was asked for.
OUTPUT="${REPO_ROOT}/.build/bin/${RID}"

# The Swift helper is not produced by `dotnet publish`, and a stale copy fails
# only later, at stream start. Build it first so the two halves stay in step.
if [[ "$(uname -s)" == "Darwin" ]]; then
  "${REPO_ROOT}/native/mobile-screencap/build.sh"
fi

dotnet publish "${REPO_ROOT}/src/MobileCanvas.Tool/MobileCanvas.Tool.csproj" \
  -c Release -r "${RID}" -o "${OUTPUT}"

printf '\n%s\n' "Built ${RID} into ${OUTPUT}"
ls -1 "${OUTPUT}" | grep -E '^mobile-' || true
printf '%s\n' "Run scripts/install.sh to install the canvas extension."
