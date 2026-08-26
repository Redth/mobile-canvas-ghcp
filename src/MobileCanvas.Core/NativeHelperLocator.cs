namespace MobileCanvas.Core;

/// <summary>Locates the bundled native helper shared by iOS capture/input and Android encoding.</summary>
public static class NativeHelperLocator
{
	public const string ExecutableName = "mobile-screencap";
	public const string PathVariable = "MOBILE_CANVAS_SCREENCAP_PATH";

	private static readonly Lazy<string?> ResolvedPath = new(
		() => OperatingSystem.IsMacOS()
			? Resolve(AppContext.BaseDirectory, Environment.GetEnvironmentVariable(PathVariable))
			: null,
		isThreadSafe: true);

	public static string? Path => ResolvedPath.Value;

	public static bool IsAvailable => OperatingSystem.IsMacOS() && Path is not null;

	internal static string? Resolve(string baseDirectory, string? configuredPath)
	{
		if (!string.IsNullOrWhiteSpace(configuredPath) && File.Exists(configuredPath))
			return System.IO.Path.GetFullPath(configuredPath);

		string[] candidates =
		[
			System.IO.Path.Combine(baseDirectory, ExecutableName),
			System.IO.Path.Combine(baseDirectory, "native", ExecutableName),
			System.IO.Path.Combine(baseDirectory, "runtimes", "native", ExecutableName),
			System.IO.Path.Combine(baseDirectory, "bin", ExecutableName),
		];

		foreach (var candidate in candidates)
		{
			if (File.Exists(candidate))
				return System.IO.Path.GetFullPath(candidate);
		}

		var directory = new DirectoryInfo(baseDirectory);
		for (var depth = 0; depth < 10 && directory is not null; depth++, directory = directory.Parent)
		{
			var developmentPath = System.IO.Path.Combine(
				directory.FullName,
				"native",
				ExecutableName,
				"out",
				ExecutableName);
			if (File.Exists(developmentPath))
				return System.IO.Path.GetFullPath(developmentPath);
		}

		return null;
	}
}
