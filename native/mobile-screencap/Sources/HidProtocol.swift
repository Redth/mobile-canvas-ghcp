import Foundation

/// Version 1 of the persistent HID protocol.
///
/// Newline-delimited JSON in both directions on the `hid` command's stdin/stdout. For this command
/// stdout carries protocol frames only; every log and diagnostic goes to stderr. Keys are emitted
/// sorted so the frames a .NET `JsonDocument` client sees are byte-stable.
enum HidProtocol {
	static let version = 1
}

/// A machine-readable failure code. The managed host branches on these, so the strings are part of
/// the contract.
enum HidErrorCode: String {
	/// The line was not a JSON object, or lacked a usable `id`/`op`.
	case malformedRequest = "malformed_request"
	/// The request parsed but failed validation; nothing was sent.
	case invalidRequest = "invalid_request"
	/// The operation is not available on the negotiated transport.
	case unsupportedOperation = "unsupported_operation"
	/// The native transport failed. Delivery is ambiguous unless `beforeDelivery` is set.
	case transportFailed = "transport_failed"
	/// The session is shutting down and cannot accept work.
	case sessionClosed = "session_closed"
	/// CoreSimulator could not be reached or the device was not found.
	case deviceUnavailable = "device_unavailable"
	/// No usable HID transport could be negotiated for the loaded CoreSimulator.
	case transportUnavailable = "transport_unavailable"
	/// The request declared a protocol version this helper does not speak.
	case unsupportedVersion = "unsupported_version"
}

/// A parsed, validated request.
struct HidRequest {
	var id: Int
	/// The request discriminator, as sent in `type`.
	var type: String
	var primitives: [HidPrimitive]
	/// Whether the batch is a completed gesture that should be drained once when it finishes.
	var drainsAfterBatch: Bool
	/// Control operations that bypass the transport.
	var control: Control?

	enum Control {
		case ping
		case shutdown
	}
}

/// A validation failure, raised before any primitive is written to the transport.
struct HidRequestError: Error {
	var id: Int
	var code: HidErrorCode
	var message: String
}

/// Parses and validates protocol frames.
///
/// The canonical request is a transport-neutral event batch:
///
/// ```json
/// {"version":1,"id":7,"type":"events","events":[
///   {"type":"touch","phase":"down","x":10,"y":20},
///   {"type":"delay","duration":0.05},
///   {"type":"touch","phase":"up","x":10,"y":20}]}
/// ```
///
/// Validation is complete before the first native event of a request is sent, so a rejected request
/// is always safe for the managed host to retry on another transport.
enum HidRequestParser {
	static func parse(line: String, screenPoints: CGSize) -> Result<HidRequest, HidRequestError> {
		guard
			let data = line.data(using: .utf8),
			let object = try? JSONSerialization.jsonObject(with: data),
			let fields = object as? [String: Any]
		else {
			return .failure(
				HidRequestError(id: 0, code: .malformedRequest, message: "the line is not a JSON object"))
		}

		guard let id = intValue(fields["id"]), id > 0 else {
			return .failure(
				HidRequestError(id: 0, code: .malformedRequest, message: "'id' must be a positive integer"))
		}
		// `op` is accepted as an alias for `type` so a client written against either spelling works.
		guard let type = (fields["type"] ?? fields["op"]) as? String, !type.isEmpty else {
			return .failure(
				HidRequestError(id: id, code: .malformedRequest, message: "'type' must be a non-empty string"))
		}
		if let declared = fields["version"] ?? fields["protocolVersion"] {
			guard let version = intValue(declared) else {
				return .failure(
					HidRequestError(id: id, code: .malformedRequest, message: "'version' must be an integer"))
			}
			guard version == HidProtocol.version else {
				return .failure(
					HidRequestError(
						id: id, code: .unsupportedVersion,
						message: "this helper speaks protocol version \(HidProtocol.version), not \(version)"))
			}
		}

		do {
			return .success(try build(id: id, type: type, fields: fields, screenPoints: screenPoints))
		} catch let error as HidRequestError {
			return .failure(error)
		} catch {
			return .failure(HidRequestError(id: id, code: .invalidRequest, message: "\(error)"))
		}
	}

	private static func build(
		id: Int, type: String, fields: [String: Any], screenPoints: CGSize
	) throws -> HidRequest {
		if let control = control(for: type) {
			return HidRequest(id: id, type: type, primitives: [], drainsAfterBatch: false, control: control)
		}
		let primitives = try primitives(id: id, type: type, fields: fields, screenPoints: screenPoints)
		return HidRequest(
			id: id, type: type, primitives: primitives,
			drainsAfterBatch: HidEventBuilder.drainsAfterBatch(primitives), control: nil)
	}

	private static func control(for type: String) -> HidRequest.Control? {
		switch type {
		case "ping":
			return .ping
		case "shutdown":
			return .shutdown
		default:
			return nil
		}
	}

	/// Expands one request, or one entry of an `events` batch, into its ordered primitives. Every
	/// field is validated here, before the session writes anything to the transport.
	private static func primitives(
		id: Int, type: String, fields: [String: Any], screenPoints: CGSize
	) throws -> [HidPrimitive] {
		switch type {
		case "events":
			guard let raw = fields["events"] as? [Any], !raw.isEmpty else {
				throw HidRequestError(
					id: id, code: .invalidRequest, message: "'events' must be a non-empty array")
			}
			return try raw.flatMap { entry -> [HidPrimitive] in
				guard let event = entry as? [String: Any], let eventType = event["type"] as? String else {
					throw HidRequestError(
						id: id, code: .invalidRequest, message: "every entry in 'events' needs a 'type'")
				}
				guard eventType != "events" else {
					throw HidRequestError(
						id: id, code: .invalidRequest, message: "'events' batches cannot be nested")
				}
				if eventType == "delay" {
					guard let duration = try optionalDuration(event, "duration", id: id) else {
						throw HidRequestError(
							id: id, code: .invalidRequest, message: "a delay event needs a 'duration'")
					}
					return [.delay(duration)]
				}
				if eventType == "key", let direction = event["direction"] as? String {
					// An explicit direction lets the host build its own chords and modifier framing.
					let usage = try usageValue(event["usage"] ?? event["keyCode"], id: id, field: "usage")
					return [.key(usage: usage, direction: try directionValue(direction, id: id))]
				}
				if eventType == "button", let direction = event["direction"] as? String {
					guard let name = event["button"] as? String, let button = HidButtonName.parse(name) else {
						throw HidRequestError(
							id: id, code: .invalidRequest,
							message: "'button' must be one of \(HidButtonName.all.joined(separator: ", "))")
					}
					return [.button(button, direction: try directionValue(direction, id: id))]
				}
				return try primitives(id: id, type: eventType, fields: event, screenPoints: screenPoints)
			}
		case "tap":
			let x = try coordinate(fields, "x", id: id, limit: screenPoints.width)
			let y = try coordinate(fields, "y", id: id, limit: screenPoints.height)
			let duration = try optionalDuration(fields, "duration", id: id) ?? 0
			return HidEventBuilder.tap(x: x, y: y, duration: duration)
		case "touch":
			let x = try coordinate(fields, "x", id: id, limit: screenPoints.width)
			let y = try coordinate(fields, "y", id: id, limit: screenPoints.height)
			guard let phase = fields["phase"] as? String else {
				throw HidRequestError(id: id, code: .invalidRequest, message: "'phase' is required")
			}
			switch phase.lowercased() {
			case "down", "move":
				// Indigo has no distinct move phase: a contact already down moves by pressing again.
				return [.touch(direction: MCHidDirection.down, x: x, y: y)]
			case "up":
				return [.touch(direction: MCHidDirection.up, x: x, y: y)]
			default:
				throw HidRequestError(
					id: id, code: .invalidRequest, message: "'phase' must be down, move, or up")
			}
		case "swipe":
			let startX = try coordinate(fields, "startX", id: id, limit: screenPoints.width)
			let startY = try coordinate(fields, "startY", id: id, limit: screenPoints.height)
			let endX = try coordinate(fields, "endX", id: id, limit: screenPoints.width)
			let endY = try coordinate(fields, "endY", id: id, limit: screenPoints.height)
			let duration = try optionalDuration(fields, "duration", id: id) ?? HidEventBuilder.defaultSwipeDuration
			let delta = try optionalDuration(fields, "delta", id: id) ?? HidEventBuilder.defaultSwipeDelta
			return HidEventBuilder.swipe(
				startX: startX, startY: startY, endX: endX, endY: endY, delta: delta, duration: duration)
		case "text":
			guard let text = fields["text"] as? String else {
				throw HidRequestError(id: id, code: .invalidRequest, message: "'text' is required")
			}
			guard let expanded = HidEventBuilder.text(text) else {
				throw HidRequestError(
					id: id, code: .invalidRequest,
					message: "'text' contains characters with no USB HID keyboard usage")
			}
			return expanded
		case "key":
			let usage = try usageValue(fields["usage"] ?? fields["keyCode"], id: id, field: "usage")
			let duration = try optionalDuration(fields, "duration", id: id) ?? 0
			return HidEventBuilder.keyPress(usage: usage, duration: duration)
		case "keySequence", "keyChord":
			guard let raw = fields["usages"] as? [Any], !raw.isEmpty else {
				throw HidRequestError(
					id: id, code: .invalidRequest, message: "'usages' must be a non-empty array")
			}
			let usages = try raw.map { try usageValue($0, id: id, field: "usages") }
			return type == "keyChord"
				? HidEventBuilder.keyChord(usages: usages)
				: HidEventBuilder.keySequence(usages: usages)
		case "button":
			guard let name = fields["button"] as? String, let button = HidButtonName.parse(name) else {
				throw HidRequestError(
					id: id, code: .invalidRequest,
					message: "'button' must be one of \(HidButtonName.all.joined(separator: ", "))")
			}
			let duration = try optionalDuration(fields, "duration", id: id) ?? 0
			return HidEventBuilder.buttonPress(button, duration: duration)
		default:
			throw HidRequestError(
				id: id, code: .invalidRequest, message: "unknown event type '\(type)'")
		}
	}

	private static func directionValue(_ raw: String, id: Int) throws -> MCHidDirection {
		switch raw.lowercased() {
		case "down":
			return MCHidDirection.down
		case "up":
			return MCHidDirection.up
		default:
			throw HidRequestError(id: id, code: .invalidRequest, message: "'direction' must be down or up")
		}
	}

	private static func coordinate(
		_ fields: [String: Any], _ key: String, id: Int, limit: CGFloat
	) throws -> Double {
		guard let value = doubleValue(fields[key]), value.isFinite else {
			throw HidRequestError(id: id, code: .invalidRequest, message: "'\(key)' must be a finite number")
		}
		// A generous bound: coordinates arrive as logical points, so anything far outside the screen
		// is a unit mistake rather than an edge tap.
		let bound = limit > 0 ? Double(limit) * 2 : 100_000
		guard value >= -bound, value <= bound else {
			throw HidRequestError(
				id: id, code: .invalidRequest, message: "'\(key)' is outside the device coordinate space")
		}
		return value
	}

	private static func optionalDuration(
		_ fields: [String: Any], _ key: String, id: Int
	) throws -> Double? {
		guard let raw = fields[key] else {
			return nil
		}
		guard let value = doubleValue(raw), value.isFinite, value >= 0, value <= 600 else {
			throw HidRequestError(
				id: id, code: .invalidRequest, message: "'\(key)' must be a number between 0 and 600")
		}
		return value
	}

	private static func usageValue(_ raw: Any?, id: Int, field: String) throws -> UInt32 {
		guard let value = intValue(raw), value >= 0, value <= 0xFFFF else {
			throw HidRequestError(
				id: id, code: .invalidRequest,
				message: "'\(field)' must be a USB HID usage between 0 and 65535")
		}
		return UInt32(value)
	}

	private static func intValue(_ raw: Any?) -> Int? {
		if let number = raw as? NSNumber {
			// Reject fractional values rather than silently truncating an id or usage.
			return number.doubleValue == number.doubleValue.rounded() ? number.intValue : nil
		}
		return nil
	}

	private static func doubleValue(_ raw: Any?) -> Double? {
		(raw as? NSNumber)?.doubleValue
	}
}

/// Serializes protocol frames onto a single ordered stdout stream.
final class HidProtocolWriter: @unchecked Sendable {
	private let lock = NSLock()
	private let handle: FileHandle

	init(handle: FileHandle = .standardOutput) {
		self.handle = handle
	}

	func ready(
		udid: String,
		transport: String,
		coreSimulatorVersion: String?,
		screen: HidScreenMetrics,
		capabilities: [String]
	) {
		write([
			"type": "ready",
			"protocolVersion": HidProtocol.version,
			"udid": udid,
			"transport": transport,
			"coreSimulatorVersion": coreSimulatorVersion ?? NSNull(),
			"screen": screen.payload,
			"capabilities": capabilities.sorted(),
		])
	}

	func unavailable(code: HidErrorCode, message: String) {
		write([
			"type": "unavailable",
			"protocolVersion": HidProtocol.version,
			"code": code.rawValue,
			"message": message,
		])
	}

	func success(id: Int) {
		write(["type": "result", "id": id, "ok": true])
	}

	func failure(id: Int, code: HidErrorCode, message: String, beforeDelivery: Bool) {
		write([
			"type": "result",
			"id": id,
			"ok": false,
			"code": code.rawValue,
			"message": message,
			"beforeDelivery": beforeDelivery,
		])
	}

	/// A terminal frame: the transport failed after `ready`, so nothing may be replayed elsewhere.
	func fatal(code: HidErrorCode, message: String) {
		write(["type": "fatal", "code": code.rawValue, "message": message])
	}

	private func write(_ payload: [String: Any]) {
		guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
			return
		}
		lock.lock()
		handle.write(data)
		handle.write(Data("\n".utf8))
		lock.unlock()
	}
}

/// The device screen metrics reported at startup so the host can validate coordinates locally.
struct HidScreenMetrics {
	var widthPixels: Double
	var heightPixels: Double
	var scale: Double

	var pointSize: CGSize {
		guard scale > 0 else { return CGSize(width: widthPixels, height: heightPixels) }
		return CGSize(width: widthPixels / scale, height: heightPixels / scale)
	}

	var payload: [String: Any] {
		[
			"widthPixels": widthPixels,
			"heightPixels": heightPixels,
			"scale": scale,
			"widthPoints": Double(pointSize.width),
			"heightPoints": Double(pointSize.height),
		]
	}
}
