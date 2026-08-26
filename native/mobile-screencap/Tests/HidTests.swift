import CoreGraphics
import Foundation

/// A dependency-free assertion harness. The helper ships as a plain executable, so the tests avoid
/// XCTest and run as their own binary that is never bundled with the product.
final class TestRunner {
	private var failures: [String] = []
	private var assertions = 0
	private var currentCase = ""

	func test(_ name: String, _ body: () throws -> Void) {
		currentCase = name
		do {
			try body()
		} catch {
			failures.append("\(name): threw \(error)")
		}
	}

	func expect(_ condition: Bool, _ message: @autoclosure () -> String) {
		assertions += 1
		if !condition {
			failures.append("\(currentCase): \(message())")
		}
	}

	func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ label: String) {
		expect(actual == expected, "\(label): expected \(expected), got \(actual)")
	}

	func expectClose(_ actual: Double, _ expected: Double, _ label: String, tolerance: Double = 1e-9) {
		expect(
			abs(actual - expected) <= tolerance,
			"\(label): expected \(expected), got \(actual)")
	}

	func finish() -> Never {
		if failures.isEmpty {
			print("ok — \(assertions) assertions passed")
			exit(0)
		}
		for failure in failures {
			print("FAIL \(failure)")
		}
		print("\(failures.count) failure(s), \(assertions) assertions")
		exit(1)
	}
}

@main
struct HidTests {
	static func main() {
		let runner = TestRunner()

		transportSelection(runner)
		simulatorKitLayout(runner)
		indigoWireLayout(runner)
		indigoButtonsAndKeyboard(runner)
		dtuhidEnvelopes(runner)
		dtuhidContacts(runner)
		coordinates(runner)
		swipeExpansion(runner)
		textAndKeys(runner)
		protocolParsing(runner)
		protocolSerialization(runner)
		commandFramingAndFailurePolicy(runner)
		contactCleanup(runner)

		runner.finish()
	}

	// MARK: Transport selection

	static func transportSelection(_ runner: TestRunner) {
		runner.test("numeric CoreSimulator version comparison") {
			runner.expect(
				MCCompareNumericVersions("1155.10", "1155.4") == .orderedDescending,
				"1155.10 must sort above 1155.4")
			runner.expect(
				MCCompareNumericVersions("1155.4", "1155.4") == .orderedSame, "equal versions sort the same")
			runner.expect(
				MCCompareNumericVersions("1155.3", "1155.4") == .orderedAscending,
				"1155.3 must sort below 1155.4")
			runner.expect(
				MCCompareNumericVersions("999.9", "1155.4") == .orderedAscending, "999.9 must sort below 1155.4")
			runner.expect(
				MCCompareNumericVersions(nil, "1155.4") == .orderedAscending, "nil must sort below any version")
		}

		runner.test("transport is selected from the loaded CoreSimulator version") {
			runner.expectEqual(
				HidTransportSelection.preferredTransport(coreSimulatorVersion: "1155.3"), .indigo, "1155.3")
			runner.expectEqual(
				HidTransportSelection.preferredTransport(coreSimulatorVersion: "1155.4"), .dtuhid, "1155.4")
			runner.expectEqual(
				HidTransportSelection.preferredTransport(coreSimulatorVersion: "1155.10"), .dtuhid, "1155.10")
			runner.expectEqual(
				HidTransportSelection.preferredTransport(coreSimulatorVersion: "1200.0"), .dtuhid, "1200.0")
			runner.expectEqual(
				HidTransportSelection.preferredTransport(coreSimulatorVersion: nil), .indigo, "unknown version")
		}

		runner.test("legacy keyboard suppression follows the same boundary") {
			runner.expect(
				!HidTransportSelection.isLegacyKeyboardSuppressed(coreSimulatorVersion: "1155.3"),
				"1155.3 keeps the legacy keyboard")
			runner.expect(
				HidTransportSelection.isLegacyKeyboardSuppressed(coreSimulatorVersion: "1155.4"),
				"1155.4 suppresses the legacy keyboard")
			runner.expect(
				HidTransportSelection.isLegacyKeyboardSuppressed(coreSimulatorVersion: "1155.10"),
				"1155.10 suppresses the legacy keyboard")
		}
	}

	// MARK: Framework layout

	static func simulatorKitLayout(_ runner: TestRunner) {
		runner.test("SimulatorKit is probed in both Xcode layouts, newest first") {
			let candidates = MCSimulatorKitCandidatePaths("/Applications/Xcode.app/Contents/Developer")
			runner.expectEqual(candidates.count, 2, "candidate count")
			runner.expectEqual(
				candidates[0],
				"/Applications/Xcode.app/Contents/SharedFrameworks/SimulatorKit.framework/SimulatorKit",
				"shared frameworks candidate is first")
			runner.expectEqual(
				candidates[1],
				"/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit",
				"legacy developer candidate is second")
		}

		runner.test("a trailing slash on the developer directory does not shift the layout") {
			let candidates = MCSimulatorKitCandidatePaths("/Applications/Xcode.app/Contents/Developer/")
			runner.expectEqual(
				candidates[0],
				"/Applications/Xcode.app/Contents/SharedFrameworks/SimulatorKit.framework/SimulatorKit",
				"shared frameworks candidate")
		}
	}

	// MARK: Indigo

	static func indigoWireLayout(_ runner: TestRunner) {
		runner.test("Indigo struct sizes match the SimulatorKit wire format") {
			runner.expectEqual(MCIndigoPayloadWireSize(), 0x90, "payload size")
			runner.expectEqual(MCIndigoMessageWireSize(), 0xB0, "message size")
			runner.expectEqual(MCIndigoTouchWireSize(), 0x70, "touch size")
		}

		runner.test("a touch message is a two-payload single-touch envelope") {
			MCFakeIndigoBuilders.reset()
			let builder = MCFakeIndigoBuilders.builder()
			let message = builder.touchMessage(
				ratio: CGPoint(x: 0.25, y: 0.75), direction: MCHidDirection.down)

			runner.expectEqual(message.count, 0x140, "message length")
			runner.expectEqual(Int(MCIndigoMessageInnerSize(message)), 0x90, "innerSize is the Swift payload stride")
			runner.expectEqual(Int(MCIndigoMessageEventType(message)), 0x02, "single-touch event type")
			runner.expectEqual(Int(MCIndigoMessageEventKind(message)), 0x0B, "touch event kind")
			runner.expectClose(MCIndigoMessageTouchXRatio(message), 0.25, "xRatio")
			runner.expectClose(MCIndigoMessageTouchYRatio(message), 0.75, "yRatio")
			runner.expectEqual(Int(MCIndigoMessageSecondContactField1(message)), 1, "duplicated contact field1")
			runner.expectEqual(Int(MCIndigoMessageSecondContactField2(message)), 2, "duplicated contact field2")

			runner.expectEqual(Int(MCFakeIndigoBuilders.lastMouseTarget), 0x32, "mouse builder target")
			runner.expectEqual(
				Int(MCFakeIndigoBuilders.lastMouseType), Int(MCHidDirection.down.rawValue), "mouse builder type")
			runner.expect(
				!MCFakeIndigoBuilders.lastMouseHadSecondPoint,
				"a single-finger touch must not pass a second point")
			runner.expectEqual(
				MCFakeIndigoBuilders.allocationCount, 1,
				"exactly one source message is allocated; the returned message is a separate allocation")
		}

		runner.test("a touch up carries the up direction into the source builder") {
			MCFakeIndigoBuilders.reset()
			let builder = MCFakeIndigoBuilders.builder()
			_ = builder.touchMessage(ratio: CGPoint(x: 0.5, y: 0.5), direction: MCHidDirection.up)
			runner.expectEqual(
				Int(MCFakeIndigoBuilders.lastMouseType), Int(MCHidDirection.up.rawValue), "mouse builder type")
		}
	}

	static func indigoButtonsAndKeyboard(_ runner: TestRunner) {
		runner.test("Indigo button sources match the wire constants") {
			let expected: [(MCHidButton, Int, String)] = [
				(.home, 0x0, "home"),
				(.lock, 0x1, "lock"),
				(.side, 0xbb8, "side"),
				(.siri, 0x400002, "siri"),
				(.applePay, 0x1f4, "apple pay"),
			]
			for (button, source, label) in expected {
				MCFakeIndigoBuilders.reset()
				let builder = MCFakeIndigoBuilders.builder()
				guard let message = builder.buttonMessage(button: button, direction: MCHidDirection.down) else {
					runner.expect(false, "\(label) must have an Indigo source")
					continue
				}
				runner.expectEqual(Int(MCIndigoMessageButtonSource(message)), source, "\(label) source")
				runner.expectEqual(Int(MCIndigoMessageButtonType(message)), 1, "\(label) down type")
				runner.expectEqual(Int(MCIndigoMessageButtonTarget(message)), 0x33, "\(label) hardware target")
			}
		}

		runner.test("Indigo keyboard forwards the USB HID usage and direction") {
			MCFakeIndigoBuilders.reset()
			let builder = MCFakeIndigoBuilders.builder()
			let message = builder.keyboardMessage(usage: 40, direction: MCHidDirection.up)
			runner.expectEqual(Int(MCFakeIndigoBuilders.lastKeyboardCode), 40, "usage")
			runner.expectEqual(Int(MCFakeIndigoBuilders.lastKeyboardType), 2, "up direction")
			runner.expect(message.count >= 0xB0, "the keyboard message is at least one payload long")
		}
	}

	// MARK: DTUHID

	static func dtuhidEnvelopes(_ runner: TestRunner) {
		runner.test("the DTUHID envelope carries the documented keys and wire types") {
			let payload = MCDtuHidEncodeDigitizerPayload(0.5, 0.25, MCDtuHidEventType.start)
			let message = MCDtuHidEncodeMessage("IndigoDigitizerEvent", payload)

			runner.expectEqual(
				MCXpcKeys(message), ["featureIdentifier", "isBarrier", "messageType", "payload"], "envelope keys")
			runner.expectEqual(MCXpcTypeName(message, "messageType"), "string", "messageType type")
			runner.expectEqual(MCXpcTypeName(message, "isBarrier"), "bool", "isBarrier type")
			runner.expectEqual(MCXpcTypeName(message, "featureIdentifier"), "string", "featureIdentifier type")
			runner.expectEqual(MCXpcTypeName(message, "payload"), "dictionary", "payload type")
			runner.expectEqual(
				MCXpcStringValue(message, "messageType"), "IndigoDigitizerEvent", "messageType value")
			runner.expectEqual(
				MCXpcStringValue(message, "featureIdentifier"),
				"com.apple.coredevice.feature.remote.hid.digitizer",
				"featureIdentifier value")
			runner.expect(!MCXpcBoolValue(message, "isBarrier"), "events are not barriers")
		}

		runner.test("a digitizer payload omits the second contact and types its scalars") {
			let payload = MCDtuHidEncodeDigitizerPayload(0.5, 0.25, MCDtuHidEventType.position)
			runner.expectEqual(
				MCXpcKeys(payload), ["edge", "eventType", "pointOne", "target"], "single-contact payload keys")
			runner.expectEqual(MCXpcTypeName(payload, "pointTwo"), "missing", "pointTwo is omitted")
			runner.expectEqual(MCXpcTypeName(payload, "eventType"), "uint64", "eventType rides as uint64")
			runner.expectEqual(MCXpcTypeName(payload, "edge"), "uint64", "edge rides as uint64")
			runner.expectEqual(MCXpcTypeName(payload, "target"), "uint64", "target rides as uint64")
			runner.expectEqual(MCXpcUInt64Value(payload, "eventType"), 1, "position event type")

			guard let point = MCXpcDictionaryValue(payload, "pointOne") else {
				runner.expect(false, "pointOne must be a dictionary")
				return
			}
			runner.expectEqual(MCXpcTypeName(point, "x"), "double", "x rides as double")
			runner.expectEqual(MCXpcTypeName(point, "y"), "double", "y rides as double")
			runner.expectClose(MCXpcDoubleValue(point, "x"), 0.5, "x value")
			runner.expectClose(MCXpcDoubleValue(point, "y"), 0.25, "y value")
		}

		runner.test("keyboard and button payloads are 1-based uint64 states") {
			let keyboard = MCDtuHidEncodeKeyboardPayload(40, MCDtuHidButtonState.down)
			runner.expectEqual(MCXpcKeys(keyboard), ["state", "usageCode"], "keyboard payload keys")
			runner.expectEqual(MCXpcTypeName(keyboard, "usageCode"), "uint64", "usageCode type")
			runner.expectEqual(MCXpcTypeName(keyboard, "state"), "uint64", "state type")
			runner.expectEqual(MCXpcUInt64Value(keyboard, "state"), 1, "down is 1, never 0")

			let button = MCDtuHidEncodeButtonPayload(0x0C, 0x40, MCDtuHidButtonState.up)
			runner.expectEqual(MCXpcKeys(button), ["state", "usageCode", "usagePage"], "button payload keys")
			runner.expectEqual(MCXpcUInt64Value(button, "usagePage"), 0x0C, "consumer page")
			runner.expectEqual(MCXpcUInt64Value(button, "usageCode"), 0x40, "menu usage")
			runner.expectEqual(MCXpcUInt64Value(button, "state"), 2, "up is 2")
		}

		runner.test("DTUHID hardware buttons map to Consumer-page usages") {
			var page: UInt64 = 0
			var code: UInt64 = 0
			let expected: [(MCHidButton, UInt64, String)] = [
				(.home, 0x40, "home"),
				(.lock, 0x30, "lock"),
				(.side, 0x30, "side"),
				(.siri, 0xCF, "siri"),
			]
			for (button, usage, label) in expected {
				runner.expect(
					MCDtuHidConsumerUsageForButton(button, &page, &code), "\(label) must have a usage")
				runner.expectEqual(page, 0x0C, "\(label) page")
				runner.expectEqual(code, usage, "\(label) usage")
			}
			runner.expect(
				!MCDtuHidConsumerUsageForButton(MCHidButton.applePay, &page, &code),
				"Apple Pay has no single usage; it is a double side-button press")
		}
	}

	static func dtuhidContacts(_ runner: TestRunner) {
		runner.test("contacts map down/up onto start, position, and end") {
			let tracker = MCDtuHidContactTracker()
			runner.expect(!tracker.active, "a fresh tracker has no contact")
			runner.expectEqual(tracker.eventType(direction: MCHidDirection.down), .start, "first down")
			runner.expect(tracker.active, "the contact is active after the first down")
			runner.expectEqual(tracker.eventType(direction: MCHidDirection.down), .position, "drag sample")
			runner.expectEqual(tracker.eventType(direction: MCHidDirection.down), .position, "second drag sample")
			runner.expectEqual(tracker.eventType(direction: MCHidDirection.up), .end, "release")
			runner.expect(!tracker.active, "the contact is inactive after release")
			runner.expectEqual(tracker.eventType(direction: MCHidDirection.down), .start, "a new gesture restarts")
		}

		runner.test("resetting a tracker clears the active contact") {
			let tracker = MCDtuHidContactTracker()
			_ = tracker.eventType(direction: MCHidDirection.down)
			tracker.reset()
			runner.expect(!tracker.active, "reset clears the contact")
			runner.expectEqual(
				tracker.eventType(direction: MCHidDirection.down), .start, "the next down starts a contact")
		}
	}

	// MARK: Coordinates

	static func coordinates(_ runner: TestRunner) {
		runner.test("points are normalized from the SimDevice screen size and scale") {
			let size = CGSize(width: 1179, height: 2556)
			let ratio = HidCoordinates.ratio(x: 196.5, y: 426, screenSize: size, screenScale: 3)
			runner.expectClose(Double(ratio.x), 0.5, "x ratio", tolerance: 1e-6)
			runner.expectClose(Double(ratio.y), 0.5, "y ratio", tolerance: 1e-6)
		}

		runner.test("out-of-screen points clamp into the unit square") {
			let size = CGSize(width: 1179, height: 2556)
			let low = HidCoordinates.ratio(x: -100, y: -100, screenSize: size, screenScale: 3)
			runner.expectClose(Double(low.x), 0, "clamped low x")
			runner.expectClose(Double(low.y), 0, "clamped low y")
			let high = HidCoordinates.ratio(x: 10_000, y: 10_000, screenSize: size, screenScale: 3)
			runner.expectClose(Double(high.x), 1, "clamped high x")
			runner.expectClose(Double(high.y), 1, "clamped high y")
		}

		runner.test("a missing screen size degrades to the origin instead of dividing by zero") {
			let ratio = HidCoordinates.ratio(x: 10, y: 10, screenSize: .zero, screenScale: 0)
			runner.expectClose(Double(ratio.x), 0, "x")
			runner.expectClose(Double(ratio.y), 0, "y")
		}
	}

	// MARK: Expansion

	static func swipeExpansion(_ runner: TestRunner) {
		runner.test("a swipe expands to timed samples with a terminal hold") {
			let events = HidEventBuilder.swipe(
				startX: 0, startY: 0, endX: 100, endY: 0, delta: 10, duration: 0.3)
			// 10 steps produces 11 down samples, one extra terminal down, and one up.
			let touches = events.compactMap { event -> (MCHidDirection, Double)? in
				guard case let .touch(direction, x, _) = event else { return nil }
				return (direction, x)
			}
			runner.expectEqual(touches.count, 13, "touch sample count")
			runner.expectEqual(touches.filter { $0.0 == MCHidDirection.down }.count, 12, "down samples")
			runner.expectEqual(touches.filter { $0.0 == MCHidDirection.up }.count, 1, "up samples")
			runner.expectClose(touches[0].1, 0, "first sample x")
			runner.expectClose(touches[10].1, 100, "last interpolated sample x")
			runner.expectClose(touches[11].1, 100, "terminal hold suppresses inertial scroll")
			runner.expect(touches[12].0 == MCHidDirection.up, "the gesture ends with a release")

			let delays = events.compactMap { event -> Double? in
				guard case let .delay(interval) = event else { return nil }
				return interval
			}
			runner.expectEqual(delays.count, 12, "delay count")
			for delay in delays {
				runner.expectClose(delay, 0.3 / 12.0, "step delay", tolerance: 1e-12)
			}
		}

		runner.test("a zero-length swipe still produces one step") {
			let events = HidEventBuilder.swipe(
				startX: 5, startY: 5, endX: 5, endY: 5, delta: 10, duration: 0.1)
			let touches = events.filter { if case .touch = $0 { return true } else { return false } }
			runner.expectEqual(touches.count, 4, "one interpolated sample, one hold, one release")
		}

		runner.test("a non-positive delta falls back to the default step") {
			let explicit = HidEventBuilder.swipe(
				startX: 0, startY: 0, endX: 100, endY: 0, delta: 10, duration: 0.3)
			let defaulted = HidEventBuilder.swipe(
				startX: 0, startY: 0, endX: 100, endY: 0, delta: 0, duration: 0.3)
			runner.expectEqual(defaulted.count, explicit.count, "event count")
		}

		runner.test("a tap without a duration emits no delay") {
			let events = HidEventBuilder.tap(x: 1, y: 2, duration: 0)
			runner.expectEqual(events.count, 2, "down and up only")
			let withDuration = HidEventBuilder.tap(x: 1, y: 2, duration: 0.5)
			runner.expectEqual(withDuration.count, 3, "down, delay, up")
		}

		runner.test("Apple Pay expands to a double side-button press") {
			let events = HidEventBuilder.applePayAsDoubleSidePress()
			let buttons = events.compactMap { event -> (MCHidButton, MCHidDirection)? in
				guard case let .button(button, direction) = event else { return nil }
				return (button, direction)
			}
			runner.expectEqual(buttons.count, 4, "two presses")
			runner.expect(buttons.allSatisfy { $0.0 == MCHidButton.side }, "every press is the side button")
			runner.expect(buttons[0].1 == MCHidDirection.down, "first half starts down")
			runner.expect(buttons[3].1 == MCHidDirection.up, "second half ends up")
		}
	}

	static func textAndKeys(_ runner: TestRunner) {
		runner.test("ASCII text maps to USB HID usages with shift framing") {
			guard let events = HidEventBuilder.text("aA!") else {
				runner.expect(false, "printable ASCII must map")
				return
			}
			let keys = events.compactMap { event -> (UInt32, MCHidDirection)? in
				guard case let .key(usage, direction) = event else { return nil }
				return (usage, direction)
			}
			// 'a' is two events; 'A' and '!' are four each because of the shift framing.
			runner.expectEqual(keys.count, 10, "key event count")
			runner.expectEqual(keys[0].0, 4, "'a' usage")
			runner.expectEqual(keys[2].0, UsbHidKeyboard.leftShift, "'A' is shifted")
			runner.expectEqual(keys[3].0, 4, "'A' uses the same usage as 'a'")
			runner.expectEqual(keys[5].0, UsbHidKeyboard.leftShift, "the shift is released")
			runner.expectEqual(keys[7].0, 30, "'!' is shift+1")
		}

		runner.test("digits, space, and newline map to their usages") {
			runner.expectEqual(UsbHidKeyboard.usage(for: "1")?.usage, 30, "'1'")
			runner.expectEqual(UsbHidKeyboard.usage(for: "9")?.usage, 38, "'9'")
			runner.expectEqual(UsbHidKeyboard.usage(for: "0")?.usage, 39, "'0'")
			runner.expectEqual(UsbHidKeyboard.usage(for: " ")?.usage, 44, "space")
			runner.expectEqual(UsbHidKeyboard.usage(for: "\n")?.usage, 40, "newline")
			runner.expectEqual(UsbHidKeyboard.usage(for: "z")?.usage, 29, "'z'")
		}

		runner.test("non-ASCII text has no keyboard expansion") {
			runner.expect(HidEventBuilder.text("café") == nil, "accented characters must not map")
			runner.expect(HidEventBuilder.text("🙂") == nil, "emoji must not map")
		}

		runner.test("a key chord holds modifiers and releases them in reverse") {
			let events = HidEventBuilder.keyChord(usages: [UsbHidKeyboard.leftCommand, UsbHidKeyboard.vKey])
			let keys = events.compactMap { event -> (UInt32, MCHidDirection)? in
				guard case let .key(usage, direction) = event else { return nil }
				return (usage, direction)
			}
			runner.expectEqual(keys.count, 4, "chord event count")
			runner.expectEqual(keys[0].0, UsbHidKeyboard.leftCommand, "command goes down first")
			runner.expectEqual(keys[1].0, UsbHidKeyboard.vKey, "v goes down second")
			runner.expectEqual(keys[2].0, UsbHidKeyboard.vKey, "v comes up first")
			runner.expectEqual(keys[3].0, UsbHidKeyboard.leftCommand, "command comes up last")
			runner.expect(keys[0].1 == MCHidDirection.down, "first half is down")
			runner.expect(keys[3].1 == MCHidDirection.up, "second half is up")
		}

		runner.test("a key sequence presses and releases each usage in turn") {
			let events = HidEventBuilder.keySequence(usages: [4, 5])
			let keys = events.compactMap { event -> (UInt32, MCHidDirection)? in
				guard case let .key(usage, direction) = event else { return nil }
				return (usage, direction)
			}
			runner.expectEqual(keys.count, 4, "sequence event count")
			runner.expectEqual(keys[0].0, 4, "first usage down")
			runner.expectEqual(keys[1].0, 4, "first usage up")
			runner.expectEqual(keys[2].0, 5, "second usage down")
		}
	}

	// MARK: Protocol

	static let screen = CGSize(width: 393, height: 852)

	static func protocolParsing(_ runner: TestRunner) {
		runner.test("malformed NDJSON is rejected without an id") {
			for line in ["not json", "[1,2]", "\"string\"", "{", "null"] {
				switch HidRequestParser.parse(line: line, screenPoints: screen) {
				case let .failure(error):
					runner.expectEqual(error.code, .malformedRequest, "code for '\(line)'")
					runner.expectEqual(error.id, 0, "unattributable id for '\(line)'")
				case .success:
					runner.expect(false, "'\(line)' must not parse")
				}
			}
		}

		runner.test("a request without a usable id or op is malformed") {
			let cases = [
				"{\"type\":\"ping\"}",
				"{\"id\":0,\"type\":\"ping\"}",
				"{\"id\":-1,\"type\":\"ping\"}",
				"{\"id\":1.5,\"type\":\"ping\"}",
				"{\"id\":\"1\",\"type\":\"ping\"}",
				"{\"id\":1}",
				"{\"id\":1,\"type\":\"\"}",
			]
			for line in cases {
				switch HidRequestParser.parse(line: line, screenPoints: screen) {
				case let .failure(error):
					runner.expectEqual(error.code, .malformedRequest, "code for \(line)")
				case .success:
					runner.expect(false, "\(line) must not parse")
				}
			}
		}

		runner.test("an unknown event type is an invalid request, not a malformed line") {
			switch HidRequestParser.parse(line: "{\"id\":7,\"type\":\"levitate\"}", screenPoints: screen) {
			case let .failure(error):
				runner.expectEqual(error.code, .invalidRequest, "code")
				runner.expectEqual(error.id, 7, "id is preserved so the host can correlate")
			case .success:
				runner.expect(false, "an unknown type must not parse")
			}
		}

		runner.test("a tap validates its coordinates before any event is built") {
			switch HidRequestParser.parse(
				line: "{\"id\":1,\"type\":\"tap\",\"x\":10,\"y\":20,\"duration\":0.05}", screenPoints: screen)
			{
			case let .success(request):
				runner.expectEqual(request.primitives.count, 3, "down, delay, up")
				runner.expect(request.drainsAfterBatch, "a tap is a complete gesture and drains once")
			case let .failure(error):
				runner.expect(false, "a valid tap must parse: \(error.message)")
			}

			for line in [
				"{\"id\":1,\"type\":\"tap\",\"y\":20}",
				"{\"id\":1,\"type\":\"tap\",\"x\":\"10\",\"y\":20}",
				"{\"id\":1,\"type\":\"tap\",\"x\":10,\"y\":999999}",
				"{\"id\":1,\"type\":\"tap\",\"x\":10,\"y\":20,\"duration\":-1}",
			] {
				switch HidRequestParser.parse(line: line, screenPoints: screen) {
				case let .failure(error):
					runner.expectEqual(error.code, .invalidRequest, "code for \(line)")
				case .success:
					runner.expect(false, "\(line) must not parse")
				}
			}
		}

		runner.test("continuous touch phases drain only on release") {
			let expectations: [(String, Bool, MCHidDirection)] = [
				("down", false, MCHidDirection.down),
				("move", false, MCHidDirection.down),
				("up", true, MCHidDirection.up),
			]
			for (phase, drains, direction) in expectations {
				switch HidRequestParser.parse(
					line: "{\"id\":3,\"type\":\"touch\",\"phase\":\"\(phase)\",\"x\":5,\"y\":6}",
					screenPoints: screen)
				{
				case let .success(request):
					runner.expectEqual(request.primitives.count, 1, "\(phase) is one primitive")
					guard case let .touch(actual, _, _) = request.primitives[0] else {
						runner.expect(false, "\(phase) must be a touch")
						continue
					}
					runner.expect(actual == direction, "\(phase) direction")
					runner.expectEqual(request.drainsAfterBatch, drains, "\(phase) drain policy")
				case let .failure(error):
					runner.expect(false, "\(phase) must parse: \(error.message)")
				}
			}

			switch HidRequestParser.parse(
				line: "{\"id\":3,\"type\":\"touch\",\"phase\":\"hover\",\"x\":5,\"y\":6}", screenPoints: screen)
			{
			case let .failure(error):
				runner.expectEqual(error.code, .invalidRequest, "unknown phase")
			case .success:
				runner.expect(false, "an unknown phase must not parse")
			}
		}

		runner.test("text, key, and button requests validate their payloads") {
			switch HidRequestParser.parse(line: "{\"id\":4,\"type\":\"text\",\"text\":\"hi\"}", screenPoints: screen) {
			case let .success(request):
				runner.expectEqual(request.primitives.count, 4, "two characters, two events each")
			case let .failure(error):
				runner.expect(false, "ASCII text must parse: \(error.message)")
			}

			switch HidRequestParser.parse(line: "{\"id\":4,\"type\":\"text\",\"text\":\"café\"}", screenPoints: screen) {
			case let .failure(error):
				runner.expectEqual(error.code, .invalidRequest, "non-ASCII text is rejected before delivery")
			case .success:
				runner.expect(false, "non-ASCII text must not parse")
			}

			switch HidRequestParser.parse(line: "{\"id\":5,\"type\":\"key\",\"usage\":40}", screenPoints: screen) {
			case let .success(request):
				runner.expectEqual(request.primitives.count, 2, "key down and up")
			case let .failure(error):
				runner.expect(false, "a key must parse: \(error.message)")
			}

			switch HidRequestParser.parse(line: "{\"id\":5,\"type\":\"key\",\"usage\":99999}", screenPoints: screen) {
			case let .failure(error):
				runner.expectEqual(error.code, .invalidRequest, "an out-of-range usage is rejected")
			case .success:
				runner.expect(false, "an out-of-range usage must not parse")
			}

			for name in HidButtonName.all {
				switch HidRequestParser.parse(
					line: "{\"id\":6,\"type\":\"button\",\"button\":\"\(name)\"}", screenPoints: screen)
				{
				case let .success(request):
					runner.expectEqual(request.primitives.count, 2, "\(name) down and up")
				case let .failure(error):
					runner.expect(false, "\(name) must parse: \(error.message)")
				}
			}

			switch HidRequestParser.parse(
				line: "{\"id\":6,\"type\":\"button\",\"button\":\"volume\"}", screenPoints: screen)
			{
			case let .failure(error):
				runner.expectEqual(error.code, .invalidRequest, "unknown button")
			case .success:
				runner.expect(false, "an unknown button must not parse")
			}
		}

		runner.test("control operations parse without primitives") {
			for (type, expected) in [("ping", "ping"), ("shutdown", "shutdown")] {
				switch HidRequestParser.parse(line: "{\"id\":9,\"type\":\"\(type)\"}", screenPoints: screen) {
				case let .success(request):
					runner.expect(request.primitives.isEmpty, "\(expected) sends nothing to the transport")
					runner.expect(request.control != nil, "\(expected) is a control operation")
				case let .failure(error):
					runner.expect(false, "\(type) must parse: \(error.message)")
				}
			}
		}

		runner.test("an events batch expands low-level primitives in order") {
			let line = """
				{"id":20,"type":"events","events":[\
				{"type":"touch","phase":"down","x":10,"y":10},\
				{"type":"delay","duration":0.05},\
				{"type":"key","usage":225,"direction":"down"},\
				{"type":"key","usage":4,"direction":"down"},\
				{"type":"key","usage":4,"direction":"up"},\
				{"type":"key","usage":225,"direction":"up"},\
				{"type":"button","button":"home","direction":"down"},\
				{"type":"touch","phase":"up","x":10,"y":10}]}
				"""
			switch HidRequestParser.parse(line: line, screenPoints: screen) {
			case let .success(request):
				runner.expectEqual(request.primitives.count, 8, "primitive count")
				guard case let .touch(first, _, _) = request.primitives[0] else {
					runner.expect(false, "the batch starts with a touch")
					return
				}
				runner.expect(first == MCHidDirection.down, "the batch starts with a touch down")
				guard case let .delay(interval) = request.primitives[1] else {
					runner.expect(false, "delays are preserved in place")
					return
				}
				runner.expectClose(interval, 0.05, "delay duration")
				guard case let .key(usage, direction) = request.primitives[2] else {
					runner.expect(false, "explicit key directions are preserved")
					return
				}
				runner.expectEqual(usage, 225, "modifier usage")
				runner.expect(direction == MCHidDirection.down, "modifier direction")
				guard case let .button(button, buttonDirection) = request.primitives[6] else {
					runner.expect(false, "explicit button directions are preserved")
					return
				}
				runner.expect(button == MCHidButton.home, "button")
				runner.expect(buttonDirection == MCHidDirection.down, "button direction")
				runner.expect(request.drainsAfterBatch, "a batch that releases its contact drains once")
			case let .failure(error):
				runner.expect(false, "a valid events batch must parse: \(error.message)")
			}
		}

		runner.test("an events batch composes high-level operations too") {
			let line = """
				{"id":21,"type":"events","events":[\
				{"type":"swipe","startX":0,"startY":0,"endX":50,"endY":0,"duration":0.2},\
				{"type":"text","text":"ab"}]}
				"""
			switch HidRequestParser.parse(line: line, screenPoints: screen) {
			case let .success(request):
				let keys = request.primitives.filter { if case .key = $0 { return true } else { return false } }
				runner.expectEqual(keys.count, 4, "two characters, two events each")
				runner.expect(request.drainsAfterBatch, "the batch completes its gesture")
			case let .failure(error):
				runner.expect(false, "a composed events batch must parse: \(error.message)")
			}
		}

		runner.test("an events batch is validated as a whole before delivery") {
			let cases = [
				"{\"id\":22,\"type\":\"events\",\"events\":[]}",
				"{\"id\":22,\"type\":\"events\"}",
				"{\"id\":22,\"type\":\"events\",\"events\":[{\"x\":1}]}",
				"{\"id\":22,\"type\":\"events\",\"events\":[{\"type\":\"events\",\"events\":[]}]}",
				"{\"id\":22,\"type\":\"events\",\"events\":[{\"type\":\"delay\"}]}",
				"{\"id\":22,\"type\":\"events\",\"events\":[{\"type\":\"key\",\"usage\":4,\"direction\":\"sideways\"}]}",
				"{\"id\":22,\"type\":\"events\",\"events\":[{\"type\":\"touch\",\"phase\":\"down\",\"x\":1,\"y\":1},{\"type\":\"text\",\"text\":\"é\"}]}",
			]
			for line in cases {
				switch HidRequestParser.parse(line: line, screenPoints: screen) {
				case let .failure(error):
					runner.expectEqual(error.code, .invalidRequest, "code for \(line)")
					runner.expectEqual(error.id, 22, "id for \(line)")
				case .success:
					runner.expect(false, "\(line) must not parse")
				}
			}
		}

		runner.test("a batch that leaves a contact down is not drained") {
			let line = """
				{"id":23,"type":"events","events":[\
				{"type":"touch","phase":"down","x":10,"y":10},\
				{"type":"touch","phase":"move","x":10,"y":20}]}
				"""
			switch HidRequestParser.parse(line: line, screenPoints: screen) {
			case let .success(request):
				runner.expect(
					!request.drainsAfterBatch,
					"draining every drag sample would cap continuous-gesture throughput")
			case let .failure(error):
				runner.expect(false, "the batch must parse: \(error.message)")
			}
		}

		runner.test("the drain rule follows the last contact in the batch") {
			runner.expect(
				HidEventBuilder.drainsAfterBatch([]), "a batch with no touches drains")
			runner.expect(
				HidEventBuilder.drainsAfterBatch(HidEventBuilder.keyPress(usage: 4, duration: 0)),
				"keyboard batches drain")
			runner.expect(
				HidEventBuilder.drainsAfterBatch(HidEventBuilder.tap(x: 1, y: 1, duration: 0)),
				"a tap drains")
			runner.expect(
				HidEventBuilder.drainsAfterBatch(
					HidEventBuilder.swipe(startX: 0, startY: 0, endX: 10, endY: 0, delta: 5, duration: 0.1)),
				"a swipe drains")
			runner.expect(
				!HidEventBuilder.drainsAfterBatch([.touch(direction: MCHidDirection.down, x: 1, y: 1)]),
				"a bare touch down does not drain")
			runner.expect(
				HidEventBuilder.drainsAfterBatch([
					.touch(direction: MCHidDirection.down, x: 1, y: 1),
					.touch(direction: MCHidDirection.up, x: 1, y: 1),
					.key(usage: 4, direction: MCHidDirection.down),
				]),
				"a trailing key does not reopen a released contact")
		}

		runner.test("the canonical envelope carries version, id, type, and events") {
			let line = """
				{"version":1,"id":31,"type":"events","events":[\
				{"type":"touch","phase":"down","x":10,"y":20},\
				{"type":"delay","duration":0.05},\
				{"type":"touch","phase":"up","x":10,"y":20}]}
				"""
			switch HidRequestParser.parse(line: line, screenPoints: screen) {
			case let .success(request):
				runner.expectEqual(request.id, 31, "id")
				runner.expectEqual(request.type, "events", "type")
				runner.expectEqual(request.primitives.count, 3, "down, delay, up")
				runner.expect(request.drainsAfterBatch, "a completed gesture drains once")
			case let .failure(error):
				runner.expect(false, "the canonical envelope must parse: \(error.message)")
			}
		}

		runner.test("a declared version must match the helper's protocol version") {
			switch HidRequestParser.parse(
				line: "{\"version\":2,\"id\":32,\"type\":\"ping\"}", screenPoints: screen)
			{
			case let .failure(error):
				runner.expectEqual(error.code, .unsupportedVersion, "code")
				runner.expectEqual(error.id, 32, "id is preserved so the host can correlate")
			case .success:
				runner.expect(false, "a future protocol version must not parse")
			}

			switch HidRequestParser.parse(
				line: "{\"version\":\"1\",\"id\":33,\"type\":\"ping\"}", screenPoints: screen)
			{
			case let .failure(error):
				runner.expectEqual(error.code, .malformedRequest, "a non-integer version is malformed")
			case .success:
				runner.expect(false, "a non-integer version must not parse")
			}

			switch HidRequestParser.parse(line: "{\"id\":34,\"type\":\"ping\"}", screenPoints: screen) {
			case .success:
				break
			case let .failure(error):
				runner.expect(false, "version is optional: \(error.message)")
			}
		}

		runner.test("'op' is accepted as an alias for 'type'") {
			switch HidRequestParser.parse(line: "{\"id\":35,\"op\":\"ping\"}", screenPoints: screen) {
			case let .success(request):
				runner.expectEqual(request.type, "ping", "the alias resolves to the same discriminator")
			case let .failure(error):
				runner.expect(false, "the alias must parse: \(error.message)")
			}
		}

		runner.test("a button event in a batch is a complete press") {
			switch HidRequestParser.parse(
				line: "{\"version\":1,\"id\":36,\"type\":\"events\",\"events\":[{\"type\":\"button\",\"button\":\"home\"}]}",
				screenPoints: screen)
			{
			case let .success(request):
				let buttons = request.primitives.compactMap { primitive -> MCHidDirection? in
					guard case let .button(_, direction) = primitive else { return nil }
					return direction
				}
				runner.expectEqual(buttons.count, 2, "the helper expands down and up")
				runner.expect(buttons[0] == MCHidDirection.down, "press starts down")
				runner.expect(buttons[1] == MCHidDirection.up, "press ends up")
			case let .failure(error):
				runner.expect(false, "a bare button press must parse: \(error.message)")
			}
		}

		runner.test("every documented button name is accepted inside a batch") {
			for name in HidButtonName.all {
				let line =
					"{\"version\":1,\"id\":37,\"type\":\"events\",\"events\":[{\"type\":\"button\",\"button\":\"\(name)\"}]}"
				switch HidRequestParser.parse(line: line, screenPoints: screen) {
				case let .success(request):
					runner.expectEqual(request.primitives.count, 2, "\(name) expands to a complete press")
				case let .failure(error):
					runner.expect(false, "\(name) must parse: \(error.message)")
				}
			}
		}

		runner.test("a swipe event in a batch is expanded natively into samples") {
			let line = """
				{"version":1,"id":38,"type":"events","events":[\
				{"type":"swipe","startX":0,"startY":0,"endX":100,"endY":0,"duration":0.3}]}
				"""
			switch HidRequestParser.parse(line: line, screenPoints: screen) {
			case let .success(request):
				let touches = request.primitives.filter {
					if case .touch = $0 { return true } else { return false }
				}
				runner.expectEqual(touches.count, 13, "the helper expands the swipe, not the host")
			case let .failure(error):
				runner.expect(false, "a swipe event must parse: \(error.message)")
			}
		}

		runner.test("requests keep their ids so replies can be correlated in order") {
			let lines = (1...5).map { "{\"id\":\($0),\"type\":\"ping\"}" }
			var ids: [Int] = []
			for line in lines {
				if case let .success(request) = HidRequestParser.parse(line: line, screenPoints: screen) {
					ids.append(request.id)
				}
			}
			runner.expectEqual(ids, [1, 2, 3, 4, 5], "ids are preserved in submission order")
		}
	}

	static func protocolSerialization(_ runner: TestRunner) {
		runner.test("result frames are byte-stable sorted JSON") {
			let (writer, read) = captureWriter()
			writer.success(id: 12)
			writer.failure(id: 13, code: .invalidRequest, message: "bad", beforeDelivery: true)
			writer.failure(id: 14, code: .transportFailed, message: "gone", beforeDelivery: false)
			writer.fatal(code: .transportFailed, message: "gone")
			runner.expectEqual(
				read(),
				"""
				{"id":12,"ok":true,"type":"result"}
				{"beforeDelivery":true,"code":"invalid_request","id":13,"message":"bad","ok":false,"type":"result"}
				{"beforeDelivery":false,"code":"transport_failed","id":14,"message":"gone","ok":false,"type":"result"}
				{"code":"transport_failed","message":"gone","type":"fatal"}

				""",
				"serialized frames")
		}

		runner.test("startup frames carry the version, transport, and capabilities") {
			let (writer, read) = captureWriter()
			writer.ready(
				udid: "ABC",
				transport: "dtuhid",
				coreSimulatorVersion: "1155.4",
				screen: HidScreenMetrics(widthPixels: 1179, heightPixels: 2556, scale: 3),
				capabilities: ["tap", "button.home"])
			writer.unavailable(code: .transportUnavailable, message: "no dtuhidd")
			runner.expectEqual(
				read(),
				"""
				{"capabilities":["button.home","tap"],"coreSimulatorVersion":"1155.4","protocolVersion":1,\
				"screen":{"heightPixels":2556,"heightPoints":852,"scale":3,"widthPixels":1179,"widthPoints":393},\
				"transport":"dtuhid","type":"ready","udid":"ABC"}
				{"code":"transport_unavailable","message":"no dtuhidd","protocolVersion":1,"type":"unavailable"}

				""",
				"startup frames")
		}
	}

	static func commandFramingAndFailurePolicy(_ runner: TestRunner) {
		runner.test("line reader preserves NDJSON framing and a final unterminated line") {
			let pipe = Pipe()
			pipe.fileHandleForWriting.write(Data("first\nsecond".utf8))
			pipe.fileHandleForWriting.closeFile()
			let reader = LineReader(handle: pipe.fileHandleForReading)

			runner.expectEqual(reader.next(), "first", "first framed request")
			runner.expectEqual(reader.next(), "second", "unterminated final request")
			runner.expect(reader.next() == nil, "EOF ends the session")
		}

		runner.test("only ambiguous delivery failures terminate the HID command") {
			runner.expect(
				!HidCommandFailurePolicy.terminatesSession(beforeDelivery: true),
				"a proven pre-delivery rejection keeps the session usable")
			runner.expect(
				HidCommandFailurePolicy.terminatesSession(beforeDelivery: false),
				"an ambiguous failure emits fatal and terminates the session")
		}
	}

	// MARK: Contact cleanup

	static func contactCleanup(_ runner: TestRunner) {
		runner.test("an active contact is released once on shutdown") {
			var state = HidContactState()
			runner.expect(state.release() == nil, "nothing to release before any touch")

			state.record(direction: MCHidDirection.down, x: 12, y: 34)
			runner.expect(state.isDown, "the contact is down")
			guard case let .touch(direction, x, y)? = state.release() else {
				runner.expect(false, "a down contact must produce a release")
				return
			}
			runner.expect(direction == MCHidDirection.up, "the release lifts the contact")
			runner.expectClose(x, 12, "released at the last x")
			runner.expectClose(y, 34, "released at the last y")
			runner.expect(!state.isDown, "the contact is no longer down")
			runner.expect(state.release() == nil, "the contact is released exactly once")
		}

		runner.test("a completed gesture leaves nothing to release") {
			var state = HidContactState()
			state.record(direction: MCHidDirection.down, x: 1, y: 1)
			state.record(direction: MCHidDirection.down, x: 2, y: 2)
			state.record(direction: MCHidDirection.up, x: 3, y: 3)
			runner.expect(state.release() == nil, "a released gesture needs no cleanup")
		}
	}

	// MARK: Helpers

	/// A writer bound to a pipe, plus a reader that drains everything written so far.
	static func captureWriter() -> (HidProtocolWriter, () -> String) {
		let pipe = Pipe()
		let writer = HidProtocolWriter(handle: pipe.fileHandleForWriting)
		return (
			writer,
			{
				try? pipe.fileHandleForWriting.close()
				let data = pipe.fileHandleForReading.readDataToEndOfFile()
				return String(decoding: data, as: UTF8.self)
			}
		)
	}
}
