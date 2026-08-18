using System.Text.Json;
using MobileCanvas.Contracts;
using WindowsCanvas.Contracts;

namespace MobileCanvas.Tool;

/// <summary>
/// The <c>mobile-canvas windows ...</c> commands.
///
/// They are dispatched before the Mobile verbs and serialize through the Windows source-generated
/// context, so the two products never share a payload shape by accident. Every panel-scoped
/// command requires <c>--session</c> and <c>--instance</c>, and the context it builds always
/// carries <c>surface=windows</c>: a Windows command must not be able to speak for a mobile panel.
/// </summary>
internal static class WindowsCli
{
	private static readonly WindowsHostClient Client = new();

	public static async Task<int> RunAsync(
		string action,
		CliArguments options,
		bool json,
		CancellationToken cancellationToken)
	{
		object result = action switch
		{
			"capabilities" => await Client.GetPreflightAsync(cancellationToken).ConfigureAwait(false),
			"apps" => await Client.ListAppsAsync(
				new WindowsCatalogQuery
				{
					Text = options.Value("text"),
					Limit = options.Int("limit", 100),
					AmbiguousOnly = options.Flag("ambiguous"),
				},
				cancellationToken).ConfigureAwait(false),
			"list" => await Client.ListWindowsAsync(
				WindowsContext(options),
				cancellationToken).ConfigureAwait(false),
			"launch" => await Client.LaunchAppAsync(
				WindowsContext(options),
				new WindowsCatalogLaunchRequest
				{
					EntryId = options.Value("app") ?? options.RequiredPosition(0, "catalog entry ID or name"),
					CorrelationTimeout = options.Double("timeout", 10),
				},
				cancellationToken).ConfigureAwait(false),
			"launch-exe" => await Client.LaunchExecutableAsync(
				WindowsContext(options),
				new WindowsExecutableLaunchRequest
				{
					ExecutablePath = options.Required("path"),
					Arguments = options.Values("arg"),
					WorkingDirectory = options.Value("working-directory"),
					CorrelationTimeout = options.Double("timeout", 10),
				},
				cancellationToken).ConfigureAwait(false),
			"attach" => await Client.AttachAsync(
				WindowsContext(options),
				new WindowsAttachRequest
				{
					CandidateId = options.Value("window") ?? options.RequiredPosition(0, "window ID"),
				},
				cancellationToken).ConfigureAwait(false),
			"session" => await Client.GetSessionAsync(
				WindowsContext(options),
				cancellationToken).ConfigureAwait(false),
			"windows" => await Client.ListSessionWindowsAsync(
				WindowsContext(options),
				cancellationToken).ConfigureAwait(false),
			"select" => await Client.SelectWindowAsync(
				WindowsContext(options),
				options.Value("window") ?? options.RequiredPosition(0, "window ID"),
				cancellationToken).ConfigureAwait(false),
			"reveal" => await Client.RevealAsync(
				WindowsContext(options),
				options.Value("window"),
				cancellationToken).ConfigureAwait(false),
			"restore" => await Client.RestoreAsync(
				WindowsContext(options),
				options.Value("window"),
				cancellationToken).ConfigureAwait(false),
			"ui-dump" or "ui-snapshot" => await Client.GetUiSnapshotAsync(
				WindowsContext(options),
				options.Required("window"),
				SnapshotRequest(options),
				cancellationToken).ConfigureAwait(false),
			"ui-find" => await Client.FindUiAsync(
				WindowsContext(options),
				options.Required("window"),
				new WindowsUiQuery
				{
					Selector = Selector(options),
					Limit = options.Int("limit", WindowsUiAutomationLimits.DefaultQueryLimit),
					MaximumDepth = options.Int("depth", WindowsUiAutomationLimits.DefaultMaximumDepth),
					MaximumNodes = options.Int("nodes", WindowsUiAutomationLimits.DefaultMaximumNodes),
					TimeoutMilliseconds = options.Int(
						"timeout",
						WindowsUiAutomationLimits.DefaultTimeoutMilliseconds),
				},
				cancellationToken).ConfigureAwait(false),
			"ui-act" => await Client.ActUiAsync(
				WindowsContext(options),
				options.Required("window"),
				new WindowsUiActionRequest
				{
					Action = options.Required("action"),
					Selector = Selector(options),
					Value = options.Value("value"),
					Scroll = options.Value("direction") is null && options.Value("amount") is null
						? null
						: new WindowsUiScrollRequest
						{
							Direction = options.Value("direction") ?? WindowsUiScrollDirections.Down,
							Amount = options.Value("amount") ?? WindowsUiScrollAmounts.Small,
						},
					MaximumDepth = options.Int(
						"depth",
						WindowsUiAutomationLimits.DefaultMaximumDepth),
					MaximumNodes = options.Int(
						"nodes",
						WindowsUiAutomationLimits.DefaultMaximumNodes),
					TimeoutMilliseconds = options.Int(
						"timeout",
						WindowsUiAutomationLimits.DefaultTimeoutMilliseconds),
				},
				cancellationToken).ConfigureAwait(false),
			"ui-wait" => await Client.WaitUiAsync(
				WindowsContext(options),
				options.Required("window"),
				new WindowsUiWaitRequest
				{
					Selector = Selector(options),
					Condition = options.Value("condition") ?? WindowsUiWaitConditions.Exists,
					Property = options.Value("property"),
					ExpectedValue = options.Value("expected"),
					TimeoutMilliseconds = options.Int(
						"timeout",
						WindowsUiAutomationLimits.DefaultTimeoutMilliseconds),
					PollIntervalMilliseconds = options.Int(
						"poll",
						WindowsUiAutomationLimits.DefaultPollIntervalMilliseconds),
					MaximumDepth = options.Int(
						"depth",
						WindowsUiAutomationLimits.DefaultMaximumDepth),
					MaximumNodes = options.Int(
						"nodes",
						WindowsUiAutomationLimits.DefaultMaximumNodes),
				},
				cancellationToken).ConfigureAwait(false),
			"release" => await Client.ReleaseAsync(
				WindowsContext(options),
				cancellationToken).ConfigureAwait(false),
			"screenshot" => await ScreenshotAsync(options, cancellationToken).ConfigureAwait(false),
			"geometry" => await Client.GetGeometryAsync(
				WindowsContext(options),
				options.Required("window"),
				cancellationToken).ConfigureAwait(false),
			"click" or "right-click" or "double-click" => await Client.ClickAsync(
				WindowsContext(options),
				options.Required("window"),
				new WindowsClickRequest
				{
					TransformVersion = options.Required("transform"),
					CaptureWidth = options.Int("capture-width", 0),
					CaptureHeight = options.Int("capture-height", 0),
					X = options.Double("x", 0),
					Y = options.Double("y", 0),
					Button = action == "right-click"
						? WindowsPointerButtons.Right
						: options.Value("button") ?? WindowsPointerButtons.Left,
					Count = action == "double-click" ? 2 : options.Int("count", 1),
					Modifiers = options.Values("modifier"),
				},
				cancellationToken).ConfigureAwait(false),
			"pointer" => await Client.PointerAsync(
				WindowsContext(options),
				options.Required("window"),
				new WindowsPointerRequest
				{
					TransformVersion = options.Required("transform"),
					CaptureWidth = options.Int("capture-width", 0),
					CaptureHeight = options.Int("capture-height", 0),
					X = options.Double("x", 0),
					Y = options.Double("y", 0),
					Action = options.Required("pointer-action"),
					Button = options.Value("button") ?? WindowsPointerButtons.Left,
					Modifiers = options.Values("modifier"),
				},
				cancellationToken).ConfigureAwait(false),
			"drag" => await Client.DragAsync(
				WindowsContext(options),
				options.Required("window"),
				new WindowsDragRequest
				{
					TransformVersion = options.Required("transform"),
					CaptureWidth = options.Int("capture-width", 0),
					CaptureHeight = options.Int("capture-height", 0),
					StartX = options.Double("x", 0),
					StartY = options.Double("y", 0),
					EndX = options.Double("end-x", 0),
					EndY = options.Double("end-y", 0),
					Button = options.Value("button") ?? WindowsPointerButtons.Left,
					DurationMilliseconds = options.Int(
						"duration",
						WindowsInputLimits.DefaultDragDurationMilliseconds),
					Steps = options.Int("steps", WindowsInputLimits.DefaultDragSteps),
					Modifiers = options.Values("modifier"),
				},
				cancellationToken).ConfigureAwait(false),
			"wheel" => await Client.WheelAsync(
				WindowsContext(options),
				options.Required("window"),
				new WindowsWheelRequest
				{
					TransformVersion = options.Required("transform"),
					CaptureWidth = options.Int("capture-width", 0),
					CaptureHeight = options.Int("capture-height", 0),
					X = options.Double("x", 0),
					Y = options.Double("y", 0),
					DeltaY = options.Double("delta-y", 0),
					DeltaX = options.Double("delta-x", 0),
					Modifiers = options.Values("modifier"),
				},
				cancellationToken).ConfigureAwait(false),
			"key" => await Client.KeyAsync(
				WindowsContext(options),
				options.Required("window"),
				new WindowsKeyRequest
				{
					TransformVersion = options.Required("transform"),
					Keys = options.Values("key"),
					Action = options.Value("key-action") ?? WindowsKeyActions.Press,
					Modifiers = options.Values("modifier"),
				},
				cancellationToken).ConfigureAwait(false),
			"type" => await Client.TypeTextAsync(
				WindowsContext(options),
				options.Required("window"),
				new WindowsTypeTextRequest
				{
					TransformVersion = options.Required("transform"),
					Text = options.Required("text"),
					DelayMilliseconds = options.Int("delay", 0),
				},
				cancellationToken).ConfigureAwait(false),
			_ => throw new ArgumentException(
				$"Unknown command 'windows {action}'. Run 'mobile-canvas --help'."),
		};

		Write(result, json);
		return 0;
	}

	/// <summary>
	/// Captures a window and writes the PNG somewhere durable, then reports the path together with
	/// the descriptor. An agent needs the file to look at and the transform token to act on, and
	/// separating them would invite clicking against a screenshot whose geometry has expired.
	/// </summary>
	private static async Task<WindowsScreenshotArtifact> ScreenshotAsync(
		CliArguments options,
		CancellationToken cancellationToken)
	{
		var windowId = options.Value("window") ?? options.RequiredPosition(0, "window ID");
		var screenshot = await Client.ScreenshotAsync(
			WindowsContext(options),
			windowId,
			new WindowsScreenshotRequest
			{
				Scale = options.Double("scale", WindowsCaptureLimits.DefaultScale),
				MaximumDimension = options.Int("max-dimension", 0),
				IncludeCursor = options.Flag("cursor"),
			},
			cancellationToken).ConfigureAwait(false);

		var output = Path.GetFullPath(
			options.Value("output") ?? CreateScreenshotPath(screenshot.Descriptor.WindowId));
		Directory.CreateDirectory(Path.GetDirectoryName(output)!);
		await File.WriteAllBytesAsync(output, screenshot.Png, cancellationToken)
			.ConfigureAwait(false);
		return new WindowsScreenshotArtifact
		{
			Path = output,
			Bytes = screenshot.Png.Length,
			CreatedAt = DateTimeOffset.UtcNow,
			Descriptor = screenshot.Descriptor,
		};
	}

	internal static string CreateScreenshotPath(string windowId)
	{
		var directory = Path.Combine(DevicePaths.Home, "artifacts", "windows-screenshots");
		Directory.CreateDirectory(directory);
		return Path.Combine(directory, CreateScreenshotFileName(windowId, DateTimeOffset.Now));
	}

	/// <summary>
	/// A default file name that cannot escape the artifacts directory. Window identifiers are
	/// minted by the host, but a name that reached the filesystem unchecked would still be one
	/// path separator away from writing somewhere it was never meant to.
	/// </summary>
	internal static string CreateScreenshotFileName(string windowId, DateTimeOffset timestamp)
	{
		var safe = new string([.. windowId
			.Where(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_')
			.Take(32)]);
		if (safe.Length == 0)
			safe = "window";
		return $"windows-{safe}-{timestamp:yyyyMMdd-HHmmss}.png";
	}

	/// <summary>
	/// The canvas panel a Windows command speaks for. <c>--surface</c> is not read here: a
	/// <c>windows</c> command is a Windows command, and letting it name another surface would be a
	/// way to reach a Mobile panel's state through a Windows verb.
	/// </summary>
	private static CanvasContextKey WindowsContext(CliArguments options) =>
		new(
			options.Required("session"),
			options.Required("instance"),
			CanvasSurfaces.Windows);

	private static void Write(object value, bool json)
	{
		if (json)
		{
			Console.WriteLine(JsonSerializer.Serialize(
				value,
				value.GetType(),
				WindowsJsonContext.Default));
			return;
		}

		switch (value)
		{
			case WindowsPreflight preflight:
				Console.WriteLine(
					$"{(preflight.Ready ? "ready" : "not ready")}" +
					$"{(preflight.Code is null ? "" : $" [{preflight.Code}]")}" +
					$"{(preflight.HelperVersion is null ? "" : $" helper {preflight.HelperVersion}")}" +
					$"{(preflight.SignatureStatus is null ? "" : $" ({preflight.SignatureStatus})")}");
				if (preflight.Detail is not null)
					Console.WriteLine(preflight.Detail);
				foreach (var feature in preflight.Features)
					Console.WriteLine($"  {feature.Name}: {(feature.Available ? "yes" : "no")}");
				break;
			case WindowsCatalogResult catalog:
				foreach (var entry in catalog.Entries)
				{
					Console.WriteLine(
						$"{entry.DisplayName} [{entry.Kind}] {entry.Id}" +
						$"{(entry.AmbiguousWith.Length > 0 ? $" (ambiguous with {entry.AmbiguousWith.Length})" : "")}");
				}
				Console.WriteLine($"{catalog.TotalMatches} match(es).");
				break;
			case WindowsWindowCandidateList candidates:
				foreach (var window in candidates.Windows)
				{
					Console.WriteLine(
						$"{(window.Attached ? "*" : window.Attachable ? " " : "!")} " +
						$"{window.Title} [{window.ProcessName}] {window.Id}" +
						$"{(window.UnattachableCode is null ? "" : $" ({window.UnattachableCode})")}");
				}
				break;
			case WindowsAppSession session:
				WriteSession(session);
				break;
			case WindowsAppSelection selection:
				if (selection is { HasSelection: true, Session: { } selected })
					WriteSession(selected);
				else
					Console.WriteLine("No Windows app session is attached.");
				break;
			case WindowsAuthorizedWindowList windows:
				foreach (var window in windows.Windows)
					WriteWindow(window);
				break;
			case WindowsOperationResult operation:
				Console.WriteLine(
					$"{operation.Operation}: {(operation.Success ? "ok" : "refused")}" +
					$"{(operation.Detail is null ? "" : $" - {operation.Detail}")}");
				break;
			case WindowsUiSnapshot snapshot:
				Console.WriteLine(
					$"UI tree: {snapshot.Metadata.NodeCount} node(s)" +
					$"{(snapshot.Metadata.Truncated ? " (truncated)" : "")}" +
					$"{(snapshot.Metadata.TimedOut ? " (timed out)" : "")}");
				if (snapshot.Root is { } root)
					WriteElement(root, 0);
				break;
			case WindowsUiFindResult find:
				Console.WriteLine($"{find.TotalMatches} match(es).");
				foreach (var match in find.Matches)
					WriteElement(match.Element, 1);
				break;
			case WindowsUiActionResult action:
				Console.WriteLine(
					$"{action.Action}: {(action.Success ? "ok" : action.Code ?? "failed")}" +
					$"{(action.Detail is null ? "" : $" - {action.Detail}")}");
				break;
			case WindowsUiWaitResult wait:
				Console.WriteLine(
					$"wait {wait.Condition}: {(wait.Satisfied ? "satisfied" : wait.Code ?? "not satisfied")}" +
					$"{(wait.Detail is null ? "" : $" - {wait.Detail}")}");
				break;
			case WindowsScreenshotArtifact artifact:
				Console.WriteLine($"{artifact.Path} ({artifact.Bytes} bytes)");
				WriteGeometry(artifact.Descriptor.Geometry);
				Console.WriteLine(
					$"  source {artifact.Descriptor.Source}" +
					$"{(artifact.Descriptor.SourceDetail is null ? "" : $" - {artifact.Descriptor.SourceDetail}")}");
				break;
			case WindowsCaptureGeometry geometry:
				WriteGeometry(geometry);
				break;
			case WindowsInputResult input:
				Console.WriteLine(
					$"{input.Operation}: {(input.Success ? "ok" : input.Code ?? "failed")}" +
					$"{(input.Point is null ? "" : $" at ({input.Point.X:0}, {input.Point.Y:0})")}" +
					$"{(input.CharacterCount is null ? "" : $" {input.CharacterCount} character(s)")}" +
					$"{(input.Detail is null ? "" : $" - {input.Detail}")}");
				Console.WriteLine($"  transform {input.TransformVersion}");
				break;
			default:
				Console.WriteLine(JsonSerializer.Serialize(
					value,
					value.GetType(),
					WindowsJsonContext.Default));
				break;
		}
	}

	private static void WriteSession(WindowsAppSession session)
	{
		Console.WriteLine($"{session.DisplayName} [{session.Origin}] {session.Id}");
		if (session.PendingCode is not null)
			Console.WriteLine($"  {session.PendingCode}: {session.PendingDetail}");
		foreach (var window in session.Windows)
			WriteWindow(window);
	}

	private static void WriteWindow(WindowsAuthorizedWindow window) =>
		Console.WriteLine(
			$"  {(window.Selected ? ">" : " ")} {window.Title} " +
			$"[{window.Correlation}{(window.Minimized ? ", minimized" : "")}] {window.Id}");

	private static void WriteGeometry(WindowsCaptureGeometry geometry)
	{
		Console.WriteLine(
			$"  content {geometry.ContentWidth}x{geometry.ContentHeight} " +
			$"capture {geometry.CaptureWidth}x{geometry.CaptureHeight} " +
			$"scale {geometry.Scale:0.###} dpi {geometry.Dpi}" +
			$"{(geometry.Minimized ? " (minimized)" : "")}");
		Console.WriteLine(
			$"  screen {geometry.ContentScreenBounds.Left},{geometry.ContentScreenBounds.Top} " +
			$"transform {geometry.TransformVersion}");
	}

	private static void WriteElement(WindowsUiElement element, int indentation)
	{
		var label = element.Properties.Password == true
			? "<password>"
			: element.Properties.Name ?? element.Properties.AutomationId ?? "";
		Console.WriteLine($"{new string(' ', indentation * 2)}{element.Role} {label}".TrimEnd());
		foreach (var child in element.Children)
			WriteElement(child, indentation + 1);
	}

	private static WindowsUiSnapshotRequest SnapshotRequest(CliArguments options) =>
		new()
		{
			MaximumDepth = options.Int("depth", WindowsUiAutomationLimits.DefaultMaximumDepth),
			MaximumNodes = options.Int("nodes", WindowsUiAutomationLimits.DefaultMaximumNodes),
			TimeoutMilliseconds = options.Int(
				"timeout",
				WindowsUiAutomationLimits.DefaultTimeoutMilliseconds),
		};

	private static WindowsUiSelector Selector(CliArguments options) =>
		new()
		{
			AutomationId = options.Value("automation-id"),
			ControlType = options.Value("control-type"),
			Role = options.Value("role"),
			Name = options.Value("name"),
			Value = options.Value("match-value"),
			Exact = !options.Flag("contains"),
			Index = options.Value("index") is { } index
				? int.Parse(index, System.Globalization.CultureInfo.InvariantCulture)
				: null,
			Path = options.Value("path") is { Length: > 0 } path
				? [.. path.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
					.Select(value => int.Parse(value, System.Globalization.CultureInfo.InvariantCulture))]
				: [],
		};
}
