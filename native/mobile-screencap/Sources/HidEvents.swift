import CoreGraphics
import Foundation

/// The transport-neutral HID primitives the session executes.
enum HidPrimitive {
	case touch(direction: MCHidDirection, x: Double, y: Double)
	case key(usage: UInt32, direction: MCHidDirection)
	case button(MCHidButton, direction: MCHidDirection)
	case delay(TimeInterval)
}

/// Expansion of high-level operations into ordered primitives.
///
/// The expansion is pure so swipe timing, text mapping, and button sequences are testable without a
/// simulator.
enum HidEventBuilder {
	/// The per-sample step, in points, a swipe is broken into when the caller does not choose one.
	static let defaultSwipeDelta: Double = 10.0
	/// The default swipe duration in seconds.
	static let defaultSwipeDuration: Double = 0.3

	static func tap(x: Double, y: Double, duration: Double) -> [HidPrimitive] {
		var events: [HidPrimitive] = [.touch(direction: MCHidDirection.down, x: x, y: y)]
		if duration > 0 {
			events.append(.delay(duration))
		}
		events.append(.touch(direction: MCHidDirection.up, x: x, y: y))
		return events
	}

	/// A swipe, expanded to timed touch samples.
	///
	/// Mirrors the sample count and delay schedule of the IDB swipe so native and IDB delivery feel
	/// the same, including the extra terminal touch-down that suppresses inertial scrolling on
	/// Apple silicon simulators.
	static func swipe(
		startX: Double,
		startY: Double,
		endX: Double,
		endY: Double,
		delta: Double,
		duration: Double
	) -> [HidPrimitive] {
		let distance = ((endY - startY) * (endY - startY) + (endX - startX) * (endX - startX)).squareRoot()
		let effectiveDelta = delta > 0 ? delta : defaultSwipeDelta
		let steps = max(1, Int(distance / effectiveDelta))
		let dx = (endX - startX) / Double(steps)
		let dy = (endY - startY) / Double(steps)
		let stepDelay = duration / Double(steps + 2)

		var events: [HidPrimitive] = []
		events.reserveCapacity((steps + 2) * 2 + 1)
		for step in 0...steps {
			events.append(
				.touch(
					direction: MCHidDirection.down,
					x: startX + dx * Double(step),
					y: startY + dy * Double(step)))
			events.append(.delay(stepDelay))
		}
		events.append(.touch(direction: MCHidDirection.down, x: startX + dx * Double(steps), y: startY + dy * Double(steps)))
		events.append(.delay(stepDelay))
		events.append(.touch(direction: MCHidDirection.up, x: endX, y: endY))
		return events
	}

	static func keyPress(usage: UInt32, duration: Double) -> [HidPrimitive] {
		var events: [HidPrimitive] = [.key(usage: usage, direction: MCHidDirection.down)]
		if duration > 0 {
			events.append(.delay(duration))
		}
		events.append(.key(usage: usage, direction: MCHidDirection.up))
		return events
	}

	/// Presses each usage in turn, releasing it before the next.
	static func keySequence(usages: [UInt32]) -> [HidPrimitive] {
		usages.flatMap { keyPress(usage: $0, duration: 0) }
	}

	/// Holds every usage down in order and releases them in reverse, so modifier chords such as
	/// Command+V land as a chord rather than as separate presses.
	static func keyChord(usages: [UInt32]) -> [HidPrimitive] {
		usages.map { .key(usage: $0, direction: MCHidDirection.down) }
			+ usages.reversed().map { .key(usage: $0, direction: MCHidDirection.up) }
	}

	static func buttonPress(_ button: MCHidButton, duration: Double) -> [HidPrimitive] {
		var events: [HidPrimitive] = [.button(button, direction: MCHidDirection.down)]
		if duration > 0 {
			events.append(.delay(duration))
		}
		events.append(.button(button, direction: MCHidDirection.up))
		return events
	}

	/// Apple Pay is a double press of the side button on transports that have no Apple Pay usage.
	static func applePayAsDoubleSidePress() -> [HidPrimitive] {
		buttonPress(MCHidButton.side, duration: 0)
			+ [.delay(0.06)]
			+ buttonPress(MCHidButton.side, duration: 0)
	}

	/// Whether a batch completes a gesture and should therefore be drained once.
	///
	/// A batch that ends with a contact still down is a continuous gesture in progress: draining it
	/// would add the bounded wait to every drag sample and cap throughput well below the rate such a
	/// gesture produces. Every other batch — tap, swipe, text, key, button, and the `up` that ends a
	/// continuous gesture — is complete and drains once.
	static func drainsAfterBatch(_ primitives: [HidPrimitive]) -> Bool {
		for primitive in primitives.reversed() {
			if case let .touch(direction, _, _) = primitive {
				return direction == MCHidDirection.up
			}
		}
		return true
	}

	/// Expands ASCII text into keyboard primitives, or `nil` when a character has no USB HID usage.
	static func text(_ value: String) -> [HidPrimitive]? {
		var events: [HidPrimitive] = []
		for character in value {
			guard let key = UsbHidKeyboard.usage(for: character) else {
				return nil
			}
			if key.shift {
				events.append(.key(usage: UsbHidKeyboard.leftShift, direction: MCHidDirection.down))
			}
			events.append(.key(usage: key.usage, direction: MCHidDirection.down))
			events.append(.key(usage: key.usage, direction: MCHidDirection.up))
			if key.shift {
				events.append(.key(usage: UsbHidKeyboard.leftShift, direction: MCHidDirection.up))
			}
		}
		return events
	}
}

/// USB HID keyboard usage mapping for the printable ASCII range.
enum UsbHidKeyboard {
	static let leftShift: UInt32 = 225
	static let leftCommand: UInt32 = 227
	static let vKey: UInt32 = 25

	private static let punctuation: [Character: (usage: UInt32, shift: Bool)] = [
		"\n": (40, false),
		"\t": (43, false),
		" ": (44, false),
		"-": (45, false),
		"=": (46, false),
		"[": (47, false),
		"]": (48, false),
		"\\": (49, false),
		";": (51, false),
		"'": (52, false),
		"`": (53, false),
		",": (54, false),
		".": (55, false),
		"/": (56, false),
		"_": (45, true),
		"+": (46, true),
		"{": (47, true),
		"}": (48, true),
		"|": (49, true),
		":": (51, true),
		"\"": (52, true),
		"~": (53, true),
		"<": (54, true),
		">": (55, true),
		"?": (56, true),
		"!": (30, true),
		"@": (31, true),
		"#": (32, true),
		"$": (33, true),
		"%": (34, true),
		"^": (35, true),
		"&": (36, true),
		"*": (37, true),
		"(": (38, true),
		")": (39, true),
	]

	static func usage(for character: Character) -> (usage: UInt32, shift: Bool)? {
		guard let ascii = character.asciiValue else {
			return nil
		}
		switch ascii {
		case UInt8(ascii: "a")...UInt8(ascii: "z"):
			return (UInt32(4 + ascii - UInt8(ascii: "a")), false)
		case UInt8(ascii: "A")...UInt8(ascii: "Z"):
			return (UInt32(4 + ascii - UInt8(ascii: "A")), true)
		case UInt8(ascii: "1")...UInt8(ascii: "9"):
			return (UInt32(30 + ascii - UInt8(ascii: "1")), false)
		case UInt8(ascii: "0"):
			return (39, false)
		default:
			return punctuation[character]
		}
	}
}

/// The hardware buttons the protocol names.
enum HidButtonName {
	static func parse(_ value: String) -> MCHidButton? {
		switch value.lowercased() {
		case "home":
			return MCHidButton.home
		case "lock":
			return MCHidButton.lock
		case "side", "side-button":
			return MCHidButton.side
		case "siri":
			return MCHidButton.siri
		case "apple-pay", "applepay":
			return MCHidButton.applePay
		default:
			return nil
		}
	}

	static let all = ["home", "lock", "side-button", "siri", "apple-pay"]
}

/// Tracks whether a digitizer contact is down and where it was last placed, so a session can lift a
/// stuck finger on shutdown.
struct HidContactState {
	private(set) var isDown = false
	private(set) var lastPoint = CGPoint.zero

	mutating func record(direction: MCHidDirection, x: Double, y: Double) {
		isDown = direction == MCHidDirection.down
		lastPoint = CGPoint(x: x, y: y)
	}

	/// The primitive that releases an active contact, or `nil` when nothing is down.
	mutating func release() -> HidPrimitive? {
		guard isDown else {
			return nil
		}
		isDown = false
		return .touch(direction: MCHidDirection.up, x: Double(lastPoint.x), y: Double(lastPoint.y))
	}
}

/// Converts logical points into the 0...1 top-left ratio both transports speak.
///
/// `screenSize` is the `SimDeviceType` main screen size in pixels; window or encoded-frame geometry
/// is deliberately not used, so the coordinate space stays the one the managed host sends.
enum HidCoordinates {
	static func ratio(x: Double, y: Double, screenSize: CGSize, screenScale: Float) -> CGPoint {
		guard screenSize.width > 0, screenSize.height > 0, screenScale > 0 else {
			return CGPoint(x: 0, y: 0)
		}
		let scaled = CGPoint(
			x: (x * Double(screenScale)) / screenSize.width,
			y: (y * Double(screenScale)) / screenSize.height)
		return CGPoint(x: clamp(scaled.x), y: clamp(scaled.y))
	}

	private static func clamp(_ value: CGFloat) -> CGFloat {
		guard value.isFinite else { return 0 }
		return min(max(value, 0), 1)
	}
}
