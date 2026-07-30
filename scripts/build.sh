#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

case "$(uname -m)" in
  arm64|aarch64) DEFAULT_RID="osx-arm64" ;;
  *)             DEFAULT_RID="osx-x64" ;;
esac
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
