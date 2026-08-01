using System.Globalization;

namespace MobileCanvas.Contracts;


/// <summary>
/// Makes the status bar say something fixed, so a screenshot taken today matches one taken next
/// month. Without it every capture carries the wall clock, whatever the battery happened to be, and
/// whichever notification icons were in flight.
/// </summary>
/// <remarks>
/// Only the fields that are set are changed; the rest keep whatever they were showing. Leaving
/// <see cref="Enabled"/> null applies the overrides without changing whether presentation mode is on,
/// which is how a second call adjusts one field.
/// </remarks>
public sealed record PresentationRequest
{
	/// <summary>
	/// True turns presentation mode on, false returns the status bar to the real device state, and
	/// null leaves it as it is.
	/// </summary>
	public bool? Enabled { get; init; }

	/// <summary>
	/// The clock, as 24-hour <c>HH:mm</c>. Both platforms redraw it in their own format, so a device
	/// set to 12-hour time shows <c>9:41</c> for <c>09:41</c>.
	/// </summary>
	public string? Time { get; init; }

	/// <summary>Battery percentage, 0 to 100.</summary>
	public int? BatteryLevel { get; init; }

	/// <summary>Whether to draw the charging bolt.</summary>
	public bool? BatteryCharging { get; init; }

	/// <summary>Wi-Fi strength, 0 (no bars) to 4 (full). Null leaves it alone.</summary>
	public int? WifiBars { get; init; }

	/// <summary>Cellular strength, 0 (no bars) to 4 (full). Null leaves it alone.</summary>
	public int? CellularBars { get; init; }

	/// <summary>The carrier name beside the signal bars.</summary>
	public string? CarrierName { get; init; }

	/// <summary>
	/// Hides the notification icons. Android draws them in the status bar and can be told to leave
	/// them out; iOS does not draw them there at all, so this is accepted and has nothing to do.
	/// </summary>
	public bool? HideNotifications { get; init; }
}

/// <summary>
/// What the status bar is showing now, read back from the device rather than echoed from the request.
/// </summary>
public sealed record PresentationState
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public string DeviceId { get; init; } = "";
	public string Platform { get; init; } = "";

	/// <summary>Whether presentation mode is on, confirmed against the device.</summary>
	public bool Enabled { get; init; }

	/// <summary>
	/// The overrides the device reports. Empty on a platform that accepts them without offering any
	/// way to read them back, which is not the same as none being set -- see <see cref="Readable"/>.
	/// </summary>
	public PresentationOverride[] Overrides { get; init; } = [];

	/// <summary>
	/// False when the platform will confirm that presentation mode is on but not what it was told to
	/// show. Reporting the request back as though it had been read would be a guess.
	/// </summary>
	public bool Readable { get; init; }
}

/// <summary>One status bar value the device is currently overriding.</summary>
public sealed record PresentationOverride
{
	public string Name { get; init; } = "";
	public string Value { get; init; } = "";
}

/// <summary>
/// An app operation and the mode it is in. Android's app ops sit beside the runtime permissions and
/// cover what those do not -- drawing over other apps, writing system settings, installing packages.
/// </summary>
public sealed record AppOperation
{
	/// <summary>The platform's own name, such as <c>SYSTEM_ALERT_WINDOW</c>.</summary>
	public string Name { get; init; } = "";

	/// <summary>One of the <see cref="AppOperationModes"/> values.</summary>
	public string Mode { get; init; } = "";

	/// <summary>
	/// True when this is the mode for the whole uid rather than the one package. A uid mode wins over
	/// a package mode, so a package set that appears to have been ignored is usually this.
	/// </summary>
	public bool UidScoped { get; init; }
}

public sealed record AppOperationListResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public string DeviceId { get; init; } = "";
	public string Platform { get; init; } = "";
	public string BundleId { get; init; } = "";
	public AppOperation[] Operations { get; init; } = [];
	public int Total { get; init; }
}

public sealed record AppOperationChangeRequest
{
	public string BundleId { get; init; } = "";

	/// <summary>The operation's platform name, such as <c>SYSTEM_ALERT_WINDOW</c>.</summary>
	public string Operation { get; init; } = "";

	/// <summary>One of the <see cref="AppOperationModes"/> values.</summary>
	public string Mode { get; init; } = AppOperationModes.Allow;
}

public sealed record AppOperationChangeResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public bool Success { get; init; } = true;
	public string DeviceId { get; init; } = "";
	public string BundleId { get; init; } = "";
	public string Operation { get; init; } = "";

	/// <summary>The mode the device reports afterwards, read back rather than assumed.</summary>
	public string Mode { get; init; } = "";
}

public static class AppOperationModes
{
	public const string Allow = "allow";

	/// <summary>The app is refused, and told so.</summary>
	public const string Deny = "deny";

	/// <summary>The app is refused, but sees a silent no-op instead of an error.</summary>
	public const string Ignore = "ignore";

	/// <summary>Whatever the platform decides for this app.</summary>
	public const string Default = "default";

	public static readonly string[] All = [Allow, Deny, Ignore, Default];
}

/// <summary>
/// Reads the 24-hour <c>HH:mm</c> clock a presentation request carries.
/// </summary>
/// <remarks>
/// Deliberately strict, and checked before the platform sees it: both platforms accept a time they
/// cannot parse and then quietly leave the clock alone, so a loose check here turns a typo into a
/// screenshot with the wrong time on it.
/// </remarks>
public static class PresentationClock
{
	public static bool TryParse(string value, out int hours, out int minutes)
	{
		hours = 0;
		minutes = 0;

		var parts = value.Trim().Split(':');
		if (parts.Length != 2)
			return false;

		if (!int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out hours))
			return false;

		if (!int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out minutes))
			return false;

		return hours is >= 0 and <= 23 && minutes is >= 0 and <= 59;
	}
}
