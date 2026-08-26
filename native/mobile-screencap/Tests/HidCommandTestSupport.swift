import Foundation

// HidCommand is compiled into the native test target without Entry.swift (which owns @main).
// These minimal test-only definitions satisfy the two command-shell dependencies.
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
}

enum Events {
	static func emit(_: [String: Any]) {}
}
