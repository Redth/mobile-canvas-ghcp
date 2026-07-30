import AppKit
import CoreMedia
import Foundation
import ScreenCaptureKit

/// `mobile-screencap` captures a single iOS Simulator device screen and writes a low-latency
/// Annex-B H.264 stream to stdout.
///
/// Structured events go to stderr as newline-delimited JSON so the binary stream on stdout
/// stays byte-exact.
@main
struct MobileScreencap {
	static func main() {
		signal(SIGPIPE, SIG_IGN)

		// ScreenCaptureKit asserts CGS_REQUIRE_INIT without a window-server connection, so the
		// helper has to become a (headless) NSApplication before any capture call.
		let app = NSApplication.shared
		app.setActivationPolicy(.prohibited)

		let arguments = Array(CommandLine.arguments.dropFirst())
		guard let command = arguments.first else {
			printUsage()
			exit(2)
		}

		let options = CommandLineOptions(Array(arguments.dropFirst()))

		Task.detached {
			do {
				switch command {
				case "list":
					try await runList()
				case "capture":
					try await runCapture(options)
				case "encode":
					try EncodeCommand.run(options)
				case "doctor":
					try await runDoctor()
				case "--help", "-h", "help":
					printUsage()
					exit(0)
				default:
					Events.emit(["type": "error", "message": "unknown command '\(command)'"])
					exit(2)
				}
			} catch let error as HelperError {
				Events.emit(["type": "error", "message": error.description])
				exit(1)
			} catch {
				Events.emit(["type": "error", "message": "\(error)"])
				exit(1)
			}
		}

		app.run()
	}

	static func printUsage() {
		let usage = """
			mobile-screencap <command> [options]

			Commands:
			  list                     Print simulator windows as JSON.
			  doctor                   Report capture prerequisites as JSON.
			  capture                  Stream Annex-B H.264 on stdout.
			  encode                   Encode raw frames from stdin to Annex-B H.264 on stdout.

			Capture options:
			  --window-id <id>         ScreenCaptureKit window id (from `list`).
			  --udid <udid>            Resolve the window by simulator UDID instead.
			  --fps <n>                Target frame rate. Default 60.
			  --bitrate <bits>         Average bitrate ceiling. Default 16000000.
			  --crop auto|none|x,y,w,h Device-screen crop. Default auto.
			  --max-height <px>        Clamp the encoded height, preserving aspect ratio.

			Encode options:
			  --width <px>             Source frame width. Required, must be even.
			  --height <px>            Source frame height. Required, must be even.
			  --pixel-format <fmt>     rgba8888 (default) or bgra8888.
			  --fps <n>                Declared frame rate. Default 60.
			  --bitrate <bits>         Average bitrate ceiling. Default 16000000.

			"""
		FileHandle.standardError.write(Data(usage.utf8))
	}

	static func runList() async throws {
		let windows = try await Discovery.windows()
		let payload = ListResponse(
			accessibilityTrusted: Discovery.accessibilityTrusted(),
			windows: windows)
		let encoder = JSONEncoder()
		encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
		let data = try encoder.encode(payload)
		FileHandle.standardOutput.write(data)
		FileHandle.standardOutput.write(Data("\n".utf8))
		exit(0)
	}

	static func runDoctor() async throws {
		var screenRecording = false
		var detail = ""
		do {
			let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
			screenRecording = true
			detail = "\(content.windows.count) windows visible"
		} catch {
			detail = "\(error.localizedDescription)"
		}

		let windows = screenRecording ? ((try? await Discovery.windows()) ?? []) : []
		let payload: [String: Any] = [
			"type": "doctor",
			"screenRecordingGranted": screenRecording,
			"screenRecordingDetail": detail,
			"accessibilityGranted": Discovery.accessibilityTrusted(),
			"simulatorWindows": windows.count,
			"exactGeometry": windows.contains { $0.screenRect != nil },
		]
		let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
		FileHandle.standardOutput.write(data)
		FileHandle.standardOutput.write(Data("\n".utf8))
		exit(screenRecording ? 0 : 1)
	}

	static func runCapture(_ options: CommandLineOptions) async throws {
		let fps = max(1, min(120, options.int("fps") ?? 60))
		let bitrate = max(500_000, options.int("bitrate") ?? 16_000_000)
		let cropMode = options.string("crop") ?? "auto"

		let all = try await Discovery.windows()
		guard !all.isEmpty else {
			throw HelperError("no simulator windows found; boot a simulator and make sure Simulator.app is not minimized")
		}

		let target: SimulatorWindow
		if let windowId = options.int("window-id") {
			guard let match = all.first(where: { $0.windowId == UInt32(windowId) }) else {
				throw HelperError("window \(windowId) is not a simulator window")
			}
			target = match
		} else if let udid = options.string("udid") {
			guard let match = all.first(where: { $0.udid?.caseInsensitiveCompare(udid) == .orderedSame }) else {
				throw HelperError("no simulator window is showing device \(udid)")
			}
			target = match
		} else {
			target = all[0]
		}

		let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
		guard let window = content.windows.first(where: { $0.windowID == target.windowId }) else {
			throw HelperError("window \(target.windowId) disappeared")
		}

		let sourceRect = resolveCrop(mode: cropMode, target: target)
		let scale = target.backingScale
		var pixelWidth = Int((sourceRect.width * scale).rounded())
		var pixelHeight = Int((sourceRect.height * scale).rounded())

		if let maxHeight = options.int("max-height"), maxHeight > 0, pixelHeight > maxHeight {
			let ratio = Double(maxHeight) / Double(pixelHeight)
			pixelWidth = Int((Double(pixelWidth) * ratio).rounded())
			pixelHeight = maxHeight
		}
		// H.264 chroma subsampling requires even dimensions.
		pixelWidth = max(2, pixelWidth - (pixelWidth % 2))
		pixelHeight = max(2, pixelHeight - (pixelHeight % 2))

		let configuration = SCStreamConfiguration()
		configuration.width = pixelWidth
		configuration.height = pixelHeight
		configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
		configuration.pixelFormat = kCVPixelFormatType_32BGRA
		configuration.showsCursor = false
		configuration.queueDepth = 6
		configuration.scalesToFit = false
		if cropMode != "none" {
			configuration.sourceRect = sourceRect
			configuration.destinationRect = CGRect(x: 0, y: 0, width: pixelWidth, height: pixelHeight)
		}

		let sink = ByteSink(fd: FileHandle.standardOutput.fileDescriptor)
		let encoder = try H264Encoder(
			options: EncoderOptions(
				width: Int32(pixelWidth),
				height: Int32(pixelHeight),
				framesPerSecond: fps,
				averageBitrate: bitrate),
			sink: sink)

		let stopper = Stopper()
		let output = CaptureOutput(encoder: encoder, sink: sink) { reason in
			stopper.stop(reason: reason)
		}

		let filter = SCContentFilter(desktopIndependentWindow: window)
		let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
		try stream.addStreamOutput(
			output,
			type: .screen,
			sampleHandlerQueue: DispatchQueue(label: "dev.mobilecanvas.screencap.frames", qos: .userInteractive))

		stopper.configure(stream: stream, encoder: encoder)
		installSignalHandlers(stopper)

		try await stream.startCapture()

		Events.emit([
			"type": "ready",
			"windowId": Int(target.windowId),
			"udid": target.udid ?? NSNull(),
			"deviceName": target.deviceName,
			"runtime": target.runtime ?? NSNull(),
			"width": pixelWidth,
			"height": pixelHeight,
			"fps": fps,
			"bitrate": bitrate,
			"backingScale": scale,
			"cropSource": cropMode == "none" ? "none" : target.screenSource,
			"sourceRect": [
				"x": Double(sourceRect.origin.x),
				"y": Double(sourceRect.origin.y),
				"width": Double(sourceRect.size.width),
				"height": Double(sourceRect.size.height),
			],
		])

		// Heartbeat so the host can distinguish "slow" from "dead" without decoding the stream.
		while !stopper.stopped {
			try? await Task.sleep(nanoseconds: 2_000_000_000)
			guard !stopper.stopped else { break }
			Events.emit([
				"type": "stats",
				"frames": encoder.encodedFrames,
				"keyFrames": encoder.keyFrames,
			])
		}
	}

	/// Resolves the device-screen rectangle in window points.
	static func resolveCrop(mode: String, target: SimulatorWindow) -> CGRect {
		let full = CGRect(x: 0, y: 0, width: target.windowFrame.width, height: target.windowFrame.height)
		switch mode {
		case "none":
			return full
		case "auto":
			return target.screenRect?.cgRect ?? full
		default:
			let parts = mode.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
			guard parts.count == 4, parts[2] > 0, parts[3] > 0 else { return full }
			return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
		}
	}

	static func installSignalHandlers(_ stopper: Stopper) {
		for signalNumber in [SIGINT, SIGTERM, SIGHUP] {
			signal(signalNumber, SIG_IGN)
			let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
			source.setEventHandler { stopper.stop(reason: "signal \(signalNumber)") }
			source.resume()
			stopper.retain(source)
		}
	}
}

struct ListResponse: Codable {
	var accessibilityTrusted: Bool
	var windows: [SimulatorWindow]
}

/// Coordinates a single clean shutdown from signals, stream errors, and a closed stdout.
final class Stopper: @unchecked Sendable {
	private let lock = NSLock()
	private var didStop = false
	private var stream: SCStream?
	private var encoder: H264Encoder?
	private var sources: [DispatchSourceSignal] = []

	var stopped: Bool {
		lock.lock()
		defer { lock.unlock() }
		return didStop
	}

	func configure(stream: SCStream, encoder: H264Encoder) {
		lock.lock()
		self.stream = stream
		self.encoder = encoder
		lock.unlock()
	}

	func retain(_ source: DispatchSourceSignal) {
		lock.lock()
		sources.append(source)
		lock.unlock()
	}

	func stop(reason: String) {
		lock.lock()
		if didStop {
			lock.unlock()
			return
		}
		didStop = true
		let stream = self.stream
		let encoder = self.encoder
		lock.unlock()

		Events.emit(["type": "stopping", "reason": reason])
		stream?.stopCapture { _ in
			encoder?.finish()
			Events.emit(["type": "stopped", "reason": reason])
			exit(0)
		}
		// Never let a wedged stop hang the process; the host is waiting on our exit.
		DispatchQueue.global().asyncAfter(deadline: .now() + 2) { exit(0) }
	}
}

enum Events {
	private static let lock = NSLock()

	static func emit(_ payload: [String: Any]) {
		guard
			let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
			var line = String(data: data, encoding: .utf8)
		else { return }
		line += "\n"
		lock.lock()
		FileHandle.standardError.write(Data(line.utf8))
		lock.unlock()
	}
}

struct CommandLineOptions {
	private var values: [String: String] = [:]

	init(_ arguments: [String]) {
		var index = 0
		while index < arguments.count {
			let argument = arguments[index]
			guard argument.hasPrefix("--") else {
				index += 1
				continue
			}
			let key = String(argument.dropFirst(2))
			if let equals = key.firstIndex(of: "=") {
				values[String(key[key.startIndex..<equals])] = String(key[key.index(after: equals)...])
				index += 1
			} else if index + 1 < arguments.count, !arguments[index + 1].hasPrefix("--") {
				values[key] = arguments[index + 1]
				index += 2
			} else {
				values[key] = "true"
				index += 1
			}
		}
	}

	func string(_ key: String) -> String? { values[key] }
	func int(_ key: String) -> Int? { values[key].flatMap(Int.init) }
}
