import Accelerate
import CoreVideo
import Foundation
import VideoToolbox

/// Encodes raw frames arriving on stdin into the same Annex-B H.264 stream `capture` produces.
///
/// This exists for Android. The emulator's own gRPC service is the fastest frame source available
/// -- ~50 FPS with zero drops at every resolution, and 0.03 ms input latency -- but it only offers
/// PNG, RGB888, and RGBA8888, with no H.264 RPC. Rather than give Android a second, worse video
/// path, raw frames are pulled over loopback and pushed through the encoder that already works,
/// so the canvas decode path, WebSocket framing, and Annex-B parser stay identical on both
/// platforms and only ~1-2 Mbps crosses to the browser.
enum EncodeCommand {
	/// Lower than the browser's 120 ms idle drain so the first frame after a drain is always a keyframe.
	private static let idleKeyFrameInterval: UInt64 = 80_000_000

	/// Pixel layouts the emulator can produce, described by how they map onto the encoder's BGRA input.
	enum PixelFormat: String {
		case rgba8888
		case bgra8888

		var bytesPerPixel: Int { 4 }

		/// Destination-to-source channel map for `vImagePermuteChannels_ARGB8888`, or nil when the
		/// incoming bytes are already in the encoder's layout.
		var permuteMap: [UInt8]? {
			switch self {
			case .rgba8888: return [2, 1, 0, 3]
			case .bgra8888: return nil
			}
		}
	}

	static func run(_ options: CommandLineOptions) throws {
		guard let width = options.int("width"), let height = options.int("height"), width > 0, height > 0 else {
			throw HelperError("encode requires --width and --height")
		}

		// H.264 chroma subsampling requires even dimensions, but a frame source that preserves aspect
		// ratio can hand back an odd size (the Android emulator routinely does). Cropping at most one
		// row and column is free -- vImage takes the source stride independently of the width it
		// reads -- and is far better than rejecting the stream or rescaling it.
		let encodedWidth = width - (width % 2)
		let encodedHeight = height - (height % 2)
		guard encodedWidth >= 2, encodedHeight >= 2 else {
			throw HelperError("encode needs at least a 2x2 frame, got \(width)x\(height)")
		}

		let formatName = options.string("pixel-format") ?? "rgba8888"
		guard let pixelFormat = PixelFormat(rawValue: formatName.lowercased()) else {
			throw HelperError("unsupported --pixel-format '\(formatName)'")
		}

		let fps = max(1, min(120, options.int("fps") ?? 60))
		let bitrate = max(500_000, options.int("bitrate") ?? 16_000_000)

		let sink = ByteSink(fd: FileHandle.standardOutput.fileDescriptor)
		let encoder = try H264Encoder(
			options: EncoderOptions(
				width: Int32(encodedWidth),
				height: Int32(encodedHeight),
				framesPerSecond: fps,
				averageBitrate: bitrate),
			sink: sink)

		let pool = try makePixelBufferPool(width: encodedWidth, height: encodedHeight)

		Events.emit([
			"type": "ready",
			"source": "stdin",
			"width": encodedWidth,
			"height": encodedHeight,
			"sourceWidth": width,
			"sourceHeight": height,
			"fps": fps,
			"bitrate": bitrate,
			"pixelFormat": pixelFormat.rawValue,
		])

		let frameBytes = width * height * pixelFormat.bytesPerPixel
		var staging = [UInt8](repeating: 0, count: frameBytes)
		var frames = 0
		var lastFrameReceivedAt: UInt64?

		while true {
			guard readFully(into: &staging, count: frameBytes) else { break }
			let receivedAt = DispatchTime.now().uptimeNanoseconds

			guard let pixelBuffer = nextPixelBuffer(from: pool) else {
				// The pool is exhausted because the encoder is still holding every buffer. Dropping
				// this frame is the right call: blocking would stall the reader and back up the
				// emulator's stream, which turns a transient stall into growing latency.
				continue
			}

			fill(
				pixelBuffer,
				from: staging,
				sourceWidth: width,
				width: encodedWidth,
				height: encodedHeight,
				format: pixelFormat)
			let forceKeyFrame = lastFrameReceivedAt.map {
				receivedAt - $0 >= idleKeyFrameInterval
			} ?? true
			lastFrameReceivedAt = receivedAt
			encoder.encode(pixelBuffer, forceKeyFrame: forceKeyFrame)

			frames += 1
			if frames % (fps * 2) == 0 {
				Events.emit([
					"type": "stats",
					"frames": encoder.encodedFrames,
					"keyFrames": encoder.keyFrames,
				])
			}
		}

		Events.emit(["type": "stopping", "reason": "stdin closed"])
		encoder.finish()
		Events.emit(["type": "stopped", "reason": "stdin closed"])
		exit(0)
	}

	/// Reads exactly `count` bytes, returning false at end of input.
	///
	/// A pipe read returns as soon as *any* bytes are available, so a large frame routinely arrives
	/// in several chunks. Treating a short read as a whole frame would shift every subsequent frame
	/// by a few bytes and produce exactly the kind of rolling corruption this pipeline exists to
	/// avoid.
	private static func readFully(into buffer: inout [UInt8], count: Int) -> Bool {
		var offset = 0
		return buffer.withUnsafeMutableBufferPointer { pointer -> Bool in
			guard let base = pointer.baseAddress else { return false }
			while offset < count {
				let read = Foundation.read(FileHandle.standardInput.fileDescriptor, base + offset, count - offset)
				if read > 0 {
					offset += read
					continue
				}
				if read < 0 && errno == EINTR { continue }
				return false
			}
			return true
		}
	}

	/// A pool rather than one reused buffer: `VTCompressionSessionEncodeFrame` is asynchronous and
	/// retains the buffer it is given, so writing the next frame into the same memory would tear the
	/// frame currently being encoded.
	private static func makePixelBufferPool(width: Int, height: Int) throws -> CVPixelBufferPool {
		let bufferAttributes: [String: Any] = [
			kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
			kCVPixelBufferWidthKey as String: width,
			kCVPixelBufferHeightKey as String: height,
			kCVPixelBufferIOSurfacePropertiesKey as String: [:] as CFDictionary,
		]
		let poolAttributes: [String: Any] = [
			kCVPixelBufferPoolMinimumBufferCountKey as String: 6,
		]

		var pool: CVPixelBufferPool?
		let status = CVPixelBufferPoolCreate(
			kCFAllocatorDefault,
			poolAttributes as CFDictionary,
			bufferAttributes as CFDictionary,
			&pool)

		guard status == kCVReturnSuccess, let pool else {
			throw HelperError("failed to create a pixel buffer pool (status \(status))")
		}
		return pool
	}

	private static func nextPixelBuffer(from pool: CVPixelBufferPool) -> CVPixelBuffer? {
		var buffer: CVPixelBuffer?
		let status = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &buffer)
		return status == kCVReturnSuccess ? buffer : nil
	}

	/// Copies a frame into the pixel buffer, permuting channels when needed.
	///
	/// The destination is copied row by row because `CVPixelBuffer` rows are padded for alignment,
	/// so its stride is usually wider than `width * 4`.
	private static func fill(
		_ pixelBuffer: CVPixelBuffer,
		from source: [UInt8],
		sourceWidth: Int,
		width: Int,
		height: Int,
		format: PixelFormat
	) {
		CVPixelBufferLockBaseAddress(pixelBuffer, [])
		defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

		guard let destinationBase = CVPixelBufferGetBaseAddress(pixelBuffer) else { return }
		let destinationStride = CVPixelBufferGetBytesPerRow(pixelBuffer)
		let sourceStride = sourceWidth * format.bytesPerPixel
		let copyBytes = width * format.bytesPerPixel

		source.withUnsafeBufferPointer { input in
			guard let sourceBase = input.baseAddress else { return }

			guard var permuteMap = format.permuteMap else {
				for row in 0..<height {
					memcpy(
						destinationBase.advanced(by: row * destinationStride),
						sourceBase + (row * sourceStride),
						copyBytes)
				}
				return
			}

			// vImage handles the whole frame in one SIMD pass, so the conversion costs well under a
			// millisecond even at native resolution.
			var sourceImage = vImage_Buffer(
				data: UnsafeMutableRawPointer(mutating: sourceBase),
				height: vImagePixelCount(height),
				width: vImagePixelCount(width),
				rowBytes: sourceStride)
			var destinationImage = vImage_Buffer(
				data: destinationBase,
				height: vImagePixelCount(height),
				width: vImagePixelCount(width),
				rowBytes: destinationStride)

			vImagePermuteChannels_ARGB8888(&sourceImage, &destinationImage, &permuteMap, vImage_Flags(kvImageNoFlags))
		}
	}
}
