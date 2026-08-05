using System.Runtime.InteropServices;
using System.Text.Json;
using MobileCanvas.Contracts;
using MobileCanvas.Core;

namespace MobileCanvas.iOS;

internal static class SimctlCatalogParser
{
	private const string Provider = "core-simulator";

	public static DeviceCatalog Parse(string json)
	{
		using var document = JsonDocument.Parse(json);
		var root = document.RootElement;
		var runtimes = ParseRuntimes(root);
		var deviceTypes = ParseDeviceTypes(root);
		var runtimeById = runtimes.ToDictionary(runtime => runtime.Id, StringComparer.Ordinal);
		var typeById = deviceTypes.ToDictionary(type => type.Id, StringComparer.Ordinal);

		return new DeviceCatalog
		{
			Devices = ParseDevices(root, runtimeById, typeById),
			Runtimes = runtimes,
			DeviceTypes = deviceTypes,
		};
	}

	private static DeviceRuntime[] ParseRuntimes(JsonElement root)
	{
		if (!root.TryGetProperty("runtimes", out var runtimesElement))
			return [];

		return runtimesElement.EnumerateArray()
			.Where(IsIosRuntime)
			.Select(runtime =>
			{
				var supportedTypes = runtime.TryGetProperty("supportedDeviceTypes", out var types)
					? types.EnumerateArray()
						.Select(type => GetString(type, "identifier"))
						.Where(id => id is not null)
						.Cast<string>()
						.ToArray()
					: [];
				var architectures = runtime.TryGetProperty("supportedArchitectures", out var values)
					? values.EnumerateArray()
						.Select(value => value.GetString())
						.Where(value => value is not null)
						.Cast<string>()
						.ToArray()
					: [];

				return new DeviceRuntime
				{
					Id = GetString(runtime, "identifier") ?? "",
					Name = GetString(runtime, "name") ?? "",
					Version = GetString(runtime, "version") ?? "",
					Platform = DevicePlatforms.Ios,
					IsAvailable = GetBoolean(runtime, "isAvailable", defaultValue: true),
					SupportedArchitectures = architectures,
					SupportedDeviceTypeIds = supportedTypes,
				};
			})
			.Where(runtime => runtime.Id.Length > 0)
			.DistinctBy(runtime => runtime.Id, StringComparer.Ordinal)
			.OrderByDescending(runtime => ParseVersion(runtime.Version))
			.ToArray();
	}

	private static bool IsIosRuntime(JsonElement runtime)
	{
		var platform = GetString(runtime, "platform");
		if (!string.IsNullOrWhiteSpace(platform))
			return platform.Equals("iOS", StringComparison.OrdinalIgnoreCase);

		return GetString(runtime, "identifier")
			?.Contains(".iOS-", StringComparison.OrdinalIgnoreCase) == true;
	}

	private static DeviceType[] ParseDeviceTypes(JsonElement root)
	{
		if (!root.TryGetProperty("devicetypes", out var deviceTypesElement))
			return [];

		return deviceTypesElement.EnumerateArray()
			.Select(type => new DeviceType
			{
				Id = GetString(type, "identifier") ?? "",
				Name = GetString(type, "name") ?? "",
				Platform = DevicePlatforms.Ios,
				ProductFamily = GetString(type, "productFamily"),
				ModelIdentifier = GetString(type, "modelIdentifier"),
				MinimumRuntimeVersion = GetString(type, "minRuntimeVersionString"),
				MaximumRuntimeVersion = GetString(type, "maxRuntimeVersionString"),
			})
			.Where(type => type.Id.Length > 0)
			.OrderBy(type => type.Name, StringComparer.OrdinalIgnoreCase)
			.ToArray();
	}

	private static DeviceTarget[] ParseDevices(
		JsonElement root,
		IReadOnlyDictionary<string, DeviceRuntime> runtimes,
		IReadOnlyDictionary<string, DeviceType> deviceTypes)
	{
		if (!root.TryGetProperty("devices", out var devicesElement))
			return [];

		var devices = new List<DeviceTarget>();
		foreach (var runtimeGroup in devicesElement.EnumerateObject())
		{
			runtimes.TryGetValue(runtimeGroup.Name, out var runtime);
			foreach (var device in runtimeGroup.Value.EnumerateArray())
			{
				var udid = GetString(device, "udid");
				if (string.IsNullOrWhiteSpace(udid))
					continue;

				var typeId = GetString(device, "deviceTypeIdentifier");
				deviceTypes.TryGetValue(typeId ?? "", out var deviceType);
				devices.Add(new DeviceTarget
				{
					Id = DeviceIdentity.Create(DevicePlatforms.Ios, Provider, udid),
					Platform = DevicePlatforms.Ios,
					Provider = Provider,
					NativeId = udid,
					Udid = udid,
					Name = GetString(device, "name") ?? udid,
					State = NormalizeState(GetString(device, "state")),
					IsAvailable = GetBoolean(device, "isAvailable", defaultValue: true),
					RuntimeId = runtimeGroup.Name,
					RuntimeName = runtime?.Name,
					OsVersion = runtime?.Version,
					DeviceTypeId = typeId,
					DeviceTypeName = deviceType?.Name,
					ModelIdentifier = deviceType?.ModelIdentifier,
					Architecture = ResolveArchitecture(runtime?.SupportedArchitectures ?? []),
					DeviceSet = "default",
					Capabilities = CreateCapabilities(),
				});
			}
		}

		return devices
			.OrderByDescending(device => device.State == DeviceStates.Booted)
			.ThenBy(device => device.Name, StringComparer.OrdinalIgnoreCase)
			.ToArray();
	}

	private static DeviceCapabilities CreateCapabilities() => new()
	{
		Boot = true,
		Shutdown = true,
		Restart = true,
		Erase = true,
		Delete = true,
		Reveal = true,
		Tap = true,
		LongPress = true,
		Swipe = true,
		Scroll = true,
		Text = true,
		Key = true,
		Button = true,
		Rotate = true,
		Screenshot = true,
		LiveStream = true,
		Recording = true,
	};

	private static string NormalizeState(string? state) => state?.ToLowerInvariant() switch
	{
		"booted" => DeviceStates.Booted,
		"shutdown" => DeviceStates.Shutdown,
		"creating" or "booting" => DeviceStates.Booting,
		"shutting down" => DeviceStates.ShuttingDown,
		_ => DeviceStates.Unknown,
	};

	private static string? ResolveArchitecture(string[] architectures)
	{
		var current = RuntimeInformation.ProcessArchitecture switch
		{
			Architecture.Arm64 => "arm64",
			Architecture.X64 => "x86_64",
			_ => null,
		};
		return current is not null && architectures.Contains(current, StringComparer.OrdinalIgnoreCase)
			? current
			: architectures.FirstOrDefault();
	}

	private static Version ParseVersion(string value) =>
		Version.TryParse(value, out var parsed) ? parsed : new Version();

	private static string? GetString(JsonElement element, string propertyName) =>
		element.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.String
			? property.GetString()
			: null;

	private static bool GetBoolean(JsonElement element, string propertyName, bool defaultValue) =>
		element.TryGetProperty(propertyName, out var property) &&
		(property.ValueKind == JsonValueKind.True || property.ValueKind == JsonValueKind.False)
			? property.GetBoolean()
			: defaultValue;
}
