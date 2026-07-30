using System.Text.Json;
using MobileCanvas.Contracts;

namespace MobileCanvas.Tool;

internal static class DevicePaths
{
	public static string Home { get; } = Path.Combine(
		Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
		".mobile-canvas");

	public static string Metadata => Path.Combine(Home, "host.json");
	public static string Lock => Path.Combine(Home, "host.lock");

	public static void EnsureHome()
	{
		Directory.CreateDirectory(Home);
		if (!OperatingSystem.IsWindows())
		{
			File.SetUnixFileMode(
				Home,
				UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
		}
	}
}

internal sealed class HostMetadataStore
{
	public HostMetadata? TryRead()
	{
		try
		{
			if (!File.Exists(DevicePaths.Metadata))
				return null;
			using var stream = File.OpenRead(DevicePaths.Metadata);
			return JsonSerializer.Deserialize(stream, DeviceJsonContext.Default.HostMetadata);
		}
		catch (IOException)
		{
			return null;
		}
		catch (JsonException)
		{
			return null;
		}
	}

	public void Write(HostMetadata metadata)
	{
		DevicePaths.EnsureHome();
		var temporaryPath = $"{DevicePaths.Metadata}.{Environment.ProcessId}.tmp";
		using (var stream = new FileStream(
			temporaryPath,
			FileMode.Create,
			FileAccess.Write,
			FileShare.None))
		{
			JsonSerializer.Serialize(stream, metadata, DeviceJsonContext.Default.HostMetadata);
		}
		if (!OperatingSystem.IsWindows())
		{
			File.SetUnixFileMode(
				temporaryPath,
				UnixFileMode.UserRead | UnixFileMode.UserWrite);
		}
		File.Move(temporaryPath, DevicePaths.Metadata, overwrite: true);
	}

	public void DeleteIfOwnedBy(int processId)
	{
		var metadata = TryRead();
		if (metadata?.ProcessId == processId && File.Exists(DevicePaths.Metadata))
			File.Delete(DevicePaths.Metadata);
	}
}
