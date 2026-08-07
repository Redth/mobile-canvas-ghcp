import CoreVideo
import Foundation
import IOSurface
import VideoToolbox

enum FramebufferCommand {
	static func run(_ options: CommandLineOptions) async throws {
		guard let udid = options.string("udid"), !udid.isEmpty else {
			throw HelperError("framebuffer requires --udid")
		}

		let fps = max(1, min(120, options.int("fps") ?? 60))
		let bitrate = max(500_000, options.int("bitrate") ?? 16_000_000)
		let maxHeight = options.int("max-height").flatMap { $0 > 0 ? $0 : nil }
		let developerDirectory = try selectedDeveloperDirectory(options.string("developer-dir"))
		let sink = ByteSink(fd: FileHandle.standardOutput.fileDescriptor)
		let stopper = FramebufferStopper()
		let capture = FramebufferCapture(
			udid: udid,
			developerDirectory: developerDirectory,
			fps: fps,
			bitrate: bitrate,
			maxHeight: maxHeight,
			sink: sink
		) { reason, failed in
			stopper.stop(reason: reason, failed: failed)
		}

		stopper.capture = capture
		let ready = try capture.start()
		let signals = installSignalHandlers(stopper)
		_ = signals

		Events.emit([
			"type": "ready",
			"source": "framebuffer",
			"udid": udid,
			"width": ready.width,
			"height": ready.height,
			"sourceWidth": ready.sourceWidth,
			"sourceHeight": ready.sourceHeight,
			"fps": fps,
			"bitrate": bitrate,
		])

		while !stopper.stopped {
			try? await Task.sleep(nanoseconds: 2_000_000_000)
			guard !stopper.stopped else { break }
			if sink.closed {
				stopper.stop(reason: "client disconnected", failed: false)
				continue
			}
			let stats = capture.stats
			Events.emit([
				"type": "stats",
				"source": "framebuffer",
				"received": stats.receivedFrames,
				"encoded": stats.encodedFrames,
				"dropped": stats.droppedFrames,
				"bytes": stats.bytesWritten,
				"surfaceChanges": stats.surfaceChanges,
			])
		}
	}

	private static func selectedDeveloperDirectory(_ override: String?) throws -> String {
		if let override, !override.isEmpty {
			return override
		}
		if let environment = ProcessInfo.processInfo.environment["DEVELOPER_DIR"], !environment.isEmpty {
			return environment
		}

		let process = Process()
		let output = Pipe()
		process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
		process.arguments = ["-p"]
		process.standardOutput = output
		process.standardError = Pipe()
		try process.run()
		process.waitUntilExit()
		guard process.terminationStatus == 0 else {
			throw HelperError("xcode-select could not locate the active developer directory")
		}
		let data = output.fileHandleForReading.readDataToEndOfFile()
		guard
			let path = String(data: data, encoding: .utf8)?
				.trimmingCharacters(in: .whitespacesAndNewlines),
			!path.isEmpty
		else {
			throw HelperError("xcode-select returned an empty developer directory")
		}
		return path
	}

	private static func installSignalHandlers(_ stopper: FramebufferStopper) -> [DispatchSourceSignal] {
		[SIGINT, SIGTERM].map { signalNumber in
			signal(signalNumber, SIG_IGN)
			let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
			source.setEventHandler {
				stopper.stop(reason: "signal \(signalNumber)", failed: false)
			}
			source.resume()
			return source
		}
	}
}

private struct FramebufferReady {
	let sourceWidth: Int
	let sourceHeight: Int
	let width: Int
	let height: Int
}

private struct FramebufferStats {
	let receivedFrames: UInt64
	let encodedFrames: Int
	let droppedFrames: UInt64
	let bytesWritten: UInt64
	let surfaceChanges: UInt64
}

private final class FramebufferCapture: @unchecked Sendable {
	private let udid: String
	private let developerDirectory: String
	private let fps: Int
	private let bitrate: Int
	private let maxHeight: Int?
	private let sink: ByteSink
	private let onFailure: @Sendable (String, Bool) -> Void
	private let lock = NSLock()
	private let frameQueue = DispatchQueue(
		label: "dev.mobilecanvas.framebuffer.frames",
		qos: .userInteractive)

	private var framebuffer: MCSimulatorFramebuffer?
	private var currentSurface: IOSurface?
	private var sourceBuffer: CVPixelBuffer?
	private var transformer: PixelBufferTransformer?
	private var encoder: H264Encoder?
	private var lastEncodedAt = -Double.infinity
	private var didStop = false
	private var receivedFrames: UInt64 = 0
	private var droppedFrames: UInt64 = 0
	private var surfaceChanges: UInt64 = 0

	init(
		udid: String,
		developerDirectory: String,
		fps: Int,
		bitrate: Int,
		maxHeight: Int?,
		sink: ByteSink,
		onFailure: @escaping @Sendable (String, Bool) -> Void)
	{
		self.udid = udid
		self.developerDirectory = developerDirectory
		self.fps = fps
		self.bitrate = bitrate
		self.maxHeight = maxHeight
		self.sink = sink
		self.onFailure = onFailure
	}

	func start() throws -> FramebufferReady {
		guard MCSimulatorFramebuffer.isSupported else {
			throw HelperError("CoreSimulator framebuffer APIs are unavailable")
		}

		let framebuffer = try MCSimulatorFramebuffer(
			udid: udid,
			developerDirectory: developerDirectory)
		self.framebuffer = framebuffer

		_ = try framebuffer.start(
			surfaceChangedHandler: { [weak self] surface in
				self?.surfaceChanged(surface)
			},
			frameRenderedHandler: { [weak self] in
				self?.frameRendered()
			})

		guard let surface = framebuffer.currentSurface as? IOSurface else {
			framebuffer.stop()
			throw HelperError("the simulator main display has no IOSurface")
		}

		lock.lock()
		do {
			let ready = try configure(surface)
			encodeCurrentFrame(force: true)
			lock.unlock()
			return ready
		} catch {
			lock.unlock()
			framebuffer.stop()
			throw error
		}
	}

	func stop() {
		lock.lock()
		if didStop {
			lock.unlock()
			return
		}
		didStop = true
		let encoder = self.encoder
		self.encoder = nil
		transformer = nil
		sourceBuffer = nil
		currentSurface = nil
		let framebuffer = self.framebuffer
		self.framebuffer = nil
		lock.unlock()

		framebuffer?.stop()
		encoder?.finish()
	}

	var stats: FramebufferStats {
		lock.lock()
		defer { lock.unlock() }
		return FramebufferStats(
			receivedFrames: receivedFrames,
			encodedFrames: encoder?.encodedFrames ?? 0,
			droppedFrames: droppedFrames,
			bytesWritten: sink.bytesWritten,
			surfaceChanges: surfaceChanges)
	}

	private func surfaceChanged(_ value: Any?) {
		guard let surface = value as? IOSurface else { return }
		frameQueue.async { [weak self] in
			self?.processSurfaceChanged(surface)
		}
	}

	private func processSurfaceChanged(_ surface: IOSurface) {
		lock.lock()
		guard !didStop else {
			lock.unlock()
			return
		}
		surfaceChanges += 1
		do {
			_ = try configure(surface)
			encodeCurrentFrame(force: true)
			lock.unlock()
		} catch {
			lock.unlock()
			onFailure("framebuffer surface update failed: \(error.localizedDescription)", true)
		}
	}

	private func frameRendered() {
		frameQueue.async { [weak self] in
			self?.processFrameRendered()
		}
	}

	private func processFrameRendered() {
		lock.lock()
		guard !didStop else {
			lock.unlock()
			return
		}
		receivedFrames += 1
		encodeCurrentFrame(force: false)
		let disconnected = sink.closed
		lock.unlock()

		if disconnected {
			onFailure("client disconnected", false)
		}
	}

	private func configure(_ surface: IOSurface) throws -> FramebufferReady {
		let surfaceReference = unsafeBitCast(surface, to: IOSurfaceRef.self)
		let sourceWidth = IOSurfaceGetWidth(surfaceReference)
		let sourceHeight = IOSurfaceGetHeight(surfaceReference)
		guard sourceWidth > 0, sourceHeight > 0 else {
			throw HelperError("the simulator IOSurface has invalid dimensions")
		}

		var unmanagedPixelBuffer: Unmanaged<CVPixelBuffer>?
		let status = CVPixelBufferCreateWithIOSurface(
			kCFAllocatorDefault,
			surfaceReference,
			nil,
			&unmanagedPixelBuffer)
		guard status == kCVReturnSuccess, let pixelBuffer = unmanagedPixelBuffer?.takeRetainedValue() else {
			throw HelperError("CVPixelBufferCreateWithIOSurface failed (status \(status))")
		}

		let dimensions = outputDimensions(sourceWidth: sourceWidth, sourceHeight: sourceHeight)
		let dimensionsChanged =
			transformer?.sourceWidth != sourceWidth ||
			transformer?.sourceHeight != sourceHeight ||
			transformer?.outputWidth != dimensions.width ||
			transformer?.outputHeight != dimensions.height

		currentSurface = surface
		sourceBuffer = pixelBuffer
		if dimensionsChanged {
			encoder?.finish()
			transformer = try PixelBufferTransformer(
				sourceWidth: sourceWidth,
				sourceHeight: sourceHeight,
				outputWidth: dimensions.width,
				outputHeight: dimensions.height)
			encoder = try H264Encoder(
				options: EncoderOptions(
					width: Int32(dimensions.width),
					height: Int32(dimensions.height),
					framesPerSecond: fps,
					averageBitrate: bitrate),
				sink: sink)
		}

		return FramebufferReady(
			sourceWidth: sourceWidth,
			sourceHeight: sourceHeight,
			width: dimensions.width,
			height: dimensions.height)
	}

	private func encodeCurrentFrame(force: Bool) {
		guard let sourceBuffer, let transformer, let encoder else {
			droppedFrames += 1
			return
		}

		let now = ProcessInfo.processInfo.systemUptime
		let minimumFrameInterval = 1.0 / Double(fps)
		if !force, now - lastEncodedAt < minimumFrameInterval * 0.9 {
			droppedFrames += 1
			return
		}
		lastEncodedAt = now

		guard let outputBuffer = transformer.transform(sourceBuffer) else {
			droppedFrames += 1
			return
		}
		encoder.encode(outputBuffer)
	}

	private func outputDimensions(sourceWidth: Int, sourceHeight: Int) -> (width: Int, height: Int) {
		guard let maxHeight, sourceHeight > maxHeight else {
			return (evenDimension(Double(sourceWidth)), evenDimension(Double(sourceHeight)))
		}
		let ratio = Double(maxHeight) / Double(sourceHeight)
		return (
			evenDimension(Double(sourceWidth) * ratio),
			evenDimension(Double(sourceHeight) * ratio))
	}

	private func evenDimension(_ value: Double) -> Int {
		max(2, Int(value.rounded()) & ~1)
	}

	deinit {
		stop()
	}
}

private final class PixelBufferTransformer {
	let sourceWidth: Int
	let sourceHeight: Int
	let outputWidth: Int
	let outputHeight: Int

	private let pool: CVPixelBufferPool
	private let transferSession: VTPixelTransferSession
	private let allocationAttributes: CFDictionary

	init(
		sourceWidth: Int,
		sourceHeight: Int,
		outputWidth: Int,
		outputHeight: Int) throws
	{
		self.sourceWidth = sourceWidth
		self.sourceHeight = sourceHeight
		self.outputWidth = outputWidth
		self.outputHeight = outputHeight

		var pool: CVPixelBufferPool?
		let poolAttributes: [CFString: Any] = [
			kCVPixelBufferPoolMinimumBufferCountKey: 6,
		]
		let bufferAttributes: [CFString: Any] = [
			kCVPixelBufferWidthKey: outputWidth,
			kCVPixelBufferHeightKey: outputHeight,
			kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
			kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
			kCVPixelBufferMetalCompatibilityKey: true,
		]
		let poolStatus = CVPixelBufferPoolCreate(
			kCFAllocatorDefault,
			poolAttributes as CFDictionary,
			bufferAttributes as CFDictionary,
			&pool)
		guard poolStatus == kCVReturnSuccess, let pool else {
			throw HelperError("CVPixelBufferPoolCreate failed (status \(poolStatus))")
		}

		var transferSession: VTPixelTransferSession?
		let transferStatus = VTPixelTransferSessionCreate(
			allocator: kCFAllocatorDefault,
			pixelTransferSessionOut: &transferSession)
		guard transferStatus == noErr, let transferSession else {
			throw HelperError("VTPixelTransferSessionCreate failed (status \(transferStatus))")
		}
		VTSessionSetProperty(
			transferSession,
			key: kVTPixelTransferPropertyKey_ScalingMode,
			value: kVTScalingMode_Normal)

		self.pool = pool
		self.transferSession = transferSession
		allocationAttributes = [
			kCVPixelBufferPoolAllocationThresholdKey: 8,
		] as CFDictionary
	}

	func transform(_ source: CVPixelBuffer) -> CVPixelBuffer? {
		var destination: CVPixelBuffer?
		guard
			CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(
				kCFAllocatorDefault,
				pool,
				allocationAttributes,
				&destination) == kCVReturnSuccess,
			let destination
		else {
			return nil
		}
		guard
			VTPixelTransferSessionTransferImage(
				transferSession,
				from: source,
				to: destination) == noErr
		else {
			return nil
		}
		return destination
	}
}

private final class FramebufferStopper: @unchecked Sendable {
	private let lock = NSLock()
	private var didStop = false
	weak var capture: FramebufferCapture?

	var stopped: Bool {
		lock.lock()
		defer { lock.unlock() }
		return didStop
	}

	func stop(reason: String, failed: Bool) {
		lock.lock()
		if didStop {
			lock.unlock()
			return
		}
		didStop = true
		let capture = self.capture
		lock.unlock()

		capture?.stop()
		Events.emit([
			"type": failed ? "error" : "stopped",
			"reason": reason,
		])
		exit(failed ? 1 : 0)
	}
}
