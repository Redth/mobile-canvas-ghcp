namespace MobileCanvas.Contracts;

/// <summary>
/// A simulated GPS fix.
/// </summary>
public sealed record DeviceLocationRequest
{
	public required double Latitude { get; init; }
	public required double Longitude { get; init; }
}

/// <summary>
/// The battery state to simulate. Fields left unset are left alone.
/// </summary>
public sealed record BatteryRequest
{
	/// <summary>Charge percentage, 0-100.</summary>
	public int? Level { get; init; }

	/// <summary>One of the values in <see cref="BatteryStates"/>.</summary>
	public string? State { get; init; }
}

/// <summary>
/// The network conditions to simulate.
/// </summary>
public sealed record NetworkRequest
{
	/// <summary>A profile name from <see cref="NetworkProfiles"/>, or a raw platform value.</summary>
	public string? Profile { get; init; }

	/// <summary>Round-trip latency to add, in milliseconds. Zero removes the delay.</summary>
	public int? LatencyMs { get; init; }
}

/// <summary>
/// What the device reports about its simulated hardware.
/// </summary>
public sealed record HardwareState
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public required string DeviceId { get; init; }
	public required string Platform { get; init; }

	public int? BatteryLevel { get; init; }
	public string? BatteryState { get; init; }

	/// <summary>Simulated download speed in bits per second, where the platform reports one.</summary>
	public long? DownloadBitsPerSecond { get; init; }

	/// <summary>Simulated upload speed in bits per second, where the platform reports one.</summary>
	public long? UploadBitsPerSecond { get; init; }

	public int? LatencyMs { get; init; }

	/// <summary>
	/// True when the platform only changes what the status bar shows without changing the
	/// connection underneath, so an app under test still has whatever network the host has.
	/// </summary>
	public bool NetworkIsIndicatorOnly { get; init; }

	/// <summary>
	/// What the platform could not report. Neither platform can read back a simulated location,
	/// so a caller has no way to confirm one except by asking the app.
	/// </summary>
	public IReadOnlyList<string> Unreadable { get; init; } = [];
}

public static class BatteryStates
{
	public const string Charging = "charging";
	public const string Discharging = "discharging";
	public const string Full = "full";

	public static IReadOnlyList<string> All { get; } = [Charging, Discharging, Full];
}

/// <summary>
/// Network profiles both platforms understand, slowest first.
/// </summary>
public static class NetworkProfiles
{
	public const string Gsm = "gsm";
	public const string Gprs = "gprs";
	public const string Edge = "edge";
	public const string Umts = "umts";
	public const string Hsdpa = "hsdpa";
	public const string Lte = "lte";
	public const string Full = "full";

	public static IReadOnlyList<string> All { get; } =
		[Gsm, Gprs, Edge, Umts, Hsdpa, Lte, Full];
}
