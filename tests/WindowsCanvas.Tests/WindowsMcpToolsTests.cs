using System.Reflection;
using System.Text.Json;
using MobileCanvas.Tool;
using WindowsCanvas.Contracts;

namespace WindowsCanvas.Tests;

public sealed class WindowsMcpToolsTests
{
	[Fact]
	public void SemanticWindowsTools_UseTheRequiredNamespaceAndSafeDescriptions()
	{
		var names = ToolNames(typeof(WindowsUiTools));

		Assert.Equal(
			new[]
			{
				"windows_app_ui_dump",
				"windows_app_ui_find",
				"windows_app_ui_act",
				"windows_app_ui_wait",
			}.OrderBy(name => name),
			names.Select(tool => tool.Name).OrderBy(name => name));
		foreach (var tool in names)
		{
			var description = tool.Method.GetCustomAttribute<System.ComponentModel.DescriptionAttribute>();
			Assert.NotNull(description);
			Assert.Contains("semantic", description!.Description, StringComparison.OrdinalIgnoreCase);
			Assert.DoesNotContain("HWND", description.Description, StringComparison.OrdinalIgnoreCase);
		}
	}

	[Fact]
	public void VisualWindowsTools_SayCoordinatesNeedATokenAndThatSemanticComesFirst()
	{
		var names = ToolNames(typeof(WindowsVisualTools));

		Assert.Equal(
			new[]
			{
				"windows_app_screenshot",
				"windows_app_click",
				"windows_app_drag",
				"windows_app_wheel",
				"windows_app_key",
				"windows_app_type_text",
				"windows_app_geometry",
			}.OrderBy(name => name),
			names.Select(tool => tool.Name).OrderBy(name => name));

		foreach (var tool in names)
		{
			var description = tool.Method
				.GetCustomAttribute<System.ComponentModel.DescriptionAttribute>();
			Assert.NotNull(description);
			// An agent reading only the tool list has to learn two things: prefer the semantic
			// tools, and coordinates are worthless without the transform token.
			Assert.Contains(
				"transformVersion",
				description!.Description,
				StringComparison.Ordinal);
			Assert.Contains(
				"windows_app_ui_",
				description.Description,
				StringComparison.Ordinal);
			Assert.DoesNotContain("HWND", description.Description, StringComparison.OrdinalIgnoreCase);
			Assert.DoesNotContain(
				"window handle",
				description.Description,
				StringComparison.OrdinalIgnoreCase);
		}
	}

	[Fact]
	public void ScreenshotArtifactNames_CannotEscapeTheArtifactsDirectory()
	{
		var name = WindowsCli.CreateScreenshotFileName(
			"win_../../etc/passwd",
			new DateTimeOffset(2026, 8, 17, 20, 15, 0, TimeSpan.Zero));

		Assert.Equal("windows-win_etcpasswd-20260817-201500.png", name);
		Assert.Equal(name, Path.GetFileName(name));
	}

	private static (System.Reflection.MethodInfo Method, string? Name)[] ToolNames(Type type) =>
		[.. type
			.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)
			.Select(method => new
			{
				Method = method,
				Tool = method.CustomAttributes.SingleOrDefault(attribute =>
					attribute.AttributeType.Name == "McpServerToolAttribute"),
			})
			.Where(item => item.Tool is not null)
			.Select(item => (
				item.Method,
				item.Tool!.NamedArguments
					.Single(argument => argument.MemberName == "Name").TypedValue.Value as string))];

	[Fact]
	public void McpSerializer_ResolvesWindowsUiContractsWithoutReflection()
	{
		var info = DeviceMcpHost.ToolSerializerOptions.GetTypeInfo(typeof(WindowsUiActionResult));
		var json = JsonSerializer.Serialize(
			new WindowsUiActionResult
			{
				Success = true,
				Action = WindowsUiActionKinds.Invoke,
				Metadata = new WindowsUiOperationMetadata { NodeCount = 1 },
			},
			DeviceMcpHost.ToolSerializerOptions);

		Assert.NotNull(info);
		Assert.Contains("\"action\":\"invoke\"", json, StringComparison.Ordinal);
		Assert.Contains("\"nodeCount\":1", json, StringComparison.Ordinal);
	}
}
