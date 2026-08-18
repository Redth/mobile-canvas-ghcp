using System.Text.Json;
using MobileCanvas.Contracts;

namespace MobileCanvas.Tool;

internal static class DevicePaths
{
	public static string Home { get; } = Path.Combine(
		Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
		".mobile-canvas");

	public static string HostHome { get; } = HostDirectoryFor(Home, MobileCanvasProtocol.Version);
	public static string Metadata => Path.Combine(HostHome, "host.json");
	public static string Lock => Path.Combine(HostHome, "host.lock");

	internal static string HostDirectoryFor(string home, string protocolVersion) =>
		Path.Combine(home, "hosts", $"v{protocolVersion}");

	internal static string HostsDirectoryFor(string home) => Path.Combine(home, "hosts");

	/// <summary>
	/// Every directory the host keeps private state in, outermost first. Creating them in this
	/// order means a child is never created under a parent that is still world-readable.
	/// </summary>
	internal static IEnumerable<string> PrivateDirectoriesFor(string home, string protocolVersion)
	{
		yield return home;
		yield return HostsDirectoryFor(home);
		yield return HostDirectoryFor(home, protocolVersion);
	}

	public static void EnsureHome()
	{
		foreach (var directory in PrivateDirectoriesFor(Home, MobileCanvasProtocol.Version))
			HostFileSecurity.CreatePrivateDirectory(directory);
	}

	/// <summary>
	/// Opens the singleton lock, which is also what proves a host already owns this protocol
	/// version. Both the host and the client take it, so the file's protection lives here rather
	/// than in whichever process happened to create it first.
	/// </summary>
	public static FileStream OpenSingletonLock()
	{
		EnsureHome();
		return HostFileSecurity.OpenPrivateFile(
			Lock,
			FileMode.OpenOrCreate,
			FileAccess.ReadWrite,
			FileShare.None);
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
		// The metadata carries the control token, so the temporary file is restricted before the
		// token is written into it rather than after the bytes are already on disk.
		using (var stream = HostFileSecurity.OpenPrivateFile(
			temporaryPath,
			FileMode.Create,
			FileAccess.Write,
			FileShare.None))
		{
			JsonSerializer.Serialize(stream, metadata, DeviceJsonContext.Default.HostMetadata);
		}
		File.Move(temporaryPath, DevicePaths.Metadata, overwrite: true);
		// A rename carries the source file's own descriptor, but an older host may have left
		// metadata behind with inherited permissions, so the destination is repaired as well.
		HostFileSecurity.ProtectExistingFile(DevicePaths.Metadata);
	}

	public void DeleteIfOwnedBy(int processId)
	{
		var metadata = TryRead();
		if (metadata?.ProcessId == processId && File.Exists(DevicePaths.Metadata))
			File.Delete(DevicePaths.Metadata);
	}
}
