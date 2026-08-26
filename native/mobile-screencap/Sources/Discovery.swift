import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

struct RectDTO: Codable {
	var x: Double
	var y: Double
	var width: Double
	var height: Double

	init(_ rect: CGRect) {
		x = Double(rect.origin.x)
		y = Double(rect.origin.y)
		width = Double(rect.size.width)
		height = Double(rect.size.height)
	}

	var cgRect: CGRect {
		CGRect(x: x, y: y, width: width, height: height)
	}
}

/// A simulator host app device window, resolved as far as the current permissions allow.
struct SimulatorWindow: Codable {
	var windowId: UInt32
	var title: String
	var deviceName: String
	var runtime: String?
	var udid: String?
	var udidAmbiguous: Bool
	/// Window frame in screen points, top-left origin.
	var windowFrame: RectDTO
	/// Device screen bounds relative to the window origin, in points. Nil when Accessibility is unavailable.
	var screenRect: RectDTO?
	var screenSource: String
	var backingScale: Double
	var accessibilityTrusted: Bool
}

enum Discovery {
	static let simulatorBundleIds: Set<String> = [
		"com.apple.iphonesimulator",
		"com.apple.dt.Devices",
	]

	static func accessibilityTrusted() -> Bool {
		AXIsProcessTrusted()
	}

	static func windows() async throws -> [SimulatorWindow] {
		let content = try await SCShareableContent.excludingDesktopWindows(
			false,
			onScreenWindowsOnly: false)

		let trusted = accessibilityTrusted()
		let devices = trusted ? SimctlCatalog.bootedDevices() : [:]

		return content.windows.compactMap { window -> SimulatorWindow? in
			guard
				let bundleIdentifier = window.owningApplication?.bundleIdentifier,
				Discovery.simulatorBundleIds.contains(bundleIdentifier)
			else {
				return nil
			}
			guard let title = window.title, !title.isEmpty else { return nil }
			let frame = window.frame
			// The host apps also own small utility surfaces (menu shims, tiny helper windows).
			// A device window is always at least phone-sized.
			guard frame.width >= 100, frame.height >= 100 else { return nil }

			let pid = window.owningApplication?.processID ?? 0
			let ax = trusted ? AccessibilityGeometry.deviceScreen(pid: pid, windowFrame: frame) : nil

			let deviceName = ax?.deviceName ?? title
			let runtime = ax?.runtime
			var udid: String?
			var ambiguous = false
			if let matches = devices[MatchKey(name: deviceName, runtime: runtime)] {
				udid = matches.first
				ambiguous = matches.count > 1
			}

			return SimulatorWindow(
				windowId: window.windowID,
				title: title,
				deviceName: deviceName,
				runtime: runtime,
				udid: udid,
				udidAmbiguous: ambiguous,
				windowFrame: RectDTO(frame),
				screenRect: ax.map { RectDTO($0.screenRect) },
				screenSource: ax == nil
					? "unavailable"
					: (ax!.exact ? "accessibility" : "accessibility-approximate"),
				backingScale: backingScale(for: frame),
				accessibilityTrusted: trusted)
		}
		.sorted { $0.windowId < $1.windowId }
	}

	static func window(id: UInt32) async throws -> (SCWindow, SimulatorWindow)? {
		let content = try await SCShareableContent.excludingDesktopWindows(
			false,
			onScreenWindowsOnly: false)
		guard let sc = content.windows.first(where: { $0.windowID == id }) else { return nil }
		let all = try await windows()
		guard let described = all.first(where: { $0.windowId == id }) else { return nil }
		return (sc, described)
	}

	static func backingScale(for frame: CGRect) -> Double {
		let center = CGPoint(x: frame.midX, y: frame.midY)
		// NSScreen frames use a bottom-left origin; CG window frames use top-left.
		let primaryHeight = NSScreen.screens.first?.frame.maxY ?? 0
		let flipped = CGPoint(x: center.x, y: primaryHeight - center.y)
		for screen in NSScreen.screens where screen.frame.contains(flipped) {
			return Double(screen.backingScaleFactor)
		}
		return Double(NSScreen.main?.backingScaleFactor ?? 2)
	}
}

struct MatchKey: Hashable {
	var name: String
	var runtime: String?
}

enum SimctlCatalog {
	/// Booted devices keyed by (name, runtime version). Only booted devices can own a window,
	/// which removes most of the ambiguity that a name-only match would carry.
	static func bootedDevices() -> [MatchKey: [String]] {
		guard let data = run("/usr/bin/xcrun", ["simctl", "list", "devices", "--json"]) else {
			return [:]
		}
		guard
			let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
			let devices = root["devices"] as? [String: Any]
		else { return [:] }

		var result: [MatchKey: [String]] = [:]
		for (runtimeId, value) in devices {
			guard let list = value as? [[String: Any]] else { continue }
			let version = runtimeVersion(fromIdentifier: runtimeId)
			for entry in list {
				guard
					let state = entry["state"] as? String, state == "Booted",
					let name = entry["name"] as? String,
					let udid = entry["udid"] as? String
				else { continue }
				result[MatchKey(name: name, runtime: version), default: []].append(udid)
				// Also index without a runtime so a name-only lookup still resolves.
				result[MatchKey(name: name, runtime: nil), default: []].append(udid)
			}
		}
		return result
	}

	/// "com.apple.CoreSimulator.SimRuntime.iOS-26-5" -> "iOS 26.5"
	static func runtimeVersion(fromIdentifier identifier: String) -> String? {
		guard let tail = identifier.split(separator: ".").last else { return nil }
		let parts = tail.split(separator: "-")
		guard parts.count >= 2 else { return nil }
		let platform = String(parts[0])
		let version = parts.dropFirst().joined(separator: ".")
		return "\(platform) \(version)"
	}

	static func run(_ path: String, _ arguments: [String]) -> Data? {
		let process = Process()
		process.executableURL = URL(fileURLWithPath: path)
		process.arguments = arguments
		let pipe = Pipe()
		process.standardOutput = pipe
		process.standardError = FileHandle.nullDevice
		do {
			try process.run()
		} catch {
			return nil
		}
		let data = pipe.fileHandleForReading.readDataToEndOfFile()
		process.waitUntilExit()
		return process.terminationStatus == 0 ? data : nil
	}
}

struct DeviceScreen {
	var screenRect: CGRect
	var deviceName: String
	var runtime: String?
	/// True only when the `iOSContentGroup` subrole was matched. The largest-AXGroup fallback is
	/// an approximation that can still include chrome or bezel, which would misalign input, so
	/// callers must be able to tell the two apart.
	var exact: Bool
}

enum AccessibilityGeometry {
	/// Simulator.app and Device Hub expose the device framebuffer view as an AXGroup with the
	/// `iOSContentGroup` subrole. Reading its frame gives an exact crop with no image analysis, and
	/// it stays correct across zoom changes, bezel styles, and device types.
	static let contentSubrole = "iOSContentGroup"

	static func deviceScreen(pid: pid_t, windowFrame: CGRect) -> DeviceScreen? {
		guard pid > 0 else { return nil }
		let app = AXUIElementCreateApplication(pid)
		guard let windows = copyValue(app, kAXWindowsAttribute) as? [AXUIElement] else { return nil }

		for window in windows {
			guard let frame = elementFrame(window) else { continue }
			guard nearlyEqual(frame, windowFrame) else { continue }
			guard let content = findContentGroup(window) else { continue }
			guard let contentFrame = elementFrame(content.element) else { continue }

			let relative = CGRect(
				x: contentFrame.origin.x - frame.origin.x,
				y: contentFrame.origin.y - frame.origin.y,
				width: contentFrame.size.width,
				height: contentFrame.size.height)

			let title = copyValue(window, kAXTitleAttribute) as? String ?? ""
			let (name, runtime) = splitTitle(title)
			return DeviceScreen(
				screenRect: relative,
				deviceName: name,
				runtime: runtime,
				exact: content.exact)
		}
		return nil
	}

	/// Titles look like "iPhone 11 Pro – iOS 26.5" using an en dash.
	static func splitTitle(_ title: String) -> (String, String?) {
		for separator in [" \u{2013} ", " - ", " \u{2014} "] {
			if let range = title.range(of: separator) {
				let name = String(title[title.startIndex..<range.lowerBound])
				let runtime = String(title[range.upperBound...])
				return (name.trimmingCharacters(in: .whitespaces), runtime.trimmingCharacters(in: .whitespaces))
			}
		}
		return (title, nil)
	}

	private static func findContentGroup(_ root: AXUIElement) -> (element: AXUIElement, exact: Bool)? {
		var queue: [AXUIElement] = [root]
		var visited = 0
		var fallback: (element: AXUIElement, area: CGFloat)?

		while !queue.isEmpty, visited < 512 {
			let element = queue.removeFirst()
			visited += 1

			if let subrole = copyValue(element, kAXSubroleAttribute) as? String, subrole == contentSubrole {
				return (element, true)
			}
			if let role = copyValue(element, kAXRoleAttribute) as? String,
				role == kAXGroupRole as String,
				let frame = elementFrame(element)
			{
				let area = frame.width * frame.height
				if area > (fallback?.area ?? 0) {
					fallback = (element, area)
				}
			}
			if let children = copyValue(element, kAXChildrenAttribute) as? [AXUIElement] {
				queue.append(contentsOf: children)
			}
		}
		return fallback.map { ($0.element, false) }
	}

	private static func elementFrame(_ element: AXUIElement) -> CGRect? {
		guard
			let positionValue = copyValue(element, kAXPositionAttribute),
			let sizeValue = copyValue(element, kAXSizeAttribute)
		else { return nil }

		var origin = CGPoint.zero
		var size = CGSize.zero
		guard
			AXValueGetValue(positionValue as! AXValue, .cgPoint, &origin),
			AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
		else { return nil }
		return CGRect(origin: origin, size: size)
	}

	private static func copyValue(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
		var value: AnyObject?
		let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
		return status == .success ? value : nil
	}

	private static func nearlyEqual(_ lhs: CGRect, _ rhs: CGRect, tolerance: CGFloat = 2) -> Bool {
		abs(lhs.origin.x - rhs.origin.x) <= tolerance
			&& abs(lhs.origin.y - rhs.origin.y) <= tolerance
			&& abs(lhs.size.width - rhs.size.width) <= tolerance
			&& abs(lhs.size.height - rhs.size.height) <= tolerance
	}
}
