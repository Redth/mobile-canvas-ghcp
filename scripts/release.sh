#!/usr/bin/env bash
set -euo pipefail

# Rebuilds every shipped architecture and refreshes runtimes/.
#
# A Copilot plugin install is a plain file copy -- nothing is compiled and
# nothing is downloaded -- so the contents of runtimes/ are literally what users
# execute. Run this whenever src/ or native/ changes, and commit the result.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '%s\n' "Bundling requires macOS: the simulator capture helper uses Apple frameworks." >&2
  exit 1
fi

# Native AOT cross-compiles between macOS architectures, so one machine can
# produce both slices.
for rid in osx-arm64 osx-x64; do
  ./scripts/build.sh "${rid}"
  node scripts/bundle.mjs --rid "${rid}" --from ".build/bin/${rid}"
done

node scripts/verify-bundle.mjs

printf '\n%s\n' "runtimes/ refreshed. Commit it so plugin installs ship the new build."
