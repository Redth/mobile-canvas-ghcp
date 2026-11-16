import Foundation

/// Covers the framebuffer pacing policy: change detection by seed or callback, frame-interval
/// throttling, and the idle floor that keeps a static screen producing frames.
enum FramePacingTests {
	static func run(_ runner: TestRunner) {
		runner.test("first decision encodes even without a callback") {
			let pacer = FramePacer(framesPerSecond: 60)
			runner.expectEqual(pacer.decide(now: 0, seed: 7), .encodeChange, "first decision")
		}

		runner.test("an unchanged surface is re-encoded only at the idle floor") {
			var pacer = FramePacer(framesPerSecond: 60)
			pacer.didEncode(now: 0, seed: 7)
			runner.expectEqual(pacer.decide(now: 1.0 / 60, seed: 7), .unchanged, "one frame later")
			runner.expectEqual(pacer.decide(now: 0.15, seed: 7), .unchanged, "below the floor")
			runner.expectEqual(pacer.decide(now: 0.2, seed: 7), .encodeIdle, "at the floor")
		}

		runner.test("the idle floor emits about five frames per second over a static second") {
			var pacer = FramePacer(framesPerSecond: 60)
			var encoded = 0
			for tick in 0..<60 {
				let now = Double(tick) / 60
				switch pacer.decide(now: now, seed: 1) {
				case .encodeChange, .encodeIdle:
					encoded += 1
					pacer.didEncode(now: now, seed: 1)
				case .throttled, .unchanged:
					break
				}
			}
			runner.expect((5...6).contains(encoded), "expected 5-6 frames, got \(encoded)")
		}

		runner.test("a new seed is encoded once per frame interval") {
			var pacer = FramePacer(framesPerSecond: 60)
			pacer.didEncode(now: 0, seed: 1)
			runner.expectEqual(pacer.decide(now: 0.005, seed: 2), .throttled, "inside the interval")
			runner.expectClose(pacer.timeUntilNextFrame(now: 0.005), 0.9 / 60 - 0.005, "catch-up delay", tolerance: 1e-9)
			runner.expectEqual(pacer.decide(now: 0.016, seed: 2), .encodeChange, "after the interval")
			pacer.didEncode(now: 0.016, seed: 2)
			runner.expectEqual(pacer.decide(now: 0.034, seed: 2), .unchanged, "same seed is not a change")
		}

		runner.test("a callback marks a change even when the seed did not move") {
			var pacer = FramePacer(framesPerSecond: 30)
			pacer.didEncode(now: 0, seed: 4)
			pacer.noteCallback()
			runner.expect(pacer.hasPendingCallback, "callback is pending")
			runner.expectEqual(pacer.decide(now: 0.034, seed: 4), .encodeChange, "callback change")
			pacer.didEncode(now: 0.034, seed: 4)
			runner.expect(!pacer.hasPendingCallback, "encode consumes the callback")
		}

		runner.test("invalidating forces the next tick to encode") {
			var pacer = FramePacer(framesPerSecond: 60)
			pacer.didEncode(now: 0, seed: 9)
			pacer.invalidate()
			runner.expectEqual(pacer.decide(now: 0.02, seed: 9), .encodeChange, "after invalidate")
		}

		runner.test("the idle floor never exceeds a lower requested frame rate") {
			let pacer = FramePacer(framesPerSecond: 2)
			runner.expectClose(pacer.idleInterval, 0.5, "idle interval at 2 fps")
		}
	}
}
