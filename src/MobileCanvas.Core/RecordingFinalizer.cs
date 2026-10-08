using System.Diagnostics;
using MobileCanvas.Contracts;

namespace MobileCanvas.Core;

internal sealed class RecordingFinalizer
{
	private readonly object _sync = new();
	private Task<RecordingStatus>? _attempt;
	private CancellationTokenSource? _attemptCancellation;
	private Task? _abandonTask;
	private RecordingStatus? _completed;
	private bool _abandonRequested;

	public bool IsCompleted
	{
		get
		{
			lock (_sync)
				return _completed is not null;
		}
	}

	public RecordingStatus? CompletedStatus
	{
		get
		{
			lock (_sync)
				return _completed;
		}
	}

	public Task<RecordingStatus> FinalizeAsync(
		Func<CancellationToken, Task<RecordingStatus>> finalize,
		CancellationToken cancellationToken)
	{
		Task<RecordingStatus> attempt;
		lock (_sync)
		{
			if (_completed is { } completed)
				return Task.FromResult(completed);
			if (_abandonRequested)
				throw new InvalidOperationException("The recording is being abandoned.");

			if (_attempt is null || (_attempt.IsCompleted && !_attempt.IsCompletedSuccessfully))
			{
				_attemptCancellation?.Dispose();
				_attemptCancellation = new CancellationTokenSource();
				_attempt = RunFinalizeAsync(finalize, _attemptCancellation.Token);
			}
			attempt = _attempt;
		}

		return attempt.WaitAsync(cancellationToken);
	}

	public async Task AbandonAsync(Func<Task> abandon)
	{
		Task<RecordingStatus>? attempt;
		CancellationTokenSource? attemptCancellation;
		lock (_sync)
		{
			if (_completed is not null)
				return;

			_abandonRequested = true;
			attempt = _attempt;
			attemptCancellation = _attemptCancellation;
		}

		if (attempt is not null)
		{
			await attemptCancellation!.CancelAsync().ConfigureAwait(false);
			await attempt.ContinueWith(
				static completedTask => _ = completedTask.Exception,
				CancellationToken.None,
				TaskContinuationOptions.ExecuteSynchronously,
				TaskScheduler.Default).ConfigureAwait(false);
		}

		Task abandonTask;
		lock (_sync)
		{
			if (_completed is not null)
				return;

			_abandonTask ??= abandon();
			abandonTask = _abandonTask;
		}

		await abandonTask.ConfigureAwait(false);
	}

	private async Task<RecordingStatus> RunFinalizeAsync(
		Func<CancellationToken, Task<RecordingStatus>> finalize,
		CancellationToken cancellationToken)
	{
		var completed = await finalize(cancellationToken).ConfigureAwait(false);
		lock (_sync)
			_completed = completed;
		return completed;
	}
}

internal interface IRecordingProcess : IDisposable
{
	bool HasExited { get; }
	int ExitCode { get; }
	int Id { get; }
	void Kill();
	Task<string> ReadStandardErrorAsync();
	Task WaitForExitAsync(CancellationToken cancellationToken);
}

internal sealed class SystemRecordingProcess(Process process) : IRecordingProcess
{
	public bool HasExited => process.HasExited;
	public int ExitCode => process.ExitCode;
	public int Id => process.Id;

	public void Dispose() => process.Dispose();

	public void Kill()
	{
		if (!process.HasExited)
			process.Kill(entireProcessTree: true);
	}

	public async Task<string> ReadStandardErrorAsync()
	{
		try
		{
			return (await process.StandardError.ReadToEndAsync().ConfigureAwait(false)).Trim();
		}
		catch (InvalidOperationException)
		{
			return "";
		}
	}

	public Task WaitForExitAsync(CancellationToken cancellationToken) =>
		process.WaitForExitAsync(cancellationToken);
}
