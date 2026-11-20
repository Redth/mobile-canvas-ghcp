using System.Diagnostics;
using MobileCanvas.Core;

namespace MobileCanvas.Tests;

public sealed class ProcessRunnerTests
{
	[Fact]
	public async Task CallerOwnedProcess_SupportsBinaryInputAndOutputWithoutWaitingForExit()
	{
		if (OperatingSystem.IsWindows())
			return;

		var startInfo = new ProcessStartInfo("/bin/sh")
		{
			UseShellExecute = false,
			RedirectStandardInput = true,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
		};
		startInfo.ArgumentList.Add("-c");
		startInfo.ArgumentList.Add("cat; echo \"$MOBILE_CANVAS_RUNNER_TEST\" >&2");
		startInfo.Environment["MOBILE_CANVAS_RUNNER_TEST"] = "stderr remains separate";
		using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
		using var process = new SystemProcessRunner().Start(startInfo);
		try
		{
			byte[] bytes = [0, 255, 128, 13, 10];
			var stderr = process.StandardError.ReadToEndAsync(timeout.Token);
			using var output = new MemoryStream();
			var copy = process.StandardOutput.BaseStream.CopyToAsync(output, timeout.Token);

			await process.StandardInput.BaseStream.WriteAsync(bytes, timeout.Token);
			await process.StandardInput.DisposeAsync();
			await process.WaitForExitAsync(timeout.Token);
			await copy;

			Assert.Equal(bytes, output.ToArray());
			Assert.Equal("stderr remains separate", (await stderr).Trim());
			Assert.Equal(0, process.ExitCode);
		}
		finally
		{
			if (!process.HasExited)
			{
				process.Kill(entireProcessTree: true);
				await process.WaitForExitAsync(CancellationToken.None);
			}
		}
	}

	[Fact]
	public async Task TextProcess_PreservesInputEnvironmentAndExitStatus()
	{
		if (OperatingSystem.IsWindows())
			return;

		var result = await new SystemProcessRunner().RunAsync(new ProcessRequest(
			"/bin/sh",
			["-c", "cat; echo \"$MOBILE_CANVAS_RUNNER_TEST\" >&2; exit 7"],
			StandardInput: "text input\n",
			Environment: new Dictionary<string, string?> { ["MOBILE_CANVAS_RUNNER_TEST"] = "error detail" }));

		Assert.Equal(7, result.ExitCode);
		Assert.Equal("text input\n", result.StandardOutput);
		Assert.Equal("error detail", result.StandardError.Trim());
	}
}
