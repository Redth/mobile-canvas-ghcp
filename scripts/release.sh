#!/usr/bin/env bash
set -euo pipefail

# Rebuilds both macOS architectures for local validation.
#
# Native AOT cannot cross-compile between operating systems, so the GitHub
# "Release runtimes" workflow remains the canonical way to produce a release.

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
npm run package:runtimes

printf '\n%s\n' "macOS runtimes and local release assets refreshed."
printf '%s\n' "Run the Release runtimes workflow to rebuild every supported RID."
