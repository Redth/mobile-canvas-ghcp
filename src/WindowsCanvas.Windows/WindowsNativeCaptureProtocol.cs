using System.Text.Json.Serialization;
using WindowsCanvas.Contracts;

namespace WindowsCanvas.Windows;

// These envelopes exist only on the managed/native process boundary. Keeping them out of
// WindowsCanvas.Contracts is what prevents a raw HWND field from becoming part of an API, CLI,
// MCP, or other public JSON vocabulary.
internal sealed record WindowsNativeScreenshotBody
{
	public double Scale { get; init; } = 1;
	public int MaximumDimension { get; init; }
	public bool IncludeCursor { get; init; }
	public int TimeoutMilliseconds { get; init; } =
		WindowsCaptureLimits.DefaultStartupTimeoutMilliseconds;
}

internal sealed record WindowsNativeScreenshotRequest
{
	public int SchemaVersion { get; init; } = WindowsCanvasProtocol.HelperSchemaVersion;
	public long Handle { get; init; }
	public WindowsNativeScreenshotBody Screenshot { get; init; } = new();
}

internal sealed record WindowsNativeCaptureBody
{
	public int FramesPerSecond { get; init; } = WindowsCaptureLimits.DefaultFramesPerSecond;
	public double Scale { get; init; } = 1;
	public long AverageBitrate { get; init; } = WindowsCaptureLimits.DefaultBitrate;
	public bool IncludeCursor { get; init; }
	public int TimeoutMilliseconds { get; init; } =
		WindowsCaptureLimits.DefaultStartupTimeoutMilliseconds;
}

internal sealed record WindowsNativeCaptureRequest
{
	public int SchemaVersion { get; init; } = WindowsCanvasProtocol.HelperSchemaVersion;
	public long Handle { get; init; }
	public WindowsNativeCaptureBody Capture { get; init; } = new();
}

[JsonSourceGenerationOptions(
	PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
	DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
	WriteIndented = false)]
[JsonSerializable(typeof(WindowsNativeScreenshotRequest))]
[JsonSerializable(typeof(WindowsNativeCaptureRequest))]
internal partial class WindowsNativeCaptureJsonContext : JsonSerializerContext;
