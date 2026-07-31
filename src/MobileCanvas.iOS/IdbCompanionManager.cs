using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.Sockets;
using MobileCanvas.Contracts;
using MobileCanvas.Core;
using Grpc.Net.Client;
using Idb;

namespace MobileCanvas.iOS;

internal sealed class IdbCompanionManager(IProcessRunner processRunner) : IAsyncDisposable
{
	private readonly ConcurrentDictionary<string, IdbCompanionSession> _sessions =
		new(StringComparer.OrdinalIgnoreCase);
	private readonly SemaphoreSlim _gate = new(1, 1);

	public async Task<IdbCompanionSession> GetAsync(string udid, CancellationToken cancellationToken)
	{
		if (_sessions.TryGetValue(udid, out var existing) && existing.IsRunning)
			return existing;

		await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			if (_sessions.TryGetValue(udid, out existing))
			{
				if (existing.IsRunning)
					return existing;
				await existing.DisposeAsync().ConfigureAwait(false);
				_sessions.TryRemove(udid, out _);
			}

			var created = await IdbCompanionSession.StartAsync(udid, processRunner, cancellationToken)
				.ConfigureAwait(false);
			_sessions[udid] = created;
			return created;
		}
		finally
		{
			_gate.Release();
		}
	}

	public async ValueTask DisposeAsync()
	{
		foreach (var session in _sessions.Values)
			await session.DisposeAsync().ConfigureAwait(false);
		_sessions.Clear();
		_gate.Dispose();
	}
}

internal sealed class IdbCompanionSession : IAsyncDisposable
{
	private readonly string _socketPath;
	private readonly string _workingDirectory;
	private readonly Process _process;
	private readonly GrpcChannel _channel;
	private readonly List<string> _standardError = [];
	private readonly SemaphoreSlim _hidGate = new(1, 1);
	private readonly SemaphoreSlim _videoGate = new(1, 1);
	private bool _disposed;

	private IdbCompanionSession(
		string udid,
		string socketPath,
		string workingDirectory,
		Process process,
		GrpcChannel channel,
		IProcessRunner processRunner)
	{
		Udid = udid;
		_socketPath = socketPath;
		_workingDirectory = workingDirectory;
		_process = process;
		_channel = channel;
		ProcessRunner = processRunner;
		Client = new CompanionService.CompanionServiceClient(channel);
	}

	public string Udid { get; }
	public bool IsRunning => !_disposed && !_process.HasExited;
	public CompanionService.CompanionServiceClient Client { get; }
	public IProcessRunner ProcessRunner { get; }

	public static async Task<IdbCompanionSession> StartAsync(
		string udid,
		IProcessRunner processRunner,
		CancellationToken cancellationToken)
	{
		if (!OperatingSystem.IsMacOS())
			throw new PlatformNotSupportedException("iOS Simulator control requires macOS.");

		var companionPath = IdbCompanionLocator.Find()
			?? throw new FileNotFoundException(
				"idb_companion was not found. Install it with Homebrew or set MOBILE_CANVAS_IDB_COMPANION.");
		var root = Path.Combine("/tmp", $"mobile-canvas-idb-{Environment.UserName}");
		Directory.CreateDirectory(root);
		File.SetUnixFileMode(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
		var workingDirectory = Path.Combine(root, $"{Environment.ProcessId}-{Guid.NewGuid():N}");
		Directory.CreateDirectory(workingDirectory);
		File.SetUnixFileMode(
			workingDirectory,
			UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
		var socketPath = Path.Combine(workingDirectory, "companion.sock");

		var startInfo = new ProcessStartInfo
		{
			FileName = companionPath,
			UseShellExecute = false,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			CreateNoWindow = true,
		};
		foreach (var argument in new[]
		{
			"--udid", udid,
			"--grpc-domain-sock", socketPath,
			"--only", "simulator",
			"--log-level", "info",
		})
		{
			startInfo.ArgumentList.Add(argument);
		}

		var process = Process.Start(startInfo)
			?? throw new InvalidOperationException("Failed to start idb_companion.");
		var errorLines = new List<string>();
		process.OutputDataReceived += (_, _) => { };
		process.ErrorDataReceived += (_, eventArgs) =>
		{
			if (eventArgs.Data is not null)
			{
				lock (errorLines)
					errorLines.Add(eventArgs.Data);
			}
		};
		process.BeginOutputReadLine();
		process.BeginErrorReadLine();

		try
		{
			var deadline = DateTimeOffset.UtcNow.AddSeconds(20);
			while (!File.Exists(socketPath))
			{
				cancellationToken.ThrowIfCancellationRequested();
				if (process.HasExited)
				throw new InvalidOperationException(
					$"idb_companion exited with code {process.ExitCode}: {FormatErrors(errorLines)}");
				if (DateTimeOffset.UtcNow >= deadline)
					throw new TimeoutException(
						$"idb_companion did not create its socket: {FormatErrors(errorLines)}");
				await Task.Delay(50, cancellationToken).ConfigureAwait(false);
			}

			var channel = CreateChannel(socketPath);
			var session = new IdbCompanionSession(
				udid,
				socketPath,
				workingDirectory,
				process,
				channel,
				processRunner);
			lock (errorLines)
				session._standardError.AddRange(SanitizeErrorLines(errorLines));
			return session;
		}
		catch
		{
			if (!process.HasExited)
				process.Kill(entireProcessTree: true);
			process.Dispose();
			if (Directory.Exists(workingDirectory))
				Directory.Delete(workingDirectory, recursive: true);
			throw;
		}
	}

	public async Task SendHidAsync(
		IEnumerable<HIDEvent> events,
		CancellationToken cancellationToken)
	{
		ThrowIfUnavailable();
		await _hidGate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			// Reuse the session channel. Building one per event cost a Unix-socket connect plus a
			// full HTTP/2 handshake, which measured ~400ms and dominated input latency.
			using var call = Client.hid(cancellationToken: cancellationToken);
			foreach (var hidEvent in events)
				await call.RequestStream.WriteAsync(hidEvent, cancellationToken).ConfigureAwait(false);
			await call.RequestStream.CompleteAsync().ConfigureAwait(false);
			await call.ResponseAsync.ConfigureAwait(false);
		}
		finally
		{
			_hidGate.Release();
		}
	}

	/// <summary>
	/// The accessibility hierarchy as idb's raw JSON. Nested format is requested because the flat
	/// legacy format loses the parent/child structure a caller needs to tell one "Done" from another.
	/// </summary>
	public async Task<string> GetAccessibilityJsonAsync(CancellationToken cancellationToken)
	{
		ThrowIfUnavailable();
		var response = await Client.accessibility_infoAsync(
			new AccessibilityInfoRequest { Format = AccessibilityInfoRequest.Types.Format.Nested },
			cancellationToken: cancellationToken);
		return response.Json;
	}

	public async Task<IosLiveVideoSession> OpenVideoAsync(
		StreamOptions options,
		DisplayGeometry display,
		CancellationToken cancellationToken)
		=> await OpenVideoAsync(options, display, null, cancellationToken).ConfigureAwait(false);

	public async Task<IosLiveVideoSession> OpenVideoAsync(
		StreamOptions options,
		DisplayGeometry display,
		string? fallbackReason,
		CancellationToken cancellationToken)
	{
		ThrowIfUnavailable();
		// A restart (scale change, reconnect) closes the old socket and immediately opens a new one,
		// but the server only releases the gate once it observes the close and disposes the session.
		// Failing instantly turns that ordinary race into a permanent PNG fallback, so wait briefly
		// for the previous session to drain before declaring a genuine conflict.
		if (!await _videoGate.WaitAsync(TimeSpan.FromSeconds(5), cancellationToken).ConfigureAwait(false))
			throw new DeviceCapabilityException(
				$"A live stream is already active for simulator '{Udid}'.");

		try
		{
			return await IosLiveVideoSession.StartAsync(
					this,
					options,
					display,
					() => _videoGate.Release(),
					fallbackReason,
					cancellationToken)
				.ConfigureAwait(false);
		}
		catch
		{
			_videoGate.Release();
			throw;
		}
	}

	public async ValueTask DisposeAsync()
	{
		if (_disposed)
			return;
		_disposed = true;
		_channel.Dispose();
		if (!_process.HasExited)
		{
			_process.Kill(entireProcessTree: true);
			await _process.WaitForExitAsync().ConfigureAwait(false);
		}
		_process.Dispose();
		_hidGate.Dispose();
		_videoGate.Dispose();

		if (File.Exists(_socketPath))
			File.Delete(_socketPath);
		if (Directory.Exists(_workingDirectory))
			Directory.Delete(_workingDirectory, recursive: true);
	}

	private void ThrowIfUnavailable()
	{
		ObjectDisposedException.ThrowIf(_disposed, this);
		if (_process.HasExited)
			throw new InvalidOperationException(
				$"idb_companion exited with code {_process.ExitCode}: {string.Join(Environment.NewLine, _standardError)}");
	}

	private static string FormatErrors(IEnumerable<string> lines) =>
		string.Join(Environment.NewLine, SanitizeErrorLines(lines));

	private static IEnumerable<string> SanitizeErrorLines(IEnumerable<string> lines) =>
		lines.Where(line => !line.Contains(" env={", StringComparison.Ordinal))
			.TakeLast(12);

	private static GrpcChannel CreateChannel(string socketPath)
	{
		var handler = new SocketsHttpHandler
		{
			EnableMultipleHttp2Connections = true,
			InitialHttp2StreamWindowSize = 65535 * 16,
			PooledConnectionIdleTimeout = Timeout.InfiniteTimeSpan,
			ConnectCallback = async (_, token) =>
			{
				var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
				try
				{
					await socket.ConnectAsync(new UnixDomainSocketEndPoint(socketPath), token)
						.ConfigureAwait(false);
					return new NetworkStream(socket, ownsSocket: true);
				}
				catch
				{
					socket.Dispose();
					throw;
				}
			},
		};
		return GrpcChannel.ForAddress("http://localhost", new GrpcChannelOptions
		{
			HttpHandler = handler,
			HttpVersion = new Version(2, 0),
			MaxReceiveMessageSize = 100 * 1024 * 1024,
			MaxSendMessageSize = 100 * 1024 * 1024,
		});
	}
}
