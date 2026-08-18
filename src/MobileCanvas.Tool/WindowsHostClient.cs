using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using MobileCanvas.Contracts;
using WindowsCanvas.Contracts;

namespace MobileCanvas.Tool;

/// <summary>
/// The client for the Windows App Canvas surface.
///
/// It is a separate type rather than more methods on <see cref="DeviceHostClient"/> because the
/// two products share only the host: discovery, startup, version negotiation, and the control
/// token are reused through the inner client, while the routes, payloads, and JSON context stay
/// Windows-only. Every panel-scoped call carries <c>surface=windows</c>, so the host's scope guard
/// can tell a Windows caller from a Mobile one even when both use the control token.
/// </summary>
public sealed class WindowsHostClient(DeviceHostClient host)
{
	private readonly DeviceHostClient _host = host;

	public WindowsHostClient()
		: this(new DeviceHostClient())
	{
	}

	public Task<WindowsPreflight> GetPreflightAsync(CancellationToken cancellationToken = default) =>
		GetAsync(
			"/api/v1/windows/capabilities",
			WindowsJsonContext.Default.WindowsPreflight,
			context: null,
			cancellationToken);

	public Task<WindowsCatalogResult> ListAppsAsync(
		WindowsCatalogQuery? query = null,
		CancellationToken cancellationToken = default)
	{
		var path = "/api/v1/windows/apps";
		var parameters = new List<string>();
		if (!string.IsNullOrWhiteSpace(query?.Text))
			parameters.Add($"text={Uri.EscapeDataString(query.Text)}");
		if (query?.Limit is > 0)
			parameters.Add($"limit={query.Limit}");
		if (query?.AmbiguousOnly == true)
			parameters.Add("ambiguous=true");
		if (parameters.Count > 0)
			path += "?" + string.Join('&', parameters);

		return GetAsync(
			path,
			WindowsJsonContext.Default.WindowsCatalogResult,
			context: null,
			cancellationToken);
	}

	public Task<WindowsWindowCandidateList> ListWindowsAsync(
		CanvasContextKey context,
		CancellationToken cancellationToken = default) =>
		GetAsync(
			"/api/v1/windows/windows",
			WindowsJsonContext.Default.WindowsWindowCandidateList,
			context,
			cancellationToken);

	public Task<WindowsAppSession> LaunchAppAsync(
		CanvasContextKey context,
		WindowsCatalogLaunchRequest request,
		CancellationToken cancellationToken = default) =>
		PostAsync(
			"/api/v1/windows/session/launch",
			JsonContent.Create(request, WindowsJsonContext.Default.WindowsCatalogLaunchRequest),
			WindowsJsonContext.Default.WindowsAppSession,
			context,
			cancellationToken);

	public Task<WindowsAppSession> LaunchExecutableAsync(
		CanvasContextKey context,
		WindowsExecutableLaunchRequest request,
		CancellationToken cancellationToken = default) =>
		PostAsync(
			"/api/v1/windows/session/launch-executable",
			JsonContent.Create(request, WindowsJsonContext.Default.WindowsExecutableLaunchRequest),
			WindowsJsonContext.Default.WindowsAppSession,
			context,
			cancellationToken);

	public Task<WindowsAppSession> AttachAsync(
		CanvasContextKey context,
		WindowsAttachRequest request,
		CancellationToken cancellationToken = default) =>
		PostAsync(
			"/api/v1/windows/session/attach",
			JsonContent.Create(request, WindowsJsonContext.Default.WindowsAttachRequest),
			WindowsJsonContext.Default.WindowsAppSession,
			context,
			cancellationToken);

	public Task<WindowsAppSelection> GetSessionAsync(
		CanvasContextKey context,
		CancellationToken cancellationToken = default) =>
		GetAsync(
			"/api/v1/windows/session",
			WindowsJsonContext.Default.WindowsAppSelection,
			context,
			cancellationToken);

	public Task<WindowsAuthorizedWindowList> ListSessionWindowsAsync(
		CanvasContextKey context,
		CancellationToken cancellationToken = default) =>
		GetAsync(
			"/api/v1/windows/session/windows",
			WindowsJsonContext.Default.WindowsAuthorizedWindowList,
			context,
			cancellationToken);

	public Task<WindowsAppSession> SelectWindowAsync(
		CanvasContextKey context,
		string windowId,
		CancellationToken cancellationToken = default) =>
		PostAsync(
			"/api/v1/windows/session/windows/select",
			JsonContent.Create(
				new WindowsSelectWindowRequest { WindowId = windowId },
				WindowsJsonContext.Default.WindowsSelectWindowRequest),
			WindowsJsonContext.Default.WindowsAppSession,
			context,
			cancellationToken);

	public Task<WindowsOperationResult> RevealAsync(
		CanvasContextKey context,
		string? windowId = null,
		CancellationToken cancellationToken = default) =>
		ActAsync("reveal", context, windowId, cancellationToken);

	public Task<WindowsOperationResult> RestoreAsync(
		CanvasContextKey context,
		string? windowId = null,
		CancellationToken cancellationToken = default) =>
		ActAsync("restore", context, windowId, cancellationToken);

	public Task<WindowsOperationResult> ReleaseAsync(
		CanvasContextKey context,
		CancellationToken cancellationToken = default) =>
		PostAsync(
			"/api/v1/windows/session/release",
			content: null,
			WindowsJsonContext.Default.WindowsOperationResult,
			context,
			cancellationToken);

	public Task<WindowsUiSnapshot> GetUiSnapshotAsync(
		CanvasContextKey context,
		string windowId,
		WindowsUiSnapshotRequest? request = null,
		CancellationToken cancellationToken = default)
	{
		request ??= new WindowsUiSnapshotRequest();
		var path = UiPath(windowId, "snapshot");
		var parameters = new List<string>();
		if (request.MaximumDepth != WindowsUiAutomationLimits.DefaultMaximumDepth)
			parameters.Add($"maximumDepth={request.MaximumDepth}");
		if (request.MaximumNodes != WindowsUiAutomationLimits.DefaultMaximumNodes)
			parameters.Add($"maximumNodes={request.MaximumNodes}");
		if (request.TimeoutMilliseconds != WindowsUiAutomationLimits.DefaultTimeoutMilliseconds)
			parameters.Add($"timeoutMilliseconds={request.TimeoutMilliseconds}");
		if (parameters.Count > 0)
			path += "?" + string.Join('&', parameters);

		return GetAsync(path, WindowsJsonContext.Default.WindowsUiSnapshot, context, cancellationToken);
	}

	public Task<WindowsUiFindResult> FindUiAsync(
		CanvasContextKey context,
		string windowId,
		WindowsUiQuery query,
		CancellationToken cancellationToken = default) =>
		PostAsync(
			UiPath(windowId, "find"),
			JsonContent.Create(query, WindowsJsonContext.Default.WindowsUiQuery),
			WindowsJsonContext.Default.WindowsUiFindResult,
			context,
			cancellationToken);

	public Task<WindowsUiActionResult> ActUiAsync(
		CanvasContextKey context,
		string windowId,
		WindowsUiActionRequest request,
		CancellationToken cancellationToken = default) =>
		PostAsync(
			UiPath(windowId, "action"),
			JsonContent.Create(request, WindowsJsonContext.Default.WindowsUiActionRequest),
			WindowsJsonContext.Default.WindowsUiActionResult,
			context,
			cancellationToken);

	public Task<WindowsUiWaitResult> WaitUiAsync(
		CanvasContextKey context,
		string windowId,
		WindowsUiWaitRequest request,
		CancellationToken cancellationToken = default) =>
		PostAsync(
			UiPath(windowId, "wait"),
			JsonContent.Create(request, WindowsJsonContext.Default.WindowsUiWaitRequest),
			WindowsJsonContext.Default.WindowsUiWaitResult,
			context,
			cancellationToken);

	/// <summary>
	/// Captures one PNG of an authorized window.
	///
	/// The image comes back as bytes and its descriptor as a base64 response header, so the two
	/// are never separated. The descriptor's transform token is what a later click has to present:
	/// coordinates read off these pixels mean nothing without it.
	/// </summary>
	public async Task<WindowsScreenshot> ScreenshotAsync(
		CanvasContextKey context,
		string windowId,
		WindowsScreenshotRequest? request = null,
		CancellationToken cancellationToken = default)
	{
		var path = CapturePath(windowId, "screenshot");
		var parameters = new List<string>();
		if (request is { Scale: > 0 } && Math.Abs(request.Scale - 1) > 0.0001)
		{
			parameters.Add(
				"scale=" + request.Scale.ToString(CultureInfo.InvariantCulture));
		}
		if (request is { MaximumDimension: > 0 })
			parameters.Add($"maximumDimension={request.MaximumDimension}");
		if (request?.IncludeCursor == true)
			parameters.Add("cursor=true");
		if (parameters.Count > 0)
			path += "?" + string.Join('&', parameters);

		return await ImageAsync(path, context, cancellationToken).ConfigureAwait(false);
	}

	/// <summary>
	/// Captures one bounded PNG preview of a window this panel was offered but has not attached, so
	/// a picker can show what a window looks like before anybody grants anything.
	///
	/// The identifier is a candidate ID from <see cref="ListWindowsAsync"/>, and it is what the
	/// returned descriptor names: this is a picture of a window that was offered, not of one this
	/// canvas may drive.
	/// </summary>
	public Task<WindowsScreenshot> CandidateThumbnailAsync(
		CanvasContextKey context,
		string candidateId,
		int maximumDimension = 0,
		CancellationToken cancellationToken = default)
	{
		if (string.IsNullOrWhiteSpace(candidateId))
			throw new ArgumentException("A Windows candidate ID is required.", nameof(candidateId));

		var path = "/api/v1/windows/windows/" + Uri.EscapeDataString(candidateId) + "/thumbnail";
		if (maximumDimension > 0)
			path += $"?maximumDimension={maximumDimension}";
		return ImageAsync(path, context, cancellationToken);
	}

	private async Task<WindowsScreenshot> ImageAsync(
		string path,
		CanvasContextKey context,
		CancellationToken cancellationToken)
	{
		using var response = await _host.SendAsync(
			HttpMethod.Get,
			Address(path, context),
			content: null,
			cancellationToken).ConfigureAwait(false);
		if (!response.IsSuccessStatusCode)
		{
			var body = await response.Content.ReadAsStringAsync(cancellationToken)
				.ConfigureAwait(false);
			throw Failure(response, body);
		}

		var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken)
			.ConfigureAwait(false);
		return new WindowsScreenshot
		{
			Png = bytes,
			Descriptor = DecodeDescriptor(response, bytes.Length),
		};
	}

	public Task<WindowsCaptureGeometry> GetGeometryAsync(
		CanvasContextKey context,
		string windowId,
		CancellationToken cancellationToken = default) =>
		GetAsync(
			CapturePath(windowId, "geometry"),
			WindowsJsonContext.Default.WindowsCaptureGeometry,
			context,
			cancellationToken);

	public Task<WindowsInputResult> ClickAsync(
		CanvasContextKey context,
		string windowId,
		WindowsClickRequest request,
		CancellationToken cancellationToken = default) =>
		PostAsync(
			InputPath(windowId, "click"),
			JsonContent.Create(request, WindowsJsonContext.Default.WindowsClickRequest),
			WindowsJsonContext.Default.WindowsInputResult,
			context,
			cancellationToken);

	public Task<WindowsInputResult> PointerAsync(
		CanvasContextKey context,
		string windowId,
		WindowsPointerRequest request,
		CancellationToken cancellationToken = default) =>
		PostAsync(
			InputPath(windowId, "pointer"),
			JsonContent.Create(request, WindowsJsonContext.Default.WindowsPointerRequest),
			WindowsJsonContext.Default.WindowsInputResult,
			context,
			cancellationToken);

	public Task<WindowsInputResult> DragAsync(
		CanvasContextKey context,
		string windowId,
		WindowsDragRequest request,
		CancellationToken cancellationToken = default) =>
		PostAsync(
			InputPath(windowId, "drag"),
			JsonContent.Create(request, WindowsJsonContext.Default.WindowsDragRequest),
			WindowsJsonContext.Default.WindowsInputResult,
			context,
			cancellationToken);

	public Task<WindowsInputResult> WheelAsync(
		CanvasContextKey context,
		string windowId,
		WindowsWheelRequest request,
		CancellationToken cancellationToken = default) =>
		PostAsync(
			InputPath(windowId, "wheel"),
			JsonContent.Create(request, WindowsJsonContext.Default.WindowsWheelRequest),
			WindowsJsonContext.Default.WindowsInputResult,
			context,
			cancellationToken);

	public Task<WindowsInputResult> KeyAsync(
		CanvasContextKey context,
		string windowId,
		WindowsKeyRequest request,
		CancellationToken cancellationToken = default) =>
		PostAsync(
			InputPath(windowId, "key"),
			JsonContent.Create(request, WindowsJsonContext.Default.WindowsKeyRequest),
			WindowsJsonContext.Default.WindowsInputResult,
			context,
			cancellationToken);

	public Task<WindowsInputResult> TypeTextAsync(
		CanvasContextKey context,
		string windowId,
		WindowsTypeTextRequest request,
		CancellationToken cancellationToken = default) =>
		PostAsync(
			InputPath(windowId, "text"),
			JsonContent.Create(request, WindowsJsonContext.Default.WindowsTypeTextRequest),
			WindowsJsonContext.Default.WindowsInputResult,
			context,
			cancellationToken);

	/// <summary>
	/// Reads the descriptor that travelled beside the image. A screenshot without one is refused
	/// rather than returned with empty geometry: coordinates against unknown geometry would be a
	/// guess, and the whole point of the token is that this path never guesses.
	/// </summary>
	internal static WindowsScreenshotDescriptor DecodeDescriptor(
		HttpResponseMessage response,
		int byteCount)
	{
		if (!response.Headers.TryGetValues(WindowsCaptureHeaders.Descriptor, out var values) &&
			!response.Content.Headers.TryGetValues(WindowsCaptureHeaders.Descriptor, out values))
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.CaptureFailed,
				"The host returned a screenshot without its capture descriptor.");
		}

		var encoded = values.FirstOrDefault();
		WindowsScreenshotDescriptor? descriptor = null;
		try
		{
			if (!string.IsNullOrWhiteSpace(encoded))
			{
				descriptor = JsonSerializer.Deserialize(
					Convert.FromBase64String(encoded),
					WindowsJsonContext.Default.WindowsScreenshotDescriptor);
			}
		}
		catch (FormatException)
		{
		}
		catch (JsonException)
		{
		}

		return descriptor is null
			? throw new WindowsCanvasException(
				WindowsErrorCodes.CaptureFailed,
				"The host returned an unreadable screenshot descriptor.")
			: descriptor with { ByteCount = byteCount };
	}

	private static string CapturePath(string windowId, string operation) =>
		WindowPath(windowId) + operation;

	private static string InputPath(string windowId, string operation) =>
		WindowPath(windowId) + "input/" + operation;

	private static string WindowPath(string windowId)
	{
		if (string.IsNullOrWhiteSpace(windowId))
			throw new ArgumentException("A Windows window ID is required.", nameof(windowId));
		return "/api/v1/windows/session/windows/" + Uri.EscapeDataString(windowId) + "/";
	}

	private Task<WindowsOperationResult> ActAsync(
		string action,
		CanvasContextKey context,
		string? windowId,
		CancellationToken cancellationToken) =>
		PostAsync(
			$"/api/v1/windows/session/windows/{action}",
			JsonContent.Create(
				new WindowsWindowActionRequest { WindowId = windowId },
				WindowsJsonContext.Default.WindowsWindowActionRequest),
			WindowsJsonContext.Default.WindowsOperationResult,
			context,
			cancellationToken);

	private static string UiPath(string windowId, string operation)
	{
		if (string.IsNullOrWhiteSpace(windowId))
			throw new ArgumentException("A Windows window ID is required.", nameof(windowId));
		return "/api/v1/windows/session/windows/" + Uri.EscapeDataString(windowId) + "/ui/" + operation;
	}

	private async Task<T> GetAsync<T>(
		string path,
		JsonTypeInfo<T> typeInfo,
		CanvasContextKey? context,
		CancellationToken cancellationToken)
	{
		var response = await _host.SendAsync(
			HttpMethod.Get,
			Address(path, context),
			content: null,
			cancellationToken).ConfigureAwait(false);
		return await ReadAsync(response, typeInfo, cancellationToken).ConfigureAwait(false);
	}

	private async Task<T> PostAsync<T>(
		string path,
		HttpContent? content,
		JsonTypeInfo<T> typeInfo,
		CanvasContextKey? context,
		CancellationToken cancellationToken)
	{
		var response = await _host.SendAsync(
			HttpMethod.Post,
			Address(path, context),
			content,
			cancellationToken).ConfigureAwait(false);
		return await ReadAsync(response, typeInfo, cancellationToken).ConfigureAwait(false);
	}

	private static string Address(string path, CanvasContextKey? context) =>
		context is null ? path : DeviceHostClient.WithContextQuery(path, context);

	private static async Task<T> ReadAsync<T>(
		HttpResponseMessage response,
		JsonTypeInfo<T> typeInfo,
		CancellationToken cancellationToken)
	{
		using (response)
		{
			if (!response.IsSuccessStatusCode)
			{
				var body = await response.Content.ReadAsStringAsync(cancellationToken)
					.ConfigureAwait(false);
				throw Failure(response, body);
			}
			return await response.Content.ReadFromJsonAsync(typeInfo, cancellationToken)
				.ConfigureAwait(false)
				?? throw new InvalidOperationException(
					"The Mobile Canvas host returned an empty Windows response.");
		}
	}

	/// <summary>
	/// Rebuilds the host's machine-readable failure so a CLI caller sees the same code an API
	/// caller does, rather than an HTTP status that has lost the reason.
	/// </summary>
	private static Exception Failure(HttpResponseMessage response, string body)
	{
		try
		{
			var error = JsonSerializer.Deserialize(body, DeviceJsonContext.Default.ApiError);
			if (error is not null && !string.IsNullOrEmpty(error.Code))
				return new WindowsCanvasException(error.Code, error.Message, (int)response.StatusCode);
		}
		catch (JsonException)
		{
		}
		return new HttpRequestException(
			$"Mobile Canvas host returned {(int)response.StatusCode} {response.ReasonPhrase}.");
	}
}
