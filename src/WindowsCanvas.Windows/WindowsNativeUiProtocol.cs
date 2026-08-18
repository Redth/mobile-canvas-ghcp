using System.Text.Json.Serialization;
using WindowsCanvas.Contracts;

namespace WindowsCanvas.Windows;

// These envelopes exist only on the managed/native process boundary. Keeping them out of
// WindowsCanvas.Contracts prevents a raw HWND field from becoming part of an API, CLI, MCP, or
// other public JSON vocabulary.
internal sealed record WindowsNativeUiSnapshotRequest
{
	public int SchemaVersion { get; init; } = WindowsCanvasProtocol.HelperSchemaVersion;
	public long Handle { get; init; }
	public WindowsUiSnapshotRequest Request { get; init; } = new();
}

internal sealed record WindowsNativeUiFindRequest
{
	public int SchemaVersion { get; init; } = WindowsCanvasProtocol.HelperSchemaVersion;
	public long Handle { get; init; }
	public WindowsUiQuery Query { get; init; } = new();
}

internal sealed record WindowsNativeUiActionRequest
{
	public int SchemaVersion { get; init; } = WindowsCanvasProtocol.HelperSchemaVersion;
	public long Handle { get; init; }
	public WindowsUiActionRequest Request { get; init; } = new();
}

internal sealed record WindowsNativeUiWaitRequest
{
	public int SchemaVersion { get; init; } = WindowsCanvasProtocol.HelperSchemaVersion;
	public long Handle { get; init; }
	public WindowsUiWaitRequest Request { get; init; } = new();
}

[JsonSourceGenerationOptions(
	PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
	DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
	WriteIndented = false)]
[JsonSerializable(typeof(WindowsNativeUiSnapshotRequest))]
[JsonSerializable(typeof(WindowsNativeUiFindRequest))]
[JsonSerializable(typeof(WindowsNativeUiActionRequest))]
[JsonSerializable(typeof(WindowsNativeUiWaitRequest))]
internal partial class WindowsNativeUiJsonContext : JsonSerializerContext;
