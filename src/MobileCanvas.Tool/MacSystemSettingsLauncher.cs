using MobileCanvas.Contracts;
using MobileCanvas.Core;

namespace MobileCanvas.Tool;

internal sealed class MacSystemSettingsLauncher(IProcessRunner processRunner)
{
	private const string ScreenRecordingUri =
		"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
	private const string AccessibilityUri =
		"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

	public Task OpenAsync(string target, CancellationToken cancellationToken) =>
		OpenAsync(target, OperatingSystem.IsMacOS(), cancellationToken);

	internal async Task OpenAsync(
		string target,
		bool isMacOS,
		CancellationToken cancellationToken)
	{
		if (!isMacOS)
			throw new NotSupportedException("System Settings links are available only on macOS.");

		var request = CreateRequest(target);
		var result = await processRunner.RunAsync(request, cancellationToken).ConfigureAwait(false);
		if (result.ExitCode != 0)
			throw new ProcessExecutionException(request.FileName, request.Arguments, result);
	}

	internal static ProcessRequest CreateRequest(string target)
	{
		var uri = target switch
		{
			SystemSettingsTargets.ScreenRecording => ScreenRecordingUri,
			SystemSettingsTargets.Accessibility => AccessibilityUri,
			_ => throw new ArgumentException(
				$"Unknown System Settings target '{target}'.",
				nameof(target)),
		};
		return new ProcessRequest("/usr/bin/open", [uri]);
	}
}
