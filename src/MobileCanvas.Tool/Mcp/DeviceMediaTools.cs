using System.ComponentModel;
using MobileCanvas.Contracts;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace MobileCanvas.Tool;

[McpServerToolType]
public sealed class DeviceMediaTools(DeviceHostClient client)
{
	[McpServerTool(
		Name = "mobile_device_screenshot",
		Title = "Capture device screenshot",
		ReadOnly = true,
		OpenWorld = false)]
	[Description("Capture a PNG screenshot from a booted device and return it as MCP image content.")]
	public async Task<ContentBlock[]> Screenshot(
		[Description("Provider-qualified device ID.")] string deviceId,
		CancellationToken cancellationToken = default)
	{
		var bytes = await client.ScreenshotAsync(deviceId, cancellationToken).ConfigureAwait(false);
		return
		[
			new TextContentBlock { Text = $"Captured {bytes.Length} byte PNG from {deviceId}." },
			ImageContentBlock.FromBytes(bytes, "image/png"),
		];
	}

	[McpServerTool(
		Name = "mobile_device_recording_start",
		Title = "Start device recording",
		Destructive = false,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description("Start a bounded H.264 MP4 screen recording on a booted device.")]
	public Task<RecordingStatus> StartRecording(
		[Description("Provider-qualified device ID.")] string deviceId,
		[Description("Maximum recording duration in seconds, from 1 through 3600.")] int timeoutSeconds = 180,
		[Description("Optional absolute output path; omit to use the Device Lab artifacts directory.")] string? outputPath = null,
		CancellationToken cancellationToken = default) =>
		client.StartRecordingAsync(
			deviceId,
			new RecordingStartRequest
			{
				TimeoutSeconds = timeoutSeconds,
				OutputPath = outputPath,
			},
			cancellationToken);

	[McpServerTool(
		Name = "mobile_device_recording_stop",
		Title = "Stop device recording",
		Destructive = false,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description("Stop and finalize the active device recording, returning its persistent output path.")]
	public Task<RecordingStatus> StopRecording(
		[Description("Provider-qualified device ID.")] string deviceId,
		CancellationToken cancellationToken = default) =>
		client.StopRecordingAsync(deviceId, cancellationToken);

	[McpServerTool(
		Name = "mobile_device_recording_status",
		Title = "Get recording status",
		ReadOnly = true,
		OpenWorld = false,
		UseStructuredContent = true)]
	[Description("Get current screen-recording status and output metadata for a device.")]
	public Task<RecordingStatus> GetRecordingStatus(
		[Description("Provider-qualified device ID.")] string deviceId,
		CancellationToken cancellationToken = default) =>
		client.GetRecordingStatusAsync(deviceId, cancellationToken);
}
