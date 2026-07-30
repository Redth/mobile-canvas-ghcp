using System.Text.Json;
using MobileCanvas.Contracts;
using MobileCanvas.Tool;
using ModelContextProtocol.Protocol;

namespace MobileCanvas.Tests;

/// <summary>
/// The MCP server runs with reflection-based serialization disabled so it can be
/// published with Native AOT. If the tool serializer options only carry the Device
/// Lab context, the host throws while starting and the stdio transport dies before
/// writing a single frame - a silent hang from the client's point of view. These
/// tests pin the resolver chain that prevents that regression.
/// </summary>
public class McpSerializationTests
{
	[Fact]
	public void ToolSerializerOptions_ResolvesDeviceLabContractTypes()
	{
		var info = DeviceMcpHost.ToolSerializerOptions.GetTypeInfo(typeof(DeviceTarget[]));

		Assert.NotNull(info);
	}

	[Fact]
	public void ToolSerializerOptions_ResolvesMcpProtocolTypes()
	{
		// ContentBlock[] is the payload every tool result is wrapped in. It lives in
		// the MCP SDK's own source-generated context, not ours.
		var info = DeviceMcpHost.ToolSerializerOptions.GetTypeInfo(typeof(ContentBlock[]));

		Assert.NotNull(info);
	}

	[Fact]
	public void ToolSerializerOptions_KeepDeviceLabCamelCaseNaming()
	{
		var target = new DeviceTarget
		{
			Id = "ios:core-simulator:UDID",
			Platform = "ios",
			Provider = "core-simulator",
			NativeId = "UDID",
			Udid = "UDID",
			Name = "iPhone 11 Pro",
			State = "booted",
		};

		var json = JsonSerializer.Serialize(target, DeviceMcpHost.ToolSerializerOptions);

		Assert.Contains("\"schemaVersion\":", json);
		Assert.Contains("\"nativeId\":\"UDID\"", json);
		Assert.DoesNotContain("\"NativeId\"", json);
	}

	[Fact]
	public void ToolSerializerOptions_SerializesMcpContentBlockWithoutReflection()
	{
		ContentBlock[] blocks = [new TextContentBlock { Text = "ok" }];

		var json = JsonSerializer.Serialize(blocks, DeviceMcpHost.ToolSerializerOptions);

		Assert.Contains("\"type\":\"text\"", json);
		Assert.Contains("\"text\":\"ok\"", json);
	}

	[Fact]
	public void DeviceLabContextAlone_CannotResolveMcpProtocolTypes()
	{
		// Guards the tests above from becoming vacuous: passing the Device Lab
		// context's own options straight to WithTools is exactly what broke the
		// AOT MCP server, so that failure mode must stay observable.
		Assert.Throws<NotSupportedException>(
			() => DeviceJsonContext.Default.Options.GetTypeInfo(typeof(ContentBlock[])));
	}
}
