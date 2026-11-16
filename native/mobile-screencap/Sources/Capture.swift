import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import VideoToolbox

/// Writes bytes to a file descriptor, tolerating partial writes and treating a closed
/// pipe as a normal shutdown rather than a crash.
///
/// A write blocks while the reader is not draining the pipe. Writes are serialized on their own
/// lock, and the closed/byte-count state lives behind a separate lock, so status and stats reads
/// never wait behind a blocked write.
final class ByteSink: @unchecked Sendable {
	private let fd: Int32
	private let writeLock = NSLock()
	private let stateLock = NSLock()
	private var isClosed = false
	private var totalBytes: UInt64 = 0

	init(fd: Int32) {
		self.fd = fd
	}

	func write(_ bytes: UnsafePointer<UInt8>, _ count: Int) {
		writeLock.lock()
		defer { writeLock.unlock() }
		guard !closed else { return }

		var offset = 0
		while offset < count {
			let written = Foundation.write(fd, bytes + offset, count - offset)
			if written > 0 {
				offset += written
				stateLock.lock()
				totalBytes += UInt64(written)
				stateLock.unlock()
				continue
			}
			if written < 0 && errno == EINTR { continue }
			stateLock.lock()
			isClosed = true
			stateLock.unlock()
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
		stateLock.lock()
		defer { stateLock.unlock() }
		return isClosed
	}

	var bytesWritten: UInt64 {
		stateLock.lock()
		defer { stateLock.unlock() }
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

	private let outputQueue: DispatchQueue?
	private let counterLock = NSLock()
	private var inFlight = 0

	private(set) var encodedFrames = 0
	private(set) var keyFrames = 0

	/// Frames submitted to VideoToolbox whose output has not been written yet. Callers that pass an
	/// `outputQueue` use this to skip frames while a reader is not draining stdout.
	var pendingFrames: Int {
		counterLock.lock()
		defer { counterLock.unlock() }
		return inFlight
	}

	/// - Parameter outputQueue: When set, encoded frames are written to the sink on this serial
	///   queue instead of on VideoToolbox's output callback. VideoToolbox can deliver that callback
	///   synchronously inside `VTCompressionSessionEncodeFrame`, so a blocking write there stalls
	///   the submitting thread. Sharing one queue across successive encoders keeps their output in
	///   order. Without it, a stalled reader back-pressures into the encoder as before.
	init(options: EncoderOptions, sink: ByteSink, outputQueue: DispatchQueue? = nil) throws {
		self.options = options
		self.sink = sink
		self.outputQueue = outputQueue

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

	/// Encodes one frame. Sources with a fixed cadence omit `presentationTime` and get synthetic
	/// 1/fps timestamps; sources with variable cadence pass wall-clock seconds so rate control and
	/// the one-second keyframe interval track real time.
	func encode(_ pixelBuffer: CVPixelBuffer, forceKeyFrame: Bool = false, presentationTime: Double? = nil) {
		guard let session else { return }
		let timescale = CMTimeScale(options.framesPerSecond * 1000)
		let pts = presentationTime.map { CMTime(seconds: $0, preferredTimescale: 1_000_000) }
			?? CMTime(value: frameIndex * 1000, timescale: timescale)
		let duration = presentationTime == nil
			? CMTime(value: 1000, timescale: timescale)
			: CMTime.invalid
		let frameProperties = forceKeyFrame
			? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
			: nil
		frameIndex += 1

		counterLock.lock()
		inFlight += 1
		counterLock.unlock()
		// VideoToolbox may or may not invoke the handler when submission fails, so release the
		// in-flight slot exactly once from whichever side finishes the frame.
		let slot = InFlightSlot()
		let status = VTCompressionSessionEncodeFrame(
			session,
			imageBuffer: pixelBuffer,
			presentationTimeStamp: pts,
			duration: duration,
			frameProperties: frameProperties,
			infoFlagsOut: nil
		) { [weak self] status, _, sampleBuffer in
			guard let self else { return }
			guard status == noErr, let sampleBuffer, let payload = self.payload(sampleBuffer) else {
				self.release(slot)
				return
			}
			if let outputQueue = self.outputQueue {
				outputQueue.async {
					self.write(payload)
					self.release(slot)
				}
			} else {
				self.write(payload)
				self.release(slot)
			}
		}
		if status != noErr {
			release(slot)
		}
	}

	private func release(_ slot: InFlightSlot) {
		counterLock.lock()
		if !slot.released {
			slot.released = true
			inFlight -= 1
		}
		counterLock.unlock()
	}

	func finish() {
		guard let session else { return }
		VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
		VTCompressionSessionInvalidate(session)
		self.session = nil
	}

	private func write(_ payload: [UInt8]) {
		sink.write(payload)
		counterLock.lock()
		encodedFrames += 1
		counterLock.unlock()
	}

	private func payload(_ sampleBuffer: CMSampleBuffer) -> [UInt8]? {
		let isKeyFrame = Self.isKeyFrame(sampleBuffer)
		var payload: [UInt8] = []

		// Every keyframe re-emits SPS/PPS so a client that joins mid-stream, or one that lost
		// bytes, can resynchronise on the next second instead of never recovering.
		if isKeyFrame, let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
			payload.append(contentsOf: parameterSets(format))
			counterLock.lock()
			keyFrames += 1
			counterLock.unlock()
		}

		guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }
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
		else { return nil }

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

		return payload.isEmpty ? nil : payload
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

private final class InFlightSlot: @unchecked Sendable {
	var released = false
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
