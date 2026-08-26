using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

public sealed class CoreSimulatorHidSessionTests
{
	[Fact]
	public async Task SendAsync_CorrelatesNumberedResult()
	{
		var process = new FakeHidProcess();
		await using var session = await StartReadyAsync(process);

		var send = session.SendAsync(
			[new IosHidTouch(10, 20, IosHidTouchPhase.Down)],
			CancellationToken.None);
		var request = await process.ReadRequestAsync();
		Assert.Equal(1, request.Id);
		Assert.Equal("events", request.Type);

		process.SendOutput("""{"id":1,"ok":true,"type":"result"}""");
		await send;
		Assert.True(session.IsUsable);
	}

	[Fact]
	public async Task SendAsync_WritesRequestsInNumberedOrder()
	{
		var process = new FakeHidProcess();
		await using var session = await StartReadyAsync(process);

		var first = session.SendAsync(
			[new IosHidKey(4, IosHidDirection.Down)],
			CancellationToken.None);
		var firstRequest = await process.ReadRequestAsync();
		var second = session.SendAsync(
			[new IosHidKey(4, IosHidDirection.Up)],
			CancellationToken.None);
		var secondRequest = await process.ReadRequestAsync();

		Assert.Equal(1, firstRequest.Id);
		Assert.Equal(2, secondRequest.Id);
		process.SendOutput("""{"id":2,"ok":true,"type":"result"}""");
		process.SendOutput("""{"id":1,"ok":true,"type":"result"}""");
		await Task.WhenAll(first, second);
	}

	[Fact]
	public async Task SendAsync_DiscardsLateCancelledReply()
	{
		var process = new FakeHidProcess();
		await using var session = await StartReadyAsync(process);
		using var cancellation = new CancellationTokenSource();

		var cancelled = session.SendAsync(
			[new IosHidDelay(0.1)],
			cancellation.Token);
		var firstRequest = await process.ReadRequestAsync();
		cancellation.Cancel();
		await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);

		process.SendOutput(
			$"{{\"id\":{firstRequest.Id},\"ok\":true,\"type\":\"result\"}}");

		var next = session.SendAsync(
			[new IosHidButtonPress(IosHidButton.Home)],
			CancellationToken.None);
		var nextRequest = await process.ReadRequestAsync();
		process.SendOutput(
			$"{{\"id\":{nextRequest.Id},\"ok\":true,\"type\":\"result\"}}");
		await next;
		Assert.True(session.IsUsable);
	}

	[Fact]
	public async Task SendAsync_CancellationAndReplyRaceDoesNotFailSession()
	{
		var process = new FakeHidProcess();
		await using var session = await StartReadyAsync(process);

		for (var index = 0; index < 100; index++)
		{
			using var cancellation = new CancellationTokenSource();
			var send = session.SendAsync(
				[new IosHidDelay(0.001)],
				cancellation.Token);
			var request = await process.ReadRequestAsync();
			using var start = new ManualResetEventSlim();
			var cancel = Task.Run(() =>
			{
				start.Wait();
				cancellation.Cancel();
			});
			var reply = Task.Run(() =>
			{
				start.Wait();
				process.SendOutput(
					$"{{\"id\":{request.Id},\"ok\":true,\"type\":\"result\"}}");
			});
			start.Set();

			try
			{
				await send;
			}
			catch (OperationCanceledException)
			{
				// Either side of the race is valid; the session must remain usable.
			}
			await Task.WhenAll(cancel, reply);
			Assert.True(session.IsUsable);
		}
	}

	[Fact]
	public async Task SendAsync_BoundsCancelledRequestTracking()
	{
		var process = new FakeHidProcess();
		await using var session = await StartReadyAsync(process);

		for (var index = 0; index < 1050; index++)
		{
			using var cancellation = new CancellationTokenSource();
			var send = session.SendAsync(
				[new IosHidDelay(0.001)],
				cancellation.Token);
			await process.ReadRequestAsync();
			cancellation.Cancel();
			await Assert.ThrowsAnyAsync<OperationCanceledException>(() => send);
		}

		Assert.InRange(session.RememberedCancellationCount, 1, 1024);
	}

	[Fact]
	public async Task SendAsync_ReportsExplicitPreDeliveryRejection()
	{
		var process = new FakeHidProcess();
		await using var session = await StartReadyAsync(process);

		var send = session.SendAsync(
			[new IosHidTouch(1, 2, IosHidTouchPhase.Move)],
			CancellationToken.None);
		var request = await process.ReadRequestAsync();
		process.SendOutput(
			$"{{\"id\":{request.Id},\"ok\":false,\"type\":\"result\","
			+ "\"code\":\"no-contact\",\"message\":\"No active contact\",\"beforeDelivery\":true}");

		var exception = await Assert.ThrowsAsync<CoreSimulatorHidException>(() => send);
		Assert.True(exception.BeforeDelivery);
		Assert.True(session.IsUsable);
	}

	[Fact]
	public async Task ProcessExitAfterReady_IsAmbiguousAndFailsPendingRequests()
	{
		var process = new FakeHidProcess();
		await using var session = await StartReadyAsync(process);

		var send = session.SendAsync(
			[new IosHidButtonPress(IosHidButton.Lock)],
			CancellationToken.None);
		await process.ReadRequestAsync();
		process.Exit(7);

		var exception = await Assert.ThrowsAsync<CoreSimulatorHidException>(() => send);
		Assert.False(exception.BeforeDelivery);
		Assert.Contains("code 7", exception.Message);
		Assert.False(session.IsUsable);
	}

	[Fact]
	public async Task MalformedResponseAfterReady_IsAmbiguous()
	{
		var process = new FakeHidProcess();
		await using var session = await StartReadyAsync(process);

		var send = session.SendAsync(
			[new IosHidButtonPress(IosHidButton.Siri)],
			CancellationToken.None);
		await process.ReadRequestAsync();
		process.SendOutput("not-json");

		var exception = await Assert.ThrowsAsync<CoreSimulatorHidException>(() => send);
		Assert.False(exception.BeforeDelivery);
		Assert.Contains("protocol corruption", exception.Message);
	}

	[Fact]
	public async Task StartupUnavailable_IsFallbackSafe()
	{
		var process = new FakeHidProcess();
		var start = CoreSimulatorHidSession.StartAsync(
			"TEST-UDID",
			process,
			TimeSpan.FromSeconds(1),
			CancellationToken.None);
		process.SendOutput(
			"""{"protocolVersion":1,"type":"unavailable","code":"framework-missing","message":"SimulatorKit missing"}""");

		var exception = await Assert.ThrowsAsync<CoreSimulatorHidException>(() => start);
		Assert.True(exception.BeforeDelivery);
		Assert.Contains("SimulatorKit missing", exception.Message);
	}

	[Fact]
	public async Task Manager_ReusesAndRemovesPerDeviceSession()
	{
		var starts = 0;
		var processes = new List<FakeHidProcess>();
		await using var manager = new CoreSimulatorHidManager(
			"/tmp/mobile-screencap",
			async (_, udid, cancellationToken) =>
			{
				starts++;
				var process = new FakeHidProcess();
				processes.Add(process);
				return await StartReadyAsync(process, udid, cancellationToken);
			});

		var first = await manager.GetAsync("TEST-UDID", CancellationToken.None);
		var second = await manager.GetAsync("test-udid", CancellationToken.None);
		Assert.Same(first, second);
		Assert.Equal(1, starts);

		await manager.RemoveAsync("TEST-UDID");
		Assert.True(processes[0].InputClosed);

		var replacement = await manager.GetAsync("TEST-UDID", CancellationToken.None);
		Assert.NotSame(first, replacement);
		Assert.Equal(2, starts);
	}

	private static async Task<CoreSimulatorHidSession> StartReadyAsync(
		FakeHidProcess process,
		string udid = "TEST-UDID",
		CancellationToken cancellationToken = default)
	{
		var start = CoreSimulatorHidSession.StartAsync(
			udid,
			process,
			TimeSpan.FromSeconds(1),
			cancellationToken);
		process.SendOutput(
			"""{"protocolVersion":1,"type":"ready","transport":"dtuhid","capabilities":["touch","keyboard","buttons"]}""");
		return await start;
	}

	private readonly record struct HidRequest(long Id, string Type);

	private sealed class FakeHidProcess : ICoreSimulatorHidProcess
	{
		private readonly Channel<string?> _output = Channel.CreateUnbounded<string?>();
		private readonly Channel<string?> _error = Channel.CreateUnbounded<string?>();
		private readonly Channel<string> _input = Channel.CreateUnbounded<string>();
		private readonly TaskCompletionSource<bool> _exit =
			new(TaskCreationOptions.RunContinuationsAsynchronously);
		private int _hasExited;
		private int? _exitCode;

		public FakeHidProcess()
		{
			StandardInput = new ChannelTextWriter(_input.Writer, () =>
			{
				InputClosed = true;
				Exit(0);
			});
			StandardOutput = new ChannelTextReader(_output.Reader);
			StandardError = new ChannelTextReader(_error.Reader);
		}

		public TextWriter StandardInput { get; }
		public TextReader StandardOutput { get; }
		public TextReader StandardError { get; }
		public bool HasExited => Volatile.Read(ref _hasExited) != 0;
		public int? ExitCode => _exitCode;
		public bool InputClosed { get; private set; }

		public void SendOutput(string line) => _output.Writer.TryWrite(line);

		public async Task<HidRequest> ReadRequestAsync()
		{
			var line = await _input.Reader.ReadAsync();
			using var document = JsonDocument.Parse(line);
			return new HidRequest(
				document.RootElement.GetProperty("id").GetInt64(),
				document.RootElement.GetProperty("type").GetString()!);
		}

		public void Exit(int exitCode)
		{
			if (Interlocked.Exchange(ref _hasExited, 1) != 0)
				return;
			_exitCode = exitCode;
			_output.Writer.TryComplete();
			_error.Writer.TryComplete();
			_input.Writer.TryComplete();
			_exit.TrySetResult(true);
		}

		public void Kill() => Exit(-1);

		public Task WaitForExitAsync(CancellationToken cancellationToken) =>
			_exit.Task.WaitAsync(cancellationToken);

		public ValueTask DisposeAsync()
		{
			Exit(_exitCode ?? 0);
			return ValueTask.CompletedTask;
		}
	}

	private sealed class ChannelTextReader(ChannelReader<string?> reader) : TextReader
	{
		public override async ValueTask<string?> ReadLineAsync(CancellationToken cancellationToken)
		{
			try
			{
				return await reader.ReadAsync(cancellationToken);
			}
			catch (ChannelClosedException)
			{
				return null;
			}
		}
	}

	private sealed class ChannelTextWriter(
		ChannelWriter<string> writer,
		Action dispose) : TextWriter
	{
		private int _disposed;

		public override Encoding Encoding => Encoding.UTF8;

		public override Task WriteLineAsync(string? value)
		{
			if (Volatile.Read(ref _disposed) != 0)
				throw new ObjectDisposedException(nameof(ChannelTextWriter));
			if (!writer.TryWrite(value ?? ""))
				throw new IOException("The fake HID input channel is closed.");
			return Task.CompletedTask;
		}

		public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;

		public override ValueTask DisposeAsync()
		{
			if (Interlocked.Exchange(ref _disposed, 1) == 0)
				dispose();
			return ValueTask.CompletedTask;
		}
	}
}
