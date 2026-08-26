import Foundation

/// `mobile-screencap accessibility --udid <udid> [--developer-dir <path>] [--max-depth <n>]
/// [--max-nodes <n>] [--timeout <seconds>]`
///
/// A single-shot read of the frontmost iOS Simulator application's accessibility hierarchy from
/// the host side, without `idb_companion`. Success writes the tree itself as one JSON object to
/// stdout, in the dictionary shape the managed `AccessibilityParser` already understands
/// (`role`/`type`, `AXLabel`, `AXValue`, `AXUniqueId`, `help`, `frame`, `enabled`, `focused`,
/// `children`). A failure instead writes a single `{"type":"unavailable","code":...,"message":...}`
/// line and exits non-zero, mirroring the `hid`/`hid-doctor` "unavailable" frame convention so a
/// managed caller can tell a startup failure from a truncated/empty success apart without parsing
/// stderr.
enum AccessibilityCommand {
	/// The root counts as depth 0; this keeps a runaway or adversarial UI tree from producing an
	/// unbounded response.
	static let defaultMaxDepth = 64
	/// A generous ceiling for a single screen's worth of UI while still bounding worst-case size
	/// and serialization time.
	static let defaultMaxNodes = 20_000
	/// How long a single request is allowed to wait on the simulator's translation round trip.
	static let defaultRequestTimeout: TimeInterval = 5.0

	static func run(_ options: CommandLineOptions) throws -> Never {
		guard let udid = options.string("udid"), !udid.isEmpty else {
			emitUnavailable(code: "invalid_request", message: "--udid is required")
			exit(2)
		}

		let maxDepth = clampInt(options.int("max-depth") ?? defaultMaxDepth, min: 0, max: 4096)
		let maxNodes = clampInt(options.int("max-nodes") ?? defaultMaxNodes, min: 1, max: 200_000)
		let requestTimeout = clampTimeout(options.double("timeout") ?? defaultRequestTimeout)

		let developerDirectory: String
		do {
			developerDirectory = try DeveloperDirectory.resolve(options.string("developer-dir"))
		} catch {
			emitUnavailable(code: "device_unavailable", message: "\(error)")
			exit(1)
		}

		guard MCSimulatorDevice.isCoreSimulatorAvailable else {
			emitUnavailable(
				code: "device_unavailable", message: "CoreSimulator is unavailable in this process")
			exit(1)
		}

		let device: MCSimulatorDevice
		do {
			device = try MCSimulatorDevice.lookUp(udid: udid, developerDirectory: developerDirectory)
		} catch {
			emitUnavailable(code: "device_unavailable", message: (error as NSError).localizedDescription)
			exit(1)
		}

		guard device.isBooted else {
			let state = device.stateDescription ?? "unknown"
			emitUnavailable(
				code: "device_not_booted",
				message: "simulator \(udid) is not booted (state: \(state))")
			exit(1)
		}

		guard MCAccessibilityReader.isAvailable else {
			emitUnavailable(
				code: "framework_unavailable",
				message: MCAccessibilityReader.unavailableReason
					?? "the accessibility translation framework is unavailable on this host")
			exit(1)
		}

		do {
			let tree = try MCAccessibilityReader.accessibilityTree(
				device: device, maxDepth: maxDepth, maxNodes: maxNodes, requestTimeout: requestTimeout)
			let data = try JSONSerialization.data(
				withJSONObject: tree, options: [.prettyPrinted, .sortedKeys])
			FileHandle.standardOutput.write(data)
			FileHandle.standardOutput.write(Data("\n".utf8))
			exit(0)
		} catch let error as NSError where error.domain == MCAccessibilityErrorDomain {
			emitUnavailable(code: errorCode(forRawValue: error.code), message: error.localizedDescription)
			exit(1)
		} catch {
			emitUnavailable(code: "internal_error", message: "\(error)")
			exit(1)
		}
	}

	/// Maps `MCAccessibilityErrorCode` (declared in `SimulatorAccessibilityBridge.h`) to a stable
	/// string a managed caller can switch on. Matched against the raw integer rather than the
	/// imported Swift enum case so this stays correct regardless of how Swift happens to spell an
	/// individual case name.
	static func errorCode(forRawValue rawValue: Int) -> String {
		switch rawValue {
		case 1: return "framework_unavailable"
		case 2: return "selector_unavailable"
		case 3: return "device_not_booted"
		case 4: return "timeout"
		case 5: return "empty_tree"
		default: return "internal_error"
		}
	}

	static func clampInt(_ value: Int, min lower: Int, max upper: Int) -> Int {
		Swift.min(Swift.max(value, lower), upper)
	}

	static func clampTimeout(_ value: Double) -> TimeInterval {
		guard value.isFinite else { return defaultRequestTimeout }
		return Swift.min(Swift.max(value, 0.1), 60.0)
	}

	private static func emitUnavailable(code: String, message: String) {
		let payload: [String: Any] = ["type": "unavailable", "code": code, "message": message]
		guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
		else {
			return
		}
		FileHandle.standardOutput.write(data)
		FileHandle.standardOutput.write(Data("\n".utf8))
	}
}
