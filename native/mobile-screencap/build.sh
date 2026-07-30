#!/usr/bin/env bash
# Builds the mobile-screencap helper.
#
# ScreenCaptureKit and VideoToolbox are not reachable from Native AOT .NET, so the capture
# path lives in this small Swift executable that ships beside `mobile-canvas`.
#
# Usage:
#   ./build.sh                 # universal binary into out/
#   ./build.sh --arch arm64    # single architecture
#   ./build.sh --output <dir>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/out"
ARCHES=("arm64" "x86_64")
CONFIGURATION="release"
DEPLOYMENT_TARGET="13.0"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--arch)
			ARCHES=("$2")
			shift 2
			;;
		--output)
			OUTPUT_DIR="$2"
			shift 2
			;;
		--debug)
			CONFIGURATION="debug"
			shift
			;;
		*)
			echo "unknown argument: $1" >&2
			exit 2
			;;
	esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
	echo "mobile-screencap only builds on macOS" >&2
	exit 1
fi

SOURCES=("$SCRIPT_DIR"/Sources/*.swift)
mkdir -p "$OUTPUT_DIR"

OPTIMIZATION=(-O -wmo)
if [[ "$CONFIGURATION" == "debug" ]]; then
	OPTIMIZATION=(-Onone -g)
fi

SLICES=()
for arch in "${ARCHES[@]}"; do
	slice_dir="$OUTPUT_DIR/$arch"
	mkdir -p "$slice_dir"
	echo "building $arch..."
	xcrun swiftc \
		"${OPTIMIZATION[@]}" \
		-swift-version 5 \
		-parse-as-library \
		-target "${arch}-apple-macos${DEPLOYMENT_TARGET}" \
		-framework ScreenCaptureKit \
		-framework VideoToolbox \
		-framework CoreMedia \
		-framework AppKit \
		-framework ApplicationServices \
		-framework Accelerate \
		-o "$slice_dir/mobile-screencap" \
		"${SOURCES[@]}"
	SLICES+=("$slice_dir/mobile-screencap")
done

if [[ ${#SLICES[@]} -gt 1 ]]; then
	echo "creating universal binary..."
	xcrun lipo -create "${SLICES[@]}" -output "$OUTPUT_DIR/mobile-screencap"
else
	cp "${SLICES[0]}" "$OUTPUT_DIR/mobile-screencap"
fi

echo "built $OUTPUT_DIR/mobile-screencap"
xcrun lipo -info "$OUTPUT_DIR/mobile-screencap"
