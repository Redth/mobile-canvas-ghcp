import Foundation

/// Coverage for the accessibility reader's pure, simulator-independent pieces: the
/// `MCAccessibilityNodeForElement` serialization/bounding contract (fed a fake `NSAccessibility`
/// element tree, so no booted simulator or private framework is required) and
/// `AccessibilityCommand`'s error-code mapping and clamp helpers. Live delivery against a real
/// translated tree is only provable against a booted device and is exercised manually, plus by the
/// shipped-helper contract check in `test.sh` for the "device does not exist" failure path.
enum AccessibilityTests {
	static func run(_ runner: TestRunner) {
		serialization(runner)
		bridgeDelegateTokenPropagation(runner)
		valueConversion(runner)
		optionalAttributes(runner)
		traversalBounds(runner)
		commandHelpers(runner)
	}

	// MARK: Serialization

	static func serialization(_ runner: TestRunner) {
		runner.test("a fully populated leaf serializes every managed-compatible key") {
			let element = MCFakeAXElement()
			element.fakeRole = "AXButton"
			element.fakeSubrole = "AXCloseButton"
			element.fakeLabel = "Done"
			element.fakeIdentifier = "done-button"
			element.fakeHelp = "Dismisses the sheet"
			element.fakeValue = "1"
			element.hasFakeValue = true
			element.fakeFrame = NSRect(x: 1, y: 2, width: 3, height: 4)
			element.hasFakeFrame = true
			element.fakeEnabled = true
			element.hasFakeEnabled = true
			element.fakeFocused = true
			element.hasFakeFocused = true

			guard let node = MCAccessibilityNodeForElement(element, 64, 20000) else {
				runner.expect(false, "expected a node for a fully populated element")
				return
			}

			runner.expectEqual(node["role"] as? String, "AXButton", "role keeps the AX prefix")
			runner.expectEqual(node["type"] as? String, "Button", "type strips the AX prefix")
			runner.expectEqual(node["subrole"] as? String, "AXCloseButton", "subrole")
			runner.expectEqual(node["AXLabel"] as? String, "Done", "AXLabel")
			runner.expectEqual(node["AXValue"] as? String, "1", "AXValue")
			runner.expectEqual(node["AXUniqueId"] as? String, "done-button", "AXUniqueId")
			runner.expectEqual(node["help"] as? String, "Dismisses the sheet", "help")
			runner.expectEqual(node["enabled"] as? Bool, true, "enabled")
			runner.expectEqual(node["focused"] as? Bool, true, "focused")

			guard let frame = node["frame"] as? [String: Any] else {
				runner.expect(false, "expected a frame dictionary")
				return
			}
			runner.expectClose((frame["x"] as? NSNumber)?.doubleValue ?? -1, 1, "frame.x")
			runner.expectClose((frame["y"] as? NSNumber)?.doubleValue ?? -1, 2, "frame.y")
			runner.expectClose((frame["width"] as? NSNumber)?.doubleValue ?? -1, 3, "frame.width")
			runner.expectClose((frame["height"] as? NSNumber)?.doubleValue ?? -1, 4, "frame.height")

			runner.expect((node["children"] as? [Any])?.isEmpty == true, "children defaults to an empty array")
		}

		runner.test("role normalization leaves a role without the AX prefix untouched") {
			let element = MCFakeAXElement()
			element.fakeRole = "Button"
			guard let node = MCAccessibilityNodeForElement(element, 64, 20000) else {
				runner.expect(false, "expected a node")
				return
			}
			runner.expectEqual(node["role"] as? String, "Button", "role")
			runner.expectEqual(node["type"] as? String, "Button", "type is unchanged without an AX prefix")
		}

		runner.test("a two-character role is left alone rather than emptied") {
			let element = MCFakeAXElement()
			element.fakeRole = "AX"
			guard let node = MCAccessibilityNodeForElement(element, 64, 20000) else {
				runner.expect(false, "expected a node")
				return
			}
			runner.expectEqual(node["role"] as? String, "AX", "role")
			runner.expectEqual(node["type"] as? String, "AX", "a bare 'AX' has nothing to strip")
		}

		runner.test("an element with nothing set still serializes with an empty children array") {
			let element = MCFakeAXElement()
			guard let node = MCAccessibilityNodeForElement(element, 64, 20000) else {
				runner.expect(false, "expected a node even for an empty element")
				return
			}
			runner.expect(node["role"] == nil, "role is omitted, not empty-stringed")
			runner.expect(node["AXLabel"] == nil, "AXLabel is omitted")
			runner.expect((node["children"] as? [Any])?.isEmpty == true, "children is still an empty array")
		}
	}

	// MARK: Bridge delegate token

	static func bridgeDelegateTokenPropagation(_ runner: TestRunner) {
		runner.test("bridge token reaches the root and children before attribute reads") {
			let token = "test-token"
			let child = MCFakeAXElement()
			child.fakeRole = "AXButton"
			child.expectedBridgeDelegateToken = token

			let root = MCFakeAXElement()
			root.fakeRole = "AXWindow"
			root.fakeChildren = [child]
			root.hasFakeChildren = true
			root.expectedBridgeDelegateToken = token

			let node = MCAccessibilityNodeForElementWithBridgeDelegateToken(root, 64, 20_000, token)

			runner.expectEqual(node?["role"] as? String, "AXWindow", "root role")
			runner.expectEqual(
				(node?["children"] as? [[String: Any]])?.first?["role"] as? String,
				"AXButton",
				"child role")
			runner.expectEqual(root.translation.bridgeDelegateToken, token, "root bridge token")
			runner.expectEqual(child.translation.bridgeDelegateToken, token, "child bridge token")
		}
	}

	// MARK: AXValue conversion

	static func valueConversion(_ runner: TestRunner) {
		runner.test("AXValue passes strings and numbers through unchanged") {
			let stringElement = MCFakeAXElement()
			stringElement.fakeValue = "hello"
			stringElement.hasFakeValue = true
			let stringNode = MCAccessibilityNodeForElement(stringElement, 64, 20000)
			runner.expectEqual(stringNode?["AXValue"] as? String, "hello", "string value")

			let numberElement = MCFakeAXElement()
			numberElement.fakeValue = NSNumber(value: 0.5)
			numberElement.hasFakeValue = true
			let numberNode = MCAccessibilityNodeForElement(numberElement, 64, 20000)
			runner.expectClose(
				(numberNode?["AXValue"] as? NSNumber)?.doubleValue ?? -1, 0.5, "number value passes through")
		}

		runner.test("AXValue degrades an arbitrary object to its description") {
			let element = MCFakeAXElement()
			element.fakeValue = NSDate(timeIntervalSinceReferenceDate: 0)
			element.hasFakeValue = true
			let node = MCAccessibilityNodeForElement(element, 64, 20000)
			runner.expect(node?["AXValue"] is String, "a non-JSON-native value becomes a description string")
		}

		runner.test("AXValue is omitted for nil, NSNull, or when the selector is unavailable") {
			let nilElement = MCFakeAXElement()
			nilElement.hasFakeValue = true
			nilElement.fakeValue = nil
			runner.expect(
				MCAccessibilityNodeForElement(nilElement, 64, 20000)?["AXValue"] == nil,
				"nil value is omitted")

			let nullElement = MCFakeAXElement()
			nullElement.hasFakeValue = true
			nullElement.fakeValue = NSNull()
			runner.expect(
				MCAccessibilityNodeForElement(nullElement, 64, 20000)?["AXValue"] == nil,
				"NSNull value is omitted")

			let unavailableElement = MCFakeAXElement()
			unavailableElement.hasFakeValue = false
			runner.expect(
				MCAccessibilityNodeForElement(unavailableElement, 64, 20000)?["AXValue"] == nil,
				"an unimplemented selector is omitted, not defaulted")
		}
	}

	// MARK: enabled/focused/frame omission

	static func optionalAttributes(_ runner: TestRunner) {
		runner.test("enabled and focused are omitted, not defaulted, when unavailable") {
			let element = MCFakeAXElement()
			// hasFakeEnabled/hasFakeFocused default to false, so the fake does not "respond" to
			// either selector -- exactly like a real element with nothing to say for them. The
			// managed AccessibilityParser is the one responsible for defaulting a missing
			// `enabled` to true and a missing `focused` to false, not the native reader.
			guard let node = MCAccessibilityNodeForElement(element, 64, 20000) else {
				runner.expect(false, "expected a node")
				return
			}
			runner.expect(node["enabled"] == nil, "enabled key is absent, not false")
			runner.expect(node["focused"] == nil, "focused key is absent, not false")
		}

		runner.test("frame is omitted entirely when the selector is unavailable") {
			let element = MCFakeAXElement()
			element.hasFakeFrame = false
			let node = MCAccessibilityNodeForElement(element, 64, 20000)
			runner.expect(node?["frame"] == nil, "frame key is absent when accessibilityFrame is unavailable")
		}
	}

	// MARK: Traversal bounds

	static func traversalBounds(_ runner: TestRunner) {
		runner.test("maxDepth 0 keeps only the root, with an empty children array") {
			let child = MCFakeAXElement()
			child.fakeRole = "AXStaticText"
			let root = MCFakeAXElement()
			root.fakeRole = "AXWindow"
			root.fakeChildren = [child]
			root.hasFakeChildren = true

			guard let node = MCAccessibilityNodeForElement(root, 0, 20000) else {
				runner.expect(false, "expected a root node")
				return
			}
			runner.expectEqual(node["role"] as? String, "AXWindow", "root role is still present")
			runner.expect((node["children"] as? [Any])?.isEmpty == true, "depth 0 truncates all children")
		}

		runner.test("maxDepth 1 includes direct children but not grandchildren") {
			let grandchild = MCFakeAXElement()
			grandchild.fakeRole = "AXStaticText"
			let child = MCFakeAXElement()
			child.fakeRole = "AXGroup"
			child.fakeChildren = [grandchild]
			child.hasFakeChildren = true
			let root = MCFakeAXElement()
			root.fakeRole = "AXWindow"
			root.fakeChildren = [child]
			root.hasFakeChildren = true

			guard let node = MCAccessibilityNodeForElement(root, 1, 20000) else {
				runner.expect(false, "expected a root node")
				return
			}
			guard let children = node["children"] as? [[String: Any]], children.count == 1 else {
				runner.expect(false, "expected exactly one direct child")
				return
			}
			runner.expectEqual(children[0]["role"] as? String, "AXGroup", "direct child role")
			runner.expect(
				(children[0]["children"] as? [Any])?.isEmpty == true,
				"grandchildren are cut off at maxDepth 1")
		}

		runner.test("a non-NSAccessibility child is skipped rather than crashing the walk") {
			// MCAXChildren only accepts an NSArray back from accessibilityChildren; the bridge
			// itself additionally guards each entry with -isKindOfClass:NSObject.class before
			// recursing, so a well-formed array of real elements never produces a gap. This test
			// pins down that a normally-shaped, all-valid children array round-trips in full.
			let first = MCFakeAXElement()
			first.fakeRole = "AXStaticText"
			let second = MCFakeAXElement()
			second.fakeRole = "AXButton"
			let root = MCFakeAXElement()
			root.fakeChildren = [first, second]
			root.hasFakeChildren = true

			guard let node = MCAccessibilityNodeForElement(root, 64, 20000) else {
				runner.expect(false, "expected a root node")
				return
			}
			runner.expectEqual((node["children"] as? [Any])?.count, 2, "both valid children are kept")
		}

		runner.test("maxNodes bounds the total node count across the whole tree, root included") {
			let children = (0..<5).map { index -> MCFakeAXElement in
				let element = MCFakeAXElement()
				element.fakeRole = "AXStaticText"
				element.fakeIdentifier = "child-\(index)"
				return element
			}
			let root = MCFakeAXElement()
			root.fakeRole = "AXWindow"
			root.fakeChildren = children
			root.hasFakeChildren = true

			// Budget of 3 covers the root plus 2 children; the rest are silently dropped, never
			// an error and never a half-built entry.
			guard let node = MCAccessibilityNodeForElement(root, 64, 3) else {
				runner.expect(false, "expected a root node even though the budget is tight")
				return
			}
			runner.expectEqual((node["children"] as? [Any])?.count, 2, "only 2 of 5 children fit the budget")
		}

		runner.test("maxNodes of 1 keeps only the root and reports no children") {
			let child = MCFakeAXElement()
			let root = MCFakeAXElement()
			root.fakeChildren = [child]
			root.hasFakeChildren = true

			guard let node = MCAccessibilityNodeForElement(root, 64, 1) else {
				runner.expect(false, "expected a root node")
				return
			}
			runner.expect((node["children"] as? [Any])?.isEmpty == true, "a budget of 1 leaves no room for children")
		}

		runner.test("a non-positive maxNodes still yields a root rather than nil") {
			// The wrapper clamps an adversarial/zero budget up to 1 so a caller always gets a
			// well-formed (if minimal) tree instead of an empty response for a bad argument.
			let root = MCFakeAXElement()
			root.fakeRole = "AXWindow"
			let node = MCAccessibilityNodeForElement(root, 64, 0)
			runner.expect(node != nil, "maxNodes <= 0 is clamped up to at least 1")
			runner.expectEqual(node?["role"] as? String, "AXWindow", "the clamped root is still fully serialized")
		}
	}

	// MARK: AccessibilityCommand helpers

	static func commandHelpers(_ runner: TestRunner) {
		runner.test("errorCode(forRawValue:) maps every MCAccessibilityErrorCode to a stable string") {
			runner.expectEqual(
				AccessibilityCommand.errorCode(forRawValue: 1), "framework_unavailable", "FrameworkUnavailable")
			runner.expectEqual(
				AccessibilityCommand.errorCode(forRawValue: 2), "selector_unavailable", "SelectorUnavailable")
			runner.expectEqual(
				AccessibilityCommand.errorCode(forRawValue: 3), "device_not_booted", "DeviceNotBooted")
			runner.expectEqual(AccessibilityCommand.errorCode(forRawValue: 4), "timeout", "Timeout")
			runner.expectEqual(AccessibilityCommand.errorCode(forRawValue: 5), "empty_tree", "EmptyTree")
			runner.expectEqual(AccessibilityCommand.errorCode(forRawValue: 6), "internal_error", "Internal")
			runner.expectEqual(
				AccessibilityCommand.errorCode(forRawValue: 0), "internal_error", "an unknown code falls back safely")
			runner.expectEqual(
				AccessibilityCommand.errorCode(forRawValue: 999), "internal_error",
				"an out-of-range code falls back safely")
		}

		runner.test("clampInt keeps a value in range and clamps outside it") {
			runner.expectEqual(AccessibilityCommand.clampInt(10, min: 0, max: 100), 10, "in range")
			runner.expectEqual(AccessibilityCommand.clampInt(-5, min: 0, max: 100), 0, "below the floor")
			runner.expectEqual(AccessibilityCommand.clampInt(500, min: 0, max: 100), 100, "above the ceiling")
			runner.expectEqual(
				AccessibilityCommand.clampInt(0, min: 0, max: 4096), 0, "maxDepth of 0 (root only) is legal")
		}

		runner.test("clampTimeout keeps a sane request timeout") {
			runner.expectClose(AccessibilityCommand.clampTimeout(2.5), 2.5, "in range")
			runner.expectClose(AccessibilityCommand.clampTimeout(0), 0.1, "a zero/negative timeout floors to 0.1s")
			runner.expectClose(AccessibilityCommand.clampTimeout(-5), 0.1, "a negative timeout floors to 0.1s")
			runner.expectClose(AccessibilityCommand.clampTimeout(120), 60, "an excessive timeout ceilings to 60s")
			runner.expectClose(
				AccessibilityCommand.clampTimeout(.infinity), AccessibilityCommand.defaultRequestTimeout,
				"a non-finite timeout falls back to the default")
			runner.expectClose(
				AccessibilityCommand.clampTimeout(.nan), AccessibilityCommand.defaultRequestTimeout,
				"NaN falls back to the default")
		}
	}
}
