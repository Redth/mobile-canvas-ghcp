using System.Collections.Concurrent;
using Android.Emulation.Control;
using Grpc.Core;
using Grpc.Net.Client;

namespace MobileCanvas.Android;

/// <summary>
/// A pooled gRPC connection to one running emulator, plus the persistent input stream.
///
/// The input stream matters: <c>streamInputEvent</c> is a single client-streaming RPC, so sending a
/// touch costs one HTTP/2 frame write (measured at 0.03 ms median) instead of a full RPC (1.1 ms) or
/// an <c>adb shell input</c> subprocess (53 ms median, 4301 ms worst case). Live drag is only smooth
/// on the streaming path.
/// </summary>
internal sealed class EmulatorConnection : IAsyncDisposable
{
	private readonly GrpcChannel _channel;
	private readonly Metadata _metadata;
	private readonly SemaphoreSlim _inputGate = new(1, 1);
	private AsyncClientStreamingCall<InputEvent, Google.Protobuf.WellKnownTypes.Empty>? _inputStream;
	private bool _disposed;

	private EmulatorConnection(EmulatorInstance instance, GrpcChannel channel, Metadata metadata)
	{
		Instance = instance;
		_channel = channel;
		_metadata = metadata;
		Client = new EmulatorController.EmulatorControllerClient(channel);
	}

	public EmulatorInstance Instance { get; }

	public EmulatorController.EmulatorControllerClient Client { get; }

	public Metadata Metadata => _metadata;

	public static EmulatorConnection Create(EmulatorInstance instance)
	{
		var channel = GrpcChannel.ForAddress($"http://127.0.0.1:{instance.GrpcPort}", new GrpcChannelOptions
		{
			// A native-resolution frame is ~12 MB, well past the 4 MB default.
			MaxReceiveMessageSize = 96 * 1024 * 1024,
			MaxSendMessageSize = 4 * 1024 * 1024,
		});

		var metadata = new Metadata();
		if (!string.IsNullOrEmpty(instance.GrpcToken))
			metadata.Add("authorization", "Bearer " + instance.GrpcToken);

		return new EmulatorConnection(instance, channel, metadata);
	}

	/// <summary>
	/// Writes one input event on the shared stream, reopening it if the emulator closed it. Writes
	/// are serialized because gRPC allows only one in-flight write per client stream, and because an
	/// out-of-order release would strand a touch slot.
	/// </summary>
	public async Task SendInputAsync(InputEvent inputEvent, CancellationToken cancellationToken)
	{
		await _inputGate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			ObjectDisposedException.ThrowIf(_disposed, this);

			for (var attempt = 0; attempt < 2; attempt++)
			{
				var stream = _inputStream ??= Client.streamInputEvent(_metadata);
				try
				{
					await stream.RequestStream.WriteAsync(inputEvent, cancellationToken).ConfigureAwait(false);
					return;
				}
				catch (Exception) when (attempt == 0)
				{
					// The emulator drops the stream on reboot or rotation. Rebuild once and retry so a
					// transient close does not surface as a failed gesture.
					await DisposeInputStreamAsync().ConfigureAwait(false);
				}
			}
		}
		finally
		{
			_inputGate.Release();
		}
	}

	// There is deliberately no key-event method here. The emulator's gRPC keyboard surface accepts
	// KeyboardEvent over both `streamInputEvent` and the unary `sendKey`, returns success, and never
	// acts on it -- verified on emulator 36.x for system buttons (GoHome), USB-HID key codes, and
	// text. `adb shell input keyevent|text` works on the same emulator in the same state, so
	// AndroidEmulatorBackend routes every keyboard path through adb. Touch is unaffected and stays
	// on `streamInputEvent`, where the 0.03 ms latency actually matters. Do not reintroduce a gRPC
	// key path without first confirming a keypress moves the device, not just that the call succeeds.

	public async ValueTask DisposeAsync()
	{
		if (_disposed)
			return;

		_disposed = true;
		await DisposeInputStreamAsync().ConfigureAwait(false);
		_channel.Dispose();
		_inputGate.Dispose();
	}

	private async Task DisposeInputStreamAsync()
	{
		var stream = _inputStream;
		_inputStream = null;
		if (stream is null)
			return;

		try
		{
			await stream.RequestStream.CompleteAsync().ConfigureAwait(false);
		}
		catch (Exception)
		{
			// The stream is being torn down; a failure to close it cleanly is not actionable.
		}

		stream.Dispose();
	}
}

/// <summary>
/// Keeps one <see cref="EmulatorConnection"/> per emulator, keyed by AVD id. Connections are rebuilt
/// when an emulator restarts on a different port.
/// </summary>
internal sealed class EmulatorConnectionPool : IAsyncDisposable
{
	private readonly ConcurrentDictionary<string, EmulatorConnection> _connections =
		new(StringComparer.OrdinalIgnoreCase);
	private readonly SemaphoreSlim _gate = new(1, 1);

	public async Task<EmulatorConnection> GetAsync(EmulatorInstance instance, CancellationToken cancellationToken)
	{
		if (_connections.TryGetValue(instance.AvdId, out var existing) &&
			existing.Instance.GrpcPort == instance.GrpcPort &&
			existing.Instance.ProcessId == instance.ProcessId)
			return existing;

		await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			if (_connections.TryGetValue(instance.AvdId, out existing))
			{
				if (existing.Instance.GrpcPort == instance.GrpcPort && existing.Instance.ProcessId == instance.ProcessId)
					return existing;

				_connections.TryRemove(instance.AvdId, out _);
				await existing.DisposeAsync().ConfigureAwait(false);
			}

			var created = EmulatorConnection.Create(instance);
			_connections[instance.AvdId] = created;
			return created;
		}
		finally
		{
			_gate.Release();
		}
	}

	public async Task RemoveAsync(string avdId)
	{
		if (_connections.TryRemove(avdId, out var connection))
			await connection.DisposeAsync().ConfigureAwait(false);
	}

	public async ValueTask DisposeAsync()
	{
		foreach (var connection in _connections.Values)
			await connection.DisposeAsync().ConfigureAwait(false);

		_connections.Clear();
		_gate.Dispose();
	}
}
