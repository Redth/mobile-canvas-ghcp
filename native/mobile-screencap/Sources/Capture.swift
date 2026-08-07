import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import VideoToolbox

/// Writes bytes to a file descriptor, tolerating partial writes and treating a closed
/// pipe as a normal shutdown rather than a crash.
final class ByteSink: @unchecked Sendable {
	private let fd: Int32
	private let lock = NSLock()
	private var isClosed = false
	private var totalBytes: UInt64 = 0

	init(fd: Int32) {
		self.fd = fd
	}

	func write(_ bytes: UnsafePointer<UInt8>, _ count: Int) {
		lock.lock()
		defer { lock.unlock() }
		guard !isClosed else { return }

		var offset = 0
		while offset < count {
			let written = Foundation.write(fd, bytes + offset, count - offset)
			if written > 0 {
				offset += written
				totalBytes += UInt64(written)
				continue
			}
			if written < 0 && errno == EINTR { continue }
			isClosed = true
			return
		}
	}

	func write(_ data: [UInt8]) {
		data.withUnsafeBufferPointer { buffer in
			guard let base = buffer.baseAddress else { return }
			write(base, buffer.count)
		}
	}

	var closed: Bool {
		lock.lock()
		defer { lock.unlock() }
		return isClosed
	}

	var bytesWritten: UInt64 {
		lock.lock()
		defer { lock.unlock() }
		return totalBytes
	}
}

struct EncoderOptions {
	var width: Int32
	var height: Int32
	var framesPerSecond: Int
	var averageBitrate: Int
}

/// H.264 encoder tuned for a low-latency screen feed.
///
/// The settings here are load-bearing. `idb`'s encoder emitted a single IDR for an entire
/// session with frame reordering enabled, so any corruption became permanent and playback
/// carried reorder latency. Driving VideoToolbox directly lets us force one keyframe per
/// second and disable reordering, which is what makes the stream both recoverable and
/// immediately displayable.
final class H264Encoder: @unchecked Sendable {
	private var session: VTCompressionSession?
	private let sink: ByteSink
	private let options: EncoderOptions
	private var frameIndex: Int64 = 0
	private let startCode: [UInt8] = [0x00, 0x00, 0x00, 0x01]

	private(set) var encodedFrames = 0
	private(set) var keyFrames = 0

	init(options: EncoderOptions, sink: ByteSink) throws {
		self.options = options
		self.sink = sink

		var created: VTCompressionSession?
		let status = VTCompressionSessionCreate(
			allocator: kCFAllocatorDefault,
			width: options.width,
			height: options.height,
			codecType: kCMVideoCodecType_H264,
			encoderSpecification: nil,
			imageBufferAttributes: nil,
			compressedDataAllocator: nil,
			outputCallback: nil,
			refcon: nil,
			compressionSessionOut: &created)
		guard status == noErr, let session = created else {
			throw HelperError("failed to create H.264 encoder (status \(status))")
		}
		self.session = session

		set(kVTCompressionPropertyKey_RealTime, true as CFBoolean)
		set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel)
		set(kVTCompressionPropertyKey_AllowFrameReordering, false as CFBoolean)
		set(kVTCompressionPropertyKey_MaxKeyFrameInterval, options.framesPerSecond as CFNumber)
		set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 1.0 as CFNumber)
		set(kVTCompressionPropertyKey_ExpectedFrameRate, options.framesPerSecond as CFNumber)
		set(kVTCompressionPropertyKey_AverageBitRate, options.averageBitrate as CFNumber)
		VTCompressionSessionPrepareToEncodeFrames(session)
	}

	private func set(_ key: CFString, _ value: CFTypeRef) {
		guard let session else { return }
		VTSessionSetProperty(session, key: key, value: value)
	}

	func encode(_ pixelBuffer: CVPixelBuffer) {
		guard let session else { return }
		let timescale = CMTimeScale(options.framesPerSecond * 1000)
		let pts = CMTime(value: frameIndex * 1000, timescale: timescale)
		let duration = CMTime(value: 1000, timescale: timescale)
		frameIndex += 1

		VTCompressionSessionEncodeFrame(
			session,
			imageBuffer: pixelBuffer,
			presentationTimeStamp: pts,
			duration: duration,
			frameProperties: nil,
			infoFlagsOut: nil
		) { [weak self] status, _, sampleBuffer in
			guard status == noErr, let sampleBuffer else { return }
			self?.emit(sampleBuffer)
		}
	}

	func finish() {
		guard let session else { return }
		VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
		VTCompressionSessionInvalidate(session)
		self.session = nil
	}

	private func emit(_ sampleBuffer: CMSampleBuffer) {
		let isKeyFrame = Self.isKeyFrame(sampleBuffer)
		var payload: [UInt8] = []

		// Every keyframe re-emits SPS/PPS so a client that joins mid-stream, or one that lost
		// bytes, can resynchronise on the next second instead of never recovering.
		if isKeyFrame, let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
			payload.append(contentsOf: parameterSets(format))
			keyFrames += 1
		}

		guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
		var totalLength = 0
		var dataPointer: UnsafeMutablePointer<Int8>?
		guard
			CMBlockBufferGetDataPointer(
				blockBuffer,
				atOffset: 0,
				lengthAtOffsetOut: nil,
				totalLengthOut: &totalLength,
				dataPointerOut: &dataPointer) == noErr,
			let base = dataPointer
		else { return }

		// VideoToolbox emits AVCC (length-prefixed NAL units); the wire format is Annex-B.
		let headerLength = Self.nalHeaderLength(sampleBuffer)
		var offset = 0
		base.withMemoryRebound(to: UInt8.self, capacity: totalLength) { bytes in
			while offset + headerLength <= totalLength {
				var nalLength = 0
				for index in 0..<headerLength {
					nalLength = (nalLength << 8) | Int(bytes[offset + index])
				}
				offset += headerLength
				guard nalLength > 0, offset + nalLength <= totalLength else { break }
				payload.append(contentsOf: startCode)
				payload.append(contentsOf: UnsafeBufferPointer(start: bytes + offset, count: nalLength))
				offset += nalLength
			}
		}

		guard !payload.isEmpty else { return }
		sink.write(payload)
		encodedFrames += 1
	}

	private func parameterSets(_ format: CMFormatDescription) -> [UInt8] {
		var output: [UInt8] = []
		var count = 0
		guard
			CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
				format,
				parameterSetIndex: 0,
				parameterSetPointerOut: nil,
				parameterSetSizeOut: nil,
				parameterSetCountOut: &count,
				nalUnitHeaderLengthOut: nil) == noErr
		else { return output }

		for index in 0..<count {
			var pointer: UnsafePointer<UInt8>?
			var size = 0
			guard
				CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
					format,
					parameterSetIndex: index,
					parameterSetPointerOut: &pointer,
					parameterSetSizeOut: &size,
					parameterSetCountOut: nil,
					nalUnitHeaderLengthOut: nil) == noErr,
				let pointer
			else { continue }
			output.append(contentsOf: startCode)
			output.append(contentsOf: UnsafeBufferPointer(start: pointer, count: size))
		}
		return output
	}

	private static func nalHeaderLength(_ sampleBuffer: CMSampleBuffer) -> Int {
		guard let format = CMSampleBufferGetFormatDescription(sampleBuffer) else { return 4 }
		var length: Int32 = 4
		CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
			format,
			parameterSetIndex: 0,
			parameterSetPointerOut: nil,
			parameterSetSizeOut: nil,
			parameterSetCountOut: nil,
			nalUnitHeaderLengthOut: &length)
		return Int(length)
	}

	private static func isKeyFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
		guard
			let attachments = CMSampleBufferGetSampleAttachmentsArray(
				sampleBuffer, createIfNecessary: false) as? [[CFString: Any]],
			let first = attachments.first
		else { return true }
		if let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool {
			return !notSync
		}
		return true
	}
}

/// Receives ScreenCaptureKit frames and forwards complete ones to the encoder.
final class CaptureOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
	private let encoder: H264Encoder
	private let sink: ByteSink
	private var droppedFrames = 0
	private let onStop: @Sendable (String) -> Void

	init(encoder: H264Encoder, sink: ByteSink, onStop: @escaping @Sendable (String) -> Void) {
		self.encoder = encoder
		self.sink = sink
		self.onStop = onStop
	}

	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
		guard type == .screen else { return }
		if sink.closed {
			onStop("client disconnected")
			return
		}
		// Only `.complete` buffers carry new pixels; idle and blank statuses reuse the previous
		// surface and would otherwise be re-encoded as duplicate frames.
		guard
			let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
				as? [[SCStreamFrameInfo: Any]],
			let raw = attachments.first?[.status] as? Int,
			let status = SCFrameStatus(rawValue: raw)
		else { return }

		guard status == .complete else {
			if status == .stopped {
				onStop("capture stopped by system")
			}
			return
		}
		guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
		encoder.encode(pixelBuffer)
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		onStop("capture stream stopped: \(error.localizedDescription)")
	}

	var stats: (frames: Int, keyFrames: Int, dropped: Int) {
		(encoder.encodedFrames, encoder.keyFrames, droppedFrames)
	}
}

struct HelperError: Error, CustomStringConvertible {
	let description: String
	init(_ description: String) {
		self.description = description
	}
}
