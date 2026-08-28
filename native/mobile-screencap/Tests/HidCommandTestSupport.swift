import Foundation

// HidCommand and AccessibilityCommand are compiled into the native test target without Entry.swift
// (which owns @main). These minimal test-only definitions satisfy their command-shell dependencies.
struct HelperError: Error {
	init(_: String) {}
}

struct CommandLineOptions {
	private let values: [String: String]

	init(_ values: [String: String] = [:]) {
		self.values = values
	}

	func string(_ key: String) -> String? {
		values[key]
	}

	func int(_ key: String) -> Int? {
		values[key].flatMap(Int.init)
	}

	func double(_ key: String) -> Double? {
		values[key].flatMap(Double.init)
	}
}

enum Events {
	static func emit(_: [String: Any]) {}
}
