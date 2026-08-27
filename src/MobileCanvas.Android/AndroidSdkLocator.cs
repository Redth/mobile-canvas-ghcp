using System.Runtime.InteropServices;
using MobileCanvas.Contracts;
using MobileCanvas.Core;

namespace MobileCanvas.Android;

/// <summary>
/// Resolves the Android SDK and the tools we shell out to. Lookup order is explicit environment
/// configuration first, then the platform default location, so a user with a non-standard SDK is
/// never silently pointed at the wrong one.
/// </summary>
internal sealed class AndroidSdkLocator
{
	private readonly Lazy<string?> _sdkRoot;

	internal AndroidSdkLocator() : this(FindSdkRoot)
	{
	}

	internal AndroidSdkLocator(string? sdkRoot) : this(() => sdkRoot)
	{
	}

	private AndroidSdkLocator(Func<string?> findSdkRoot)
	{
		_sdkRoot = new Lazy<string?>(findSdkRoot);
	}

	public string? SdkRoot => _sdkRoot.Value;

	public string? Adb => Resolve(Path.Combine("platform-tools", Executable("adb")));

	public string? Emulator => Resolve(Path.Combine("emulator", Executable("emulator")));

	public string? AvdManager
	{
		get
		{
			if (SdkRoot is null)
				return null;

			// avdmanager moved into cmdline-tools; "latest" is the conventional channel but a
			// versioned directory is equally valid, so both are probed.
			var candidates = new List<string>
			{
				Path.Combine(SdkRoot, "cmdline-tools", "latest", "bin", Script("avdmanager")),
				Path.Combine(SdkRoot, "tools", "bin", Script("avdmanager")),
			};

			var cmdlineTools = Path.Combine(SdkRoot, "cmdline-tools");
			if (Directory.Exists(cmdlineTools))
			{
				foreach (var directory in Directory.EnumerateDirectories(cmdlineTools))
					candidates.Add(Path.Combine(directory, "bin", Script("avdmanager")));
			}

			return candidates.FirstOrDefault(File.Exists);
		}
	}

	public IReadOnlyList<AndroidSystemImage> GetInstalledSystemImages() =>
		SdkRoot is { } root ? FindInstalledSystemImages(root) : [];

	internal static IReadOnlyList<AndroidSystemImage> FindInstalledSystemImages(string sdkRoot)
	{
		var systemImages = Path.Combine(sdkRoot, "system-images");
		if (!Directory.Exists(systemImages))
			return [];

		var results = new List<AndroidSystemImage>();
		foreach (var platformDirectory in EnumerateDirectories(systemImages))
		{
			var platform = Path.GetFileName(platformDirectory);
			if (!platform.StartsWith("android-", StringComparison.OrdinalIgnoreCase))
				continue;

			foreach (var tagDirectory in EnumerateDirectories(platformDirectory))
			{
				var tag = Path.GetFileName(tagDirectory);
				foreach (var architectureDirectory in EnumerateDirectories(tagDirectory))
				{
					var architecture = Path.GetFileName(architectureDirectory);
					results.Add(new AndroidSystemImage(
						$"system-images;{platform};{tag};{architecture}",
						platform["android-".Length..],
						tag,
						architecture));
				}
			}
		}

		return results
			.OrderByDescending(image => ParseVersion(image.Version))
			.ThenBy(image => image.Tag, StringComparer.OrdinalIgnoreCase)
			.ThenBy(image => image.Architecture, StringComparer.OrdinalIgnoreCase)
			.ToArray();
	}

	/// <summary>
	/// The directory the emulator writes per-process discovery files into. This is the join between
	/// an AVD, an adb serial, and a gRPC endpoint, so without it only adb-level control is possible.
	/// </summary>
	public static string? RunningDirectory
	{
		get
		{
			var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
			if (string.IsNullOrEmpty(home))
				return null;

			if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
				return Path.Combine(home, "Library", "Caches", "TemporaryItems", "avd", "running");

			if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
			{
				var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
				return string.IsNullOrEmpty(localAppData)
					? null
					: Path.Combine(localAppData, "Temp", "avd", "running");
			}

			var xdg = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR");
			return string.IsNullOrEmpty(xdg)
				? Path.Combine("/tmp", "avd", "running")
				: Path.Combine(xdg, "avd", "running");
		}
	}

	public DependencyCheck[] Check()
	{
		var checks = new List<DependencyCheck>
		{
			SdkRoot is null
				? new DependencyCheck
				{
					Name = "android-sdk",
					Status = "missing",
					Message = "Android SDK not found. Set ANDROID_HOME or ANDROID_SDK_ROOT.",
				}
				: new DependencyCheck { Name = "android-sdk", Status = "ok", Message = "Android SDK found.", Path = SdkRoot },
		};

		checks.Add(Tool("adb", Adb, "adb not found. Install platform-tools."));
		checks.Add(Tool("emulator", Emulator, "emulator not found. Install the Android Emulator package."));
		checks.Add(Tool("avdmanager", AvdManager, "avdmanager not found. Install cmdline-tools; creating AVDs will be unavailable."));

		var running = RunningDirectory;
		checks.Add(running is not null && Directory.Exists(running)
			? new DependencyCheck { Name = "emulator-discovery", Status = "ok", Message = "Emulator discovery directory found.", Path = running }
			: new DependencyCheck
			{
				Name = "emulator-discovery",
				Status = "warning",
				Message = "No emulator discovery directory yet. It appears once an emulator starts.",
				Path = running,
			});

		return [.. checks];

		static DependencyCheck Tool(string name, string? path, string missingMessage) =>
			path is null
				? new DependencyCheck { Name = name, Status = "missing", Message = missingMessage }
				: new DependencyCheck { Name = name, Status = "ok", Message = $"{name} found.", Path = path };
	}

	private string? Resolve(string relativePath)
	{
		if (SdkRoot is null)
			return null;

		var full = Path.Combine(SdkRoot, relativePath);
		return File.Exists(full) ? full : null;
	}

	private static string Executable(string name) =>
		RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? name + ".exe" : name;

	private static string Script(string name) =>
		RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? name + ".bat" : name;

	private static string? FindSdkRoot()
	{
		foreach (var variable in new[] { "ANDROID_HOME", "ANDROID_SDK_ROOT" })
		{
			var value = Environment.GetEnvironmentVariable(variable);
			if (!string.IsNullOrWhiteSpace(value) && Directory.Exists(value))
				return value;
		}

		var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
		if (string.IsNullOrEmpty(home))
			return null;

		var defaults = RuntimeInformation.IsOSPlatform(OSPlatform.OSX)
			? new[] { Path.Combine(home, "Library", "Android", "sdk") }
			: RuntimeInformation.IsOSPlatform(OSPlatform.Windows)
				? new[] { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Android", "Sdk") }
				: new[] { Path.Combine(home, "Android", "Sdk"), Path.Combine(home, "android-sdk") };

		return defaults.FirstOrDefault(Directory.Exists);
	}

	private static Version ParseVersion(string value) =>
		Version.TryParse(value, out var parsed) ? parsed : new Version();

	private static IEnumerable<string> EnumerateDirectories(string path)
	{
		try
		{
			return Directory.EnumerateDirectories(path).ToArray();
		}
		catch (IOException)
		{
			return [];
		}
		catch (UnauthorizedAccessException)
		{
			return [];
		}
	}
}

internal sealed record AndroidSystemImage(
	string PackageId,
	string Version,
	string Tag,
	string Architecture);

/// <summary>
/// Enumerates configured AVDs and running emulator instances, and joins them to adb serials.
/// </summary>
internal sealed class EmulatorDiscovery(AndroidSdkLocator locator, IProcessRunner processRunner)
{
	public IReadOnlyList<EmulatorInstance> GetRunningInstances()
	{
		var directory = AndroidSdkLocator.RunningDirectory;
		if (directory is null || !Directory.Exists(directory))
			return [];

		var instances = new List<EmulatorInstance>();
		foreach (var file in Directory.EnumerateFiles(directory, "pid_*.ini"))
		{
			string contents;
			try
			{
				contents = File.ReadAllText(file);
			}
			catch (IOException)
			{
				continue;
			}
			catch (UnauthorizedAccessException)
			{
				continue;
			}

			var parsed = EmulatorDiscoveryParser.Parse(contents);
			if (parsed is null)
				continue;

			// The file name is the authoritative pid; the body does not always carry one.
			var name = Path.GetFileNameWithoutExtension(file);
			var pid = name.StartsWith("pid_", StringComparison.Ordinal) &&
				int.TryParse(name.AsSpan(4), out var parsedPid)
				? parsedPid
				: parsed.ProcessId;

			instances.Add(parsed with { ProcessId = pid });
		}

		return instances;
	}

	public async Task<IReadOnlyList<string>> ListAvdsAsync(CancellationToken cancellationToken)
	{
		if (locator.Emulator is null)
			return [];

		var result = await processRunner
			.RunAsync(new ProcessRequest(locator.Emulator, ["-list-avds"]), cancellationToken)
			.ConfigureAwait(false);

		return result.ExitCode == 0 ? EmulatorDiscoveryParser.ParseAvdList(result.StandardOutput) : [];
	}

	public async Task<IReadOnlyList<(string Serial, string State)>> ListAdbDevicesAsync(CancellationToken cancellationToken)
	{
		if (locator.Adb is null)
			return [];

		var result = await processRunner
			.RunAsync(new ProcessRequest(locator.Adb, ["devices"]), cancellationToken)
			.ConfigureAwait(false);

		return result.ExitCode == 0 ? EmulatorDiscoveryParser.ParseAdbDevices(result.StandardOutput) : [];
	}
}
