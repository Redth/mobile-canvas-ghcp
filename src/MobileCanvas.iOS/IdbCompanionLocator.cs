namespace MobileCanvas.iOS;

internal static class IdbCompanionLocator
{
	private static readonly string[] KnownPaths =
	[
		"/opt/homebrew/bin/idb_companion",
		"/usr/local/bin/idb_companion",
	];

	public static string? Find()
	{
		foreach (var environmentVariable in new[] { "MOBILE_CANVAS_IDB_COMPANION", "IDB_COMPANION_PATH" })
		{
			var configured = Environment.GetEnvironmentVariable(environmentVariable);
			if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured))
				return Path.GetFullPath(configured);
		}

		var pathValue = Environment.GetEnvironmentVariable("PATH");
		if (!string.IsNullOrWhiteSpace(pathValue))
		{
			foreach (var directory in pathValue.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
			{
				var candidate = Path.Combine(directory, "idb_companion");
				if (File.Exists(candidate))
					return candidate;
			}
		}

		return KnownPaths.FirstOrDefault(File.Exists);
	}
}
