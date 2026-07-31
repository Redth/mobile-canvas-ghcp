using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using MobileCanvas.Contracts;

namespace MobileCanvas.Tool;

internal static class DeviceCli
{
	private static readonly DeviceHostClient Client = new();

	public static async Task<int> RunAsync(string[] args, CancellationToken cancellationToken = default)
	{
		if (args.Length == 0 || args[0] is "--help" or "-h" or "help")
		{
			Console.WriteLine(HelpText);
			return 0;
		}

		if (args[0] is "--version" or "-v" or "version")
		{
			Console.WriteLine(VersionText);
			return 0;
		}

		var command = args[0];
		var action = args.Length > 1 ? args[1] : "";
		var options = new CliArguments(args.Skip(Math.Min(2, args.Length)));
		var json = options.Flag("json") || (Console.IsOutputRedirected && !options.Flag("no-json"));
		if (options.Flag("schema"))
		{
			Console.WriteLine(MobileCanvasSchemas.For(command, action));
			return 0;
		}

		object result = (command, action) switch
		{
			("host", "start") => await Client.StartAsync(cancellationToken).ConfigureAwait(false),
			("host", "status") => await Client.TryGetHealthAsync(cancellationToken).ConfigureAwait(false)
				?? new HostHealth { Status = "stopped" },
			("host", "stop") => await StopHostAsync(cancellationToken).ConfigureAwait(false),
			("canvas", "open") => await Client.OpenCanvasAsync(
				new CanvasOpenRequest
				{
					SessionId = options.Required("session"),
					InstanceId = options.Required("instance"),
				},
				cancellationToken).ConfigureAwait(false),
			("canvas", "close") => await CloseCanvasAsync(options, cancellationToken).ConfigureAwait(false),
			("devices", "catalog") => await Client.GetCatalogAsync(cancellationToken).ConfigureAwait(false),
			("devices", "list") => await Client.ListDevicesAsync(cancellationToken).ConfigureAwait(false),
			("devices", "get") => await Client.GetDeviceAsync(
				options.RequiredPosition(0, "device ID"),
				cancellationToken).ConfigureAwait(false),
			("devices", "create") => await Client.CreateDeviceAsync(
				new CreateDeviceRequest
				{
					Platform = options.Value("platform") ?? DevicePlatforms.Ios,
					Name = options.Required("name"),
					RuntimeId = options.Required("runtime"),
					DeviceTypeId = options.Required("device-type"),
				},
				options.Context(),
				cancellationToken).ConfigureAwait(false),
			("devices", "boot") => await Client.BootAsync(
				options.RequiredPosition(0, "device ID"),
				options.Context(),
				cancellationToken).ConfigureAwait(false),
			("devices", "shutdown") => await Client.ShutdownAsync(
				options.RequiredPosition(0, "device ID"),
				options.Context(),
				cancellationToken).ConfigureAwait(false),
			("devices", "restart") => await Client.RestartAsync(
				options.RequiredPosition(0, "device ID"),
				options.Context(),
				cancellationToken).ConfigureAwait(false),
			("devices", "reveal") => await Client.RevealAsync(
				options.RequiredPosition(0, "device ID"),
				options.Context(),
				cancellationToken).ConfigureAwait(false),
			("devices", "erase") => await Client.EraseAsync(
				options.RequiredPosition(0, "device ID"),
				options.Flag("confirm"),
				options.Context(),
				cancellationToken).ConfigureAwait(false),
			("devices", "delete") => await DeleteAsync(options, cancellationToken).ConfigureAwait(false),
			("devices", "selected") => await Client.GetSelectionAsync(
				options.RequiredContext(),
				cancellationToken).ConfigureAwait(false),
			("devices", "select") => await Client.SelectAsync(
				options.RequiredContext(),
				options.RequiredPosition(0, "device ID"),
				cancellationToken).ConfigureAwait(false),
			("devices", "display") => await Client.GetDisplayAsync(
				options.RequiredPosition(0, "device ID"),
				cancellationToken).ConfigureAwait(false),
			("input", "tap") => await TapAsync(options, cancellationToken).ConfigureAwait(false),
			("input", "swipe") => await SwipeAsync(options, cancellationToken).ConfigureAwait(false),
			("input", "type") => await TypeAsync(options, cancellationToken).ConfigureAwait(false),
			("input", "key") => await KeyAsync(options, cancellationToken).ConfigureAwait(false),
			("input", "button") => await ButtonAsync(options, cancellationToken).ConfigureAwait(false),
			("input", "rotate") => await RotateAsync(options, cancellationToken).ConfigureAwait(false),
			("ui", "dump") => await Client.GetUiSnapshotAsync(
				options.RequiredPosition(0, "device ID"),
				options.Flag("raw"),
				cancellationToken).ConfigureAwait(false),
			("ui", "find") => await Client.FindUiElementsAsync(
				options.RequiredPosition(0, "device ID"),
				UiQueryFrom(options),
				cancellationToken).ConfigureAwait(false),
			("ui", "tap") => await Client.TapUiElementAsync(
				options.RequiredPosition(0, "device ID"),
				UiQueryFrom(options),
				options.Context(),
				cancellationToken).ConfigureAwait(false),
			("app", "list") => await Client.ListAppsAsync(
				options.RequiredPosition(0, "device ID"),
				new AppQuery
				{
					Text = options.Value("text"),
					IncludeSystem = options.Flag("system"),
					Limit = options.Int("limit", 100),
				},
				cancellationToken).ConfigureAwait(false),
			("app", "launch") => await Client.LaunchAppAsync(
				options.RequiredPosition(0, "device ID"),
				new AppLaunchRequest
				{
					BundleId = options.Required("bundle"),
					Relaunch = options.Flag("relaunch"),
				},
				cancellationToken).ConfigureAwait(false),
			("app", "terminate") => await Client.TerminateAppAsync(
				options.RequiredPosition(0, "device ID"),
				options.Required("bundle"),
				cancellationToken).ConfigureAwait(false),
			("app", "install") => await Client.InstallAppAsync(
				options.RequiredPosition(0, "device ID"),
				new AppInstallRequest { Path = options.Required("path") },
				cancellationToken).ConfigureAwait(false),
			("app", "uninstall") => await Client.UninstallAppAsync(
				options.RequiredPosition(0, "device ID"),
				options.Required("bundle"),
				options.Flag("confirm"),
				cancellationToken).ConfigureAwait(false),
			("log", _) => await Client.ReadLogAsync(
				BareVerbOptions(args).RequiredPosition(0, "device ID"),
				new LogQuery
				{
					BundleId = options.Value("bundle"),
					MinimumLevel = options.Value("level"),
					Text = options.Value("text"),
					Since = TimeSpan.FromSeconds(options.Int("seconds", 300)),
					Limit = options.Int("limit", 200),
				},
				cancellationToken).ConfigureAwait(false),
			("crashes", "list") => await Client.ListCrashesAsync(
				options.RequiredPosition(0, "device ID"),
				new CrashQuery { Text = options.Value("text"), Limit = options.Int("limit", 25) },
				cancellationToken).ConfigureAwait(false),
			("crashes", "show") => await Client.GetCrashAsync(
				options.RequiredPosition(0, "device ID"),
				options.Required("id"),
				cancellationToken).ConfigureAwait(false),
			("file", "list") => await Client.ListFilesAsync(
				options.RequiredPosition(0, "device ID"),
				new FileQuery { BundleId = options.Value("bundle"), Path = options.Value("path") ?? "" },
				cancellationToken).ConfigureAwait(false),
			("file", "pull") => await Client.PullFileAsync(
				options.RequiredPosition(0, "device ID"),
				new FileTransferRequest
				{
					BundleId = options.Value("bundle"),
					DevicePath = options.Required("path"),
					HostPath = options.Required("output"),
				},
				cancellationToken).ConfigureAwait(false),
			("file", "push") => await Client.PushFileAsync(
				options.RequiredPosition(0, "device ID"),
				new FileTransferRequest
				{
					BundleId = options.Value("bundle"),
					DevicePath = options.Required("path"),
					HostPath = options.Required("input"),
				},
				cancellationToken).ConfigureAwait(false),
			("permission", "list") => await Client.ListPermissionsAsync(
				options.RequiredPosition(0, "device ID"),
				options.Required("bundle"),
				cancellationToken).ConfigureAwait(false),
			("permission", "grant" or "revoke" or "reset") => await Client.ChangePermissionAsync(
				options.RequiredPosition(0, "device ID"),
				new PermissionChangeRequest
				{
					BundleId = options.Required("bundle"),
					Permission = options.RequiredPosition(1, "permission"),
					Action = action,
				},
				cancellationToken).ConfigureAwait(false),
			("settings", "get") => await Client.GetSettingsAsync(
				options.RequiredPosition(0, "device ID"),
				cancellationToken).ConfigureAwait(false),
			("settings", "set") => await Client.UpdateSettingsAsync(
				options.RequiredPosition(0, "device ID"),
				new DeviceSettingsRequest
				{
					Appearance = options.Value("appearance"),
					FontScale = options.Value("font-scale") is { } scale
						? double.Parse(scale, CultureInfo.InvariantCulture)
						: null,
					ContentSize = options.Value("content-size"),
					IncreaseContrast = options.Value("contrast") is { } contrast
						? bool.Parse(contrast)
						: null,
				},
				cancellationToken).ConfigureAwait(false),
			("hardware", "get") => await Client.GetHardwareStateAsync(
				options.RequiredPosition(0, "device ID"),
				cancellationToken).ConfigureAwait(false),
			("location", "set") => await Client.SetLocationAsync(
				options.RequiredPosition(0, "device ID"),
				new DeviceLocationRequest
				{
					Latitude = double.Parse(options.Required("latitude"), CultureInfo.InvariantCulture),
					Longitude = double.Parse(options.Required("longitude"), CultureInfo.InvariantCulture),
				},
				cancellationToken).ConfigureAwait(false),
			("location", "clear") => await Client.ClearLocationAsync(
				options.RequiredPosition(0, "device ID"),
				cancellationToken).ConfigureAwait(false),
			("battery", "set") => await Client.SetBatteryAsync(
				options.RequiredPosition(0, "device ID"),
				new BatteryRequest
				{
					Level = options.Value("level") is { } level ? int.Parse(level, CultureInfo.InvariantCulture) : null,
					State = options.Value("state"),
				},
				cancellationToken).ConfigureAwait(false),
			("network", "set") => await Client.SetNetworkAsync(
				options.RequiredPosition(0, "device ID"),
				new NetworkRequest
				{
					Profile = options.Value("profile"),
					LatencyMs = options.Value("latency") is { } latency
						? int.Parse(latency, CultureInfo.InvariantCulture)
						: null,
				},
				cancellationToken).ConfigureAwait(false),
			("screenshot", _) => await ScreenshotAsync(
				action,
				new CliArguments(args.Skip(1)),
				cancellationToken).ConfigureAwait(false),
			("recording", "start") => await Client.StartRecordingAsync(
				options.RequiredPosition(0, "device ID"),
				new RecordingStartRequest
				{
					OutputPath = options.Value("output"),
					TimeoutSeconds = options.Int("timeout", 180),
				},
				cancellationToken).ConfigureAwait(false),
			("recording", "stop") => await Client.StopRecordingAsync(
				options.RequiredPosition(0, "device ID"),
				cancellationToken).ConfigureAwait(false),
			("recording", "status") => await Client.GetRecordingStatusAsync(
				options.RequiredPosition(0, "device ID"),
				cancellationToken).ConfigureAwait(false),
			("guide", _) => GuideText,
			_ => throw new ArgumentException(
				$"Unknown command '{string.Join(' ', args.Take(2))}'. Run 'mobile-canvas --help'."),
		};

		Write(result, json);
		return 0;
	}

	public static int WriteError(Exception exception)
	{
		var json = Environment.GetCommandLineArgs().Contains("--json", StringComparer.Ordinal);
		if (json)
		{
			Console.Error.WriteLine(JsonSerializer.Serialize(
				new ApiError { Code = "command_failed", Message = exception.Message },
				DeviceJsonContext.Default.ApiError));
		}
		else
		{
			Console.Error.WriteLine($"error: {exception.Message}");
		}
		return 1;
	}

	private static async Task<OperationResult> StopHostAsync(CancellationToken cancellationToken)
	{
		await Client.StopAsync(cancellationToken).ConfigureAwait(false);
		return new OperationResult { Operation = "host-stop" };
	}

	private static async Task<OperationResult> CloseCanvasAsync(
		CliArguments options,
		CancellationToken cancellationToken)
	{
		await Client.CloseCanvasAsync(
			new CanvasCloseRequest
			{
				SessionId = options.Required("session"),
				InstanceId = options.Required("instance"),
			},
			cancellationToken).ConfigureAwait(false);
		return new OperationResult { Operation = "canvas-close" };
	}

	private static async Task<OperationResult> DeleteAsync(
		CliArguments options,
		CancellationToken cancellationToken)
	{
		var id = options.RequiredPosition(0, "device ID");
		await Client.DeleteAsync(id, options.Flag("confirm"), cancellationToken).ConfigureAwait(false);
		return new OperationResult { Operation = "delete", DeviceId = id };
	}

	private static async Task<OperationResult> TapAsync(
		CliArguments options,
		CancellationToken cancellationToken)
	{
		var id = options.RequiredPosition(0, "device ID");
		await Client.TapAsync(
			id,
			new TapRequest
			{
				X = options.Double("x"),
				Y = options.Double("y"),
				Duration = options.Double("duration", 0),
			},
			options.Context(),
			cancellationToken).ConfigureAwait(false);
		return new OperationResult { Operation = "tap", DeviceId = id };
	}

	private static async Task<OperationResult> SwipeAsync(
		CliArguments options,
		CancellationToken cancellationToken)
	{
		var id = options.RequiredPosition(0, "device ID");
		await Client.SwipeAsync(
			id,
			new SwipeRequest
			{
				StartX = options.Double("start-x"),
				StartY = options.Double("start-y"),
				EndX = options.Double("end-x"),
				EndY = options.Double("end-y"),
				Duration = options.Double("duration", 0.35),
			},
			options.Context(),
			cancellationToken).ConfigureAwait(false);
		return new OperationResult { Operation = "swipe", DeviceId = id };
	}

	private static async Task<OperationResult> TypeAsync(
		CliArguments options,
		CancellationToken cancellationToken)
	{
		var id = options.RequiredPosition(0, "device ID");
		await Client.TypeTextAsync(id, options.Required("text"), options.Context(), cancellationToken)
			.ConfigureAwait(false);
		return new OperationResult { Operation = "type", DeviceId = id };
	}

	private static async Task<OperationResult> KeyAsync(
		CliArguments options,
		CancellationToken cancellationToken)
	{
		var id = options.RequiredPosition(0, "device ID");
		await Client.PressKeyAsync(
			id,
			(ulong)options.Long("code"),
			options.Context(),
			cancellationToken).ConfigureAwait(false);
		return new OperationResult { Operation = "key", DeviceId = id };
	}

	private static async Task<OperationResult> ButtonAsync(
		CliArguments options,
		CancellationToken cancellationToken)
	{
		var id = options.RequiredPosition(0, "device ID");
		await Client.PressButtonAsync(
			id,
			options.Required("button"),
			options.Context(),
			cancellationToken).ConfigureAwait(false);
		return new OperationResult { Operation = "button", DeviceId = id };
	}

	private static async Task<OperationResult> RotateAsync(
		CliArguments options,
		CancellationToken cancellationToken)
	{
		var id = options.RequiredPosition(0, "device ID");
		await Client.RotateAsync(
			id,
			options.Required("orientation"),
			options.Context(),
			cancellationToken).ConfigureAwait(false);
		return new OperationResult { Operation = "rotate", DeviceId = id };
	}

	/// <summary>
	/// Builds a query from the shared <c>--text</c>/<c>--id</c>/<c>--role</c> flags used by every ui verb.
	/// </summary>
	private static UiQuery UiQueryFrom(CliArguments options) => new()
	{
		Text = options.Value("text"),
		Identifier = options.Value("id"),
		Role = options.Value("role"),
		Exact = options.Flag("exact"),
		Limit = options.Int("limit", 20),
	};

	private static async Task<MediaArtifact> ScreenshotAsync(
		string firstArgument,
		CliArguments options,
		CancellationToken cancellationToken)
	{
		var id = !firstArgument.StartsWith("--", StringComparison.Ordinal)
			? firstArgument
			: options.RequiredPosition(0, "device ID");
		if (string.IsNullOrWhiteSpace(id))
			throw new ArgumentException("A device ID is required.");
		var output = options.Value("output") ?? CreateScreenshotPath();
		output = Path.GetFullPath(output);
		Directory.CreateDirectory(Path.GetDirectoryName(output)!);
		var bytes = await Client.ScreenshotAsync(id, options.Context(), cancellationToken)
			.ConfigureAwait(false);
		await File.WriteAllBytesAsync(output, bytes, cancellationToken).ConfigureAwait(false);
		return new MediaArtifact
		{
			Path = output,
			MimeType = "image/png",
			Bytes = bytes.Length,
			CreatedAt = DateTimeOffset.UtcNow,
		};
	}

	private static string CreateScreenshotPath()
	{
		var directory = Path.Combine(DevicePaths.Home, "artifacts", "screenshots");
		Directory.CreateDirectory(directory);
		return Path.Combine(directory, $"ios-{DateTimeOffset.Now:yyyyMMdd-HHmmss}.png");
	}

	private static void Write(object value, bool json)
	{
		if (value is string text)
		{
			Console.WriteLine(text);
			return;
		}
		if (json)
		{
			Console.WriteLine(JsonSerializer.Serialize(value, value.GetType(), DeviceJsonContext.Default));
			return;
		}

		switch (value)
		{
			case DeviceTarget target:
				Console.WriteLine($"{target.Name} [{target.State}] {target.Id}");
				break;
			case DeviceTarget[] targets:
				foreach (var device in targets)
					Console.WriteLine($"{device.Name,-28} {device.State,-10} {device.OsVersion,-8} {device.Id}");
				break;
			case DeviceCatalog catalog:
				Console.WriteLine(
					$"{catalog.Devices.Length} devices, {catalog.Runtimes.Length} runtimes, " +
					$"{catalog.DeviceTypes.Length} device types");
				break;
			case HostHealth health:
				Console.WriteLine($"Mobile Canvas host: {health.Status} (pid {health.ProcessId}, v{health.Version})");
				break;
			case CanvasOpenResult canvas:
				Console.WriteLine(canvas.Url);
				break;
			case MediaArtifact artifact:
				Console.WriteLine($"{artifact.Path} ({artifact.Bytes} bytes)");
				break;
			case RecordingStatus recording:
				Console.WriteLine(
					recording.IsRecording
						? $"Recording to {recording.OutputPath}"
						: recording.OutputPath is null
							? "Not recording"
							: $"Recording saved to {recording.OutputPath}");
				break;
			case OperationResult operation:
				Console.WriteLine($"{operation.Operation}: ok");
				break;
			default:
				Console.WriteLine(JsonSerializer.Serialize(value, value.GetType(), DeviceJsonContext.Default));
				break;
		}
	}

	private static string VersionText
	{
		get
		{
			var assembly = typeof(DeviceCli).Assembly;
			var version = assembly
				.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
				.InformationalVersion;

			// Source Link appends "+<commit>"; the hash identifies the exact build
			// behind a bundled binary, so keep it rather than trimming it away.
			if (string.IsNullOrEmpty(version))
			{
				version = assembly.GetName().Version?.ToString() ?? "unknown";
			}

			return $"mobile-canvas {version} ({RuntimeInformation.RuntimeIdentifier})";
		}
	}

	/// <summary>
	/// Parses options for a verb that takes a device ID where others take a sub-action, so its first
	/// positional argument sits one place earlier than usual.
	/// </summary>
	private static CliArguments BareVerbOptions(string[] args) =>
		new(args.Skip(Math.Min(1, args.Length)));

	private const string HelpText = """
		Mobile Canvas - discover and control local mobile virtual devices

		Usage:
		  mobile-canvas host start|status|stop [--json]
		  mobile-canvas devices catalog|list [--json] [--schema]
		  mobile-canvas devices get <id> [--json]
		  mobile-canvas devices display <id> [--json]
		  mobile-canvas devices create --name <name> --runtime <id> --device-type <id>
		  mobile-canvas devices boot|shutdown|restart|reveal <id>
		  mobile-canvas devices erase|delete <id> --confirm
		  mobile-canvas devices select|selected --session <id> --instance <id>
		  mobile-canvas input tap <id> --x <points> --y <points> [--duration <seconds>]
		  mobile-canvas input swipe <id> --start-x <x> --start-y <y> --end-x <x> --end-y <y>
		  mobile-canvas input type <id> --text <text>
		  mobile-canvas input key <id> --code <USB-HID-code>
		  mobile-canvas input button <id> --button <name>
		  mobile-canvas input rotate <id> --orientation <name>
		  mobile-canvas ui dump <id> [--raw] [--json]
		  mobile-canvas ui find <id> [--text <s>] [--id <s>] [--role <s>] [--exact] [--limit <n>]
		  mobile-canvas ui tap <id> [--text <s>] [--id <s>] [--role <s>] [--exact]
		  mobile-canvas app list <id> [--text <s>] [--system] [--limit <n>] [--json]
		  mobile-canvas app launch <id> --bundle <bundle-id> [--relaunch]
		  mobile-canvas app terminate <id> --bundle <bundle-id>
		  mobile-canvas app install <id> --path <app-or-apk>
		  mobile-canvas app uninstall <id> --bundle <bundle-id> --confirm
		  mobile-canvas log <id> [--bundle <bundle-id>] [--level <name>] [--text <s>]
		                         [--seconds <n>] [--limit <n>] [--json]
		  mobile-canvas crashes list <id> [--text <s>] [--limit <n>] [--json]
		  mobile-canvas crashes show <id> --id <crash-id> [--json]
		  mobile-canvas file list <id> [--bundle <bundle-id>] [--path <p>] [--json]
		  mobile-canvas file pull <id> [--bundle <bundle-id>] --path <p> --output <host-path>
		  mobile-canvas file push <id> [--bundle <bundle-id>] --path <p> --input <host-path>
		  mobile-canvas permission list <id> --bundle <bundle-id> [--json]
		  mobile-canvas permission grant|revoke|reset <id> <permission> --bundle <bundle-id>
		  mobile-canvas settings get <id> [--json]
		  mobile-canvas settings set <id> [--appearance light|dark] [--font-scale <n>]
		                                  [--content-size <c>] [--contrast true|false]
		  mobile-canvas hardware get <id> [--json]
		  mobile-canvas location set <id> --latitude <lat> --longitude <lon>
		  mobile-canvas location clear <id>
		  mobile-canvas battery set <id> [--level 0-100] [--state charging|discharging|full]
		  mobile-canvas network set <id> [--profile <p>] [--latency <ms>]
		  mobile-canvas screenshot <id> [--output <path>] [--json]
		  mobile-canvas recording start|stop|status <id>
		  mobile-canvas mcp
		  mobile-canvas guide
		  mobile-canvas --version
		""";

	private const string GuideText = """
		Use `devices list --json` to discover targets. Device IDs are stable provider-qualified
		identifiers; `nativeId`/`udid` can be passed to Xcode and framework deployment tools.
		Boot a target before input, screenshots, recording, or streaming. Erase and delete always
		require `--confirm` (or `confirm: true` through canvas/MCP). The host and canvas detach
		without shutting down the device.

		Prefer `ui find`/`ui tap` over screenshot-and-guess: they read the live accessibility tree,
		so a tap lands on the element rather than on a coordinate that a layout change invalidates.
		`ui dump --raw` returns the untouched platform payload when the normalized tree is not enough.

		Use `app launch` rather than hunting for an icon on the home screen: it does not depend on
		which page the icon is on, or on the app having one. `app list` hides the platform's built-in
		apps unless `--system` is passed, because they outnumber a developer's own many times over.
		`app uninstall` deletes the app's data with it, so it requires `--confirm`.

		`log` is bounded on purpose: an idle device writes tens of thousands of lines a minute, so it
		defaults to the last five minutes and the newest 200 entries. Narrow it with `--bundle` to one
		app and `--level error` to the lines that matter; both filter on the device rather than after
		the fact. Levels are verbose, debug, info, warning, error and fatal -- Apple's log has no
		warning rung, so asking iOS for it yields errors and faults.

		`crashes list` finds crashes the device recorded after the fact, including ones that happened
		while nothing was watching. Pass an ID from that list to `crashes show` for the full report.

		`file` addresses two places. With `--bundle` the path is relative to that app's data container,
		which is where the database and the files it wrote actually live; without it the path is an
		absolute device path. Prefer `--bundle`: on Android nothing but the app can read those files, and
		on iOS the container is a directory named after a GUID that changes when the app is reinstalled.
		Android app access needs a debuggable build, and says so when the build is not one.

		`permission` takes names that work on both platforms -- camera, microphone, location,
		contacts, calendar, photos, notifications -- as well as a platform's own name. One name can
		cover several Android permissions, so the result lists everything the change actually touched,
		read back from the device rather than assumed: both platforms accept changes they then decline
		to make.

		`settings` covers the two things worth flipping mid-test: dark mode, and the text size that
		breaks a layout. iOS names text sizes (`--content-size large`) where Android scales them
		(`--font-scale 1.3`), and each says so if given the other.

		`location`, `battery` and `network` simulate hardware, and the platforms differ enough that
		each says what it cannot do rather than pretending. Neither can read a location back, so a fix
		is confirmed only by asking the app. An emulator cannot be returned to a real position at all.
		A simulator has no network of its own to slow down -- `network set` there only changes what the
		status bar draws, and the result says so.
		""";
}

internal sealed class CliArguments
{
	private static readonly HashSet<string> FlagNames =
		["json", "no-json", "confirm", "schema", "wait", "raw", "system", "relaunch"];
	private readonly Dictionary<string, string?> _options =
		new(StringComparer.OrdinalIgnoreCase);
	private readonly List<string> _positions = [];

	public CliArguments(IEnumerable<string> arguments)
	{
		var values = arguments.ToArray();
		for (var index = 0; index < values.Length; index++)
		{
			var value = values[index];
			if (!value.StartsWith("--", StringComparison.Ordinal))
			{
				_positions.Add(value);
				continue;
			}
			var option = value[2..];
			var separator = option.IndexOf('=');
			if (separator >= 0)
			{
				_options[option[..separator]] = option[(separator + 1)..];
				continue;
			}
			if (!FlagNames.Contains(option) &&
				index + 1 < values.Length &&
				!values[index + 1].StartsWith("--", StringComparison.Ordinal))
			{
				_options[option] = values[++index];
			}
			else
			{
				_options[option] = null;
			}
		}
	}

	public bool Flag(string name) => _options.ContainsKey(name);
	public string? Value(string name) => _options.GetValueOrDefault(name);

	public string Required(string name) =>
		Value(name) is { Length: > 0 } value
			? value
			: throw new ArgumentException($"--{name} is required.");

	public string RequiredPosition(int index, string description) =>
		index < _positions.Count
			? _positions[index]
			: throw new ArgumentException($"A {description} is required.");

	public int Int(string name, int fallback) =>
		Value(name) is { } value
			? int.Parse(value, NumberStyles.Integer, CultureInfo.InvariantCulture)
			: fallback;

	public long Long(string name) =>
		long.Parse(Required(name), NumberStyles.Integer, CultureInfo.InvariantCulture);

	public double Double(string name, double? fallback = null) =>
		Value(name) is { } value
			? double.Parse(value, NumberStyles.Float, CultureInfo.InvariantCulture)
			: fallback ?? throw new ArgumentException($"--{name} is required.");

	public CanvasContextKey? Context()
	{
		var session = Value("session");
		var instance = Value("instance");
		return string.IsNullOrWhiteSpace(session) || string.IsNullOrWhiteSpace(instance)
			? null
			: new CanvasContextKey(session, instance);
	}

	public CanvasContextKey RequiredContext() =>
		Context() ?? throw new ArgumentException("--session and --instance are required.");
}

internal static class MobileCanvasSchemas
{
	public static string For(string command, string action) =>
		(command, action) switch
		{
			("devices", "list") or ("devices", "get") => """
				{"$schema":"https://json-schema.org/draft/2020-12/schema","title":"Mobile Canvas Device Target","type":"object","required":["schemaVersion","id","platform","provider","nativeId","name","state","capabilities"],"properties":{"schemaVersion":{"type":"string"},"id":{"type":"string"},"platform":{"type":"string"},"provider":{"type":"string"},"nativeId":{"type":"string"},"udid":{"type":["string","null"]},"name":{"type":"string"},"state":{"type":"string"},"runtimeId":{"type":"string"},"capabilities":{"type":"object"}}}
				""",
			("devices", "selected") => """
				{"$schema":"https://json-schema.org/draft/2020-12/schema","title":"Mobile Canvas Device Selection","type":"object","required":["schemaVersion","hasSelection"],"properties":{"schemaVersion":{"type":"string"},"hasSelection":{"type":"boolean"},"device":{"type":["object","null"],"required":["id","platform","nativeId","name","state"],"properties":{"id":{"type":"string"},"platform":{"type":"string"},"provider":{"type":"string"},"nativeId":{"type":"string"},"udid":{"type":["string","null"]},"name":{"type":"string"},"state":{"type":"string"},"runtimeId":{"type":"string"}}}}}
				""",
			("devices", "catalog") => """
				{"$schema":"https://json-schema.org/draft/2020-12/schema","title":"Mobile Canvas Device Catalog","type":"object","required":["schemaVersion","runtimes","deviceTypes","devices","diagnostics"]}
				""",
			_ => throw new ArgumentException($"No schema is defined for '{command} {action}'."),
		};
}
