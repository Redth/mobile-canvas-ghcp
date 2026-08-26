using MobileCanvas.Core;

namespace MobileCanvas.iOS;

internal static class XcodeDeveloperDirectory
{
	public static async Task<string> ResolveSelectedAsync(
		IProcessRunner processRunner,
		CancellationToken cancellationToken)
	{
		var configured = Environment.GetEnvironmentVariable("DEVELOPER_DIR");
		if (!string.IsNullOrWhiteSpace(configured))
			return Path.GetFullPath(configured);

		var result = await processRunner.RunAsync(
			new ProcessRequest("xcode-select", ["-p"]),
			cancellationToken).ConfigureAwait(false);
		if (result.ExitCode != 0)
			throw new ProcessExecutionException("xcode-select", ["-p"], result);

		var developerDirectory = result.StandardOutput.Trim();
		if (developerDirectory.Length == 0)
			throw new InvalidOperationException("xcode-select returned an empty developer directory.");
		return Path.GetFullPath(developerDirectory);
	}
}
