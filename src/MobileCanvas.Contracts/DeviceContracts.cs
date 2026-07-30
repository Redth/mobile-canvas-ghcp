namespace MobileCanvas.Contracts;

public static class MobileCanvasProtocol
{
	public const string Version = "1.0";
}

public static class DevicePlatforms
{
	public const string Ios = "ios";
	public const string Android = "android";
}

public static class DeviceStates
{
	public const string Booted = "booted";
	public const string Shutdown = "shutdown";
	public const string Booting = "booting";
	public const string ShuttingDown = "shutting-down";
	public const string Unknown = "unknown";
}

public sealed record DeviceCapabilities
{
	public bool Boot { get; init; }
	public bool Shutdown { get; init; }
	public bool Restart { get; init; }
	public bool Erase { get; init; }
	public bool Delete { get; init; }
	public bool Reveal { get; init; }
	public bool Tap { get; init; }
	public bool LongPress { get; init; }
	public bool Swipe { get; init; }
	public bool Scroll { get; init; }
	public bool Text { get; init; }
	public bool Key { get; init; }
	public bool Button { get; init; }
	public bool Rotate { get; init; }
	public bool Screenshot { get; init; }
	public bool LiveStream { get; init; }
	public bool Recording { get; init; }
}

public sealed record DisplayGeometry
{
	public int PixelWidth { get; init; }
	public int PixelHeight { get; init; }
	public double PointWidth { get; init; }
	public double PointHeight { get; init; }
	public double Scale { get; init; }
	public string Orientation { get; init; } = "portrait";
}

public sealed record DeviceTarget
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public string Id { get; init; } = "";
	public string Platform { get; init; } = "";
	public string Provider { get; init; } = "";
	public string NativeId { get; init; } = "";
	public string? Udid { get; init; }
	public string Name { get; init; } = "";
	public string State { get; init; } = DeviceStates.Unknown;
	public bool IsAvailable { get; init; }
	public bool IsVirtual { get; init; } = true;
	public string? RuntimeId { get; init; }
	public string? RuntimeName { get; init; }
	public string? OsVersion { get; init; }
	public string? DeviceTypeId { get; init; }
	public string? DeviceTypeName { get; init; }
	public string? ModelIdentifier { get; init; }
	public string? Architecture { get; init; }
	public string? DeviceSet { get; init; }
	public DisplayGeometry? Display { get; init; }
	public DeviceCapabilities Capabilities { get; init; } = new();
}

public sealed record DeviceRuntime
{
	public string Id { get; init; } = "";
	public string Name { get; init; } = "";
	public string Version { get; init; } = "";
	public string Platform { get; init; } = "";
	public bool IsAvailable { get; init; }
	public string[] SupportedArchitectures { get; init; } = [];
	public string[] SupportedDeviceTypeIds { get; init; } = [];
}

public sealed record DeviceType
{
	public string Id { get; init; } = "";
	public string Name { get; init; } = "";
	public string Platform { get; init; } = "";
	public string? ProductFamily { get; init; }
	public string? ModelIdentifier { get; init; }
	public string? MinimumRuntimeVersion { get; init; }
	public string? MaximumRuntimeVersion { get; init; }
}

public sealed record DependencyCheck
{
	public string Name { get; init; } = "";
	public string Status { get; init; } = "";
	public string Message { get; init; } = "";
	public string? Path { get; init; }
	public string? Version { get; init; }
}

public sealed record HostDiagnostics
{
	public string Platform { get; init; } = "";
	public bool Ready { get; init; }
	public DependencyCheck[] Checks { get; init; } = [];
}

public sealed record DeviceCatalog
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public DeviceTarget[] Devices { get; init; } = [];
	public DeviceRuntime[] Runtimes { get; init; } = [];
	public DeviceType[] DeviceTypes { get; init; } = [];
	public HostDiagnostics[] Diagnostics { get; init; } = [];
}

public sealed record CreateDeviceRequest
{
	public string Platform { get; init; } = DevicePlatforms.Ios;
	public string Name { get; init; } = "";
	public string RuntimeId { get; init; } = "";
	public string DeviceTypeId { get; init; } = "";
}

public sealed record TapRequest
{
	public double X { get; init; }
	public double Y { get; init; }
	public double Duration { get; init; }
}

public sealed record SwipeRequest
{
	public double StartX { get; init; }
	public double StartY { get; init; }
	public double EndX { get; init; }
	public double EndY { get; init; }
	public double Duration { get; init; } = 0.35;
}

/// <summary>
/// A single point in a continuous gesture. Streaming down/move/up lets the device animate while
/// the user is still dragging, instead of replaying the whole gesture after it ends.
/// </summary>
public sealed record TouchRequest
{
	public double X { get; init; }
	public double Y { get; init; }
	public string Phase { get; init; } = TouchPhases.Move;
}

public static class TouchPhases
{
	public const string Down = "down";
	public const string Move = "move";
	public const string Up = "up";
}

public sealed record TextInputRequest
{
	public string Text { get; init; } = "";
}

public sealed record KeyInputRequest
{
	public ulong KeyCode { get; init; }
}

public sealed record ButtonInputRequest
{
	public string Button { get; init; } = "";
}

public sealed record RotateRequest
{
	public string Orientation { get; init; } = "portrait";
}

/// <summary>
/// A single agent-driven input, broadcast to canvas clients so the UI can show a cursor tracking
/// whatever is remotely driving the device.
///
/// Coordinates are logical points in the device's own coordinate space, matching every other input
/// contract. The canvas converts them to element space, so the overlay stays correct at any panel
/// size or stream scale.
/// </summary>
public sealed record AutomationEvent
{
	public string Kind { get; init; } = "";
	public string DeviceId { get; init; } = "";

	/// <summary>Where the gesture begins, in logical points. Absent for non-positional input.</summary>
	public double? X { get; init; }
	public double? Y { get; init; }

	/// <summary>Where a swipe or drag ends, in logical points.</summary>
	public double? EndX { get; init; }
	public double? EndY { get; init; }

	/// <summary>Gesture length in seconds, so the cursor animation matches the real gesture.</summary>
	public double? Duration { get; init; }

	/// <summary>Human-readable detail for the status pill, such as a button name or typed text.</summary>
	public string? Detail { get; init; }
}

public static class AutomationEventKinds
{
	public const string Tap = "tap";
	public const string LongPress = "long-press";
	public const string Swipe = "swipe";
	public const string Touch = "touch";
	public const string Text = "text";
	public const string Key = "key";
	public const string Button = "button";
	public const string Rotate = "rotate";
	public const string Screenshot = "screenshot";
}

public sealed record StreamOptions
{
	public int FramesPerSecond { get; init; } = 30;
	public double Scale { get; init; } = 1;
	public double CompressionQuality { get; init; } = 0.75;

	/// <summary>
	/// Upper bound handed to idb's H.264 rate controller. Leaving this at zero makes idb fall back to
	/// a starvation-level default: measured against a simulator running full-screen app transitions it
	/// produced 589 kbit/s and dropped to 18.6 FPS, which is what makes animation smear and take
	/// seconds to recover. Raising the ceiling let the same scene reach 3.3 Mbit/s at 28.4 FPS. The
	/// encoder self-regulates well below this value (asking for 20 Mbit/s still only produced
	/// 3.4 Mbit/s), so this is a ceiling that keeps the rate controller out of the way rather than a
	/// target, and the stream stays cheap because it never leaves loopback.
	/// </summary>
	public double AverageBitrate { get; init; } = 12_000_000;

	public double KeyFrameRate { get; init; } = 1;
}

public sealed record StreamDescriptor
{
	public string Encoding { get; init; } = "h264-annexb";
	public int FramesPerSecond { get; init; }
	public double Scale { get; init; }
	public DisplayGeometry Display { get; init; } = new();

	/// <summary>
	/// Which capture backend produced this stream, so a degraded fallback is visible instead of
	/// just looking worse.
	/// </summary>
	public string Source { get; init; } = "unknown";

	/// <summary>
	/// Why the preferred backend could not be used, when the stream fell back.
	/// </summary>
	public string? SourceDetail { get; init; }
}

public sealed record RecordingStartRequest
{
	public string? OutputPath { get; init; }
	public int TimeoutSeconds { get; init; } = 180;
}

public sealed record RecordingStatus
{
	public string DeviceId { get; init; } = "";
	public bool IsRecording { get; init; }
	public string? OutputPath { get; init; }
	public DateTimeOffset? StartedAt { get; init; }
	public int? TimeoutSeconds { get; init; }
}

public sealed record MediaArtifact
{
	public string Path { get; init; } = "";
	public string MimeType { get; init; } = "";
	public long Bytes { get; init; }
	public DateTimeOffset CreatedAt { get; init; }
}

public sealed record CanvasOpenRequest
{
	public string SessionId { get; init; } = "";
	public string InstanceId { get; init; } = "";
}

public sealed record CanvasContextKey(string SessionId, string InstanceId);

public sealed record CanvasOpenResult
{
	public string Url { get; init; } = "";
	public string Title { get; init; } = "Mobile Device";
}

public sealed record CanvasBootstrapRequest
{
	public string Secret { get; init; } = "";
	public string SessionId { get; init; } = "";
	public string InstanceId { get; init; } = "";
}

public sealed record CanvasCloseRequest
{
	public string SessionId { get; init; } = "";
	public string InstanceId { get; init; } = "";
}

public sealed record SelectDeviceRequest
{
	public string DeviceId { get; init; } = "";
}

public sealed record ConfirmedOperationRequest
{
	public bool Confirm { get; init; }
}

/// <summary>
/// The device a single canvas instance currently controls. A canvas that has not chosen a device yet is a normal
/// state rather than an error, so <see cref="HasSelection"/> is reported explicitly instead of returning a bare null.
/// </summary>
public sealed record DeviceSelection
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public bool HasSelection { get; init; }
	public DeviceTarget? Device { get; init; }

	public static readonly DeviceSelection None = new();

	public static DeviceSelection For(DeviceTarget? device) =>
		device is null ? None : new DeviceSelection { HasSelection = true, Device = device };
}

public sealed record ApiError
{
	public string Code { get; init; } = "";
	public string Message { get; init; } = "";
}

public sealed record OperationResult
{
	public bool Success { get; init; } = true;
	public string Operation { get; init; } = "";
	public string? DeviceId { get; init; }
}

public sealed record HostMetadata
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public int ProcessId { get; init; }
	public int Port { get; init; }
	public string ControlToken { get; init; } = "";
	public string Version { get; init; } = "";
	public DateTimeOffset StartedAt { get; init; }
}

public sealed record HostHealth
{
	public string Status { get; init; } = "ok";
	public string Version { get; init; } = "";
	public int ProcessId { get; init; }
}
