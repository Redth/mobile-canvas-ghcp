#!/usr/bin/env bash
# Builds and runs the native mobile-screencap HID tests.
#
# The tests link the HID sources plus test-only fakes into their own executable, so nothing under
# Tests/ is ever compiled into the shipped `mobile-screencap`. They cover the private-API-adjacent
# logic that can be exercised without a booted simulator: transport selection, framework layout,
# Indigo wire layout and allocator ownership, DTUHID envelope types, contact tracking, and the
# NDJSON protocol. Live delivery is only provable against a booted device.
#
# Usage:
#   ./test.sh                 # host architecture
#   ./test.sh --arch x86_64
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCH="$(uname -m)"
OUTPUT_DIR="$SCRIPT_DIR/out/tests"
DEPLOYMENT_TARGET="13.0"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--arch)
			ARCH="$2"
			shift 2
			;;
		--output)
			OUTPUT_DIR="$2"
			shift 2
			;;
		*)
			echo "unknown argument: $1" >&2
			exit 2
			;;
	esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
	echo "mobile-screencap tests only run on macOS" >&2
	exit 1
fi

SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
BUILD_DIR="$OUTPUT_DIR/$ARCH"
mkdir -p "$BUILD_DIR"
# Drop stale objects: swiftc rejects an input it sees change mid-build, which an incremental
# rebuild into an existing build directory can trip.
rm -f "$BUILD_DIR"/*.o

# Only the HID sources are under test; capture and encoding keep their own commands and contracts.
SWIFT_SOURCES=(
	"$SCRIPT_DIR/Sources/DeveloperDirectory.swift"
	"$SCRIPT_DIR/Sources/HidEvents.swift"
	"$SCRIPT_DIR/Sources/HidCommand.swift"
	"$SCRIPT_DIR/Sources/HidProtocol.swift"
	"$SCRIPT_DIR/Sources/HidSession.swift"
	"$SCRIPT_DIR/Tests/HidCommandTestSupport.swift"
	"$SCRIPT_DIR/Tests/HidTests.swift"
)
OBJC_SOURCES=(
	"$SCRIPT_DIR/Sources/SimulatorDeviceBridge.m"
	"$SCRIPT_DIR/Sources/SimulatorIndigoHid.m"
	"$SCRIPT_DIR/Sources/SimulatorDtuHid.m"
	"$SCRIPT_DIR/Tests/IndigoTestSupport.m"
)

echo "building native HID tests for $ARCH..."
OBJECTS=()
for source in "${OBJC_SOURCES[@]}"; do
	object="$BUILD_DIR/$(basename "${source%.m}").o"
	xcrun clang \
		-target "${ARCH}-apple-macos${DEPLOYMENT_TARGET}" \
		-isysroot "$SDK_PATH" \
		-I "$SCRIPT_DIR/Sources" \
		-fobjc-arc \
		-fblocks \
		-Wall \
		-Werror \
		-O0 \
		-g \
		-c "$source" \
		-o "$object"
	OBJECTS+=("$object")
done

xcrun swiftc \
	-Onone \
	-g \
	-swift-version 5 \
	-parse-as-library \
	-target "${ARCH}-apple-macos${DEPLOYMENT_TARGET}" \
	-I "$SCRIPT_DIR/Sources" \
	-import-objc-header "$SCRIPT_DIR/Tests/TestBridging.h" \
	-o "$BUILD_DIR/hid-tests" \
	"${SWIFT_SOURCES[@]}" \
	"${OBJECTS[@]}"

echo "running native HID tests..."
"$BUILD_DIR/hid-tests"

# The shipped helper still has to answer its own commands. `hid-doctor` is a static probe, so it runs
# anywhere; `hid` against a device that does not exist must report a startup `unavailable` frame,
# which is exactly the shape the managed host falls back from.
HELPER="${MOBILE_SCREENCAP_PATH:-$SCRIPT_DIR/out/mobile-screencap}"
if [[ -x "$HELPER" ]]; then
	echo "checking shipped helper commands..."
	"$HELPER" hid-doctor > "$BUILD_DIR/hid-doctor.json" || true
	python3 - "$BUILD_DIR/hid-doctor.json" <<'PY'
import json, sys
with open(sys.argv[1]) as handle:
    payload = json.load(handle)
required = {
    "type", "protocolVersion", "coreSimulatorAvailable", "coreSimulatorVersion",
    "transportPolicy", "legacyKeyboardSuppressed", "dtuhidSymbolsAvailable",
    "digitizerService", "simulatorKitPath", "simulatorKitCandidates", "negotiable", "detail",
}
missing = required - set(payload)
if missing:
    raise SystemExit(f"hid-doctor is missing keys: {sorted(missing)}")
if payload["type"] != "hid-doctor" or payload["protocolVersion"] != 1:
    raise SystemExit("hid-doctor reported an unexpected type or protocol version")
print("hid-doctor ok")
PY

	set +e
	echo "" | "$HELPER" hid --udid 00000000-0000-0000-0000-000000000000 \
		> "$BUILD_DIR/hid-unavailable.ndjson" 2> "$BUILD_DIR/hid-unavailable.log"
	status=$?
	set -e
	python3 - "$BUILD_DIR/hid-unavailable.ndjson" "$status" <<'PY'
import json, sys
lines = [line for line in open(sys.argv[1]).read().splitlines() if line.strip()]
if len(lines) != 1:
    raise SystemExit(f"expected exactly one startup frame on stdout, got {len(lines)}")
frame = json.loads(lines[0])
if frame.get("type") != "unavailable":
    raise SystemExit(f"expected an 'unavailable' startup frame, got {frame!r}")
if frame.get("protocolVersion") != 1 or not frame.get("code") or not frame.get("message"):
    raise SystemExit(f"the startup frame is missing protocol fields: {frame!r}")
if sys.argv[2] == "0":
    raise SystemExit("an unavailable session must exit non-zero")
print("hid startup ok")
PY

	# Existing commands must keep working: a rename or a new dispatch arm cannot regress Android's
	# use of the same executable.
	"$HELPER" --help 2>&1 | grep -q "encode" || {
		echo "the helper no longer advertises 'encode'" >&2
		exit 1
	}
	printf '' | "$HELPER" encode --width 2 --height 2 > /dev/null 2>&1 || true
	echo "shipped helper commands ok"
else
	echo "note: $HELPER is not built; skipping shipped-helper checks" >&2
fi

echo "native HID tests passed"
