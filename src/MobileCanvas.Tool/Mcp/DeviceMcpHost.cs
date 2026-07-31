using System.Reflection;
using System.Text.Json;
using MobileCanvas.Contracts;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ModelContextProtocol;
using ModelContextProtocol.Server;

namespace MobileCanvas.Tool;

internal static class DeviceMcpHost
{
	/// <summary>
	/// Mobile Canvas contract types chained ahead of the MCP SDK's own source-generated
	/// context. Under Native AOT reflection-based serialization is disabled, so the
	/// server cannot start unless both resolvers are present: ours for tool payloads
	/// and the SDK's for protocol types such as <c>ContentBlock[]</c>.
	/// </summary>
	internal static readonly JsonSerializerOptions ToolSerializerOptions = CreateToolSerializerOptions();

	private static JsonSerializerOptions CreateToolSerializerOptions()
	{
		var options = new JsonSerializerOptions(McpJsonUtilities.DefaultOptions);
		options.TypeInfoResolverChain.Insert(0, DeviceJsonContext.Default);
		options.MakeReadOnly();
		return options;
	}

	public static async Task RunAsync(CancellationToken cancellationToken = default)
	{
		var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";
		var builder = Host.CreateApplicationBuilder([]);
		builder.Logging.ClearProviders();
		builder.Logging.AddConsole(options =>
			options.LogToStandardErrorThreshold = LogLevel.Trace);
		builder.Services.AddSingleton<DeviceHostClient>();
		builder.Services
			.AddMcpServer(options =>
			{
				options.ServerInfo = new()
				{
					Name = "mobile-canvas",
					Version = version,
				};
			})
			.WithStdioServerTransport()
			.WithTools<DeviceDiscoveryTools>(ToolSerializerOptions)
			.WithTools<DeviceLifecycleTools>(ToolSerializerOptions)
			.WithTools<DeviceInteractionTools>(ToolSerializerOptions)
			.WithTools<DeviceUiTools>(ToolSerializerOptions)
			.WithTools<DeviceAppTools>(ToolSerializerOptions)
			.WithTools<DeviceDiagnosticsTools>(ToolSerializerOptions)
			.WithTools<DeviceMediaTools>(ToolSerializerOptions);
		await builder.Build().RunAsync(cancellationToken).ConfigureAwait(false);
	}
}
