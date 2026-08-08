using MobileCanvas.Contracts;
using MobileCanvas.Core;
using MobileCanvas.Tool;

namespace MobileCanvas.Tests;

public sealed class MacSystemSettingsLauncherTests
{
	[Theory]
	[InlineData(
		SystemSettingsTargets.ScreenRecording,
		"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")]
	[InlineData(
		SystemSettingsTargets.Accessibility,
		"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")]
	public async Task OpenAsync_UsesAllowlistedSystemSettingsUri(string target, string expectedUri)
	{
		var runner = new RecordingProcessRunner(new ProcessResult(0, "", ""));
		var launcher = new MacSystemSettingsLauncher(runner);

		await launcher.OpenAsync(target, isMacOS: true, CancellationToken.None);

		var request = Assert.Single(runner.Requests);
		Assert.Equal("/usr/bin/open", request.FileName);
		Assert.Equal([expectedUri], request.Arguments);
	}

	[Fact]
	public async Task OpenAsync_RejectsUnknownTargets()
	{
		var runner = new RecordingProcessRunner(new ProcessResult(0, "", ""));
		var launcher = new MacSystemSettingsLauncher(runner);

		var error = await Assert.ThrowsAsync<ArgumentException>(
			() => launcher.OpenAsync("not-allowlisted", isMacOS: true, CancellationToken.None));

		Assert.Contains("Unknown System Settings target", error.Message);
		Assert.Empty(runner.Requests);
	}

	[Fact]
	public async Task OpenAsync_RejectsNonMacHosts()
	{
		var runner = new RecordingProcessRunner(new ProcessResult(0, "", ""));
		var launcher = new MacSystemSettingsLauncher(runner);

		await Assert.ThrowsAsync<NotSupportedException>(
			() => launcher.OpenAsync(
				SystemSettingsTargets.ScreenRecording,
				isMacOS: false,
				CancellationToken.None));

		Assert.Empty(runner.Requests);
	}

	[Fact]
	public async Task OpenAsync_PropagatesProcessFailures()
	{
		var result = new ProcessResult(1, "", "System Settings could not be opened.");
		var launcher = new MacSystemSettingsLauncher(new RecordingProcessRunner(result));

		var error = await Assert.ThrowsAsync<ProcessExecutionException>(
			() => launcher.OpenAsync(
				SystemSettingsTargets.Accessibility,
				isMacOS: true,
				CancellationToken.None));

		Assert.Same(result, error.Result);
	}

	private sealed class RecordingProcessRunner(ProcessResult result) : IProcessRunner
	{
		public List<ProcessRequest> Requests { get; } = [];

		public Task<ProcessResult> RunAsync(
			ProcessRequest request,
			CancellationToken cancellationToken = default)
		{
			Requests.Add(request);
			return Task.FromResult(result);
		}
	}
}
