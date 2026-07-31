namespace MobileCanvas.Contracts;

/// <summary>
/// A simulated remote push notification.
/// </summary>
public sealed record PushNotificationRequest
{
	/// <summary>The app that should receive it.</summary>
	public required string BundleId { get; init; }

	/// <summary>
	/// The APNs payload as JSON. Must be an object containing an <c>aps</c> key, and 4096 bytes
	/// or less -- the platform enforces both and says which one failed.
	/// </summary>
	public required string Payload { get; init; }
}

/// <summary>
/// An inbound text message, as though it arrived over the network.
/// </summary>
public sealed record SmsRequest
{
	/// <summary>The sender's number. Free-form: the emulator does not validate it.</summary>
	public required string From { get; init; }

	public required string Body { get; init; }
}

/// <summary>
/// An inbound phone call, or a change to one already in progress.
/// </summary>
public sealed record CallRequest
{
	/// <summary>One of the values in <see cref="CallActions"/>.</summary>
	public required string Action { get; init; }

	/// <summary>
	/// The number to call from. Required to place a call; optional afterwards, where leaving it
	/// unset applies the action to the call already in progress.
	/// </summary>
	public string? Number { get; init; }
}

public static class CallActions
{
	/// <summary>Ring the device from <see cref="CallRequest.Number"/>.</summary>
	public const string Place = "place";

	/// <summary>Answer a ringing call, putting it through.</summary>
	public const string Accept = "accept";

	/// <summary>Put an active call on hold.</summary>
	public const string Hold = "hold";

	/// <summary>Hang up, from either end.</summary>
	public const string Cancel = "cancel";

	public static IReadOnlyList<string> All { get; } = [Place, Accept, Hold, Cancel];
}

/// <summary>
/// One call the device's telephony stack knows about.
/// </summary>
public sealed record PhoneCall
{
	/// <summary>The other party, as the device reports it. Partly masked on some builds.</summary>
	public required string Number { get; init; }

	/// <summary>The platform's own word for the state, such as <c>RINGING</c> or <c>ACTIVE</c>.</summary>
	public required string State { get; init; }
}

/// <summary>
/// What the device reports about its calls, read back after a change rather than assumed from it.
/// </summary>
public sealed record CallStateResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public required string DeviceId { get; init; }
	public required string Platform { get; init; }

	public IReadOnlyList<PhoneCall> Calls { get; init; } = [];
}

public static class BiometricActions
{
	/// <summary>A scan the device accepts, unlocking whatever was waiting on it.</summary>
	public const string Match = "match";

	/// <summary>A scan the device rejects, which is the path apps handle worst.</summary>
	public const string NoMatch = "nomatch";

	public static IReadOnlyList<string> All { get; } = [Match, NoMatch];
}

/// <summary>
/// A simulated fingerprint or face scan.
/// </summary>
public sealed record BiometricRequest
{
	/// <summary>One of the values in <see cref="BiometricActions"/>.</summary>
	public required string Action { get; init; }

	/// <summary>
	/// Which enrolled finger to present, where the platform tracks more than one. Ignored on iOS,
	/// which has no equivalent.
	/// </summary>
	public int? FingerId { get; init; }
}

/// <summary>
/// The outcome of a simulated scan.
/// </summary>
public sealed record BiometricResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public required string DeviceId { get; init; }
	public required string Platform { get; init; }
	public required string Action { get; init; }

	/// <summary>
	/// True only where the platform actually answered for the scan. iOS posts the event into a
	/// notification bus that reports nothing back, so a scan there is indistinguishable from one
	/// that reached no listener -- confirm it by looking at the app.
	/// </summary>
	public bool Confirmed { get; init; }
}

/// <summary>
/// Text to place on the device's pasteboard.
/// </summary>
public sealed record ClipboardRequest
{
	public required string Text { get; init; }
}

/// <summary>
/// The device's pasteboard.
/// </summary>
public sealed record ClipboardResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public required string DeviceId { get; init; }
	public required string Platform { get; init; }

	public required string Text { get; init; }
}

/// <summary>
/// Files to place in the device's photo library.
/// </summary>
public sealed record MediaRequest
{
	/// <summary>Paths on this machine. Images and videos on both platforms; iOS also takes vCards.</summary>
	public required IReadOnlyList<string> HostPaths { get; init; }
}

/// <summary>
/// What reached the library.
/// </summary>
public sealed record MediaResult
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public required string DeviceId { get; init; }
	public required string Platform { get; init; }

	/// <summary>The host paths that were accepted.</summary>
	public IReadOnlyList<string> Added { get; init; } = [];
}
