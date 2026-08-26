using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using MobileCanvas.Core;

namespace MobileCanvas.iOS;

internal sealed class CoreSimulatorHidManager : IAsyncDisposable
{
	private readonly string? _helperPath;
	private readonly Func<string, string, CancellationToken, Task<CoreSimulatorHidSession>> _startSession;
	private readonly ConcurrentDictionary<string, CoreSimulatorHidSession> _sessions =
		new(StringComparer.OrdinalIgnoreCase);
	private readonly SemaphoreSlim _gate = new(1, 1);
	private int _disposed;

	public CoreSimulatorHidManager()
		: this(
			NativeHelperLocator.Path,
			static (helperPath, udid, cancellationToken) =>
				CoreSimulatorHidSession.StartAsync(helperPath, udid, cancellationToken))
	{
	}

	internal CoreSimulatorHidManager(
		string? helperPath,
		Func<string, string, CancellationToken, Task<CoreSimulatorHidSession>> startSession)
	{
		_helperPath = helperPath;
		_startSession = startSession;
	}

	public async Task<CoreSimulatorHidSession> GetAsync(
		string udid,
		CancellationToken cancellationToken)
	{
		ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
		if (_sessions.TryGetValue(udid, out var existing) && existing.IsUsable)
			return existing;

		if (_helperPath is null)
		{
			throw new CoreSimulatorHidException(
				$"{NativeHelperLocator.ExecutableName} was not found in the runtime bundle.",
				beforeDelivery: true);
		}

		await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
			if (_sessions.TryGetValue(udid, out existing))
			{
				if (existing.IsUsable)
					return existing;
				_sessions.TryRemove(udid, out _);
				await existing.DisposeAsync().ConfigureAwait(false);
			}

			CoreSimulatorHidSession created;
			try
			{
				created = await _startSession(_helperPath, udid, cancellationToken)
					.ConfigureAwait(false);
			}
			catch (OperationCanceledException)
			{
				throw;
			}
			catch (CoreSimulatorHidException)
			{
				throw;
			}
			catch (Exception exception) when (
				exception is IOException
					or UnauthorizedAccessException
					or InvalidOperationException
					or Win32Exception)
			{
				throw new CoreSimulatorHidException(
					$"Could not start bundled CoreSimulator HID: {exception.Message}",
					beforeDelivery: true,
					exception);
			}

			_sessions[udid] = created;
			return created;
		}
		finally
		{
			_gate.Release();
		}
	}

	public async Task RemoveAsync(string udid)
	{
		if (Volatile.Read(ref _disposed) != 0)
			return;
		await _gate.WaitAsync().ConfigureAwait(false);
		try
		{
			if (Volatile.Read(ref _disposed) != 0)
				return;
			if (_sessions.TryRemove(udid, out var session))
				await session.DisposeAsync().ConfigureAwait(false);
		}
		finally
		{
			_gate.Release();
		}
	}

	public async ValueTask DisposeAsync()
	{
		if (Interlocked.Exchange(ref _disposed, 1) != 0)
			return;

		await _gate.WaitAsync().ConfigureAwait(false);
		try
		{
			foreach (var session in _sessions.Values)
				await session.DisposeAsync().ConfigureAwait(false);
			_sessions.Clear();
		}
		finally
		{
			_gate.Release();
		}
	}
}

internal interface ICoreSimulatorHidProcess : IAsyncDisposable
{
	TextWriter StandardInput { get; }
	TextReader StandardOutput { get; }
	TextReader StandardError { get; }
	bool HasExited { get; }
	int? ExitCode { get; }
	void Kill();
	Task WaitForExitAsync(CancellationToken cancellationToken);
}

internal sealed class CoreSimulatorHidSession : IAsyncDisposable
{
	private static readonly TimeSpan StartupTimeout = TimeSpan.FromSeconds(15);
	private static readonly TimeSpan ShutdownTimeout = TimeSpan.FromSeconds(2);

	private readonly string _udid;
	private readonly ICoreSimulatorHidProcess _process;
	private readonly SemaphoreSlim _writeGate = new(1, 1);
	private readonly ConcurrentDictionary<long, PendingRequest> _pending = new();
	private readonly ConcurrentDictionary<long, byte> _cancelled = new();
	private readonly TaskCompletionSource<CoreSimulatorHidReady> _ready =
		new(TaskCreationOptions.RunContinuationsAsynchronously);
	private readonly CancellationTokenSource _lifetime = new();
	private readonly Queue<string> _standardError = new();
	private readonly object _stateLock = new();
	private Task? _stdoutPump;
	private Task? _stderrPump;
	private Task? _exitObserver;
	private CoreSimulatorHidException? _failure;
	private long _nextRequestId;
	private int _readySeen;
	private int _disposed;
	private const int MaximumRememberedCancellations = 1024;

	private CoreSimulatorHidSession(string udid, ICoreSimulatorHidProcess process)
	{
		_udid = udid;
		_process = process;
	}

	public bool IsUsable =>
		Volatile.Read(ref _disposed) == 0 &&
		Volatile.Read(ref _readySeen) != 0 &&
		GetFailure() is null &&
		!_process.HasExited;

	public string Transport =>
		_ready.Task.IsCompletedSuccessfully ? _ready.Task.Result.Transport : "";

	internal int RememberedCancellationCount => _cancelled.Count;

	public static async Task<CoreSimulatorHidSession> StartAsync(
		string helperPath,
		string udid,
		CancellationToken cancellationToken)
	{
		if (!OperatingSystem.IsMacOS())
		{
			throw new CoreSimulatorHidException(
				"Bundled CoreSimulator HID requires macOS.",
				beforeDelivery: true);
		}

		SystemCoreSimulatorHidProcess? process = null;
		try
		{
			process = SystemCoreSimulatorHidProcess.Start(helperPath, udid);
			return await StartAsync(udid, process, StartupTimeout, cancellationToken)
				.ConfigureAwait(false);
		}
		catch
		{
			if (process is not null)
				await process.DisposeAsync().ConfigureAwait(false);
			throw;
		}
	}

	internal static async Task<CoreSimulatorHidSession> StartAsync(
		string udid,
		ICoreSimulatorHidProcess process,
		TimeSpan startupTimeout,
		CancellationToken cancellationToken)
	{
		var session = new CoreSimulatorHidSession(udid, process);
		session._stdoutPump = session.PumpStandardOutputAsync();
		session._stderrPump = session.PumpStandardErrorAsync();
		session._exitObserver = session.ObserveExitAsync();

		try
		{
			var ready = await session._ready.Task
				.WaitAsync(startupTimeout, cancellationToken)
				.ConfigureAwait(false);
			if (ready.Version != CoreSimulatorHidProtocol.Version)
			{
				throw new CoreSimulatorHidException(
					$"CoreSimulator HID protocol version {ready.Version} is not supported; "
					+ $"expected {CoreSimulatorHidProtocol.Version}.",
					beforeDelivery: true);
			}
			return session;
		}
		catch (TimeoutException exception)
		{
			await session.DisposeAsync().ConfigureAwait(false);
			throw new CoreSimulatorHidException(
				$"{NativeHelperLocator.ExecutableName} did not establish CoreSimulator HID "
				+ $"for '{udid}' within {startupTimeout.TotalSeconds:0} seconds.",
				beforeDelivery: true,
				exception);
		}
		catch
		{
			await session.DisposeAsync().ConfigureAwait(false);
			throw;
		}
	}

	public async Task SendAsync(
		IReadOnlyList<IosHidEvent> events,
		CancellationToken cancellationToken)
	{
		CoreSimulatorHidProtocol.ValidateEvents(events);
		ThrowIfUnavailable();

		long id;
		PendingRequest pending;
		await _writeGate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			ThrowIfUnavailable();
			cancellationToken.ThrowIfCancellationRequested();
			id = Interlocked.Increment(ref _nextRequestId);
			pending = new PendingRequest();
			if (!_pending.TryAdd(id, pending))
				throw new InvalidOperationException($"Duplicate CoreSimulator HID request ID {id}.");

			var request = CoreSimulatorHidProtocol.SerializeRequest(id, events);
			try
			{
				await _process.StandardInput.WriteLineAsync(request).ConfigureAwait(false);
				await _process.StandardInput.FlushAsync(CancellationToken.None).ConfigureAwait(false);
			}
			catch (Exception exception) when (
				exception is IOException or ObjectDisposedException or InvalidOperationException)
			{
				_pending.TryRemove(id, out _);
				var failure = new CoreSimulatorHidException(
					$"Could not write CoreSimulator HID request {id}: {exception.Message}",
					beforeDelivery: false,
					exception);
				Fail(failure);
				throw failure;
			}
		}
		finally
		{
			_writeGate.Release();
		}

		try
		{
			await pending.Completion.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
		}
		catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
		{
			// Publish the cancellation before removing the pending request. Otherwise the stdout
			// pump can observe the result in between those operations and misclassify it as an
			// unknown request, which would fail the whole live session.
			RememberCancellation(id);
			if (!_pending.TryRemove(id, out _))
				_cancelled.TryRemove(id, out _);
			throw;
		}
	}

	public async ValueTask DisposeAsync()
	{
		if (Interlocked.Exchange(ref _disposed, 1) != 0)
			return;

		CompletePending(new CoreSimulatorHidException(
			$"The CoreSimulator HID session for '{_udid}' was removed before delivery completed.",
			beforeDelivery: false));

		var ownsInput = await _writeGate.WaitAsync(ShutdownTimeout).ConfigureAwait(false);
		if (!ownsInput)
			_process.Kill();
		else
		{
			try
			{
				await _process.StandardInput.DisposeAsync().ConfigureAwait(false);
			}
			catch (IOException)
			{
				// The process already closed its input pipe.
			}
			catch (ObjectDisposedException)
			{
				// The process already closed its input pipe.
			}
			finally
			{
				_writeGate.Release();
			}
		}

		if (!_process.HasExited)
		{
			using var graceful = new CancellationTokenSource(ShutdownTimeout);
			try
			{
				await _process.WaitForExitAsync(graceful.Token).ConfigureAwait(false);
			}
			catch (OperationCanceledException)
			{
				_process.Kill();
			}
		}

		if (!_process.HasExited)
		{
			using var killed = new CancellationTokenSource(ShutdownTimeout);
			try
			{
				await _process.WaitForExitAsync(killed.Token).ConfigureAwait(false);
			}
			catch (OperationCanceledException)
			{
				// The process has already been force-terminated; do not block disposal indefinitely.
			}
		}

		await _lifetime.CancelAsync().ConfigureAwait(false);
		await AwaitPumpAsync(_stdoutPump).ConfigureAwait(false);
		await AwaitPumpAsync(_stderrPump).ConfigureAwait(false);
		await AwaitPumpAsync(_exitObserver).ConfigureAwait(false);
		await _process.DisposeAsync().ConfigureAwait(false);
		_lifetime.Dispose();
	}

	private async Task PumpStandardOutputAsync()
	{
		try
		{
			while (!_lifetime.IsCancellationRequested)
			{
				var line = await _process.StandardOutput.ReadLineAsync(_lifetime.Token)
					.ConfigureAwait(false);
				if (line is null)
				break;

				CoreSimulatorHidResponse response;
				try
				{
					response = CoreSimulatorHidProtocol.ParseResponse(line);
				}
				catch (InvalidDataException exception)
				{
					Fail(new CoreSimulatorHidException(
						$"CoreSimulator HID protocol corruption: {exception.Message}",
						beforeDelivery: Volatile.Read(ref _readySeen) == 0,
						exception));
					return;
				}

				if (response.Version != CoreSimulatorHidProtocol.Version)
				{
					Fail(new CoreSimulatorHidException(
						$"CoreSimulator HID protocol version {response.Version} is not supported; "
						+ $"expected {CoreSimulatorHidProtocol.Version}.",
						beforeDelivery: Volatile.Read(ref _readySeen) == 0));
					return;
				}

				switch (response)
				{
					case CoreSimulatorHidReady ready:
						if (Interlocked.CompareExchange(ref _readySeen, 1, 0) != 0)
						{
							Fail(new CoreSimulatorHidException(
								"The CoreSimulator HID helper emitted more than one ready response.",
								beforeDelivery: false));
							return;
						}
						_ready.TrySetResult(ready);
						break;
					case CoreSimulatorHidUnavailable unavailable:
						Fail(new CoreSimulatorHidException(
							$"{unavailable.Code}: {unavailable.Message}",
							beforeDelivery: Volatile.Read(ref _readySeen) == 0));
						return;
					case CoreSimulatorHidResult result:
						if (Volatile.Read(ref _readySeen) == 0)
						{
							Fail(new CoreSimulatorHidException(
								"The CoreSimulator HID helper returned a result before ready.",
								beforeDelivery: true));
							return;
						}
						HandleResult(result);
						break;
					case CoreSimulatorHidFatal fatal:
						Fail(new CoreSimulatorHidException(
							$"{fatal.Code}: {fatal.Message}",
							beforeDelivery: false));
						return;
				}
			}

			if (Volatile.Read(ref _disposed) == 0 && GetFailure() is null)
			{
				Fail(new CoreSimulatorHidException(
					$"{NativeHelperLocator.ExecutableName} closed the HID protocol stream"
					+ FormatExitDetail() + FormatStandardError(),
					beforeDelivery: Volatile.Read(ref _readySeen) == 0));
			}
		}
		catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
		{
			// Session is shutting down.
		}
		catch (IOException exception)
		{
			if (Volatile.Read(ref _disposed) == 0)
			{
				Fail(new CoreSimulatorHidException(
					$"CoreSimulator HID protocol read failed: {exception.Message}",
					beforeDelivery: Volatile.Read(ref _readySeen) == 0,
					exception));
			}
		}
	}

	private async Task PumpStandardErrorAsync()
	{
		try
		{
			while (!_lifetime.IsCancellationRequested)
			{
				var line = await _process.StandardError.ReadLineAsync(_lifetime.Token)
					.ConfigureAwait(false);
				if (line is null)
					break;
				lock (_standardError)
				{
					_standardError.Enqueue(line);
					while (_standardError.Count > 20)
						_standardError.Dequeue();
				}
			}
		}
		catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
		{
			// Session is shutting down.
		}
		catch (IOException)
		{
			// Process exit closes stderr; the exit observer reports the session failure.
		}
	}

	private async Task ObserveExitAsync()
	{
		try
		{
			await _process.WaitForExitAsync(_lifetime.Token).ConfigureAwait(false);
			if (Volatile.Read(ref _disposed) == 0 && GetFailure() is null)
			{
				Fail(new CoreSimulatorHidException(
					$"{NativeHelperLocator.ExecutableName} exited during HID delivery"
					+ FormatExitDetail() + FormatStandardError(),
					beforeDelivery: Volatile.Read(ref _readySeen) == 0));
			}
		}
		catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
		{
			// Session is shutting down.
		}
	}

	private void HandleResult(CoreSimulatorHidResult result)
	{
		if (_pending.TryRemove(result.Id, out var pending))
		{
			if (result.Success)
			{
				pending.Completion.TrySetResult(true);
			}
			else
			{
				pending.Completion.TrySetException(new CoreSimulatorHidException(
					$"{result.Code ?? "native-error"}: "
					+ (result.Message ?? "CoreSimulator rejected the HID request."),
					result.BeforeDelivery));
			}
			return;
		}

		if (_cancelled.TryRemove(result.Id, out _))
			return;

		Fail(new CoreSimulatorHidException(
			$"The CoreSimulator HID helper returned unknown request ID {result.Id}.",
			beforeDelivery: false));
	}

	private void RememberCancellation(long id)
	{
		_cancelled[id] = 0;
		while (_cancelled.Count > MaximumRememberedCancellations)
		{
			var oldest = _cancelled.Keys.DefaultIfEmpty().Min();
			if (oldest == 0)
				break;
			_cancelled.TryRemove(oldest, out _);
		}
	}

	private void ThrowIfUnavailable()
	{
		if (Volatile.Read(ref _disposed) != 0)
		{
			throw new CoreSimulatorHidException(
				$"The CoreSimulator HID session for '{_udid}' has been disposed.",
				beforeDelivery: false);
		}
		if (GetFailure() is { } failure)
			throw failure;
		if (!_ready.Task.IsCompletedSuccessfully)
		{
			throw new CoreSimulatorHidException(
				$"CoreSimulator HID for '{_udid}' has not completed startup.",
				beforeDelivery: true);
		}
		if (_process.HasExited)
		{
			throw new CoreSimulatorHidException(
				$"{NativeHelperLocator.ExecutableName} has exited" + FormatExitDetail()
				+ FormatStandardError(),
				beforeDelivery: false);
		}
	}

	private CoreSimulatorHidException? GetFailure()
	{
		lock (_stateLock)
			return _failure;
	}

	private void Fail(CoreSimulatorHidException failure)
	{
		lock (_stateLock)
		{
			if (_failure is not null)
				return;
			_failure = failure;
		}

		_ready.TrySetException(failure);
		CompletePending(failure);
	}

	private void CompletePending(CoreSimulatorHidException failure)
	{
		foreach (var entry in _pending)
		{
			if (_pending.TryRemove(entry.Key, out var pending))
				pending.Completion.TrySetException(failure);
		}
	}

	private string FormatExitDetail() =>
		_process.ExitCode is { } exitCode ? $" with code {exitCode}" : "";

	private string FormatStandardError()
	{
		lock (_standardError)
		{
			return _standardError.Count == 0
				? "."
				: $": {string.Join(Environment.NewLine, _standardError)}";
		}
	}

	private static async Task AwaitPumpAsync(Task? task)
	{
		if (task is null)
			return;
		try
		{
			await task.ConfigureAwait(false);
		}
		catch (OperationCanceledException)
		{
			// Session is shutting down.
		}
	}

	private sealed class PendingRequest
	{
		public TaskCompletionSource<bool> Completion { get; } =
			new(TaskCreationOptions.RunContinuationsAsynchronously);
	}
}

internal sealed class SystemCoreSimulatorHidProcess : ICoreSimulatorHidProcess
{
	private readonly Process _process;

	private SystemCoreSimulatorHidProcess(Process process)
	{
		_process = process;
	}

	public TextWriter StandardInput => _process.StandardInput;
	public TextReader StandardOutput => _process.StandardOutput;
	public TextReader StandardError => _process.StandardError;
	public bool HasExited => _process.HasExited;
	public int? ExitCode => _process.HasExited ? _process.ExitCode : null;

	public static SystemCoreSimulatorHidProcess Start(string helperPath, string udid)
	{
		var startInfo = new ProcessStartInfo(helperPath)
		{
			UseShellExecute = false,
			RedirectStandardInput = true,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			StandardInputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
			StandardOutputEncoding = Encoding.UTF8,
			StandardErrorEncoding = Encoding.UTF8,
			CreateNoWindow = true,
		};
		startInfo.ArgumentList.Add("hid");
		startInfo.ArgumentList.Add("--udid");
		startInfo.ArgumentList.Add(udid);

		var process = new Process { StartInfo = startInfo };
		if (!process.Start())
		{
			process.Dispose();
			throw new InvalidOperationException(
				$"Could not start {NativeHelperLocator.ExecutableName}.");
		}
		return new SystemCoreSimulatorHidProcess(process);
	}

	public void Kill()
	{
		if (!_process.HasExited)
			_process.Kill(entireProcessTree: true);
	}

	public Task WaitForExitAsync(CancellationToken cancellationToken) =>
		_process.WaitForExitAsync(cancellationToken);

	public ValueTask DisposeAsync()
	{
		_process.Dispose();
		return ValueTask.CompletedTask;
	}
}
