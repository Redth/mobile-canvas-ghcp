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

	#region Apps

	public async Task<InstalledApp[]> ListAppsAsync(
		string deviceId,
		bool includeSystem,
		CancellationToken cancellationToken = default)
	{
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);

		// Running state is one call for the whole list, and it is what tells a caller whether to launch
		// an app or just bring it forward.
		var running = PackageListParser.ParseRunning(
			await RunAdbAsync(serial, ["shell", "ps", "-A", "-o", "PID,NAME"], cancellationToken)
				.ConfigureAwait(false));

		var user = PackageListParser.Parse(
			await RunAdbAsync(serial, ["shell", "pm", "list", "packages", "-3", "-f", "--show-versioncode"], cancellationToken)
				.ConfigureAwait(false)
				?? throw new DeviceCapabilityException(
					$"Could not list packages on '{serial}'. Check that adb is available and the emulator is responding."),
			AppKinds.User,
			running);

		if (!includeSystem)
			return user;

		var system = PackageListParser.Parse(
			await RunAdbAsync(serial, ["shell", "pm", "list", "packages", "-s", "-f", "--show-versioncode"], cancellationToken)
				.ConfigureAwait(false),
			AppKinds.System,
			running);

		return [.. user, .. system];
	}

	public async Task<AppOperationResult> LaunchAppAsync(
		string deviceId,
		AppLaunchRequest request,
		CancellationToken cancellationToken = default)
	{
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);

		if (request.Relaunch)
		{
			await RunAdbAsync(serial, ["shell", "am", "force-stop", request.BundleId], cancellationToken)
				.ConfigureAwait(false);
		}

		// Android has no "launch this package" verb; it needs the launcher activity, which the package
		// manager can resolve. Asking it beats hardcoding a guess like ".MainActivity", and beats
		// monkey, which types synthetic events at whatever it finds.
		var resolved = PackageListParser.ParseResolvedActivity(
			await RunAdbAsync(serial, ["shell", "cmd", "package", "resolve-activity", "--brief", request.BundleId], cancellationToken)
				.ConfigureAwait(false))
			?? throw new DeviceCapabilityException(
				$"'{request.BundleId}' has no launchable activity on '{serial}'. It may not be installed, "
				+ "or it may be a service or plug-in with no launcher entry.");

		var arguments = new List<string> { "shell", "am", "start", "-W", "-n", resolved };
		foreach (var argument in request.Arguments)
		{
			arguments.Add("-e");
			arguments.Add("arg");
			arguments.Add(QuoteForDeviceShell(argument));
		}

		var output = await RunAdbAsync(serial, [.. arguments], cancellationToken).ConfigureAwait(false);
		EnsureActivityStarted(output, request.BundleId);

		// The process only exists once the activity is up, so the PID is read back rather than reported
		// by am, which says nothing about what it started.
		var running = PackageListParser.ParseRunning(
			await RunAdbAsync(serial, ["shell", "ps", "-A", "-o", "PID,NAME"], cancellationToken)
				.ConfigureAwait(false));

		return new AppOperationResult
		{
			DeviceId = deviceId,
			BundleId = request.BundleId,
			Operation = AppOperations.Launch,
			ProcessId = running.TryGetValue(request.BundleId, out var pid) ? pid : null,
			Detail = resolved,
		};
	}

	public async Task<AppOperationResult> TerminateAppAsync(
		string deviceId,
		string bundleId,
		CancellationToken cancellationToken = default)
	{
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);
		_ = await RunAdbAsync(serial, ["shell", "am", "force-stop", bundleId], cancellationToken)
			.ConfigureAwait(false)
			?? throw new DeviceCapabilityException($"Could not stop '{bundleId}' on '{serial}'.");

		return new AppOperationResult
		{
			DeviceId = deviceId,
			BundleId = bundleId,
			Operation = AppOperations.Terminate,
		};
	}

	public async Task<AppOperationResult> InstallAppAsync(
		string deviceId,
		AppInstallRequest request,
		CancellationToken cancellationToken = default)
	{
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);

		// adb never says what it installed, so the package set is sampled either side of the install and
		// the newcomer is the answer. Without this an agent can install an app and then have nothing to
		// pass to launch. A reinstall adds no package, so the answer is then legitimately unknown.
		var before = await ListPackageNamesAsync(serial, cancellationToken).ConfigureAwait(false);

		var result = await RunAdbResultAsync(serial, ["install", "-r", request.Path], cancellationToken)
			.ConfigureAwait(false);

		EnsurePackageManagerSucceeded("install", request.Path, result);

		var after = await ListPackageNamesAsync(serial, cancellationToken).ConfigureAwait(false);

		return new AppOperationResult
		{
			DeviceId = deviceId,
			BundleId = after.Except(before).SingleOrDefault(),
			Operation = AppOperations.Install,
			Detail = request.Path,
		};
	}

	/// <summary>
	/// Every third-party package name installed on the device.
	/// </summary>
	private async Task<IReadOnlyList<string>> ListPackageNamesAsync(
		string serial,
		CancellationToken cancellationToken)
	{
		var output = await RunAdbAsync(serial, ["shell", "pm", "list", "packages", "-3"], cancellationToken)
			.ConfigureAwait(false);

		return PackageListParser.ParseNames(output);
	}

	public async Task<AppOperationResult> UninstallAppAsync(
		string deviceId,
		string bundleId,
		CancellationToken cancellationToken = default)
	{
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);

		// pm answers a missing package with DELETE_FAILED_INTERNAL_ERROR, which reads like the device
		// broke rather than like the app was never there. Checking first buys a plain answer, and one
		// that matches what the iOS backend says.
		var installed = await RunAdbAsync(serial, ["shell", "pm", "path", bundleId], cancellationToken)
			.ConfigureAwait(false);

		if (string.IsNullOrWhiteSpace(installed) || !installed.Contains("package:", StringComparison.Ordinal))
			throw new DeviceCapabilityException(
				$"'{bundleId}' is not installed on '{serial}', so there is nothing to uninstall.");

		var result = await RunAdbResultAsync(serial, ["uninstall", bundleId], cancellationToken)
			.ConfigureAwait(false);

		EnsurePackageManagerSucceeded("uninstall", bundleId, result);

		return new AppOperationResult
		{
			DeviceId = deviceId,
			BundleId = bundleId,
			Operation = AppOperations.Uninstall,
		};
	}

	/// <summary>
	/// Fails when <c>am start -W</c> reported anything other than a completed launch.
	/// </summary>
	/// <remarks>
	/// am writes its failures to stdout and still exits zero, so a caller that trusts the exit code
	/// believes it launched an app that never started. <c>-W</c> also makes the call mean what it says:
	/// without it am returns as soon as the intent is dispatched, so the next call -- typically a
	/// screen dump -- races a process that does not exist yet.
	/// </remarks>
	private static void EnsureActivityStarted(string? output, string bundleId)
	{
		if (output is null)
			throw new DeviceCapabilityException($"Could not start '{bundleId}'.");

		if (PackageListParser.FindLaunchFailure(output) is { } failure)
			throw new DeviceCapabilityException($"Could not start '{bundleId}': {failure}");
	}

	/// <summary>
	/// Fails when the package manager reported a failure.
	/// </summary>
	/// <remarks>
	/// <c>adb install</c> and <c>adb uninstall</c> print "Failure [REASON]" and exit zero, so the
	/// output is the only reliable signal. The bracketed reason is the useful part -- it names the
	/// difference between a downgrade, a signature mismatch, and a missing package.
	/// </remarks>
	private static void EnsurePackageManagerSucceeded(string operation, string subject, ProcessResult result)
	{
		var output = (result.StandardOutput + '\n' + result.StandardError).Trim();

		if (result.ExitCode == 0 && output.Contains("Success", StringComparison.OrdinalIgnoreCase))
			return;

		var detail = output.Split('\n')
			.Select(line => line.Trim())
			.FirstOrDefault(line =>
				line.StartsWith("Failure", StringComparison.OrdinalIgnoreCase)
				|| line.StartsWith("Error", StringComparison.OrdinalIgnoreCase)
				|| line.StartsWith("adb:", StringComparison.OrdinalIgnoreCase));

		throw new DeviceCapabilityException(
			$"Could not {operation} '{subject}': {detail ?? (output.Length == 0 ? $"adb exited with code {result.ExitCode}." : output)}");
	}

	#endregion

	#region Diagnostics

	public async Task<LogEntry[]> ReadLogAsync(
		string deviceId,
		LogQuery query,
		CancellationToken cancellationToken = default)
	{
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);

		var arguments = new List<string> { "logcat", "-d", "-v", "threadtime" };

		if (await ResolveSinceAsync(serial, query.Since, cancellationToken).ConfigureAwait(false) is { } since)
		{
			arguments.Add("-T");
			arguments.Add(since);
		}

		if (!string.IsNullOrWhiteSpace(query.BundleId))
		{
			var pid = await ResolvePidAsync(serial, query.BundleId, cancellationToken).ConfigureAwait(false);

			// A package with no process has written nothing this session. Saying so beats returning the
			// whole device log, which is what an unfiltered logcat would do.
			if (pid is null)
				return [];

			arguments.Add($"--pid={pid}");
		}

		var priority = LogcatParser.ToPriority(query.MinimumLevel);
		if (priority != 'V')
			arguments.Add($"*:{priority}");

		var output = await RunAdbAsync(serial, [.. arguments], cancellationToken).ConfigureAwait(false)
			?? throw new DeviceCapabilityException(
				$"Could not read the log from '{serial}'. Check that adb is available and the emulator is responding.");

		return LogcatParser.Parse(output);
	}

	public async Task<CrashReport[]> ListCrashesAsync(
		string deviceId,
		CancellationToken cancellationToken = default)
	{
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);

		var output = await RunAdbAsync(serial, ["shell", "dumpsys", "dropbox"], cancellationToken)
			.ConfigureAwait(false);

		var reports = LogcatParser.ParseDropbox(output);
		await AttributeCrashesAsync(serial, reports, cancellationToken).ConfigureAwait(false);
		return reports;
	}

	/// <summary>
	/// Fills in the app each crash belongs to, which dropbox's listing does not say.
	/// </summary>
	/// <remarks>
	/// Without this every ANR reads as "data_app_anr" and nothing else, so a list of five is five
	/// identical rows and a search by package matches nothing at all -- silently, which is worse than
	/// failing. The package only appears inside the report body, and reading the whole box in one call
	/// would transfer megabytes (its bodies run to ~25KB each), so the newest window is enriched with
	/// individual prints, measured at ~55ms apiece. Older entries keep a null bundle ID rather than
	/// being dropped, so the total a caller sees stays honest.
	/// </remarks>
	private async Task AttributeCrashesAsync(
		string serial,
		CrashReport[] reports,
		CancellationToken cancellationToken)
	{
		var window = Math.Min(reports.Length, AttributedCrashWindow);
		if (window == 0)
			return;

		using var limiter = new SemaphoreSlim(4);
		await Task.WhenAll(Enumerable.Range(0, window).Select(async index =>
		{
			await limiter.WaitAsync(cancellationToken).ConfigureAwait(false);
			try
			{
				var package = await FindCrashPackageAsync(serial, reports[index].Id, cancellationToken)
					.ConfigureAwait(false);

				if (package is not null)
					reports[index] = reports[index] with { Name = package, BundleId = package };
			}
			finally
			{
				limiter.Release();
			}
		})).ConfigureAwait(false);
	}

	private async Task<string?> FindCrashPackageAsync(
		string serial,
		string crashId,
		CancellationToken cancellationToken)
	{
		var separator = crashId.LastIndexOf('|');
		if (separator < 0)
			return null;

		var output = await RunAdbAsync(
			serial,
			["shell", "dumpsys", "dropbox", "--print", QuoteForDeviceShell(crashId[..separator])],
			cancellationToken).ConfigureAwait(false);

		return LogcatParser.FindDropboxPackage(output);
	}

	/// <summary>
	/// How many of the newest crashes are looked up by app. Bounds a listing's cost to about a second
	/// on a device whose drop box has filled up.
	/// </summary>
	private const int AttributedCrashWindow = 25;

	public async Task<CrashDetailResult> GetCrashAsync(
		string deviceId,
		string crashId,
		CancellationToken cancellationToken = default)
	{
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);

		// The ID is "<timestamp>|<tag>", the pair dropbox needs to single out one entry.
		var separator = crashId.LastIndexOf('|');
		if (separator < 0)
			throw new DeviceCapabilityException(
				$"'{crashId}' is not a crash ID. List crashes first to see the available IDs.");

		var timestamp = crashId[..separator];
		var tag = crashId[(separator + 1)..];

		// dumpsys takes only a timestamp -- there is no tag argument, despite the listing printing one.
		var output = await RunAdbAsync(
			serial,
			["shell", "dumpsys", "dropbox", "--print", QuoteForDeviceShell(timestamp)],
			cancellationToken).ConfigureAwait(false);

		var content = LogcatParser.ExtractDropboxEntry(output)
			?? throw new DeviceCapabilityException(
				$"No crash report '{crashId}' exists on '{serial}'. Dropbox drops old entries, so it may have aged out.");

		var package = LogcatParser.FindDropboxPackage(content);

		return new CrashDetailResult
		{
			DeviceId = deviceId,
			Report = new CrashReport
			{
				Id = crashId,
				// Named the same way the listing names it, so the two views agree.
				Name = package ?? tag,
				Timestamp = timestamp,
				Kind = LogcatParser.DescribeTag(tag),
				BundleId = package,
			},
			Content = content,
		};
	}

	/// <summary>
	/// Formats a start time for <c>logcat -T</c>, computed on the device.
	/// </summary>
	/// <remarks>
	/// logcat compares against the device's own clock, so the window has to be worked out there. An
	/// emulator usually tracks the host, but "usually" is the part that produces an empty log at three
	/// in the morning. Returns null when the device will not answer, which reads as "no time filter"
	/// rather than as a filter that silently excludes everything.
	/// </remarks>
	private async Task<string?> ResolveSinceAsync(
		string serial,
		TimeSpan since,
		CancellationToken cancellationToken)
	{
		var seconds = (long)Math.Max(1, Math.Round(since.TotalSeconds));

		var output = await RunAdbAsync(
			serial,
			["shell", $"date -d @$(( $(date +%s) - {seconds} )) +'%m-%d %H:%M:%S.000'"],
			cancellationToken).ConfigureAwait(false);

		var stamp = output?.Trim();
		return string.IsNullOrEmpty(stamp) || stamp.Contains("not found", StringComparison.OrdinalIgnoreCase)
			? null
			: stamp;
	}

	private async Task<int?> ResolvePidAsync(
		string serial,
		string bundleId,
		CancellationToken cancellationToken)
	{
		var output = await RunAdbAsync(
			serial,
			["shell", "pidof", QuoteForDeviceShell(bundleId)],
			cancellationToken).ConfigureAwait(false);

		// pidof lists every process for the package; the first is the main one.
		var first = output?.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
		return int.TryParse(first, out var pid) ? pid : null;
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
	/// Runs adb and returns the whole result, including exit code and stderr.
	/// </summary>
	/// <remarks>
	/// <see cref="RunAdbAsync"/> collapses any failure to null, which is fine for a probe but loses the
	/// reason. Package operations fail for specific, actionable reasons -- a signature mismatch, a
	/// downgrade, a missing package -- so they need the text adb actually printed.
	/// </remarks>
	internal async Task<ProcessResult> RunAdbResultAsync(
		string serial,
		string[] arguments,
		CancellationToken cancellationToken)
	{
		if (_locator.Adb is null)
			throw new DeviceCapabilityException(
				"adb was not found. Install Android platform-tools or set ANDROID_HOME.");

		return await _processRunner
			.RunAsync(new ProcessRequest(_locator.Adb, ["-s", serial, .. arguments]), cancellationToken)
			.ConfigureAwait(false);
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

	#region Permissions and settings

	/// <summary>
	/// Maps the names that mean the same thing on both platforms onto Android's own.
	/// </summary>
	/// <remarks>
	/// Several are one-to-many because Android splits what iOS treats as a single decision: location
	/// into fine and coarse, contacts and calendar into read and write, photos into images and video.
	/// A change fans out across the whole set so that asking for "location" produces the state a user
	/// would recognise, rather than half of it.
	/// </remarks>
	private static readonly Dictionary<string, string[]> AndroidPermissions = new(StringComparer.OrdinalIgnoreCase)
	{
		[DevicePermissions.Camera] = ["android.permission.CAMERA"],
		[DevicePermissions.Microphone] = ["android.permission.RECORD_AUDIO"],
		[DevicePermissions.Location] =
			["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"],
		[DevicePermissions.LocationAlways] = ["android.permission.ACCESS_BACKGROUND_LOCATION"],
		[DevicePermissions.Contacts] =
			["android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"],
		[DevicePermissions.Calendar] =
			["android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR"],
		[DevicePermissions.Photos] =
			["android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO"],
		[DevicePermissions.PhotosAdd] = ["android.permission.READ_MEDIA_VISUAL_USER_SELECTED"],
		[DevicePermissions.MediaLibrary] = ["android.permission.READ_MEDIA_AUDIO"],
		[DevicePermissions.Motion] = ["android.permission.ACTIVITY_RECOGNITION"],
		[DevicePermissions.Notifications] = ["android.permission.POST_NOTIFICATIONS"],
	};

	public async Task<PermissionListResult> ListPermissionsAsync(
		string deviceId,
		string bundleId,
		CancellationToken cancellationToken = default)
	{
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var granted = await ReadPermissionStateAsync(serial, bundleId, deviceId, cancellationToken)
			.ConfigureAwait(false);

		// Reported by Android's own name, because that is what the manifest and the error messages
		// use, with the canonical name attached where there is one.
		var canonical = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
		foreach (var (name, platformNames) in AndroidPermissions)
		{
			foreach (var platformName in platformNames)
				canonical[platformName] = name;
		}

		var permissions = granted
			.Select(entry => new DevicePermission
			{
				Name = canonical.GetValueOrDefault(entry.Key, entry.Key),
				PlatformName = entry.Key,
				Granted = entry.Value,
			})
			.OrderBy(permission => permission.PlatformName, StringComparer.Ordinal)
			.ToArray();

		return new PermissionListResult
		{
			DeviceId = deviceId,
			Platform = DevicePlatforms.Android,
			BundleId = bundleId,
			Permissions = permissions,
			Total = permissions.Length,
		};
	}

	public async Task<PermissionChangeResult> ChangePermissionAsync(
		string deviceId,
		PermissionChangeRequest request,
		CancellationToken cancellationToken = default)
	{
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);

		var targets = AndroidPermissions.TryGetValue(request.Permission, out var mapped)
			? mapped
			: [request.Permission];

		// A reset makes the app ask again, which is what 'revoke' already does here: Android has no
		// third state, so the two collapse.
		var verb = request.Action == PermissionActions.Grant ? "grant" : "revoke";

		foreach (var target in targets)
		{
			var result = await RunAdbResultAsync(
				serial,
				["shell", "pm", verb, request.BundleId, target],
				cancellationToken).ConfigureAwait(false);

			var complaint = FindPermissionFailure(result);
			if (complaint is not null)
				throw new DeviceCapabilityException(
					$"Could not {verb} '{target}' for '{request.BundleId}' on '{deviceId}': {complaint}");
		}

		// pm grant exits zero and prints nothing when the app never declared the permission, so the
		// only way to know whether anything happened is to look afterwards.
		var granted = await ReadPermissionStateAsync(serial, request.BundleId, deviceId, cancellationToken)
			.ConfigureAwait(false);

		var touched = targets
			.Select(target => new DevicePermission
			{
				Name = request.Permission,
				PlatformName = target,
				Granted = granted.TryGetValue(target, out var value) ? value : null,
			})
			.ToArray();

		if (touched.All(permission => permission.Granted is null))
			throw new DeviceCapabilityException(
				$"'{request.BundleId}' does not declare {string.Join(" or ", targets)}, so there is "
				+ "nothing to change. Add it to the manifest and reinstall.");

		return new PermissionChangeResult
		{
			DeviceId = deviceId,
			BundleId = request.BundleId,
			Permission = request.Permission,
			Action = request.Action,
			Permissions = touched,
		};
	}

	private async Task<Dictionary<string, bool>> ReadPermissionStateAsync(
		string serial,
		string bundleId,
		string deviceId,
		CancellationToken cancellationToken)
	{
		var result = await RunAdbResultAsync(
			serial,
			["shell", "dumpsys", "package", QuoteForDeviceShell(bundleId)],
			cancellationToken).ConfigureAwait(false);

		// dumpsys answers an unknown package with a short report rather than an error, so the absence
		// of the package header is what says the bundle ID is wrong.
		if (!result.StandardOutput.Contains($"Package [{bundleId}]", StringComparison.Ordinal))
			throw new DeviceCapabilityException(
				$"'{bundleId}' is not installed on '{deviceId}'. Check the package with `app list`.");

		return PermissionParser.ParseRuntimePermissions(result.StandardOutput);
	}

	/// <summary>
	/// Reduces a pm failure to its first useful line.
	/// </summary>
	/// <remarks>
	/// An unknown permission comes back as a twenty-line Java stack trace whose only informative part
	/// is the exception line, and an unknown package as "Error: package not found". Neither is worth
	/// handing to a reader whole.
	/// </remarks>
	private static string? FindPermissionFailure(ProcessResult result)
	{
		foreach (var line in $"{result.StandardError}\n{result.StandardOutput}".Split('\n'))
		{
			var text = line.Trim();
			if (text.StartsWith("java.", StringComparison.Ordinal))
				return text;
			if (text.StartsWith("Error:", StringComparison.OrdinalIgnoreCase)
				|| text.StartsWith("Failure", StringComparison.OrdinalIgnoreCase))
			{
				return text;
			}
		}

		return result.ExitCode == 0 ? null : $"pm exited with code {result.ExitCode}";
	}

	public async Task<DeviceSettings> GetSettingsAsync(
		string deviceId,
		CancellationToken cancellationToken = default)
	{
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);

		var night = await RunAdbAsync(serial, ["shell", "cmd", "uimode", "night"], cancellationToken)
			.ConfigureAwait(false);
		var scale = await RunAdbAsync(
			serial,
			["shell", "settings", "get", "system", "font_scale"],
			cancellationToken).ConfigureAwait(false);
		var contrast = await RunAdbAsync(
			serial,
			["shell", "settings", "get", "secure", "high_text_contrast_enabled"],
			cancellationToken).ConfigureAwait(false);

		return new DeviceSettings
		{
			DeviceId = deviceId,
			Platform = DevicePlatforms.Android,
			Appearance = ParseNightMode(night),
			FontScale = ParseSetting(scale) is { } text && double.TryParse(text, out var value) ? value : null,
			IncreaseContrast = ParseSetting(contrast) switch
			{
				"1" => true,
				"0" => false,
				_ => null,
			},
		};
	}

	public async Task<DeviceSettings> UpdateSettingsAsync(
		string deviceId,
		DeviceSettingsRequest request,
		CancellationToken cancellationToken = default)
	{
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);

		if (request.Appearance is { } appearance)
		{
			await RequireSettingAsync(
				serial,
				["shell", "cmd", "uimode", "night", appearance == DeviceAppearances.Dark ? "yes" : "no"],
				cancellationToken).ConfigureAwait(false);
		}

		if (request.FontScale is { } scale)
		{
			await RequireSettingAsync(
				serial,
				["shell", "settings", "put", "system", "font_scale", scale.ToString("0.0###", CultureInfo.InvariantCulture)],
				cancellationToken).ConfigureAwait(false);
		}

		if (request.IncreaseContrast is { } contrast)
		{
			await RequireSettingAsync(
				serial,
				["shell", "settings", "put", "secure", "high_text_contrast_enabled", contrast ? "1" : "0"],
				cancellationToken).ConfigureAwait(false);
		}

		if (request.ContentSize is not null)
			throw new DeviceCapabilityException(
				"Android sizes text by scale rather than by named category. Use a font scale instead, "
				+ "for example 1.3.");

		return await GetSettingsAsync(deviceId, cancellationToken).ConfigureAwait(false);
	}

	private async Task RequireSettingAsync(string serial, string[] arguments, CancellationToken cancellationToken)
	{
		var result = await RunAdbResultAsync(serial, arguments, cancellationToken).ConfigureAwait(false);
		if (FindPermissionFailure(result) is { } failure)
			throw new DeviceCapabilityException($"Could not apply the setting: {failure}");
	}

	/// <summary>Reads the answer to <c>cmd uimode night</c>, which is "Night mode: yes".</summary>
	private static string? ParseNightMode(string? output)
	{
		var value = output?.Trim();
		if (value is null || !value.StartsWith("Night mode:", StringComparison.OrdinalIgnoreCase))
			return null;

		return value["Night mode:".Length..].Trim().ToLowerInvariant() switch
		{
			"yes" => DeviceAppearances.Dark,
			"no" => DeviceAppearances.Light,

			// 'auto' and 'custom' follow the clock, so neither names the appearance in force.
			_ => null,
		};
	}

	/// <summary>Reads a settings value, where an unset key answers with the literal "null".</summary>
	private static string? ParseSetting(string? output)
	{
		var value = output?.Trim();
		return value is null or "" or "null" ? null : value;
	}

	#endregion

	#region Files

	/// <summary>
	/// Lists a directory on the device, or inside one app's data container.
	/// </summary>
	/// <remarks>
	/// An app's own files are the ones worth reading, and nothing but the app can reach them, so a
	/// bundle ID routes every command through <c>run-as</c>. That only works for a debuggable build --
	/// which is what a developer is looking at -- and says so plainly when it does not.
	/// </remarks>
	public async Task<FileListResult> ListFilesAsync(
		string deviceId,
		FileQuery query,
		CancellationToken cancellationToken = default)
	{
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var path = NormalizeDevicePath(query.Path, query.BundleId);

		// -A drops "." and ".."; -l gives the size and date; -L follows the symlinks Android uses for
		// several of an app's own directories.
		var result = await RunAppShellAsync(
			serial,
			query.BundleId,
			["ls", "-lAL", QuoteForDeviceShell(path)],
			cancellationToken).ConfigureAwait(false);

		// ls writes "No such file or directory" and exits non-zero, but run-as writes its own refusal
		// and exits zero, so both have to be looked at rather than just the code.
		var failure = FindShellFailure(result);
		if (failure is not null)
			throw new DeviceCapabilityException(DescribeFileFailure(failure, path, query.BundleId, deviceId));

		var files = LsParser.Parse(result.StandardOutput, path);

		return new FileListResult
		{
			DeviceId = deviceId,
			Platform = DevicePlatforms.Android,
			Path = path,
			Total = files.Length,
			Files = [.. files.OrderByDescending(file => file.IsDirectory).ThenBy(file => file.Name, StringComparer.OrdinalIgnoreCase)],
		};
	}

	/// <summary>
	/// Copies a file off the device.
	/// </summary>
	/// <remarks>
	/// An app-scoped pull cannot use <c>adb pull</c> at all: it reads as the shell user, which is
	/// refused on <c>/data/data</c>, and <c>run-as</c> cannot stage a copy anywhere adb can reach
	/// either -- <c>/data/local/tmp</c> rejects its writes. Both were measured rather than assumed. So
	/// the bytes come back over <c>exec-out</c>, which unlike <c>adb shell</c> allocates no pty and
	/// leaves them untouched.
	/// </remarks>
	public async Task<FileTransferResult> PullFileAsync(
		string deviceId,
		FileTransferRequest request,
		CancellationToken cancellationToken = default)
	{
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var path = NormalizeDevicePath(request.DevicePath, request.BundleId);

		var expected = await RequireFileSizeAsync(serial, request.BundleId, path, deviceId, cancellationToken)
			.ConfigureAwait(false);

		var destination = PrepareDestination(request.HostPath, PathFileName(path));

		// No quoting: exec-out hands the arguments to execvp rather than to a shell, so a quote would
		// arrive as part of the file name instead of being stripped off it.
		string[] arguments = string.IsNullOrWhiteSpace(request.BundleId)
			? ["exec-out", "cat", path]
			: ["exec-out", "run-as", request.BundleId, "cat", path];

		var size = await RunAdbToFileAsync(serial, arguments, destination, cancellationToken)
			.ConfigureAwait(false);

		if (size != expected)
		{
			File.Delete(destination);
			throw new DeviceCapabilityException(
				$"Reading '{path}' from '{deviceId}' returned {size} bytes where the device reports "
				+ $"{expected}, so the copy is incomplete and was discarded.");
		}

		return new FileTransferResult
		{
			DeviceId = deviceId,
			DevicePath = path,
			HostPath = destination,
			Size = size,
			Operation = FileOperations.Pull,
		};
	}

	/// <summary>
	/// Copies a file onto the device.
	/// </summary>
	/// <remarks>
	/// An app-scoped push goes by way of <c>/data/local/tmp</c>: adb can write there and
	/// <c>run-as</c> can read from it, which is the one direction that works. The staged copy is
	/// removed afterwards so a fixture is not left where another app could read it.
	/// </remarks>
	public async Task<FileTransferResult> PushFileAsync(
		string deviceId,
		FileTransferRequest request,
		CancellationToken cancellationToken = default)
	{
		var serial = await RequireSerialAsync(deviceId, cancellationToken).ConfigureAwait(false);
		var path = NormalizeDevicePath(request.DevicePath, request.BundleId);
		var size = new FileInfo(request.HostPath).Length;

		if (string.IsNullOrWhiteSpace(request.BundleId))
		{
			var push = await RunAdbResultAsync(serial, ["push", request.HostPath, path], cancellationToken)
				.ConfigureAwait(false);

			if (push.ExitCode != 0)
				throw new DeviceCapabilityException(
					$"Could not push to '{path}' on '{deviceId}': {Explain(push)}");
		}
		else
		{
			await PushThroughStagingAsync(serial, request.BundleId, request.HostPath, path, deviceId, cancellationToken)
				.ConfigureAwait(false);
		}

		return new FileTransferResult
		{
			DeviceId = deviceId,
			DevicePath = path,
			HostPath = request.HostPath,
			Size = size,
			Operation = FileOperations.Push,
		};
	}

	private async Task PushThroughStagingAsync(
		string serial,
		string bundleId,
		string hostPath,
		string devicePath,
		string deviceId,
		CancellationToken cancellationToken)
	{
		var staged = $"/data/local/tmp/mobile-canvas-{Guid.NewGuid():N}";

		var push = await RunAdbResultAsync(serial, ["push", hostPath, staged], cancellationToken)
			.ConfigureAwait(false);

		if (push.ExitCode != 0)
			throw new DeviceCapabilityException(
				$"Could not stage the file on '{deviceId}': {Explain(push)}");

		try
		{
			var copy = await RunAdbResultAsync(
				serial,
				["shell", "run-as", bundleId, "cp", staged, QuoteForDeviceShell(devicePath)],
				cancellationToken).ConfigureAwait(false);

			var failure = FindShellFailure(copy);
			if (failure is not null)
				throw new DeviceCapabilityException(
					DescribeFileFailure(failure, devicePath, bundleId, deviceId));
		}
		finally
		{
			// Not left behind: /data/local/tmp is readable by anything with shell access.
			await RunAdbAsync(serial, ["shell", "rm", "-f", staged], cancellationToken).ConfigureAwait(false);
		}
	}

	/// <summary>
	/// Reports the size of a device file, and refuses anything that is not one.
	/// </summary>
	/// <remarks>
	/// The size is the point: <c>adb exec-out</c> reports neither a non-zero exit code nor stderr when
	/// the command under it fails, so a pull has no way to tell a truncated read from a whole one
	/// except by knowing up front how many bytes to expect.
	/// </remarks>
	private async Task<long> RequireFileSizeAsync(
		string serial,
		string? bundleId,
		string path,
		string deviceId,
		CancellationToken cancellationToken)
	{
		var probe = await RunAppShellAsync(
			serial,
			bundleId,
			["ls", "-ld", QuoteForDeviceShell(path)],
			cancellationToken).ConfigureAwait(false);

		var failure = FindShellFailure(probe);
		if (failure is not null)
			throw new DeviceCapabilityException(DescribeFileFailure(failure, path, bundleId, deviceId));

		if (LsParser.Parse(probe.StandardOutput, "").FirstOrDefault() is not { } entry)
			throw new DeviceCapabilityException(
				$"Could not read '{path}' on '{deviceId}': {probe.StandardOutput.Trim()}");

		if (entry.IsDirectory)
			throw new DeviceCapabilityException($"'{path}' is a directory, not a file.");

		return entry.Size;
	}

	private Task<ProcessResult> RunAppShellAsync(
		string serial,
		string? bundleId,
		string[] command,
		CancellationToken cancellationToken) =>
		RunAdbResultAsync(
			serial,
			string.IsNullOrWhiteSpace(bundleId)
				? ["shell", .. command]
				: ["shell", "run-as", bundleId, .. command],
			cancellationToken);

	/// <summary>
	/// Finds the line explaining a device-shell failure, or null when there was none.
	/// </summary>
	/// <remarks>
	/// <c>run-as</c> refuses an unknown or release-signed package by printing to stdout and exiting
	/// zero, so an exit code alone reports success for a command that did nothing -- the same trap as
	/// uiautomator, <c>am start</c> and <c>adb install</c>.
	/// </remarks>
	private static string? FindShellFailure(ProcessResult result)
	{
		if (result.StandardError.Trim() is { Length: > 0 } error)
			return error.Split('\n')[0].Trim();

		foreach (var line in result.StandardOutput.Split('\n'))
		{
			var text = line.Trim();
			if (text.StartsWith("run-as:", StringComparison.Ordinal)
				|| text.Contains("Permission denied", StringComparison.OrdinalIgnoreCase)
				|| text.Contains("No such file or directory", StringComparison.OrdinalIgnoreCase))
			{
				return text;
			}
		}

		return result.ExitCode == 0 ? null : $"the command exited with code {result.ExitCode}";
	}

	/// <summary>
	/// Turns a device-shell refusal into something that says what to do about it.
	/// </summary>
	private static string DescribeFileFailure(string failure, string path, string? bundleId, string deviceId)
	{
		if (failure.Contains("not debuggable", StringComparison.OrdinalIgnoreCase)
			|| failure.Contains("package not an application", StringComparison.OrdinalIgnoreCase)
			|| failure.Contains("unknown package", StringComparison.OrdinalIgnoreCase))
		{
			return $"'{bundleId}' is not a debuggable build on '{deviceId}', so its files cannot be "
				+ $"reached. Install a debug build, or use a path under /sdcard instead. ({failure})";
		}

		return $"Could not read '{path}' on '{deviceId}': {failure}";
	}

	private static string Explain(ProcessResult result) =>
		result.StandardError.Trim() is { Length: > 0 } error
			? error
			: result.StandardOutput.Trim() is { Length: > 0 } output
				? output
				: $"adb exited with code {result.ExitCode}.";

	/// <summary>
	/// Reads an app-relative path as relative and a device path as absolute.
	/// </summary>
	private static string NormalizeDevicePath(string path, string? bundleId)
	{
		var trimmed = path.Trim();

		if (string.IsNullOrWhiteSpace(bundleId))
			return trimmed.Length == 0 ? "/" : trimmed;

		// run-as starts in the app's data directory, so a relative path already means the right thing
		// and a leading slash would escape to the device root.
		var relative = trimmed.TrimStart('/');
		return relative.Length == 0 ? "." : relative;
	}

	private static string PathFileName(string path)
	{
		var slash = path.TrimEnd('/').LastIndexOf('/');
		var name = slash < 0 ? path : path[(slash + 1)..];
		return name.Trim('/') is { Length: > 0 } trimmed ? trimmed : "file";
	}

	/// <summary>
	/// Works out where a pull should land, creating the parent directory if it is missing.
	/// </summary>
	private static string PrepareDestination(string hostPath, string fileName)
	{
		var destination = Directory.Exists(hostPath) ? Path.Combine(hostPath, fileName) : hostPath;

		var parent = Path.GetDirectoryName(destination);
		if (!string.IsNullOrEmpty(parent))
			Directory.CreateDirectory(parent);

		return destination;
	}

	/// <summary>
	/// Runs adb and streams stdout straight to a file, so nothing decodes the bytes on the way.
	/// </summary>
	/// <remarks>
	/// Unlike <see cref="RunAdbBinaryAsync"/> this reports a failure rather than returning nothing: a
	/// zero-length result is a legitimate answer for a file, so it cannot double as an error. These
	/// guards are still not enough on their own -- <c>exec-out</c> exits zero and writes the failing
	/// command's own complaint to stdout -- so the caller checks the byte count as well.
	/// </remarks>
	private async Task<long> RunAdbToFileAsync(
		string serial,
		string[] arguments,
		string destination,
		CancellationToken cancellationToken)
	{
		if (_locator.Adb is null)
			throw new DeviceCapabilityException(
				"adb was not found. Install Android platform-tools or set ANDROID_HOME.");

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

		long written;
		var drainErrors = process.StandardError.ReadToEndAsync(cancellationToken);

		await using (var file = File.Create(destination))
		{
			await process.StandardOutput.BaseStream.CopyToAsync(file, cancellationToken).ConfigureAwait(false);
			written = file.Length;
		}

		await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
		var errors = await drainErrors.ConfigureAwait(false);

		if (process.ExitCode != 0 || errors.Trim() is { Length: > 0 })
		{
			File.Delete(destination);
			throw new DeviceCapabilityException(
				$"Could not read the file from the device: "
				+ (errors.Trim() is { Length: > 0 } text ? text : $"adb exited with code {process.ExitCode}."));
		}

		return written;
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
