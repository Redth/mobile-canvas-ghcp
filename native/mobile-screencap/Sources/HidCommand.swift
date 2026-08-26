import Foundation

/// `mobile-screencap hid --udid <udid>`: a persistent version-1 NDJSON HID session.
///
/// Stdout carries protocol frames only. Requests are processed strictly in order so contact state
/// and event ordering stay deterministic; a request is fully validated before its first native
/// event is sent, so a rejection with `beforeDelivery` is safe for the host to route elsewhere.
enum HidCommand {
	static func run(_ options: CommandLineOptions) throws -> Never {
		let writer = HidProtocolWriter()
		guard let udid = options.string("udid"), !udid.isEmpty else {
			writer.unavailable(code: .invalidRequest, message: "--udid is required")
			exit(2)
		}

		let developerDirectory: String
		do {
			developerDirectory = try DeveloperDirectory.resolve(options.string("developer-dir"))
		} catch {
			writer.unavailable(code: .deviceUnavailable, message: "\(error)")
			exit(1)
		}

		let session: HidSession
		do {
			session = try HidSession.open(udid: udid, developerDirectory: developerDirectory)
		} catch let error as HidDeliveryError {
			writer.unavailable(code: error.code, message: error.message)
			exit(1)
		} catch {
			writer.unavailable(code: .transportUnavailable, message: "\(error)")
			exit(1)
		}

		writer.ready(
			udid: udid,
			transport: session.kind.rawValue,
			coreSimulatorVersion: session.coreSimulatorVersion,
			screen: session.screen,
			capabilities: session.capabilities)
		Events.emit([
			"type": "hid-ready",
			"transport": session.kind.rawValue,
			"coreSimulatorVersion": session.coreSimulatorVersion ?? NSNull(),
		])

		let reader = LineReader(handle: .standardInput)
		let screenPoints = session.screen.pointSize

		while let line = reader.next() {
			let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
			if trimmed.isEmpty {
				continue
			}

			switch HidRequestParser.parse(line: trimmed, screenPoints: screenPoints) {
			case let .failure(error):
				writer.failure(
					id: error.id, code: error.code, message: error.message, beforeDelivery: true)
			case let .success(request):
				if case .ping = request.control {
					writer.success(id: request.id)
					continue
				}
				if case .shutdown = request.control {
					writer.success(id: request.id)
					session.close()
					exit(0)
				}
				guard session.isHealthy else {
					// A transport that failed after `ready` may already have delivered part of a
					// gesture, so this is terminal rather than a fallback-safe rejection.
					let reason = session.failureReason ?? "the native HID transport is no longer usable"
					writer.failure(
						id: request.id, code: .transportFailed, message: reason, beforeDelivery: false)
					writer.fatal(code: .transportFailed, message: reason)
					session.close()
					exit(1)
				}

				do {
					try session.deliver(request)
					writer.success(id: request.id)
				} catch let error as HidDeliveryError {
					writer.failure(
						id: request.id, code: error.code, message: error.message,
						beforeDelivery: error.beforeDelivery)
					if HidCommandFailurePolicy.terminatesSession(beforeDelivery: error.beforeDelivery) {
						writer.fatal(code: error.code, message: error.message)
						session.close()
						exit(1)
					}
				} catch {
					writer.failure(
						id: request.id, code: .transportFailed, message: "\(error)", beforeDelivery: false)
					writer.fatal(code: .transportFailed, message: "\(error)")
					session.close()
					exit(1)
				}
			}
		}

		// Clean EOF: lift anything still down, drain once, disconnect, and exit.
		session.close()
		exit(0)
	}
}

enum HidCommandFailurePolicy {
	static func terminatesSession(beforeDelivery: Bool) -> Bool {
		!beforeDelivery
	}
}

/// `mobile-screencap hid-doctor`: a conservative static probe.
///
/// Reports whether a HID session is *negotiable* on this host — framework layout, symbol
/// availability, and the version policy. It does not connect to a device, so it never claims a live
/// transport; `hid` startup remains authoritative.
enum HidDoctorCommand {
	static func run(_ options: CommandLineOptions) throws {
		let developerDirectory = (try? DeveloperDirectory.resolve(options.string("developer-dir"))) ?? ""
		let coreSimulatorAvailable = MCSimulatorDevice.isCoreSimulatorAvailable
		let version = MCSimulatorDevice.loadedCoreSimulatorVersion
		let preferred = HidTransportSelection.preferredTransport(coreSimulatorVersion: version)
		let candidates = MCSimulatorKitCandidatePaths(developerDirectory)
		let simulatorKitPath = candidates.first { FileManager.default.fileExists(atPath: $0) }
		let dtuhidSymbols = MCDtuHidTransport.areXPCSymbolsAvailable

		let negotiable: Bool
		let detail: String
		if !coreSimulatorAvailable {
			negotiable = false
			detail = "CoreSimulator could not be loaded."
		} else if preferred == .dtuhid {
			negotiable = dtuhidSymbols
			detail = dtuhidSymbols
				? "CoreSimulator \(version ?? "unknown") routes HID through dtuhidd; the required XPC symbols are present. "
					+ "A live session still depends on \(MCDtuHidTransport.digitizerServiceName) on the booted device."
				: "CoreSimulator \(version ?? "unknown") routes HID through dtuhidd, but the required private XPC "
					+ "symbols are missing from this host."
		} else {
			negotiable = simulatorKitPath != nil
			detail = simulatorKitPath != nil
				? "CoreSimulator \(version ?? "unknown") uses the legacy Indigo transport; SimulatorKit was located."
				: "CoreSimulator \(version ?? "unknown") uses the legacy Indigo transport, but SimulatorKit was not "
					+ "found in the selected developer directory."
		}

		let payload: [String: Any] = [
			"type": "hid-doctor",
			"protocolVersion": HidProtocol.version,
			"coreSimulatorAvailable": coreSimulatorAvailable,
			"coreSimulatorVersion": version ?? NSNull(),
			"transportPolicy": preferred.rawValue,
			"legacyKeyboardSuppressed": HidTransportSelection.isLegacyKeyboardSuppressed(
				coreSimulatorVersion: version),
			"dtuhidSymbolsAvailable": dtuhidSymbols,
			"digitizerService": MCDtuHidTransport.digitizerServiceName,
			"simulatorKitPath": simulatorKitPath ?? NSNull(),
			"simulatorKitCandidates": candidates,
			"negotiable": negotiable,
			"detail": detail,
		]
		let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
		FileHandle.standardOutput.write(data)
		FileHandle.standardOutput.write(Data("\n".utf8))
		exit(negotiable ? 0 : 1)
	}
}

/// Reads newline-delimited input without waiting for EOF, so the session stays interactive.
final class LineReader {
	private let handle: FileHandle
	private var buffer = Data()
	private var atEnd = false

	init(handle: FileHandle) {
		self.handle = handle
	}

	func next() -> String? {
		while true {
			if let index = buffer.firstIndex(of: UInt8(ascii: "\n")) {
				let line = buffer[buffer.startIndex..<index]
				buffer.removeSubrange(buffer.startIndex...index)
				return String(decoding: line, as: UTF8.self)
			}
			if atEnd {
				guard !buffer.isEmpty else { return nil }
				let line = String(decoding: buffer, as: UTF8.self)
				buffer.removeAll()
				return line
			}
			let chunk = handle.availableData
			if chunk.isEmpty {
				atEnd = true
				continue
			}
			buffer.append(chunk)
		}
	}
}
