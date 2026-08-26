import CoreGraphics
import Foundation

/// A failure raised while delivering a batch. `beforeDelivery` distinguishes a rejection that wrote
/// nothing (safe for the managed host to route elsewhere) from an ambiguous mid-batch failure.
struct HidDeliveryError: Error {
	var code: HidErrorCode
	var message: String
	var beforeDelivery: Bool
}

/// The native transports the helper can negotiate.
enum HidTransportKind: String {
	case indigo
	case dtuhid
}

/// Chooses the transport for the CoreSimulator actually loaded in this process.
///
/// Deliberately not derived from the selected Xcode: CoreSimulator is a system framework that the
/// Xcode installer overwrites, so it can be newer than `DEVELOPER_DIR`. Also deliberately not a
/// probe for a resident `dtuhidd`, which is demand-launched and normally not running even on a
/// simulator that routes all HID through it.
enum HidTransportSelection {
	/// The first CoreSimulator version to hand the guest's HID services to `dtuhidd`.
	static let firstDtuHidCoreSimulatorVersion = "1155.4"

	static func shipsDtuHid(coreSimulatorVersion: String?) -> Bool {
		guard let coreSimulatorVersion else {
			return false
		}
		return MCCompareNumericVersions(coreSimulatorVersion, firstDtuHidCoreSimulatorVersion) != .orderedAscending
	}

	/// Whether the guest has handed its legacy keyboard HID over to `dtuhidd`. From that point legacy
	/// keyboard events deliver byte-correctly and produce no text, so a session that cannot reach
	/// DTUHID must not claim keyboard readiness.
	static func isLegacyKeyboardSuppressed(coreSimulatorVersion: String?) -> Bool {
		shipsDtuHid(coreSimulatorVersion: coreSimulatorVersion)
	}

	static func preferredTransport(coreSimulatorVersion: String?) -> HidTransportKind {
		shipsDtuHid(coreSimulatorVersion: coreSimulatorVersion) ? .dtuhid : .indigo
	}
}

/// A negotiated native HID transport plus the state a persistent session needs.
final class HidSession {
	let kind: HidTransportKind
	let screen: HidScreenMetrics
	let coreSimulatorVersion: String?

	private let screenSize: CGSize
	private let screenScale: Float
	private let indigoClient: MCIndigoHidClient?
	private let indigoBuilder: MCIndigoMessageBuilder?
	private let dtuhid: MCDtuHidTransport?
	/// Whether a digitizer contact is currently down, so shutdown can lift it.
	private var contact = HidContactState()

	var capabilities: [String] {
		["events", "tap", "touch", "swipe", "text", "key", "keySequence", "keyChord"]
			+ HidButtonName.all.map { "button.\($0)" }
	}

	/// Establishes the transport the loaded CoreSimulator requires.
	///
	/// Failures here happen before any event can be delivered, so the caller reports them as a
	/// startup `unavailable` frame the managed host may safely fall back from.
	static func open(udid: String, developerDirectory: String) throws -> HidSession {
		guard MCSimulatorDevice.isCoreSimulatorAvailable else {
			throw HidDeliveryError(
				code: .deviceUnavailable,
				message: "CoreSimulator is unavailable in this process",
				beforeDelivery: true)
		}

		let device: MCSimulatorDevice
		do {
			device = try MCSimulatorDevice.lookUp(udid: udid, developerDirectory: developerDirectory)
		} catch {
			throw HidDeliveryError(
				code: .deviceUnavailable,
				message: (error as NSError).localizedDescription,
				beforeDelivery: true)
		}

		let version = MCSimulatorDevice.loadedCoreSimulatorVersion
		let screenSize = device.mainScreenSize
		let screenScale = device.mainScreenScale
		guard screenSize.width > 0, screenSize.height > 0, screenScale > 0 else {
			throw HidDeliveryError(
				code: .deviceUnavailable,
				message: "CoreSimulator did not report a main screen size for \(udid)",
				beforeDelivery: true)
		}
		let metrics = HidScreenMetrics(
			widthPixels: Double(screenSize.width),
			heightPixels: Double(screenSize.height),
			scale: Double(screenScale))

		if HidTransportSelection.preferredTransport(coreSimulatorVersion: version) == .dtuhid {
			do {
				let transport = try MCDtuHidTransport.make(device: device)
				return HidSession(
					kind: .dtuhid, screen: metrics, coreSimulatorVersion: version,
					screenSize: screenSize, screenScale: screenScale,
					indigoClient: nil, indigoBuilder: nil, dtuhid: transport)
			} catch {
				// On CoreSimulator 1155.4 and newer the guest has already handed its legacy services
				// to dtuhidd, so falling back to Indigo would deliver keyboard events into the void.
				throw HidDeliveryError(
					code: .transportUnavailable,
					message:
						"CoreSimulator \(version ?? "unknown") routes HID through dtuhidd, but its digitizer "
						+ "service is unreachable: \((error as NSError).localizedDescription)",
					beforeDelivery: true)
			}
		}

		do {
			let builder = try MCIndigoMessageBuilder.make(developerDirectory: developerDirectory)
			let client = try MCIndigoHidClient.make(device: device, developerDirectory: developerDirectory)
			return HidSession(
				kind: .indigo, screen: metrics, coreSimulatorVersion: version,
				screenSize: screenSize, screenScale: screenScale,
				indigoClient: client, indigoBuilder: builder, dtuhid: nil)
		} catch {
			throw HidDeliveryError(
				code: .transportUnavailable,
				message: "The legacy Indigo HID transport is unavailable: \((error as NSError).localizedDescription)",
				beforeDelivery: true)
		}
	}

	private init(
		kind: HidTransportKind,
		screen: HidScreenMetrics,
		coreSimulatorVersion: String?,
		screenSize: CGSize,
		screenScale: Float,
		indigoClient: MCIndigoHidClient?,
		indigoBuilder: MCIndigoMessageBuilder?,
		dtuhid: MCDtuHidTransport?
	) {
		self.kind = kind
		self.screen = screen
		self.coreSimulatorVersion = coreSimulatorVersion
		self.screenSize = screenSize
		self.screenScale = screenScale
		self.indigoClient = indigoClient
		self.indigoBuilder = indigoBuilder
		self.dtuhid = dtuhid
	}

	/// Delivers one request's primitives in order, draining once when the batch completes a gesture.
	func deliver(_ request: HidRequest) throws {
		var delivered = false
		do {
			for primitive in expand(request.primitives) {
				if case let .delay(interval) = primitive {
					if interval > 0 {
						Thread.sleep(forTimeInterval: interval)
					}
					continue
				}
				try send(primitive)
				delivered = true
			}
		} catch let error as HidDeliveryError {
			throw HidDeliveryError(
				code: error.code,
				message: error.message,
				beforeDelivery: error.beforeDelivery && !delivered)
		}

		if request.drainsAfterBatch {
			dtuhid?.drain()
		}
	}

	/// Rewrites primitives the negotiated transport cannot express directly.
	private func expand(_ primitives: [HidPrimitive]) -> [HidPrimitive] {
		guard kind == .dtuhid else {
			return primitives
		}
		return primitives.flatMap { primitive -> [HidPrimitive] in
			// Apple Pay has no single DTUHID usage; it is a double press of the side button. Only the
			// down half expands, so a down/up pair does not become four presses.
			if case let .button(button, direction) = primitive,
				button == MCHidButton.applePay
			{
				return direction == MCHidDirection.down ? HidEventBuilder.applePayAsDoubleSidePress() : []
			}
			return [primitive]
		}
	}

	private func send(_ primitive: HidPrimitive) throws {
		switch primitive {
		case let .touch(direction, x, y):
			let ratio = HidCoordinates.ratio(x: x, y: y, screenSize: screenSize, screenScale: screenScale)
			if let dtuhid {
				try run { try dtuhid.sendTouch(ratio: ratio, direction: direction) }
			} else if let indigoClient, let indigoBuilder {
				let message = indigoBuilder.touchMessage(ratio: ratio, direction: direction)
				try run { try indigoClient.send(message: message, timeout: 5) }
			} else {
				throw disposedError()
			}
			contact.record(direction: direction, x: x, y: y)
		case let .key(usage, direction):
			if let dtuhid {
				try run { try dtuhid.sendKeyboard(usage: usage, direction: direction) }
			} else if let indigoClient, let indigoBuilder {
				let message = indigoBuilder.keyboardMessage(usage: usage, direction: direction)
				try run { try indigoClient.send(message: message, timeout: 5) }
			} else {
				throw disposedError()
			}
		case let .button(button, direction):
			if let dtuhid {
				try run { try dtuhid.sendButton(button: button, direction: direction) }
			} else if let indigoClient, let indigoBuilder {
				guard let message = indigoBuilder.buttonMessage(button: button, direction: direction) else {
					throw HidDeliveryError(
						code: .unsupportedOperation,
						message: "This button has no legacy Indigo source",
						beforeDelivery: true)
				}
				try run { try indigoClient.send(message: message, timeout: 5) }
			} else {
				throw disposedError()
			}
		case .delay:
			break
		}
	}

	private func run(_ body: () throws -> Void) throws {
		do {
			try body()
		} catch {
			throw HidDeliveryError(
				code: .transportFailed,
				message: (error as NSError).localizedDescription,
				beforeDelivery: false)
		}
	}

	private func disposedError() -> HidDeliveryError {
		HidDeliveryError(code: .sessionClosed, message: "The HID session is closed", beforeDelivery: true)
	}

	/// Whether the transport is still usable. A DTUHID connection that XPC interrupted or invalidated
	/// is not, and the session must not accept input into it.
	var isHealthy: Bool {
		guard let dtuhid else {
			return indigoClient != nil
		}
		return dtuhid.isConnected
	}

	var failureReason: String? {
		dtuhid?.failureReason
	}

	/// Lifts any contact still down, drains once, and disconnects. Used on clean EOF and shutdown so
	/// the guest does not keep a stuck finger.
	func close() {
		if case let .touch(direction, x, y)? = contact.release() {
			let ratio = HidCoordinates.ratio(x: x, y: y, screenSize: screenSize, screenScale: screenScale)
			if let dtuhid, dtuhid.isConnected {
				try? dtuhid.sendTouch(ratio: ratio, direction: direction)
			} else if let indigoClient, let indigoBuilder {
				let message = indigoBuilder.touchMessage(ratio: ratio, direction: direction)
				try? indigoClient.send(message: message, timeout: 2)
			}
		}
		dtuhid?.drain()
		dtuhid?.disconnect()
		indigoClient?.disconnect()
	}

	var hasActiveContact: Bool { contact.isDown }
}
