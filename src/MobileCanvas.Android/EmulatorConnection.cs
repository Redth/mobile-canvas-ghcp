using System.Collections.Concurrent;
using Android.Emulation.Control;
using Grpc.Core;
using Grpc.Net.Client;

namespace MobileCanvas.Android;

/// <summary>
/// A pooled gRPC connection to one running emulator.
/// </summary>
internal sealed class EmulatorConnection : IAsyncDisposable
{
	private readonly GrpcChannel _channel;
	private readonly Metadata _metadata;
	private readonly SemaphoreSlim _inputGate = new(1, 1);
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
	/// Sends one touch and waits for the emulator to acknowledge it. The client-streaming endpoint
	/// can accept writes after a guest reset without reporting that the events were discarded, which
	/// makes controls appear successful while doing nothing. The unary endpoint costs about 1 ms but
	/// gives every event a server response, and serialization keeps releases ordered after presses.
	/// </summary>
	public async Task SendTouchAsync(TouchEvent touchEvent, CancellationToken cancellationToken)
	{
		await _inputGate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			ObjectDisposedException.ThrowIf(_disposed, this);
			await Client.sendTouchAsync(
					touchEvent,
					_metadata,
					cancellationToken: cancellationToken)
				.ConfigureAwait(false);
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
	// AndroidEmulatorBackend routes every keyboard path through adb. Touch uses the acknowledged
	// unary `sendTouch` endpoint instead. Do not reintroduce a gRPC key path without first confirming
	// a keypress moves the device, not just that the call succeeds.

	public ValueTask DisposeAsync()
	{
		if (_disposed)
			return ValueTask.CompletedTask;

		_disposed = true;
		_channel.Dispose();
		_inputGate.Dispose();
		return ValueTask.CompletedTask;
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
