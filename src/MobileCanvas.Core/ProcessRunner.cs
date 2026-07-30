using System.Diagnostics;

namespace MobileCanvas.Core;

public sealed record ProcessRequest(
	string FileName,
	IReadOnlyList<string> Arguments,
	string? StandardInput = null,
	IReadOnlyDictionary<string, string?>? Environment = null,
	string? WorkingDirectory = null);

public sealed record ProcessResult(int ExitCode, string StandardOutput, string StandardError);

public interface IProcessRunner
{
	Task<ProcessResult> RunAsync(ProcessRequest request, CancellationToken cancellationToken = default);
}

public sealed class ProcessExecutionException(
	string fileName,
	IReadOnlyList<string> arguments,
	ProcessResult result)
	: InvalidOperationException(CreateMessage(fileName, arguments, result))
{
	public ProcessResult Result { get; } = result;

	private static string CreateMessage(string fileName, IReadOnlyList<string> arguments, ProcessResult result)
	{
		var detail = string.IsNullOrWhiteSpace(result.StandardError)
			? result.StandardOutput.Trim()
			: result.StandardError.Trim();
		return $"Process '{fileName} {string.Join(' ', arguments)}' exited with code {result.ExitCode}: {detail}";
	}
}

public sealed class SystemProcessRunner : IProcessRunner
{
	public async Task<ProcessResult> RunAsync(
		ProcessRequest request,
		CancellationToken cancellationToken = default)
	{
		var startInfo = new ProcessStartInfo
		{
			FileName = request.FileName,
			UseShellExecute = false,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			RedirectStandardInput = request.StandardInput is not null,
			CreateNoWindow = true,
			WorkingDirectory = request.WorkingDirectory ?? "",
		};

		foreach (var argument in request.Arguments)
			startInfo.ArgumentList.Add(argument);

		if (request.Environment is not null)
		{
			foreach (var pair in request.Environment)
				startInfo.Environment[pair.Key] = pair.Value;
		}

		using var process = Process.Start(startInfo)
			?? throw new InvalidOperationException($"Failed to start process '{request.FileName}'.");

		var standardOutput = process.StandardOutput.ReadToEndAsync(cancellationToken);
		var standardError = process.StandardError.ReadToEndAsync(cancellationToken);

		if (request.StandardInput is not null)
		{
			await process.StandardInput.WriteAsync(request.StandardInput.AsMemory(), cancellationToken)
				.ConfigureAwait(false);
			await process.StandardInput.DisposeAsync().ConfigureAwait(false);
		}

		try
		{
			await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
		}
		catch (OperationCanceledException)
		{
			if (!process.HasExited)
				process.Kill(entireProcessTree: true);
			throw;
		}

		return new ProcessResult(
			process.ExitCode,
			await standardOutput.ConfigureAwait(false),
			await standardError.ConfigureAwait(false));
	}
}
