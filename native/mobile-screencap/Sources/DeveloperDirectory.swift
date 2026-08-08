import Foundation

enum DeveloperDirectory {
	static func resolve(_ override: String?) throws -> String {
		if let override, !override.isEmpty {
			return override
		}
		if let environment = ProcessInfo.processInfo.environment["DEVELOPER_DIR"], !environment.isEmpty {
			return environment
		}

		let process = Process()
		let output = Pipe()
		process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
		process.arguments = ["-p"]
		process.standardOutput = output
		process.standardError = Pipe()
		try process.run()
		process.waitUntilExit()
		guard process.terminationStatus == 0 else {
			throw HelperError("xcode-select could not locate the active developer directory")
		}
		let data = output.fileHandleForReading.readDataToEndOfFile()
		guard
			let path = String(data: data, encoding: .utf8)?
				.trimmingCharacters(in: .whitespacesAndNewlines),
			!path.isEmpty
		else {
			throw HelperError("xcode-select returned an empty developer directory")
		}
		return path
	}
}
