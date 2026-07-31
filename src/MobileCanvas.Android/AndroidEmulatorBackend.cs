using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;
using MobileCanvas.Contracts;
using MobileCanvas.Core;
using Android.Emulation.Control;
using Grpc.Core;
using Microsoft.Extensions.Logging;

namespace MobileCanvas.Android;

/// <summary>
/// Android Emulator backend built on the emulator's own gRPC control service
/// (<c>android.emulation.control.EmulatorController</c>), with adb and the SDK command-line tools
/// covering catalog and lifecycle.
/// </summary>
/// <remarks>
/// The transport choice was settled by measurement, not by porting the iOS design.
/// <c>adb exec-out screenrecord</c> has idb's exact fatal flaw (one IDR for an entire stream, so a
/// corrupt picture never recovers) and <c>adb shell input</c> measured 53 ms median / 4301 ms worst
/// case per event because it spawns a host process and an on-device JVM. The emulator's gRPC service
/// delivers ~50 FPS at every resolution including full native, and 0.03 ms median input latency over
/// a persistent <c>streamInputEvent</c> call.
/// </remarks>
public sealed partial class AndroidEmulatorBackend : IDeviceBackend, IAsyncDisposable
{
	private const string ProviderId = "android-emulator";

	private readonly AndroidSdkLocator _locator = new();
	private readonly EmulatorConnectionPool _connections = new();
	private readonly EmulatorDiscovery _discovery;
	private readonly IProcessRunner _processRunner;
	private readonly ILogger<AndroidEmulatorBackend> _logger;
	private readonly AndroidRecordingManager _recordings;

	// Running-instance cache. Reading discovery files is a handful of file reads rather than a
	// process spawn, but the iOS work proved that anything on the per-event path needs a cache, and
	// this also keeps a gesture pinned to one emulator instance while it is in flight.
	private readonly SemaphoreSlim _cacheGate = new(1, 1);
	private readonly Dictionary<string, CachedInstance> _instanceCache = new(StringComparer.OrdinalIgnoreCase);
	private static readonly TimeSpan InstanceCacheTtl = TimeSpan.FromSeconds(3);

	private readonly Lock _geometryLock = new();
	private readonly Dictionary<string, DisplayGeometry> _geometryCache = new(StringComparer.OrdinalIgnoreCase);

	public AndroidEmulatorBackend(IProcessRunner processRunner, ILogger<AndroidEmulatorBackend> logger)
	{
		_processRunner = processRunner;
		_logger = logger;
		_discovery = new EmulatorDiscovery(_locator, processRunner);
		_recordings = new AndroidRecordingManager(this, logger);
	}

	public string Platform => DevicePlatforms.Android;

	private sealed record CachedInstance(EmulatorInstance Instance, long Timestamp);

	#region Catalog

	public async Task<DeviceCatalog> GetCatalogAsync(CancellationToken cancellationToken = default)
	{
		var checks = _locator.Check();
		var diagnostics = new HostDiagnostics
		{
			Platform = DevicePlatforms.Android,
			Ready = checks.All(c => c.Status != "missing" && c.Status != "error"),
			Checks = checks,
		};

		if (!diagnostics.Ready)
			return new DeviceCatalog { Diagnostics = [diagnostics] };

		var devices = await ListDevicesCoreAsync(cancellationToken).ConfigureAwait(false);
		var deviceTypes = await ListDeviceTypesAsync(cancellationToken).ConfigureAwait(false);

		return new DeviceCatalog
		{
			Devices = devices,
			Runtimes = BuildRuntimes(devices),
			DeviceTypes = deviceTypes,
			Diagnostics = [diagnostics],
		};
	}

	public async Task<DeviceTarget[]> ListDevicesAsync(CancellationToken cancellationToken = default)
	{
		if (_locator.Emulator is null)
			return [];

		return await ListDevicesCoreAsync(cancellationToken).ConfigureAwait(false);
	}

	private async Task<DeviceTarget[]> ListDevicesCoreAsync(CancellationToken cancellationToken)
	{
		var avds = await _discovery.ListAvdsAsync(cancellationToken).ConfigureAwait(false);
		var running = _discovery.GetRunningInstances();
		var adbDevices = await _discovery.ListAdbDevicesAsync(cancellationToken).ConfigureAwait(false);

		PruneGeometryCache(running);

		var runningByAvd = new Dictionary<string, EmulatorInstance>(StringComparer.OrdinalIgnoreCase);
		foreach (var instance in running)
			runningByAvd[instance.AvdId] = instance;

		var adbBySerial = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
		foreach (var (serial, state) in adbDevices)
			adbBySerial[serial] = state;

		var targets = new List<DeviceTarget>();

		// A configured AVD and a running instance are the same logical device, so a running instance
		// must never produce a second entry.
		foreach (var avd in avds)
		{
			runningByAvd.TryGetValue(avd, out var instance);
			targets.Add(await BuildTargetAsync(avd, instance, adbBySerial, cancellationToken).ConfigureAwait(false));
		}

		// An emulator started from an AVD home we cannot enumerate still deserves to be controllable.
		foreach (var instance in running)
		{
			if (avds.Contains(instance.AvdId, StringComparer.OrdinalIgnoreCase))
				continue;

			targets.Add(await BuildTargetAsync(instance.AvdId, instance, adbBySerial, cancellationToken)
				.ConfigureAwait(false));
		}

		return [.. targets
			.OrderByDescending(t => t.State == DeviceStates.Booted)
			.ThenBy(t => t.Name, StringComparer.OrdinalIgnoreCase)];
	}

	public async Task<DeviceTarget> GetDeviceAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		var devices = await ListDevicesCoreAsync(cancellationToken).ConfigureAwait(false);
		return devices.FirstOrDefault(d => string.Equals(d.Id, deviceId, StringComparison.OrdinalIgnoreCase))
			?? throw new DeviceNotFoundException(deviceId);
	}

	private async Task<DeviceTarget> BuildTargetAsync(
		string avdId,
		EmulatorInstance? instance,
		Dictionary<string, string> adbBySerial,
		CancellationToken cancellationToken)
	{
		var serial = instance?.Serial;
		var adbState = serial is not null && adbBySerial.TryGetValue(serial, out var s) ? s : null;

		var state = instance is null
			? DeviceStates.Shutdown
			: adbState == "device" ? DeviceStates.Booted : DeviceStates.Booting;

		var config = ReadAvdConfig(instance?.AvdDirectory ?? FindAvdDirectory(avdId));

		DisplayGeometry? display = null;
		if (state == DeviceStates.Booted && instance is not null)
			display = await TryGetGeometryAsync(instance, cancellationToken).ConfigureAwait(false);

		return new DeviceTarget
		{
			Id = DeviceIdentity.Create(Platform, ProviderId, avdId),
			Platform = Platform,
			Provider = ProviderId,
			NativeId = avdId,
			// `udid` is the field a deploy command consumes. On Android that is the adb serial, which
			// is what `adb -s` / `dotnet build -t:Run` expect, not the AVD name.
			Udid = serial,
			Name = instance?.AvdName ?? PrettifyAvdName(avdId),
			State = state,
			IsAvailable = true,
			IsVirtual = true,
			RuntimeId = config.GetValueOrDefault("image.sysdir.1"),
			RuntimeName = DescribeRuntime(config),
			OsVersion = DescribeApiLevel(config),
			DeviceTypeId = config.GetValueOrDefault("hw.device.name"),
			DeviceTypeName = PrettifyAvdName(config.GetValueOrDefault("hw.device.name") ?? ""),
			ModelIdentifier = config.GetValueOrDefault("hw.device.manufacturer"),
			Architecture = config.GetValueOrDefault("abi.type") ?? config.GetValueOrDefault("hw.cpu.arch"),
			Display = display,
			Capabilities = BuildCapabilities(instance),
		};
	}

	/// <summary>
	/// Capabilities are reported per instance, not per platform, because an emulator that started
	/// without gRPC genuinely cannot stream or take low-latency input. Reporting it honestly lets the
	/// canvas explain the restart instead of presenting a dead viewport.
	/// </summary>
	private static DeviceCapabilities BuildCapabilities(EmulatorInstance? instance)
	{
		var grpc = instance?.HasGrpc == true;
		return new DeviceCapabilities
		{
			Boot = true,
			Shutdown = true,
			Restart = true,
			Erase = true,
			Delete = true,
			Reveal = false,
			Tap = true,
			LongPress = true,
			Swipe = true,
			Scroll = true,
			Text = true,
			Key = true,
			Button = true,
			Rotate = grpc,
			Screenshot = true,
			LiveStream = grpc && AndroidVideoEncoder.IsAvailable,
			Recording = grpc && AndroidVideoEncoder.IsAvailable,
		};
	}

	private static DeviceRuntime[] BuildRuntimes(DeviceTarget[] devices)
	{
		// sdkmanager is slow and network-aware, so runtimes are derived from what the configured AVDs
		// actually reference. That is also the only set a user can create against offline.
		return [.. devices
			.Where(d => !string.IsNullOrEmpty(d.RuntimeId))
			.GroupBy(d => d.RuntimeId!, StringComparer.OrdinalIgnoreCase)
			.Select(g => new DeviceRuntime
			{
				Id = ToSystemImagePackage(g.Key),
				Name = g.First().RuntimeName ?? g.Key,
				Version = g.First().OsVersion ?? "",
				Platform = DevicePlatforms.Android,
				IsAvailable = true,
				SupportedArchitectures = [.. g.Select(d => d.Architecture)
					.Where(a => !string.IsNullOrEmpty(a))
					.Distinct(StringComparer.OrdinalIgnoreCase)!],
			})
			.OrderBy(r => r.Name, StringComparer.OrdinalIgnoreCase)];
	}

	private async Task<DeviceType[]> ListDeviceTypesAsync(CancellationToken cancellationToken)
	{
		if (_locator.AvdManager is null)
			return [];

		try
		{
			var result = await _processRunner
				.RunAsync(new ProcessRequest(_locator.AvdManager, ["list", "device", "-c"]), cancellationToken)
				.ConfigureAwait(false);

			if (result.ExitCode != 0)
				return [];

			return [.. result.StandardOutput
				.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
				.Where(static line => line.Length > 0 && line[0] != '[' && !line.Contains(':', StringComparison.Ordinal))
				.Distinct(StringComparer.OrdinalIgnoreCase)
				.Select(static id => new DeviceType
				{
					Id = id,
					Name = PrettifyAvdName(id),
					Platform = DevicePlatforms.Android,
					ProductFamily = DevicePlatforms.Android,
				})];
		}
		catch (Exception exception) when (exception is not OperationCanceledException)
		{
			_logger.LogDebug(exception, "Failed to enumerate Android device types.");
			return [];
		}
	}

	#endregion

	#region Lifecycle

	public async Task<DeviceTarget> CreateAsync(
		CreateDeviceRequest request,
		CancellationToken cancellationToken = default)
	{
		if (_locator.AvdManager is null)
		{
			throw new DeviceCapabilityException(
				"avdmanager was not found. Install the Android SDK 'cmdline-tools;latest' package to create AVDs.");
		}

		if (string.IsNullOrWhiteSpace(request.RuntimeId))
			throw new ArgumentException("A system image (runtimeId) is required to create an AVD.", nameof(request));

		var name = SanitizeAvdName(request.Name);
		var arguments = new List<string>
		{
			"create", "avd", "--name", name, "--package", request.RuntimeId, "--force",
		};

		if (!string.IsNullOrWhiteSpace(request.DeviceTypeId))
		{
			arguments.Add("--device");
			arguments.Add(request.DeviceTypeId);
		}

		// avdmanager prompts on stdin for a custom hardware profile; "no" accepts the image default.
		var result = await _processRunner
			.RunAsync(new ProcessRequest(_locator.AvdManager, [.. arguments], StandardInput: "no\n"), cancellationToken)
			.ConfigureAwait(false);

		if (result.ExitCode != 0)
			throw new ProcessExecutionException(_locator.AvdManager, arguments, result);

		return await GetDeviceAsync(
			DeviceIdentity.Create(Platform, ProviderId, name),
			cancellationToken).ConfigureAwait(false);
	}

	public async Task<DeviceTarget> BootAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		var avdId = DeviceIdentity.GetNativeId(deviceId);
		InvalidateCache(avdId);

		if (FindRunning(avdId) is null)
			await LaunchEmulatorAsync(avdId, wipeData: false, cancellationToken).ConfigureAwait(false);

		await WaitForBootAsync(avdId, cancellationToken).ConfigureAwait(false);
		InvalidateCache(avdId);
		return await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
	}

	/// <summary>
	/// Launches an emulator with the two flags that decide whether Mobile Canvas can use it at all.
	/// </summary>
	/// <remarks>
	/// <c>-grpc</c> is mandatory rather than optional: the emulator only auto-enables gRPC on port
	/// 8554, and only for the first instance. A second emulator silently starts without it and prints
	/// nothing, which would leave the canvas with no video and no fast input.
	/// <c>-gpu host</c> is equally load-bearing: the same capture code measured 3 FPS against a
	/// software-rendered AVD and 50 FPS with host GPU.
	/// </remarks>
	private async Task LaunchEmulatorAsync(string avdId, bool wipeData, CancellationToken cancellationToken)
	{
		if (_locator.Emulator is null)
			throw new DeviceCapabilityException("The Android emulator executable was not found.");

		var grpcPort = FindFreePort();
		var arguments = new List<string>
		{
			"-avd", avdId,
			"-grpc", grpcPort.ToString(CultureInfo.InvariantCulture),
			"-gpu", "host",
			"-no-snapshot-save",
		};

		if (wipeData)
			arguments.Add("-wipe-data");

		_logger.LogInformation("Launching emulator {Avd} with gRPC on port {Port}.", avdId, grpcPort);

		var startInfo = new ProcessStartInfo(_locator.Emulator)
		{
			UseShellExecute = false,
			CreateNoWindow = true,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
		};

		foreach (var argument in arguments)
			startInfo.ArgumentList.Add(argument);

		var process = Process.Start(startInfo)
			?? throw new InvalidOperationException($"Failed to start '{_locator.Emulator}'.");

		// The emulator runs for the life of the device, so its pipes must be drained or it blocks on
		// a full buffer partway through boot.
		DrainAsync(process);

		// Surface an immediate launch failure (bad AVD name, locked AVD) as an error instead of a
		// five-minute boot timeout.
		await Task.Delay(TimeSpan.FromMilliseconds(750), cancellationToken).ConfigureAwait(false);
		if (process.HasExited && process.ExitCode != 0)
			throw new InvalidOperationException($"The emulator exited immediately with code {process.ExitCode}.");

		static void DrainAsync(Process process)
		{
			_ = Task.Run(async () =>
			{
				try
				{
					await Task.WhenAll(
						process.StandardOutput.ReadToEndAsync(),
						process.StandardError.ReadToEndAsync()).ConfigureAwait(false);
				}
				catch (Exception)
				{
					// The emulator exited and closed its pipes.
				}
			});
		}
	}

	private async Task WaitForBootAsync(string avdId, CancellationToken cancellationToken)
	{
		using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		timeout.CancelAfter(TimeSpan.FromMinutes(5));

		try
		{
			while (true)
			{
				timeout.Token.ThrowIfCancellationRequested();
				var instance = FindRunning(avdId);

				if (instance?.HasGrpc == true)
				{
					try
					{
						var connection = await _connections.GetAsync(instance, timeout.Token).ConfigureAwait(false);
						var status = await connection.Client
							.getStatusAsync(
								new Google.Protobuf.WellKnownTypes.Empty(),
								connection.Metadata,
								cancellationToken: timeout.Token)
							.ConfigureAwait(false);

						if (status.Booted)
							return;
					}
					catch (RpcException)
					{
						// The service accepts connections before the guest finishes booting.
					}
				}
				else if (instance?.Serial is { } serial &&
					await IsBootCompletedAsync(serial, timeout.Token).ConfigureAwait(false))
				{
					return;
				}

				await Task.Delay(TimeSpan.FromSeconds(1), timeout.Token).ConfigureAwait(false);
			}
		}
		catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
		{
			throw new TimeoutException($"Emulator '{avdId}' did not finish booting within 5 minutes.");
		}
	}

	private async Task<bool> IsBootCompletedAsync(string serial, CancellationToken cancellationToken)
	{
		var output = await RunAdbAsync(serial, ["shell", "getprop", "sys.boot_completed"], cancellationToken)
			.ConfigureAwait(false);
		return output?.Trim() == "1";
	}

	public async Task<DeviceTarget> ShutdownAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		var avdId = DeviceIdentity.GetNativeId(deviceId);
		var instance = FindRunning(avdId);
		InvalidateCache(avdId);

		if (instance is null)
			return await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);

		await _recordings.StopQuietlyAsync(deviceId).ConfigureAwait(false);

		var stopped = false;
		if (instance.HasGrpc)
		{
			try
			{
				var connection = await _connections.GetAsync(instance, cancellationToken).ConfigureAwait(false);
				await connection.Client
					.setVmStateAsync(
						new VmRunState { State = VmRunState.Types.RunState.Shutdown },
						connection.Metadata,
						cancellationToken: cancellationToken)
					.ConfigureAwait(false);
				stopped = true;
			}
			catch (RpcException exception)
			{
				_logger.LogDebug(exception, "gRPC shutdown failed for {Avd}; falling back to adb.", avdId);
			}
		}

		if (!stopped && instance.Serial is { } serial)
			await RunAdbAsync(serial, ["emu", "kill"], cancellationToken).ConfigureAwait(false);

		await _connections.RemoveAsync(avdId).ConfigureAwait(false);
		await WaitForExitAsync(avdId, cancellationToken).ConfigureAwait(false);
		InvalidateCache(avdId);

		return await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
	}

	/// <summary>
	/// Waits for the emulator's discovery file to disappear. Relaunching before it does produces a
	/// second instance that silently starts without gRPC, because the ports are still held.
	/// </summary>
	private async Task WaitForExitAsync(string avdId, CancellationToken cancellationToken)
	{
		using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		timeout.CancelAfter(TimeSpan.FromSeconds(45));

		try
		{
			while (FindRunning(avdId) is not null)
				await Task.Delay(TimeSpan.FromMilliseconds(400), timeout.Token).ConfigureAwait(false);
		}
		catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
		{
			_logger.LogWarning("Emulator {Avd} did not release its ports within 45 seconds.", avdId);
		}
	}

	public async Task<DeviceTarget> RestartAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		await ShutdownAsync(deviceId, cancellationToken).ConfigureAwait(false);
		return await BootAsync(deviceId, cancellationToken).ConfigureAwait(false);
	}

	public async Task<DeviceTarget> EraseAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		var avdId = DeviceIdentity.GetNativeId(deviceId);
		await ShutdownAsync(deviceId, cancellationToken).ConfigureAwait(false);

		// -wipe-data only takes effect at launch, so erasing means relaunching.
		await LaunchEmulatorAsync(avdId, wipeData: true, cancellationToken).ConfigureAwait(false);
		await WaitForBootAsync(avdId, cancellationToken).ConfigureAwait(false);
		InvalidateCache(avdId);

		return await GetDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
	}

	public async Task DeleteAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		if (_locator.AvdManager is null)
		{
			throw new DeviceCapabilityException(
				"avdmanager was not found. Install the Android SDK 'cmdline-tools;latest' package to delete AVDs.");
		}

		var avdId = DeviceIdentity.GetNativeId(deviceId);
		await ShutdownAsync(deviceId, cancellationToken).ConfigureAwait(false);

		var arguments = new[] { "delete", "avd", "--name", avdId };
		var result = await _processRunner
			.RunAsync(new ProcessRequest(_locator.AvdManager, arguments), cancellationToken)
			.ConfigureAwait(false);

		if (result.ExitCode != 0)
			throw new ProcessExecutionException(_locator.AvdManager, arguments, result);

		InvalidateCache(avdId);
	}

	public Task<DeviceTarget> RevealAsync(string deviceId, CancellationToken cancellationToken = default) =>
		throw new DeviceCapabilityException(
			"Emulators have no window to reveal; Mobile Canvas launches them headless-capable and renders them in the canvas.");

	#endregion

	#region Input

	public async Task TapAsync(string deviceId, TapRequest request, CancellationToken cancellationToken = default)
	{
		var connection = await RequireConnectionAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var (x, y) = await ToDeviceCoordinatesAsync(connection, request.X, request.Y, cancellationToken)
			.ConfigureAwait(false);

		await SendTouchAsync(connection, x, y, pressure: 1, cancellationToken).ConfigureAwait(false);

		if (request.Duration > 0)
			await Task.Delay(TimeSpan.FromSeconds(Math.Min(request.Duration, 10)), cancellationToken).ConfigureAwait(false);

		await SendTouchAsync(connection, x, y, pressure: 0, cancellationToken).ConfigureAwait(false);
	}

	public async Task TouchAsync(string deviceId, TouchRequest request, CancellationToken cancellationToken = default)
	{
		var connection = await RequireConnectionAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var (x, y) = await ToDeviceCoordinatesAsync(connection, request.X, request.Y, cancellationToken)
			.ConfigureAwait(false);

		// pressure > 0 is down/move, pressure == 0 is release. The release MUST be delivered or the
		// touch slot leaks and every later gesture is silently swallowed, which is the same
		// stuck-finger hazard the iOS serial gesture chain guards against.
		var pressure = request.Phase == TouchPhases.Up ? 0 : 1;
		await SendTouchAsync(connection, x, y, pressure, cancellationToken).ConfigureAwait(false);
	}

	public async Task SwipeAsync(string deviceId, SwipeRequest request, CancellationToken cancellationToken = default)
	{
		var connection = await RequireConnectionAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var start = await ToDeviceCoordinatesAsync(connection, request.StartX, request.StartY, cancellationToken)
			.ConfigureAwait(false);
		var end = await ToDeviceCoordinatesAsync(connection, request.EndX, request.EndY, cancellationToken)
			.ConfigureAwait(false);

		var duration = TimeSpan.FromSeconds(Math.Clamp(request.Duration, 0.05, 5));
		var steps = Math.Clamp((int)(duration.TotalMilliseconds / 16), 2, 120);
		var stepDelay = duration / steps;

		await SendTouchAsync(connection, start.X, start.Y, pressure: 1, cancellationToken).ConfigureAwait(false);
		try
		{
			for (var step = 1; step <= steps; step++)
			{
				var progress = (double)step / steps;
				var x = (int)Math.Round(start.X + ((end.X - start.X) * progress));
				var y = (int)Math.Round(start.Y + ((end.Y - start.Y) * progress));
				await SendTouchAsync(connection, x, y, pressure: 1, cancellationToken).ConfigureAwait(false);
				await Task.Delay(stepDelay, cancellationToken).ConfigureAwait(false);
			}
		}
		finally
		{
			// A cancelled swipe must still release, or the slot stays down forever.
			await SendTouchAsync(connection, end.X, end.Y, pressure: 0, CancellationToken.None)
				.ConfigureAwait(false);
		}
	}

	public async Task TypeTextAsync(string deviceId, string text, CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrEmpty(text))
			return;

		// Text goes through adb for the same reason buttons do: the emulator accepts a
		// KeyboardEvent over both `streamInputEvent` and the unary `sendKey`, reports success, and
		// never delivers a character. Verified against a focused text field on emulator 36.x.
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);
		await RunAdbAsync(
			serial,
			["shell", "input", "text", QuoteForDeviceShell(text)],
			cancellationToken).ConfigureAwait(false);
	}

	// `adb shell` joins its arguments into a command line that the device's shell re-parses, so the
	// text must be quoted there as well as passed as a single argv entry. Without this, spaces split
	// the string and `& ; $ ( ) ' "` are interpreted as shell syntax on the device.
	private static string QuoteForDeviceShell(string value) =>
		$"'{value.Replace("'", "'\\''", StringComparison.Ordinal)}'";

	public async Task PressKeyAsync(string deviceId, ulong keyCode, CancellationToken cancellationToken = default)
	{
		// Same gRPC keyboard limitation as TypeTextAsync and PressButtonAsync.
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);
		if (AndroidKeyMap.UsbToAndroidKeyEvent(keyCode) is { } androidKey)
			await RunAdbAsync(serial, ["shell", "input", "keyevent", androidKey], cancellationToken).ConfigureAwait(false);
		else
			throw new DeviceCapabilityException($"Key code 0x{keyCode:X} has no Android key mapping.");
	}

	public async Task PressButtonAsync(string deviceId, string button, CancellationToken cancellationToken = default)
	{
		// System buttons go through adb, not gRPC. The emulator's KeyboardEvent carries a `key` field
		// documented to accept the W3C phone keys ("GoHome", "GoBack", "AppSwitch", "Power"), but on
		// emulator 36.x those are accepted and silently ignored over both `streamInputEvent` and the
		// unary `sendKey` -- the call reports success and the device never moves. `adb shell input
		// keyevent` was verified to work on the same emulator in the same state. A button press is
		// discrete rather than per-frame, so adb's ~50 ms is imperceptible here; the latency that
		// actually matters is on the touch path, which stays on gRPC.
		var androidKey = button.ToLowerInvariant() switch
		{
			"home" => "KEYCODE_HOME",
			"back" => "KEYCODE_BACK",
			"apps" or "recents" or "app-switch" => "KEYCODE_APP_SWITCH",
			"lock" or "power" => "KEYCODE_POWER",
			"volume-up" or "volumeup" => "KEYCODE_VOLUME_UP",
			"volume-down" or "volumedown" => "KEYCODE_VOLUME_DOWN",
			"menu" => "KEYCODE_MENU",
			_ => throw new ArgumentException(
				"Button must be home, back, apps, lock, volume-up, volume-down, or menu.",
				nameof(button)),
		};

		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);
		await RunAdbAsync(serial, ["shell", "input", "keyevent", androidKey], cancellationToken).ConfigureAwait(false);
	}

	public async Task RotateAsync(string deviceId, string orientation, CancellationToken cancellationToken = default)
	{
		var degrees = orientation.ToLowerInvariant() switch
		{
			"portrait" => 0f,
			"landscape" or "landscape-left" or "landscapeleft" => 90f,
			"portrait-upside-down" or "portraitupsidedown" => 180f,
			"landscape-right" or "landscaperight" => 270f,
			_ => throw new ArgumentException(
				"Orientation must be portrait, landscape, portrait-upside-down, or landscape-right.",
				nameof(orientation)),
		};

		var connection = await RequireConnectionAsync(deviceId, cancellationToken).ConfigureAwait(false);
		await connection.Client
			.setPhysicalModelAsync(
				new PhysicalModelValue
				{
					Target = PhysicalModelValue.Types.PhysicalType.Rotation,
					Value = new ParameterValue { Data = { 0f, 0f, -degrees } },
				},
				connection.Metadata,
				cancellationToken: cancellationToken)
			.ConfigureAwait(false);

		// Rotation changes the frame size, so the cached geometry is now wrong.
		lock (_geometryLock)
			_geometryCache.Remove(DeviceIdentity.GetNativeId(deviceId));
	}

	private static Task SendTouchAsync(
		EmulatorConnection connection,
		int x,
		int y,
		int pressure,
		CancellationToken cancellationToken) =>
		connection.SendInputAsync(
			new InputEvent
			{
				TouchEvent = new TouchEvent
				{
					Touches = { new Touch { X = x, Y = y, Identifier = 0, Pressure = pressure } },
				},
			},
			cancellationToken);

	#endregion

	#region Media

	public async Task<byte[]> ScreenshotAsync(string deviceId, CancellationToken cancellationToken = default)
	{
		var connection = await TryGetConnectionAsync(deviceId, cancellationToken).ConfigureAwait(false);
		if (connection is not null)
		{
			var image = await connection.Client
				.getScreenshotAsync(
					new ImageFormat { Format = ImageFormat.Types.ImgFormat.Png },
					connection.Metadata,
					cancellationToken: cancellationToken)
				.ConfigureAwait(false);

			// Protobuf renames a field that collides with its message name, so `Image.image` is
			// generated as `Image_`.
			return image.Image_.ToByteArray();
		}

		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var bytes = await RunAdbBinaryAsync(serial, ["exec-out", "screencap", "-p"], cancellationToken)
			.ConfigureAwait(false);

		return bytes.Length > 0
			? bytes
			: throw new InvalidOperationException($"Screenshot failed for '{deviceId}'.");
	}

	public async Task<ILiveVideoSession> OpenVideoStreamAsync(
		string deviceId,
		StreamOptions options,
		CancellationToken cancellationToken = default)
	{
		var connection = await RequireConnectionAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var display = await GetDisplayAsync(deviceId, cancellationToken).ConfigureAwait(false);

		return await AndroidLiveVideoSession
			.StartAsync(connection, options, display, _logger, cancellationToken)
			.ConfigureAwait(false);
	}

	public Task<RecordingStatus> StartRecordingAsync(
		string deviceId,
		RecordingStartRequest request,
		CancellationToken cancellationToken = default) =>
		_recordings.StartAsync(deviceId, request, cancellationToken);

	public Task<RecordingStatus> StopRecordingAsync(
		string deviceId,
		CancellationToken cancellationToken = default) =>
		_recordings.StopAsync(deviceId, cancellationToken);

	public Task<RecordingStatus> GetRecordingStatusAsync(
		string deviceId,
		CancellationToken cancellationToken = default) =>
		Task.FromResult(_recordings.GetStatus(deviceId));

	#endregion

	#region UI hierarchy

	public async Task<UiSnapshot> GetUiSnapshotAsync(
		string deviceId,
		bool includeRaw,
		CancellationToken cancellationToken = default)
	{
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);

		// Dumping to /dev/tty writes the hierarchy straight to stdout. The alternative writes a file on
		// the device and needs a second call to pull it back, which doubles the cost of every capture.
		var dump = await RunAdbAsync(serial, ["exec-out", "uiautomator", "dump", "/dev/tty"], cancellationToken)
			.ConfigureAwait(false)
			?? throw new DeviceCapabilityException(
				$"Could not read the view hierarchy from '{serial}'. uiautomator may be busy or the screen may be off.");

		var display = await GetDisplayAsync(deviceId, cancellationToken).ConfigureAwait(false);

		// uiautomator reports its own failures on stdout and still exits zero -- most often
		// "ERROR: could not get idle state." when something on screen never stops animating. Without
		// this the parser returns nothing and the snapshot claims an empty screen, so a caller reads a
		// broken capture as a screen with no elements on it.
		var root = UiAutomatorParser.Parse(dump, display.Scale)
			?? throw new DeviceCapabilityException(
				$"uiautomator could not capture the view hierarchy on '{serial}': {Summarize(dump)} "
				+ "This usually means something on screen is still animating. Retry, or fall back to a screenshot.");

		return new UiSnapshot
		{
			DeviceId = deviceId,
			Platform = DevicePlatforms.Android,
			Root = root,
			ElementCount = UiTree.Count(root),
			Raw = includeRaw ? dump : null,
		};
	}

	/// <summary>
	/// Condenses uiautomator's output into one line fit for an error message. The output is short when
	/// it failed and enormous when it did not, so it is capped rather than trusted.
	/// </summary>
	private static string Summarize(string dump)
	{
		var text = dump.ReplaceLineEndings(" ").Trim();
		if (text.Length == 0)
			return "it produced no output.";

		return text.Length <= 200 ? text : string.Concat(text.AsSpan(0, 200), "...");
	}

	#endregion

	#region Geometry

	public async Task<DisplayGeometry> GetDisplayAsync(
		string deviceId,
		CancellationToken cancellationToken = default)
	{
		var avdId = DeviceIdentity.GetNativeId(deviceId);
		var instance = await ResolveInstanceAsync(avdId, cancellationToken).ConfigureAwait(false)
			?? throw new DeviceCapabilityException($"Emulator '{avdId}' is not running.");

		return await TryGetGeometryAsync(instance, cancellationToken).ConfigureAwait(false)
			?? throw new InvalidOperationException($"Could not determine the display geometry for '{avdId}'.");
	}

	private async Task<DisplayGeometry?> TryGetGeometryAsync(
		EmulatorInstance instance,
		CancellationToken cancellationToken)
	{
		lock (_geometryLock)
		{
			if (_geometryCache.TryGetValue(instance.AvdId, out var cached))
				return cached;
		}

		var geometry = await ReadGeometryAsync(instance, cancellationToken).ConfigureAwait(false);
		if (geometry is not null)
		{
			lock (_geometryLock)
				_geometryCache[instance.AvdId] = geometry;
		}

		return geometry;
	}

	private async Task<DisplayGeometry?> ReadGeometryAsync(
		EmulatorInstance instance,
		CancellationToken cancellationToken)
	{
		if (instance.HasGrpc)
		{
			try
			{
				var connection = await _connections.GetAsync(instance, cancellationToken).ConfigureAwait(false);
				var status = await connection.Client
					.getStatusAsync(
						new Google.Protobuf.WellKnownTypes.Empty(),
						connection.Metadata,
						cancellationToken: cancellationToken)
					.ConfigureAwait(false);

				var entries = status.HardwareConfig?.Entry;
				var width = FindHardwareInt(entries, "hw.lcd.width");
				var height = FindHardwareInt(entries, "hw.lcd.height");
				var density = FindHardwareInt(entries, "hw.lcd.density");

				if (width > 0 && height > 0)
				{
					return await WithCornersAsync(Build(width, height, density), instance, cancellationToken)
						.ConfigureAwait(false);
				}
			}
			catch (RpcException exception)
			{
				_logger.LogDebug(exception, "gRPC geometry lookup failed for {Avd}; falling back to adb.", instance.AvdId);
			}
		}

		if (instance.Serial is not { } serial)
			return null;

		var sizeOutput = await RunAdbAsync(serial, ["shell", "wm", "size"], cancellationToken).ConfigureAwait(false);
		if (sizeOutput is null || EmulatorDiscoveryParser.ParseWmSize(sizeOutput) is not { } size)
			return null;

		var densityOutput = await RunAdbAsync(serial, ["shell", "wm", "density"], cancellationToken).ConfigureAwait(false);
		var parsedDensity = densityOutput is null ? 0 : EmulatorDiscoveryParser.ParseWmDensity(densityOutput) ?? 0;

		return await WithCornersAsync(
				Build(size.Width, size.Height, parsedDensity),
				instance,
				cancellationToken)
			.ConfigureAwait(false);

		static DisplayGeometry Build(int width, int height, int density)
		{
			// Android reports density in dpi; the shared contract wants a point-to-pixel scale, and
			// 160 dpi is the mdpi baseline that defines one density-independent pixel.
			var scale = density > 0 ? density / 160.0 : 1.0;
			return new DisplayGeometry
			{
				PixelWidth = width,
				PixelHeight = height,
				PointWidth = Math.Round(width / scale, 2),
				PointHeight = Math.Round(height / scale, 2),
				Scale = Math.Round(scale, 3),
				Orientation = width > height ? "landscape" : "portrait",
			};
		}
	}

	/// <summary>
	/// Adds the panel's rounded-corner radius, which only the guest OS knows: the emulator hands out
	/// a square framebuffer and the hardware config carries no corner geometry, so without this the
	/// canvas would draw sharp corners on a device that has none. A failed lookup leaves the radius
	/// unknown rather than failing the whole geometry read.
	/// </summary>
	private async Task<DisplayGeometry> WithCornersAsync(
		DisplayGeometry geometry,
		EmulatorInstance instance,
		CancellationToken cancellationToken)
	{
		if (instance.Serial is not { } serial)
			return geometry;

		var output = await RunAdbAsync(serial, ["shell", "dumpsys", "display"], cancellationToken)
			.ConfigureAwait(false);
		if (output is null || EmulatorDiscoveryParser.ParseRoundedCornerRadius(output) is not { } pixels)
			return geometry;

		var scale = geometry.Scale > 0 ? geometry.Scale : 1.0;
		return geometry with
		{
			CornerRadius = Math.Round(pixels / scale, 2),
			CornerCurve = DisplayCornerCurves.Circular,
		};
	}

	private static int FindHardwareInt(IEnumerable<Entry>? entries, string key)
	{
		var raw = entries?.FirstOrDefault(e => string.Equals(e.Key, key, StringComparison.OrdinalIgnoreCase))?.Value;
		return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) ? value : 0;
	}

	/// <summary>
	/// Clamps a canvas point into the guest display so a gesture that leaves the frame becomes an
	/// edge touch rather than an out-of-range coordinate the emulator drops.
	/// </summary>
	private async Task<(int X, int Y)> ToDeviceCoordinatesAsync(
		EmulatorConnection connection,
		double x,
		double y,
		CancellationToken cancellationToken)
	{
		var geometry = await TryGetGeometryAsync(connection.Instance, cancellationToken).ConfigureAwait(false);
		if (geometry is null)
			return ((int)Math.Round(x), (int)Math.Round(y));

		// The contract is logical points, matching iOS, but the emulator's touch surface is the raw
		// framebuffer. Without this scale every Android tap landed at 1/scale of the requested point
		// (1/3 on a Pixel 8 Pro), which stayed hidden because swipes scroll regardless of origin.
		var scale = geometry.Scale > 0 ? geometry.Scale : 1;

		return (
			Math.Clamp((int)Math.Round(x * scale), 0, Math.Max(0, geometry.PixelWidth - 1)),
			Math.Clamp((int)Math.Round(y * scale), 0, Math.Max(0, geometry.PixelHeight - 1)));
	}

	private void PruneGeometryCache(IReadOnlyList<EmulatorInstance> running)
	{
		lock (_geometryLock)
		{
			foreach (var key in _geometryCache.Keys.ToArray())
			{
				if (!running.Any(i => string.Equals(i.AvdId, key, StringComparison.OrdinalIgnoreCase)))
					_geometryCache.Remove(key);
			}
		}
	}

	#endregion

	#region Instance resolution

	internal async Task<EmulatorConnection> RequireConnectionAsync(
		string deviceId,
		CancellationToken cancellationToken)
	{
		var avdId = DeviceIdentity.GetNativeId(deviceId);
		var instance = await ResolveInstanceAsync(avdId, cancellationToken).ConfigureAwait(false)
			?? throw new DeviceCapabilityException($"Emulator '{avdId}' is not running.");

		if (!instance.HasGrpc)
		{
			throw new DeviceCapabilityException(
				$"Emulator '{avdId}' is running without its gRPC service, which happens when another emulator " +
				"already holds port 8554. Restart it from Mobile Canvas so it starts with an explicit gRPC port.");
		}

		return await _connections.GetAsync(instance, cancellationToken).ConfigureAwait(false);
	}

	private async Task<EmulatorConnection?> TryGetConnectionAsync(string deviceId, CancellationToken cancellationToken)
	{
		var instance = await ResolveInstanceAsync(DeviceIdentity.GetNativeId(deviceId), cancellationToken)
			.ConfigureAwait(false);

		return instance?.HasGrpc == true
			? await _connections.GetAsync(instance, cancellationToken).ConfigureAwait(false)
			: null;
	}

	private async Task<EmulatorInstance?> ResolveInstanceAsync(string avdId, CancellationToken cancellationToken)
	{
		await _cacheGate.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			if (_instanceCache.TryGetValue(avdId, out var cached) &&
				Stopwatch.GetElapsedTime(cached.Timestamp) < InstanceCacheTtl)
			{
				return cached.Instance;
			}

			var instance = FindRunning(avdId);
			if (instance is null)
			{
				_instanceCache.Remove(avdId);
				return null;
			}

			_instanceCache[avdId] = new CachedInstance(instance, Stopwatch.GetTimestamp());
			return instance;
		}
		finally
		{
			_cacheGate.Release();
		}
	}

	private EmulatorInstance? FindRunning(string avdId) =>
		_discovery.GetRunningInstances()
			.FirstOrDefault(i => string.Equals(i.AvdId, avdId, StringComparison.OrdinalIgnoreCase));

	private void InvalidateCache(string avdId)
	{
		_cacheGate.Wait();
		try
		{
			_instanceCache.Remove(avdId);
		}
		finally
		{
			_cacheGate.Release();
		}

		lock (_geometryLock)
			_geometryCache.Remove(avdId);
	}

	internal async Task<string> RequireSerialAsync(string deviceId, CancellationToken cancellationToken)
	{
		var avdId = DeviceIdentity.GetNativeId(deviceId);
		var instance = await ResolveInstanceAsync(avdId, cancellationToken).ConfigureAwait(false);
		return instance?.Serial ?? throw new DeviceCapabilityException($"Emulator '{avdId}' is not running.");
	}

	#endregion

	#region adb

	internal string? AdbPath => _locator.Adb;

	internal async Task<string?> RunAdbAsync(string serial, string[] arguments, CancellationToken cancellationToken)
	{
		if (_locator.Adb is null)
			return null;

		var result = await _processRunner
			.RunAsync(new ProcessRequest(_locator.Adb, ["-s", serial, .. arguments]), cancellationToken)
			.ConfigureAwait(false);

		return result.ExitCode == 0 ? result.StandardOutput : null;
	}

	/// <summary>
	/// Runs adb and returns raw stdout bytes. <see cref="IProcessRunner"/> decodes stdout as text,
	/// which would corrupt a PNG, so binary output needs its own path.
	/// </summary>
	private async Task<byte[]> RunAdbBinaryAsync(
		string serial,
		string[] arguments,
		CancellationToken cancellationToken)
	{
		if (_locator.Adb is null)
			return [];

		var startInfo = new ProcessStartInfo(_locator.Adb)
		{
			UseShellExecute = false,
			CreateNoWindow = true,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
		};

		startInfo.ArgumentList.Add("-s");
		startInfo.ArgumentList.Add(serial);
		foreach (var argument in arguments)
			startInfo.ArgumentList.Add(argument);

		using var process = Process.Start(startInfo)
			?? throw new InvalidOperationException($"Failed to start '{_locator.Adb}'.");

		using var buffer = new MemoryStream();
		var copy = process.StandardOutput.BaseStream.CopyToAsync(buffer, cancellationToken);
		var drainErrors = process.StandardError.ReadToEndAsync(cancellationToken);

		await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
		await copy.ConfigureAwait(false);
		await drainErrors.ConfigureAwait(false);

		return process.ExitCode == 0 ? buffer.ToArray() : [];
	}

	#endregion

	#region AVD metadata

	private static string? FindAvdDirectory(string avdId)
	{
		var root = Environment.GetEnvironmentVariable("ANDROID_AVD_HOME");
		if (string.IsNullOrWhiteSpace(root))
		{
			var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
			if (string.IsNullOrEmpty(home))
				return null;

			root = Path.Combine(home, ".android", "avd");
		}

		var directory = Path.Combine(root, avdId + ".avd");
		return Directory.Exists(directory) ? directory : null;
	}

	private static Dictionary<string, string> ReadAvdConfig(string? avdDirectory)
	{
		var config = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
		if (avdDirectory is null)
			return config;

		var path = Path.Combine(avdDirectory, "config.ini");
		if (!File.Exists(path))
			return config;

		try
		{
			foreach (var line in File.ReadLines(path))
			{
				var separator = line.IndexOf('=');
				if (separator > 0)
					config[line[..separator].Trim()] = line[(separator + 1)..].Trim();
			}
		}
		catch (IOException)
		{
			// A config being rewritten mid-read should not fail the whole catalog.
		}

		return config;
	}

	private static string? DescribeRuntime(Dictionary<string, string> config)
	{
		var api = DescribeApiLevel(config);
		if (api is null)
			return null;

		var tag = config.GetValueOrDefault("tag.display");
		return string.IsNullOrEmpty(tag) ? $"API {api}" : $"API {api} ({tag})";
	}

	private static string? DescribeApiLevel(Dictionary<string, string> config)
	{
		var sysdir = config.GetValueOrDefault("image.sysdir.1");
		if (string.IsNullOrEmpty(sysdir))
			return null;

		var match = ApiLevelPattern().Match(sysdir);
		return match.Success ? match.Groups[1].Value : null;
	}

	/// <summary>
	/// Turns a system image directory ("system-images/android-36/google_apis/arm64-v8a/") into the
	/// sdkmanager package id ("system-images;android-36;google_apis;arm64-v8a") that
	/// <c>avdmanager --package</c> expects, so a listed runtime can be passed straight back to create.
	/// </summary>
	internal static string ToSystemImagePackage(string sysdir) =>
		string.Join(';', sysdir.Trim('/', '\\').Split(['/', '\\'], StringSplitOptions.RemoveEmptyEntries));

	private static string SanitizeAvdName(string name)
	{
		// avdmanager rejects spaces and most punctuation in AVD names.
		var cleaned = AvdNamePattern().Replace(name, "_").Trim('_');
		return string.IsNullOrEmpty(cleaned) ? "mobile_canvas_avd" : cleaned;
	}

	/// <summary>
	/// Turns an AVD or hardware profile id such as <c>pixel_8_pro</c> into <c>Pixel 8 Pro</c>.
	/// </summary>
	/// <remarks>
	/// Only all-lowercase words are capitalised, so ids that already carry meaningful casing
	/// (<c>API36</c>, <c>Nexus 10</c>, <c>x86_64</c>) survive unchanged instead of being mangled into
	/// <c>Api36</c> or <c>X86 64</c>.
	/// </remarks>
	private static string PrettifyAvdName(string avdId)
	{
		if (string.IsNullOrEmpty(avdId))
			return avdId;

		var words = avdId.Replace('_', ' ').Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
		for (var i = 0; i < words.Length; i++)
		{
			var word = words[i];
			if (char.IsLower(word[0]) && !word.Any(char.IsUpper))
				words[i] = char.ToUpperInvariant(word[0]) + word[1..];
		}

		return string.Join(' ', words);
	}

	private static int FindFreePort()
	{
		using var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
		listener.Start();
		var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
		listener.Stop();
		return port;
	}

	[GeneratedRegex(@"[^A-Za-z0-9._-]+")]
	private static partial Regex AvdNamePattern();

	[GeneratedRegex(@"android-(\d+)")]
	private static partial Regex ApiLevelPattern();

	#endregion

	public async ValueTask DisposeAsync()
	{
		await _recordings.DisposeAsync().ConfigureAwait(false);
		await _connections.DisposeAsync().ConfigureAwait(false);
		_cacheGate.Dispose();
	}
}
