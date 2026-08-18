using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using WindowsCanvas.Contracts;

namespace WindowsCanvas.Windows;

/// <summary>
/// Runs the checksummed <c>windows-app-helper.exe</c> that ships beside <c>mobile-canvas.exe</c>
/// and parses its strict JSON with the source-generated context.
///
/// Every invocation is bounded. The helper reads Shell, registry, and window state that a hostile
/// or merely broken machine can make arbitrarily large or arbitrarily slow, so output is capped
/// and the process is killed on timeout instead of the host waiting forever on a child.
/// </summary>
public sealed class ProcessWindowsNativeBridge : IWindowsNativeBridge
{
	internal const string HelperFileName = "windows-app-helper.exe";
	internal static Encoding HelperInputEncoding { get; } = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

	/// <summary>
	/// Enough for a very large machine's app catalog, small enough that a runaway helper cannot
	/// exhaust the host. A payload past this point is a bug, not a big desktop.
	/// </summary>
	private const int MaximumOutputCharacters = 16 * 1024 * 1024;

	private readonly string? _helperPath;
	private readonly TimeSpan _timeout;

	public ProcessWindowsNativeBridge(string? helperDirectory = null, TimeSpan? timeout = null)
	{
		// A UIA request may intentionally wait for its full public 30-second maximum. Keep a small
		// process-supervision margin for the helper to serialize its bounded result, while still
		// guaranteeing a stuck native call cannot survive longer than this outer deadline.
		_timeout = timeout ?? TimeSpan.FromSeconds(35);
		var directory = helperDirectory ?? DefaultHelperDirectory();
		_helperPath = directory is null ? null : Path.Combine(directory, HelperFileName);
	}

	public WindowsHelperLocation Locate()
	{
		if (!OperatingSystem.IsWindows())
		{
			return new WindowsHelperLocation
			{
				PlatformSupported = false,
				Path = _helperPath,
				Present = false,
				Detail = "Windows App Canvas runs only on Windows.",
			};
		}

		if (_helperPath is null)
		{
			return new WindowsHelperLocation
			{
				PlatformSupported = true,
				Present = false,
				Detail = "Could not determine the directory that holds mobile-canvas.exe.",
			};
		}

		var present = File.Exists(_helperPath);
		return new WindowsHelperLocation
		{
			PlatformSupported = true,
			Path = _helperPath,
			Present = present,
			Detail = present
				? null
				: $"{HelperFileName} is missing from {Path.GetDirectoryName(_helperPath)}. " +
					"Reinstall the Mobile Canvas runtime for this architecture.",
		};
	}

	public Task<WindowsHelperCapabilities> GetCapabilitiesAsync(
		CancellationToken cancellationToken = default) =>
		RunAsync(
			WindowsJsonContext.Default.WindowsHelperCapabilities,
			["capabilities", "--json"],
			cancellationToken);

	public Task<WindowsHelperCatalog> GetCatalogAsync(CancellationToken cancellationToken = default) =>
		RunAsync(
			WindowsJsonContext.Default.WindowsHelperCatalog,
			["catalog", "--json"],
			cancellationToken);

	public Task<WindowsHelperWindowList> ListWindowsAsync(
		CancellationToken cancellationToken = default) =>
		RunAsync(
			WindowsJsonContext.Default.WindowsHelperWindowList,
			["windows", "--json"],
			cancellationToken);

	public Task<WindowsHelperLaunch> LaunchCatalogEntryAsync(
		string entryId,
		CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrWhiteSpace(entryId) || entryId.Length > 256)
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				"A catalog entry identifier is required.");
		}

		return RunAsync(
			WindowsJsonContext.Default.WindowsHelperLaunch,
			["launch", "--json", "--id", entryId],
			cancellationToken);
	}

	public async Task<WindowsUiSnapshot> GetUiSnapshotAsync(
		WindowsNativeWindowTarget target,
		WindowsUiSnapshotRequest request,
		CancellationToken cancellationToken = default)
	{
		var normalized = WindowsUiAutomationNormalizer.SnapshotRequest(request);
		var response = await RunAsync(
			WindowsJsonContext.Default.WindowsHelperUiSnapshot,
			["uia-snapshot", "--json"],
			WindowsNativeUiJsonContext.Default.WindowsNativeUiSnapshotRequest,
			new WindowsNativeUiSnapshotRequest { Handle = target.Handle, Request = normalized },
			cancellationToken).ConfigureAwait(false);
		return response.Result ?? MissingResult<WindowsUiSnapshot>("uia-snapshot");
	}

	public async Task<WindowsUiFindResult> FindUiAsync(
		WindowsNativeWindowTarget target,
		WindowsUiQuery query,
		CancellationToken cancellationToken = default)
	{
		var normalized = WindowsUiAutomationNormalizer.Query(query);
		var response = await RunAsync(
			WindowsJsonContext.Default.WindowsHelperUiFind,
			["uia-find", "--json"],
			WindowsNativeUiJsonContext.Default.WindowsNativeUiFindRequest,
			new WindowsNativeUiFindRequest { Handle = target.Handle, Query = normalized },
			cancellationToken).ConfigureAwait(false);
		return response.Result ?? MissingResult<WindowsUiFindResult>("uia-find");
	}

	public async Task<WindowsUiActionResult> ActUiAsync(
		WindowsNativeWindowTarget target,
		WindowsUiActionRequest request,
		CancellationToken cancellationToken = default)
	{
		var normalized = WindowsUiAutomationNormalizer.Action(request);
		var response = await RunAsync(
			WindowsJsonContext.Default.WindowsHelperUiAction,
			["uia-action", "--json"],
			WindowsNativeUiJsonContext.Default.WindowsNativeUiActionRequest,
			new WindowsNativeUiActionRequest { Handle = target.Handle, Request = normalized },
			cancellationToken).ConfigureAwait(false);
		return response.Result ?? MissingResult<WindowsUiActionResult>("uia-action");
	}

	public async Task<WindowsUiWaitResult> WaitUiAsync(
		WindowsNativeWindowTarget target,
		WindowsUiWaitRequest request,
		CancellationToken cancellationToken = default)
	{
		var normalized = WindowsUiAutomationNormalizer.Wait(request);
		var response = await RunAsync(
			WindowsJsonContext.Default.WindowsHelperUiWait,
			["uia-wait", "--json"],
			WindowsNativeUiJsonContext.Default.WindowsNativeUiWaitRequest,
			new WindowsNativeUiWaitRequest { Handle = target.Handle, Request = normalized },
			cancellationToken).ConfigureAwait(false);
		return response.Result ?? MissingResult<WindowsUiWaitResult>("uia-wait");
	}

	/// <summary>
	/// Runs the one-shot screenshot command. Standard output carries nothing but PNG bytes and
	/// standard error carries nothing but one JSON descriptor line, so the two never have to be
	/// separated by a framing convention that could be got wrong.
	/// </summary>
	public async Task<WindowsScreenshot> CaptureScreenshotAsync(
		WindowsNativeWindowTarget target,
		WindowsScreenshotRequest request,
		CancellationToken cancellationToken = default)
	{
		var normalized = WindowsCaptureNormalizer.Screenshot(request);
		var helperPath = RequireHelperPath();
		var payload = JsonSerializer.Serialize(
			new WindowsNativeScreenshotRequest
			{
				Handle = target.Handle,
				Screenshot = new WindowsNativeScreenshotBody
				{
					Scale = normalized.Scale,
					MaximumDimension = normalized.MaximumDimension,
					IncludeCursor = normalized.IncludeCursor,
					TimeoutMilliseconds = WindowsCaptureLimits.DefaultStartupTimeoutMilliseconds,
				},
			},
			WindowsNativeCaptureJsonContext.Default.WindowsNativeScreenshotRequest);

		var startInfo = new ProcessStartInfo
		{
			FileName = helperPath,
			UseShellExecute = false,
			RedirectStandardInput = true,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			CreateNoWindow = true,
			StandardErrorEncoding = Encoding.UTF8,
			StandardInputEncoding = HelperInputEncoding,
		};
		startInfo.ArgumentList.Add("screenshot");
		startInfo.ArgumentList.Add("--json");

		using var process = Start(startInfo);
		using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
		timeout.CancelAfter(_timeout);

		byte[] bytes;
		string diagnostics;
		try
		{
			await process.StandardInput.WriteAsync(payload.AsMemory(), timeout.Token)
				.ConfigureAwait(false);
			await process.StandardInput.FlushAsync(timeout.Token).ConfigureAwait(false);
			process.StandardInput.Close();

			var bytesTask = ReadBoundedBytesAsync(
				process.StandardOutput.BaseStream,
				timeout.Token);
			var errorTask = ReadBoundedAsync(process.StandardError, timeout.Token);
			bytes = await bytesTask.ConfigureAwait(false);
			diagnostics = await errorTask.ConfigureAwait(false);
			await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
		}
		catch (OperationCanceledException)
		{
			TryKill(process);
			if (cancellationToken.IsCancellationRequested)
				throw;
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.HelperTimeout,
				$"{HelperFileName} screenshot did not finish within {_timeout.TotalSeconds:0} " +
				"seconds.");
		}
		catch (HelperOutputTooLargeException)
		{
			TryKill(process);
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.HelperOutputTooLarge,
				$"{HelperFileName} screenshot produced more than " +
				$"{WindowsCaptureLimits.MaximumScreenshotBytes / (1024 * 1024)} MB of image data.");
		}

		var status = ParseCaptureStatus(diagnostics)
			?? throw HelperFailure("screenshot", diagnostics, process.ExitCode);
		WindowsCaptureNormalizer.RequireOk(status, "screenshot");
		WindowsCaptureNormalizer.RequireIdentity(status, target.Window);
		if (process.ExitCode != 0)
			throw HelperFailure("screenshot", diagnostics, process.ExitCode);
		if (status.ByteCount != bytes.Length)
		{
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.CaptureFailed,
				$"{HelperFileName} screenshot announced {status.ByteCount} bytes but delivered " +
				$"{bytes.Length}. The image was discarded rather than decoded.");
		}

		return new WindowsScreenshot
		{
			Png = bytes,
			Descriptor = new WindowsScreenshotDescriptor
			{
				Status = string.IsNullOrWhiteSpace(status.Status)
					? WindowsCaptureStatuses.Ok
					: status.Status,
				Source = string.IsNullOrWhiteSpace(status.Source)
					? WindowsCaptureSources.WindowsGraphicsCapture
					: status.Source,
				SourceDetail = status.SourceDetail,
				Geometry = WindowsCaptureNormalizer.Geometry(status.Geometry, "screenshot"),
				Capabilities = status.Capabilities ?? new WindowsCaptureCapabilities(),
				ByteCount = bytes.Length,
				CapturedAt = DateTimeOffset.UtcNow,
			},
		};
	}

	public async Task<IWindowsVideoSession> OpenVideoAsync(
		WindowsNativeWindowTarget target,
		WindowsStreamRequest request,
		CancellationToken cancellationToken = default)
	{
		var normalized = WindowsCaptureNormalizer.Stream(request);
		var helperPath = RequireHelperPath();
		var payload = JsonSerializer.Serialize(
			new WindowsNativeCaptureRequest
			{
				Handle = target.Handle,
				Capture = new WindowsNativeCaptureBody
				{
					FramesPerSecond = normalized.FramesPerSecond,
					Scale = normalized.Scale,
					AverageBitrate = normalized.AverageBitrate,
					IncludeCursor = normalized.IncludeCursor,
					TimeoutMilliseconds = WindowsCaptureLimits.DefaultStartupTimeoutMilliseconds,
				},
			},
			WindowsNativeCaptureJsonContext.Default.WindowsNativeCaptureRequest);

		return await ProcessWindowsVideoSession.StartAsync(
			helperPath,
			payload,
			new WindowsStreamDescriptor
			{
				FramesPerSecond = normalized.FramesPerSecond,
				Scale = normalized.Scale,
				AverageBitrate = normalized.AverageBitrate,
			},
			TimeSpan.FromMilliseconds(WindowsCaptureLimits.DefaultStartupTimeoutMilliseconds),
			target.Window,
			cancellationToken).ConfigureAwait(false);
	}

	/// <summary>The last well-formed capture line the helper wrote to standard error.</summary>
	internal static WindowsHelperCapture? ParseCaptureStatus(string diagnostics)
	{
		WindowsHelperCapture? last = null;
		foreach (var line in diagnostics.Split('\n'))
		{
			if (ProcessWindowsVideoSession.TryParse(line.Trim('\r', ' ')) is { } parsed)
				last = parsed;
		}
		return last;
	}

	internal static string? DefaultHelperDirectory()
	{
		// AppContext follows the entry assembly for framework-dependent development runs and the
		// executable for Native AOT releases. Environment.ProcessPath points at dotnet.exe in the
		// former case, which would make the host look for its companion in the SDK installation.
		return AppContext.BaseDirectory;
	}

	private Task<T> RunAsync<T>(
		JsonTypeInfo<T> typeInfo,
		string[] arguments,
		CancellationToken cancellationToken)
		=> RunCoreAsync(typeInfo, arguments, input: null, cancellationToken);

	private Task<T> RunAsync<T, TInput>(
		JsonTypeInfo<T> typeInfo,
		string[] arguments,
		JsonTypeInfo<TInput> inputTypeInfo,
		TInput input,
		CancellationToken cancellationToken) =>
		RunCoreAsync(
			typeInfo,
			arguments,
			JsonSerializer.Serialize(input, inputTypeInfo),
			cancellationToken);

	private async Task<T> RunCoreAsync<T>(
		JsonTypeInfo<T> typeInfo,
		string[] arguments,
		string? input,
		CancellationToken cancellationToken)
	{
		var startInfo = CreateJsonStartInfo(RequireHelperPath(), arguments, input is not null);

		var process = Start(startInfo);

		using (process)
		using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
		{
			timeout.CancelAfter(_timeout);
			if (input is not null)
			{
				try
				{
					await process.StandardInput.WriteAsync(input.AsMemory(), timeout.Token)
						.ConfigureAwait(false);
					await process.StandardInput.FlushAsync(timeout.Token).ConfigureAwait(false);
					process.StandardInput.Close();
				}

				catch (OperationCanceledException)
				{
					TryKill(process);
					if (cancellationToken.IsCancellationRequested)
						throw;
					throw WindowsCanvasException.Gateway(
						WindowsErrorCodes.HelperTimeout,
						$"{HelperFileName} {arguments[0]} did not accept its request within " +
						$"{_timeout.TotalSeconds:0} seconds.");
				}
			}
			return await ReadAsync(process, timeout, arguments, typeInfo, cancellationToken)
				.ConfigureAwait(false);
		}
	}

	internal static ProcessStartInfo CreateJsonStartInfo(
		string helperPath,
		IEnumerable<string> arguments,
		bool redirectInput)
	{
		var startInfo = new ProcessStartInfo
		{
			FileName = helperPath,
			UseShellExecute = false,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			RedirectStandardInput = redirectInput,
			CreateNoWindow = true,
			StandardOutputEncoding = Encoding.UTF8,
			StandardErrorEncoding = Encoding.UTF8,
		};
		if (redirectInput)
			startInfo.StandardInputEncoding = HelperInputEncoding;
		foreach (var argument in arguments)
			startInfo.ArgumentList.Add(argument);
		return startInfo;
	}

	/// <summary>
	/// The helper's absolute path, or the one machine-readable failure a missing or non-Windows
	/// installation deserves. Every command resolves it through here so a packaging mistake reads
	/// the same whether it was noticed by a JSON command or by capture.
	/// </summary>
	private string RequireHelperPath()
	{
		var location = Locate();
		if (!location.PlatformSupported)
		{
			throw WindowsCanvasException.Conflict(
				WindowsErrorCodes.PlatformUnsupported,
				location.Detail ?? "Windows App Canvas runs only on Windows.");
		}
		if (!location.Present || location.Path is null)
		{
			throw WindowsCanvasException.Conflict(
				WindowsErrorCodes.HelperMissing,
				location.Detail ?? $"{HelperFileName} was not found.");
		}
		return location.Path;
	}

	private static Process Start(ProcessStartInfo startInfo)
	{
		try
		{
			return Process.Start(startInfo)
				?? throw WindowsCanvasException.Gateway(
					WindowsErrorCodes.HelperFailed,
					$"Could not start {HelperFileName}.");
		}
		catch (Win32Exception exception)
		{
			// A helper that will not start at all is a packaging or policy failure, not an
			// unhandled host error, so it keeps the same code every other helper failure uses.
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.HelperFailed,
				$"Windows refused to start {HelperFileName}: {exception.Message}");
		}
	}

	private async Task<T> ReadAsync<T>(
		Process process,
		CancellationTokenSource timeout,
		string[] arguments,
		JsonTypeInfo<T> typeInfo,
		CancellationToken cancellationToken)
	{
		string standardOutput;
		string standardError;
		try
		{
			var outputTask = ReadBoundedAsync(process.StandardOutput, timeout.Token);
			var errorTask = ReadBoundedAsync(process.StandardError, timeout.Token);
			standardOutput = await outputTask.ConfigureAwait(false);
			standardError = await errorTask.ConfigureAwait(false);
			await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
		}
		catch (OperationCanceledException)
		{
			TryKill(process);
			if (cancellationToken.IsCancellationRequested)
				throw;
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.HelperTimeout,
				$"{HelperFileName} {arguments[0]} did not finish within " +
				$"{_timeout.TotalSeconds:0} seconds.");
		}
		catch (HelperOutputTooLargeException)
		{
			TryKill(process);
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.HelperOutputTooLarge,
				$"{HelperFileName} {arguments[0]} produced more than " +
				$"{MaximumOutputCharacters / (1024 * 1024)} MB of output.");
		}

		if (process.ExitCode != 0)
			throw HelperFailure(arguments[0], standardError, process.ExitCode);

		return Parse(typeInfo, arguments[0], standardOutput);
	}

	/// <summary>
	/// Parses one strict, versioned payload. A schema version the host does not know is refused
	/// rather than best-effort bound: a mismatched helper means the installation is inconsistent,
	/// and reading half of its fields would be worse than saying so.
	/// </summary>
	internal static T Parse<T>(JsonTypeInfo<T> typeInfo, string command, string payload)
	{
		if (string.IsNullOrWhiteSpace(payload))
		{
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.HelperFailed,
				$"{HelperFileName} {command} returned no output.");
		}

		WindowsHelperEnvelope? envelope;
		try
		{
			envelope = JsonSerializer.Deserialize(
				payload,
				WindowsJsonContext.Default.WindowsHelperEnvelope);
		}
		catch (JsonException exception)
		{
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.HelperFailed,
				$"{HelperFileName} {command} returned malformed JSON: {exception.Message}");
		}

		if (envelope is null)
		{
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.HelperFailed,
				$"{HelperFileName} {command} returned an empty JSON document.");
		}
		if (envelope.SchemaVersion != WindowsCanvasProtocol.HelperSchemaVersion)
		{
			throw WindowsCanvasException.Conflict(
				WindowsErrorCodes.HelperIncompatible,
				$"{HelperFileName} reported schema version {envelope.SchemaVersion}; this host " +
				$"requires {WindowsCanvasProtocol.HelperSchemaVersion}. Reinstall the matching " +
				"Mobile Canvas runtime.");
		}
		if (!envelope.Ok)
		{
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.HelperFailed,
				Describe(envelope.Error) ?? $"{HelperFileName} {command} reported a failure.");
		}
		if (command.StartsWith("uia-", StringComparison.Ordinal))
			RequireUiResultVersion(command, payload);

		try
		{
			return JsonSerializer.Deserialize(payload, typeInfo)
				?? throw WindowsCanvasException.Gateway(
					WindowsErrorCodes.HelperFailed,
					$"{HelperFileName} {command} returned an empty result.");
		}
		catch (JsonException exception)
		{
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.HelperFailed,
				$"{HelperFileName} {command} returned an unreadable result: {exception.Message}");
		}
	}

	internal static WindowsCanvasException HelperFailure(
		string command,
		string standardError,
		int exitCode)
	{
		WindowsHelperEnvelope? envelope = null;
		try
		{
			if (!string.IsNullOrWhiteSpace(standardError))
			{
				envelope = JsonSerializer.Deserialize(
					standardError,
					WindowsJsonContext.Default.WindowsHelperEnvelope);
			}
		}
		catch (JsonException)
		{
			// A helper that crashed before it could frame an error still has to produce something
			// actionable, so fall through to the raw text below.
		}

		var detail = Describe(envelope?.Error)
			?? (string.IsNullOrWhiteSpace(standardError) ? null : standardError.Trim());
		return WindowsCanvasException.Gateway(
			WindowsErrorCodes.HelperFailed,
			$"{HelperFileName} {command} exited with {exitCode}" +
			(detail is null ? "." : $": {detail}"));
	}

	private static string? Describe(WindowsHelperErrorDetail? error) =>
		error is null
			? null
			: string.IsNullOrWhiteSpace(error.Hresult)
				? $"{error.Code}: {error.Message}"
				: $"{error.Code}: {error.Message} ({error.Hresult})";

	private static void RequireUiResultVersion(string command, string payload)
	{
		try
		{
			using var document = JsonDocument.Parse(payload);
			if (!document.RootElement.TryGetProperty("result", out var result) ||
				result.ValueKind != JsonValueKind.Object ||
				!result.TryGetProperty("schemaVersion", out var version) ||
				version.ValueKind != JsonValueKind.String)
			{
				throw WindowsCanvasException.Gateway(
					WindowsErrorCodes.HelperFailed,
					$"{HelperFileName} {command} omitted its versioned result.");
			}
			if (!version.GetString()!.Equals(
					WindowsCanvasProtocol.Version,
					StringComparison.Ordinal))
			{
				throw WindowsCanvasException.Conflict(
					WindowsErrorCodes.HelperIncompatible,
					$"{HelperFileName} {command} reported result schema version " +
					$"'{version.GetString()}'; this host requires " +
					$"'{WindowsCanvasProtocol.Version}'.");
			}
		}
		catch (JsonException exception)
		{
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.HelperFailed,
				$"{HelperFileName} {command} returned malformed JSON: {exception.Message}");
		}
	}

	private static T MissingResult<T>(string command) =>
		throw WindowsCanvasException.Gateway(
			WindowsErrorCodes.HelperFailed,
			$"{HelperFileName} {command} returned no result.");

	private static async Task<string> ReadBoundedAsync(
		StreamReader reader,
		CancellationToken cancellationToken)
	{
		var builder = new StringBuilder();
		var buffer = new char[8192];
		while (true)
		{
			var read = await reader.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
			if (read == 0)
				return builder.ToString();
			if (builder.Length + read > MaximumOutputCharacters)
				throw new HelperOutputTooLargeException();
			builder.Append(buffer, 0, read);
		}
	}

	/// <summary>
	/// Reads an image payload with a hard ceiling. A screenshot is the one helper answer that is
	/// binary, and an unbounded read of a child process's pipe is exactly how a broken helper turns
	/// into a host that runs out of memory.
	/// </summary>
	private static async Task<byte[]> ReadBoundedBytesAsync(
		Stream stream,
		CancellationToken cancellationToken)
	{
		using var image = new MemoryStream();
		var buffer = new byte[64 * 1024];
		while (true)
		{
			var read = await stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
			if (read == 0)
				return image.ToArray();
			if (image.Length + read > WindowsCaptureLimits.MaximumScreenshotBytes)
				throw new HelperOutputTooLargeException();
			image.Write(buffer, 0, read);
		}
	}

	private static void TryKill(Process process)
	{
		try
		{
			if (!process.HasExited)
				process.Kill(entireProcessTree: true);
		}
		catch (InvalidOperationException)
		{
		}
		catch (SystemException)
		{
		}
	}

	private sealed class HelperOutputTooLargeException : Exception;
}
