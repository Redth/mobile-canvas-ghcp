import Foundation

enum RotationCommand {
	static func run(_ options: CommandLineOptions) throws {
		guard let udid = options.string("udid"), !udid.isEmpty else {
			throw HelperError("--udid is required")
		}
		guard let name = options.string("orientation") else {
			throw HelperError("--orientation is required")
		}

		let orientation: UInt
		switch name.lowercased() {
		case "portrait":
			orientation = 1
		case "portrait-upside-down":
			orientation = 2
		case "landscape-right":
			orientation = 3
		case "landscape-left":
			orientation = 4
		default:
			throw HelperError(
				"--orientation must be portrait, portrait-upside-down, landscape-left, or landscape-right")
		}

		try MCSimulatorRotation.rotateDevice(
			withUDID: udid,
			developerDirectory: DeveloperDirectory.resolve(options.string("developer-dir")),
			orientation: orientation)
	}
}
