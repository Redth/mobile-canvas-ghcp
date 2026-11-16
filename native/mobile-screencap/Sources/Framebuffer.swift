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
		let developerDirectory = try DeveloperDirectory.resolve(options.string("developer-dir"))
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

		// `ready` goes out before anything is written to stdout. A host that only starts reading
		// stdout after `ready` would otherwise fill the pipe with the first keyframe and wedge here.
		Events.emit([
			"type": "ready",
			"source": "framebuffer",
			"udid": udid,
			"width": ready.width,
			"height": ready.height,
			"sourceWidth": ready.sourceWidth,
			"sourceHeight": ready.sourceHeight,
			"fps": fps,
			"idleFps": FramePacer.idleFramesPerSecond,
			"bitrate": bitrate,
		])
		capture.beginStreaming()

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
				"changed": stats.changedFrames,
				"polled": stats.polledFrames,
				"idle": stats.idleFrames,
				"throttled": stats.throttledTicks,
				"backpressure": stats.backpressureFrames,
				"dropped": stats.droppedFrames,
				"bytes": stats.bytesWritten,
				"surfaceChanges": stats.surfaceChanges,
			])
		}
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
	var receivedFrames: UInt64 = 0
	var encodedFrames = 0
	/// Encoded because the surface changed (seed or callback).
	var changedFrames: UInt64 = 0
	/// Subset of `changedFrames` found only by the seed poll, with no SimulatorKit callback.
	var polledFrames: UInt64 = 0
	/// Unchanged frames re-encoded for the idle floor.
	var idleFrames: UInt64 = 0
	/// Ticks that saw a change inside the frame interval; a later tick encodes it.
	var throttledTicks: UInt64 = 0
	/// Frames skipped because the encoder's output was not being drained.
	var backpressureFrames: UInt64 = 0
	/// Frames lost to a failed pixel transfer.
	var droppedFrames: UInt64 = 0
	var bytesWritten: UInt64 = 0
	var surfaceChanges: UInt64 = 0
}

/// Streams the simulator's IOSurface through the shared H.264 encoder.
///
/// All capture state is confined to `queue`. Nothing that can block on stdout runs there or under
/// a lock: encoded frames are written on `outputQueue`, and the capture queue skips frames while
/// too many are unwritten rather than waiting on a reader that has stopped draining. `statsLock`
/// only guards counters and the stop flag, so `start`, `stats` and `stop` can never wedge behind a
/// stalled pipe.
private final class FramebufferCapture: @unchecked Sendable {
	/// How often the descriptor is asked for its live surface, in case a replacement (rotation,
	/// display change) arrives without a surface-change callback.
	private static let surfaceRevalidationInterval = 0.25
	private static let maximumPendingFrames = 2
	private static let stopTimeout = DispatchTimeInterval.seconds(1)

	private let udid: String
	private let developerDirectory: String
	private let fps: Int
	private let bitrate: Int
	private let maxHeight: Int?
	private let sink: ByteSink
	private let onFailure: @Sendable (String, Bool) -> Void
	private let queue = DispatchQueue(
		label: "dev.mobilecanvas.framebuffer.frames",
		qos: .userInteractive)
	/// Shared by every encoder this capture creates, so a replacement encoder's parameter sets can
	/// never overtake the previous encoder's last frames.
	private let outputQueue = DispatchQueue(
		label: "dev.mobilecanvas.framebuffer.output",
		qos: .userInteractive)
	private let clockOrigin = ProcessInfo.processInfo.systemUptime

	private let statsLock = NSLock()
	private var counters = FramebufferStats()
	private var didStop = false
	private var callbackSeen = false
	private var callbackTickScheduled = false
	private var activeEncoder: H264Encoder?
	private var retiredEncodedFrames = 0

	// Confined to `queue`.
	private var framebuffer: MCSimulatorFramebuffer?
	private var currentSurface: IOSurface?
	private var currentSurfaceID: IOSurfaceID = 0
	private var sourceBuffer: CVPixelBuffer?
	private var transformer: PixelBufferTransformer?
	private var encoder: H264Encoder?
	private var pacer: FramePacer
	private var timer: DispatchSourceTimer?
	private var lastSurfaceCheckAt = -Double.infinity
	private var catchUpTickScheduled = false
	/// Set by `beginStreaming`; callbacks registered during `start` must not encode before `ready`.
	private var streaming = false

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
		pacer = FramePacer(framesPerSecond: fps)
	}

	/// Attaches to the display and prepares the encoder without writing any output.
	func start() throws -> FramebufferReady {
		guard MCSimulatorFramebuffer.isSupported else {
			throw HelperError("CoreSimulator framebuffer APIs are unavailable")
		}
		return try queue.sync {
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

			guard let surface = (framebuffer.liveSurface() ?? framebuffer.currentSurface) as? IOSurface else {
				framebuffer.stop()
				self.framebuffer = nil
				throw HelperError("the simulator main display has no IOSurface")
			}

			do {
				return try configure(surface)
			} catch {
				framebuffer.stop()
				self.framebuffer = nil
				throw error
			}
		}
	}

	/// Encodes the current picture immediately, so a static screen still produces a first frame,
	/// then starts the seed poll at the requested frame rate.
	func beginStreaming() {
		queue.async { [self] in
			guard !isStopped else { return }
			streaming = true
			lastSurfaceCheckAt = now()
			encodeCurrent(now: now(), forceKeyFrame: true, kind: .change)

			let interval = 1.0 / Double(fps)
			let timer = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
			timer.schedule(
				deadline: .now() + interval,
				repeating: interval,
				leeway: .microseconds(500))
			timer.setEventHandler { [weak self] in
				self?.tick()
			}
			self.timer = timer
			timer.resume()
		}
	}

	func stop() {
		statsLock.lock()
		if didStop {
			statsLock.unlock()
			return
		}
		didStop = true
		statsLock.unlock()

		// Teardown runs on the capture queue; bound the wait so a wedged private API call cannot
		// hang the exit.
		let finished = DispatchSemaphore(value: 0)
		queue.async { [self] in
			timer?.cancel()
			timer = nil
			framebuffer?.stop()
			framebuffer = nil
			encoder?.finish()
			encoder = nil
			transformer = nil
			sourceBuffer = nil
			currentSurface = nil
			finished.signal()
		}
		_ = finished.wait(timeout: .now() + Self.stopTimeout)
	}

	var stats: FramebufferStats {
		statsLock.lock()
		defer { statsLock.unlock() }
		var snapshot = counters
		snapshot.encodedFrames = retiredEncodedFrames + (activeEncoder?.encodedFrames ?? 0)
		snapshot.bytesWritten = sink.bytesWritten
		return snapshot
	}

	private var isStopped: Bool {
		statsLock.lock()
		defer { statsLock.unlock() }
		return didStop
	}

	private func now() -> Double {
		ProcessInfo.processInfo.systemUptime - clockOrigin
	}

	private func surfaceChanged(_ value: Any?) {
		guard let surface = value as? IOSurface else { return }
		queue.async { [weak self] in
			self?.replaceSurface(surface)
		}
	}

	private func frameRendered() {
		statsLock.lock()
		counters.receivedFrames += 1
		callbackSeen = true
		let schedule = !callbackTickScheduled
		callbackTickScheduled = true
		statsLock.unlock()

		// Callbacks can arrive in bursts; one queued tick absorbs all of them.
		if schedule {
			queue.async { [weak self] in
				self?.tick()
			}
		}
	}

	private func tick() {
		statsLock.lock()
		let stopped = didStop
		let sawCallback = callbackSeen
		callbackSeen = false
		callbackTickScheduled = false
		statsLock.unlock()
		guard !stopped, streaming, let framebuffer else { return }

		if sawCallback {
			pacer.noteCallback()
		}

		let time = now()
		if time - lastSurfaceCheckAt >= Self.surfaceRevalidationInterval {
			lastSurfaceCheckAt = time
			if let live = framebuffer.liveSurface() as? IOSurface,
				IOSurfaceGetID(unsafeBitCast(live, to: IOSurfaceRef.self)) != currentSurfaceID
			{
				replaceSurface(live)
				return
			}
		}

		guard let currentSurface else { return }
		let seed = IOSurfaceGetSeed(unsafeBitCast(currentSurface, to: IOSurfaceRef.self))
		switch pacer.decide(now: time, seed: seed) {
		case .encodeChange:
			encodeCurrent(now: time, seed: seed, kind: pacer.hasPendingCallback ? .change : .polledChange)
		case .encodeIdle:
			encodeCurrent(now: time, seed: seed, kind: .idle)
		case .throttled:
			statsLock.lock()
			counters.throttledTicks += 1
			statsLock.unlock()
			scheduleCatchUpTick(after: pacer.timeUntilNextFrame(now: time))
		case .unchanged:
			break
		}

		if sink.closed {
			fail("client disconnected", failed: false)
		}
	}

	/// A change that arrives just inside the frame interval would otherwise wait for the next timer
	/// tick, which can be almost a whole interval away and costs a frame under animation.
	private func scheduleCatchUpTick(after delay: Double) {
		guard !catchUpTickScheduled else { return }
		catchUpTickScheduled = true
		queue.asyncAfter(deadline: .now() + max(0, delay)) { [weak self] in
			guard let self else { return }
			catchUpTickScheduled = false
			tick()
		}
	}

	private func replaceSurface(_ surface: IOSurface) {
		guard !isStopped else { return }
		statsLock.lock()
		counters.surfaceChanges += 1
		statsLock.unlock()
		do {
			_ = try configure(surface)
			pacer.invalidate()
			if streaming {
				encodeCurrent(now: now(), forceKeyFrame: true, kind: .change)
			}
		} catch {
			fail("framebuffer surface update failed: \(error)", failed: true)
		}
	}

	private enum FrameKind {
		case change
		case polledChange
		case idle
	}

	private func encodeCurrent(now time: Double, seed: UInt32? = nil, forceKeyFrame: Bool = false, kind: FrameKind) {
		guard let currentSurface, let sourceBuffer, let transformer, let encoder else { return }
		if encoder.pendingFrames >= Self.maximumPendingFrames {
			// Leave the pacer untouched so the next tick retries once the reader catches up.
			statsLock.lock()
			counters.backpressureFrames += 1
			statsLock.unlock()
			return
		}

		let encodedSeed = seed ?? IOSurfaceGetSeed(unsafeBitCast(currentSurface, to: IOSurfaceRef.self))
		guard let outputBuffer = transformer.transform(sourceBuffer) else {
			statsLock.lock()
			counters.droppedFrames += 1
			statsLock.unlock()
			return
		}
		pacer.didEncode(now: time, seed: encodedSeed)
		encoder.encode(outputBuffer, forceKeyFrame: forceKeyFrame, presentationTime: time)

		statsLock.lock()
		switch kind {
		case .change:
			counters.changedFrames += 1
		case .polledChange:
			counters.changedFrames += 1
			counters.polledFrames += 1
		case .idle:
			counters.idleFrames += 1
		}
		statsLock.unlock()
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
		currentSurfaceID = IOSurfaceGetID(surfaceReference)
		sourceBuffer = pixelBuffer
		if dimensionsChanged {
			// Finishing hands the old encoder's remaining frames to `outputQueue` ahead of the new
			// parameter sets without waiting for them to be written.
			encoder?.finish()
			transformer = try PixelBufferTransformer(
				sourceWidth: sourceWidth,
				sourceHeight: sourceHeight,
				outputWidth: dimensions.width,
				outputHeight: dimensions.height)
			let replacement = try H264Encoder(
				options: EncoderOptions(
					width: Int32(dimensions.width),
					height: Int32(dimensions.height),
					framesPerSecond: fps,
					averageBitrate: bitrate),
				sink: sink,
				outputQueue: outputQueue)
			statsLock.lock()
			retiredEncodedFrames += activeEncoder?.encodedFrames ?? 0
			activeEncoder = replacement
			statsLock.unlock()
			encoder = replacement
		}

		return FramebufferReady(
			sourceWidth: sourceWidth,
			sourceHeight: sourceHeight,
			width: dimensions.width,
			height: dimensions.height)
	}

	private func fail(_ reason: String, failed: Bool) {
		// The stopper tears down on this queue, so report from elsewhere.
		let onFailure = self.onFailure
		DispatchQueue.global(qos: .userInitiated).async {
			onFailure(reason, failed)
		}
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
