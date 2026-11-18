import Foundation

/// Decides which framebuffer ticks become encoded frames.
///
/// SimulatorKit frame callbacks are not a reliable change signal: on Xcode 27 runtimes they can
/// stay silent for a static screen and arrive well below display cadence during animation. The
/// capture loop therefore also polls the IOSurface seed, which the producer bumps on every write.
/// A change (new seed or a callback) is encoded at most once per frame interval; an unchanged
/// surface is re-encoded only at the idle floor, so a static screen still delivers fresh frames to
/// late joiners and idle-flushing decoders without duplicating frames above that floor.
///
/// The seed poll and idle floor follow the approach of Expo's serve-sim `FrameCapture`
/// (https://github.com/expo/expo-device-hub, Apache-2.0); this is an independent implementation.
struct FramePacer {
	enum Decision: Equatable {
		/// The surface changed and the frame interval has elapsed.
		case encodeChange
		/// Nothing changed, but the idle floor is due.
		case encodeIdle
		/// A change is pending but the previous frame was too recent; a later tick picks it up.
		case throttled
		/// Nothing changed and the idle floor is not due.
		case unchanged
	}

	/// Re-emit a static screen at this rate. 5 FPS keeps the gap below the 250 ms idle flush in the
	/// Ailoha video player while costing only skipped macroblocks between keyframes.
	static let idleFramesPerSecond = 5.0

	let frameInterval: Double
	let idleInterval: Double

	private(set) var lastEncodedAt = -Double.infinity
	private var lastSeed: UInt32?
	private var callbackPending = false

	init(framesPerSecond: Int) {
		let fps = Double(max(1, framesPerSecond))
		frameInterval = 1.0 / fps
		idleInterval = 1.0 / min(fps, Self.idleFramesPerSecond)
	}

	/// Records that SimulatorKit reported a rendered frame.
	mutating func noteCallback() {
		callbackPending = true
	}

	var hasPendingCallback: Bool { callbackPending }

	/// Forgets the encoded seed so the next decision treats the surface as changed.
	mutating func invalidate() {
		lastSeed = nil
	}

	func decide(now: Double, seed: UInt32) -> Decision {
		let elapsed = now - lastEncodedAt
		if callbackPending || seed != lastSeed {
			// Timer and callback jitter would otherwise throttle frames that are only a hair early.
			return elapsed >= frameInterval * 0.9 ? .encodeChange : .throttled
		}
		return elapsed >= idleInterval * 0.95 ? .encodeIdle : .unchanged
	}

	/// Seconds until a pending change may be encoded.
	func timeUntilNextFrame(now: Double) -> Double {
		max(0, lastEncodedAt + frameInterval * 0.9 - now)
	}

	/// Records an encode. `seed` must be read before the pixels are copied, so a write that races
	/// the copy leaves the seed different and is encoded again on the next tick.
	mutating func didEncode(now: Double, seed: UInt32) {
		lastEncodedAt = now
		lastSeed = seed
		callbackPending = false
	}
}
