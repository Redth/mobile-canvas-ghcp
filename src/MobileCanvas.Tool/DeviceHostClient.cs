using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using MobileCanvas.Contracts;

namespace MobileCanvas.Tool;

public sealed class DeviceHostClient
{
	private readonly HostMetadataStore _metadataStore = new();
	private readonly SemaphoreSlim _startLock = new(1, 1);
	private HostMetadata? _metadata;

	public async Task<HostHealth> StartAsync(CancellationToken cancellationToken = default)
	{
		await EnsureStartedAsync(cancellationToken).ConfigureAwait(false);
		return await GetHealthAsync(cancellationToken).ConfigureAwait(false);
	}

	public async Task<HostHealth> GetHealthAsync(CancellationToken cancellationToken = default)
	{
		var response = await SendAsync(HttpMethod.Get, "/api/v1/status", cancellationToken)
			.ConfigureAwait(false);
		return await ReadAsync(response, DeviceJsonContext.Default.HostHealth, cancellationToken)
			.ConfigureAwait(false);
	}

	public async Task<HostHealth?> TryGetHealthAsync(CancellationToken cancellationToken = default)
	{
		var metadata = _metadataStore.TryRead();
		if (metadata is null || !await IsHealthyAsync(metadata, cancellationToken).ConfigureAwait(false))
			return null;
		_metadata = metadata;
		using var client = CreateClient(metadata, TimeSpan.FromSeconds(2));
		using var response = await client.GetAsync("/api/v1/status", cancellationToken)
			.ConfigureAwait(false);
		return await response.Content.ReadFromJsonAsync(
			DeviceJsonContext.Default.HostHealth,
			cancellationToken).ConfigureAwait(false);
	}

	public async Task StopAsync(CancellationToken cancellationToken = default)
	{
		using var response = await SendAsync(
			HttpMethod.Post,
			"/api/v1/host/stop",
			cancellationToken).ConfigureAwait(false);
		response.EnsureSuccessStatusCode();
		var metadata = _metadata;
		if (metadata is not null)
			await WaitForProcessExitAsync(metadata.ProcessId, cancellationToken).ConfigureAwait(false);
		_metadata = null;
	}

	public async Task<CanvasOpenResult> OpenCanvasAsync(
		CanvasOpenRequest request,
		CancellationToken cancellationToken = default)
	{
		using var content = JsonContent.Create(request, DeviceJsonContext.Default.CanvasOpenRequest);
		var response = await SendAsync(
			HttpMethod.Post,
			"/api/v1/canvas/open",
			content,
			cancellationToken).ConfigureAwait(false);
		return await ReadAsync(
			response,
			DeviceJsonContext.Default.CanvasOpenResult,
			cancellationToken).ConfigureAwait(false);
	}

	public async Task CloseCanvasAsync(
		CanvasCloseRequest request,
		CancellationToken cancellationToken = default)
	{
		using var content = JsonContent.Create(request, DeviceJsonContext.Default.CanvasCloseRequest);
		using var response = await SendAsync(
			HttpMethod.Post,
			"/api/v1/canvas/close",
			content,
			cancellationToken).ConfigureAwait(false);
		await EnsureSuccessAsync(response, cancellationToken).ConfigureAwait(false);
	}

	public async Task<DeviceCatalog> GetCatalogAsync(CancellationToken cancellationToken = default)
	{
		var response = await SendAsync(HttpMethod.Get, "/api/v1/catalog", cancellationToken)
			.ConfigureAwait(false);
		return await ReadAsync(response, DeviceJsonContext.Default.DeviceCatalog, cancellationToken)
			.ConfigureAwait(false);
	}

	public async Task<DeviceTarget[]> ListDevicesAsync(CancellationToken cancellationToken = default)
	{
		var response = await SendAsync(HttpMethod.Get, "/api/v1/devices", cancellationToken)
			.ConfigureAwait(false);
		return await ReadAsync(response, DeviceJsonContext.Default.DeviceTargetArray, cancellationToken)
			.ConfigureAwait(false);
	}

	public async Task<DeviceTarget> GetDeviceAsync(
		string deviceId,
		CancellationToken cancellationToken = default) =>
		await GetTargetAsync($"/api/v1/devices/{Escape(deviceId)}", cancellationToken)
			.ConfigureAwait(false);

	public async Task<DeviceTarget> CreateDeviceAsync(
		CreateDeviceRequest request,
		CanvasContextKey? context = null,
		CancellationToken cancellationToken = default)
	{
		using var content = JsonContent.Create(request, DeviceJsonContext.Default.CreateDeviceRequest);
		return await PostTargetAsync("/api/v1/devices", content, context, cancellationToken)
			.ConfigureAwait(false);
	}

	public Task<DeviceTarget> BootAsync(
		string deviceId,
		CanvasContextKey? context = null,
		CancellationToken cancellationToken = default) =>
		PostTargetAsync(
			$"/api/v1/devices/{Escape(deviceId)}/boot",
			content: null,
			context,
			cancellationToken);

	public Task<DeviceTarget> ShutdownAsync(
		string deviceId,
		CanvasContextKey? context = null,
		CancellationToken cancellationToken = default) =>
		PostTargetAsync(
			$"/api/v1/devices/{Escape(deviceId)}/shutdown",
			content: null,
			context,
			cancellationToken);

	public Task<DeviceTarget> RestartAsync(
		string deviceId,
		CanvasContextKey? context = null,
		CancellationToken cancellationToken = default) =>
		PostTargetAsync(
			$"/api/v1/devices/{Escape(deviceId)}/restart",
			content: null,
			context,
			cancellationToken);

	public Task<DeviceTarget> RevealAsync(
		string deviceId,
		CanvasContextKey? context = null,
		CancellationToken cancellationToken = default) =>
		PostTargetAsync(
			$"/api/v1/devices/{Escape(deviceId)}/reveal",
			content: null,
			context,
			cancellationToken);

	public async Task<DeviceTarget> EraseAsync(
		string deviceId,
		bool confirm,
		CanvasContextKey? context = null,
		CancellationToken cancellationToken = default)
	{
		using var content = JsonContent.Create(
			new ConfirmedOperationRequest { Confirm = confirm },
			DeviceJsonContext.Default.ConfirmedOperationRequest);
		return await PostTargetAsync(
			$"/api/v1/devices/{Escape(deviceId)}/erase",
			content,
			context,
			cancellationToken).ConfigureAwait(false);
	}

	public async Task DeleteAsync(
		string deviceId,
		bool confirm,
		CancellationToken cancellationToken = default)
	{
		using var content = JsonContent.Create(
			new ConfirmedOperationRequest { Confirm = confirm },
			DeviceJsonContext.Default.ConfirmedOperationRequest);
		using var response = await SendAsync(
			HttpMethod.Delete,
			$"/api/v1/devices/{Escape(deviceId)}",
			content,
			cancellationToken).ConfigureAwait(false);
		await EnsureSuccessAsync(response, cancellationToken).ConfigureAwait(false);
	}

	public async Task<DeviceSelection> GetSelectionAsync(
		CanvasContextKey context,
		CancellationToken cancellationToken = default)
	{
		var response = await SendAsync(
			HttpMethod.Get,
			WithContext("/api/v1/selection", context),
			content: null,
			cancellationToken).ConfigureAwait(false);
		return await ReadAsync(response, DeviceJsonContext.Default.DeviceSelection, cancellationToken)
			.ConfigureAwait(false);
	}

	public async Task<DeviceTarget> SelectAsync(
		CanvasContextKey context,
		string deviceId,
		CancellationToken cancellationToken = default)
	{
		using var content = JsonContent.Create(
			new SelectDeviceRequest { DeviceId = deviceId },
			DeviceJsonContext.Default.SelectDeviceRequest);
		var response = await SendAsync(
			HttpMethod.Post,
			WithContext("/api/v1/selection", context),
			content,
			cancellationToken).ConfigureAwait(false);
		return await ReadAsync(response, DeviceJsonContext.Default.DeviceTarget, cancellationToken)
			.ConfigureAwait(false);
	}

	public async Task TapAsync(
		string deviceId,
		TapRequest request,
		CancellationToken cancellationToken = default) =>
		await PostAsync(
			$"/api/v1/devices/{Escape(deviceId)}/input/tap",
			JsonContent.Create(request, DeviceJsonContext.Default.TapRequest),
			cancellationToken).ConfigureAwait(false);

	public async Task SwipeAsync(
		string deviceId,
		SwipeRequest request,
		CancellationToken cancellationToken = default) =>
		await PostAsync(
			$"/api/v1/devices/{Escape(deviceId)}/input/swipe",
			JsonContent.Create(request, DeviceJsonContext.Default.SwipeRequest),
			cancellationToken).ConfigureAwait(false);

	public async Task TypeTextAsync(
		string deviceId,
		string text,
		CancellationToken cancellationToken = default) =>
		await PostAsync(
			$"/api/v1/devices/{Escape(deviceId)}/input/text",
			JsonContent.Create(
				new TextInputRequest { Text = text },
				DeviceJsonContext.Default.TextInputRequest),
			cancellationToken).ConfigureAwait(false);

	public async Task PressKeyAsync(
		string deviceId,
		ulong keyCode,
		CancellationToken cancellationToken = default) =>
		await PostAsync(
			$"/api/v1/devices/{Escape(deviceId)}/input/key",
			JsonContent.Create(
				new KeyInputRequest { KeyCode = keyCode },
				DeviceJsonContext.Default.KeyInputRequest),
			cancellationToken).ConfigureAwait(false);

	public async Task PressButtonAsync(
		string deviceId,
		string button,
		CancellationToken cancellationToken = default) =>
		await PostAsync(
			$"/api/v1/devices/{Escape(deviceId)}/input/button",
			JsonContent.Create(
				new ButtonInputRequest { Button = button },
				DeviceJsonContext.Default.ButtonInputRequest),
			cancellationToken).ConfigureAwait(false);

	public async Task RotateAsync(
		string deviceId,
		string orientation,
		CancellationToken cancellationToken = default) =>
		await PostAsync(
			$"/api/v1/devices/{Escape(deviceId)}/input/rotate",
			JsonContent.Create(
				new RotateRequest { Orientation = orientation },
				DeviceJsonContext.Default.RotateRequest),
			cancellationToken).ConfigureAwait(false);

	public async Task<DisplayGeometry> GetDisplayAsync(
		string deviceId,
		CancellationToken cancellationToken = default)
	{
		var response = await SendAsync(
			HttpMethod.Get,
			$"/api/v1/devices/{Escape(deviceId)}/display",
			cancellationToken).ConfigureAwait(false);
		return await ReadAsync(response, DeviceJsonContext.Default.DisplayGeometry, cancellationToken)
			.ConfigureAwait(false);
	}

	public async Task<byte[]> ScreenshotAsync(
		string deviceId,
		CancellationToken cancellationToken = default)
	{
		using var response = await SendAsync(
			HttpMethod.Get,
			$"/api/v1/devices/{Escape(deviceId)}/screenshot",
			cancellationToken).ConfigureAwait(false);
		await EnsureSuccessAsync(response, cancellationToken).ConfigureAwait(false);
		return await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
	}

	public async Task<RecordingStatus> StartRecordingAsync(
		string deviceId,
		RecordingStartRequest request,
		CancellationToken cancellationToken = default)
	{
		using var content = JsonContent.Create(
			request,
			DeviceJsonContext.Default.RecordingStartRequest);
		return await PostRecordingAsync(
			$"/api/v1/devices/{Escape(deviceId)}/recording/start",
			content,
			cancellationToken).ConfigureAwait(false);
	}

	public Task<RecordingStatus> StopRecordingAsync(
		string deviceId,
		CancellationToken cancellationToken = default) =>
		PostRecordingAsync(
			$"/api/v1/devices/{Escape(deviceId)}/recording/stop",
			content: null,
			cancellationToken);

	public async Task<RecordingStatus> GetRecordingStatusAsync(
		string deviceId,
		CancellationToken cancellationToken = default)
	{
		var response = await SendAsync(
			HttpMethod.Get,
			$"/api/v1/devices/{Escape(deviceId)}/recording",
			cancellationToken).ConfigureAwait(false);
		return await ReadAsync(response, DeviceJsonContext.Default.RecordingStatus, cancellationToken)
			.ConfigureAwait(false);
	}

	private async Task EnsureStartedAsync(CancellationToken cancellationToken)
	{
		if (_metadata is not null && await IsHealthyAsync(_metadata, cancellationToken).ConfigureAwait(false))
			return;

		await _startLock.WaitAsync(cancellationToken).ConfigureAwait(false);
		try
		{
			var existing = _metadataStore.TryRead();
			if (existing is not null && await IsHealthyAsync(existing, cancellationToken).ConfigureAwait(false))
			{
				_metadata = existing;
				return;
			}

			var deadline = DateTimeOffset.UtcNow.AddSeconds(20);
			while (DateTimeOffset.UtcNow < deadline && !IsSingletonLockAvailable())
			{
				cancellationToken.ThrowIfCancellationRequested();
				await Task.Delay(100, cancellationToken).ConfigureAwait(false);
				var candidate = _metadataStore.TryRead();
				if (candidate is not null &&
					await IsHealthyAsync(candidate, cancellationToken).ConfigureAwait(false))
				{
					_metadata = candidate;
					return;
				}
			}

			StartHostProcess();
			while (DateTimeOffset.UtcNow < deadline)
			{
				cancellationToken.ThrowIfCancellationRequested();
				await Task.Delay(100, cancellationToken).ConfigureAwait(false);
				var candidate = _metadataStore.TryRead();
				if (candidate is not null &&
					await IsHealthyAsync(candidate, cancellationToken).ConfigureAwait(false))
				{
					_metadata = candidate;
					return;
				}
			}
			throw new TimeoutException("Mobile Canvas host did not become ready within 20 seconds.");
		}
		finally
		{
			_startLock.Release();
		}
	}

	private static void StartHostProcess()
	{
		var executable = Environment.ProcessPath
			?? throw new InvalidOperationException("Could not determine the mobile-canvas executable path.");
		var startInfo = new ProcessStartInfo
		{
			FileName = executable,
			UseShellExecute = false,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			CreateNoWindow = true,
		};
		if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
		{
			var entryAssembly = Path.Combine(AppContext.BaseDirectory, "mobile-canvas.dll");
			if (!File.Exists(entryAssembly))
				throw new InvalidOperationException("Could not determine the Mobile Canvas assembly path.");
			startInfo.ArgumentList.Add(entryAssembly);
		}
		startInfo.ArgumentList.Add("host");
		startInfo.ArgumentList.Add("run");
		startInfo.Environment["MOBILE_CANVAS_HOST_PROCESS"] = "1";

		var process = Process.Start(startInfo)
			?? throw new InvalidOperationException("Failed to start the Mobile Canvas host.");
		process.OutputDataReceived += (_, _) => { };
		process.ErrorDataReceived += (_, _) => { };
		process.BeginOutputReadLine();
		process.BeginErrorReadLine();
	}

	private static bool IsSingletonLockAvailable()
	{
		DevicePaths.EnsureHome();
		try
		{
			using var stream = new FileStream(
				DevicePaths.Lock,
				FileMode.OpenOrCreate,
				FileAccess.ReadWrite,
				FileShare.None);
			return true;
		}
		catch (IOException)
		{
			return false;
		}
	}

	private static async Task WaitForProcessExitAsync(
		int processId,
		CancellationToken cancellationToken)
	{
		Process process;
		try
		{
			process = Process.GetProcessById(processId);
		}
		catch (ArgumentException)
		{
			return;
		}

		using (process)
		using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
		{
			timeout.CancelAfter(TimeSpan.FromSeconds(20));
			try
			{
				await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
			}
			catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
			{
				throw new TimeoutException(
					$"Mobile Canvas host process {processId} did not stop within 20 seconds.");
			}
		}
	}

	private async Task<bool> IsHealthyAsync(
		HostMetadata metadata,
		CancellationToken cancellationToken)
	{
		try
		{
			using var client = CreateClient(metadata, TimeSpan.FromMilliseconds(750));
			using var response = await client.GetAsync("/api/v1/status", cancellationToken)
				.ConfigureAwait(false);
			return response.IsSuccessStatusCode;
		}
		catch (HttpRequestException)
		{
			return false;
		}
		catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
		{
			return false;
		}
	}

	private async Task<HttpResponseMessage> SendAsync(
		HttpMethod method,
		string path,
		CancellationToken cancellationToken) =>
		await SendAsync(method, path, content: null, cancellationToken).ConfigureAwait(false);

	private async Task<HttpResponseMessage> SendAsync(
		HttpMethod method,
		string path,
		HttpContent? content,
		CancellationToken cancellationToken)
	{
		await EnsureStartedAsync(cancellationToken).ConfigureAwait(false);
		using var client = CreateClient(_metadata!, TimeSpan.FromMinutes(5));
		var request = new HttpRequestMessage(method, path) { Content = content };
		return await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
	}

	private static HttpClient CreateClient(HostMetadata metadata, TimeSpan timeout)
	{
		var client = new HttpClient
		{
			BaseAddress = new Uri($"http://127.0.0.1:{metadata.Port}"),
			Timeout = timeout,
		};
		client.DefaultRequestHeaders.Authorization =
			new AuthenticationHeaderValue("Bearer", metadata.ControlToken);
		return client;
	}

	private async Task<DeviceTarget> GetTargetAsync(
		string path,
		CancellationToken cancellationToken)
	{
		var response = await SendAsync(HttpMethod.Get, path, cancellationToken).ConfigureAwait(false);
		return await ReadAsync(response, DeviceJsonContext.Default.DeviceTarget, cancellationToken)
			.ConfigureAwait(false);
	}

	private async Task<DeviceTarget> PostTargetAsync(
		string path,
		HttpContent? content,
		CanvasContextKey? context,
		CancellationToken cancellationToken)
	{
		var response = await SendAsync(
			HttpMethod.Post,
			context is null ? path : WithContext(path, context),
			content,
			cancellationToken).ConfigureAwait(false);
		return await ReadAsync(response, DeviceJsonContext.Default.DeviceTarget, cancellationToken)
			.ConfigureAwait(false);
	}

	private async Task<RecordingStatus> PostRecordingAsync(
		string path,
		HttpContent? content,
		CancellationToken cancellationToken)
	{
		var response = await SendAsync(HttpMethod.Post, path, content, cancellationToken)
			.ConfigureAwait(false);
		return await ReadAsync(response, DeviceJsonContext.Default.RecordingStatus, cancellationToken)
			.ConfigureAwait(false);
	}

	private async Task PostAsync(
		string path,
		HttpContent content,
		CancellationToken cancellationToken)
	{
		using (content)
		using (var response = await SendAsync(
			HttpMethod.Post,
			path,
			content,
			cancellationToken).ConfigureAwait(false))
		{
			await EnsureSuccessAsync(response, cancellationToken).ConfigureAwait(false);
		}
	}

	private static async Task<T> ReadAsync<T>(
		HttpResponseMessage response,
		JsonTypeInfo<T> typeInfo,
		CancellationToken cancellationToken)
	{
		using (response)
		{
			await EnsureSuccessAsync(response, cancellationToken).ConfigureAwait(false);
			return await response.Content.ReadFromJsonAsync(typeInfo, cancellationToken).ConfigureAwait(false)
				?? throw new InvalidOperationException("The Mobile Canvas host returned an empty response.");
		}
	}

	private static async Task EnsureSuccessAsync(
		HttpResponseMessage response,
		CancellationToken cancellationToken)
	{
		if (response.IsSuccessStatusCode)
			return;
		try
		{
			var error = await response.Content.ReadFromJsonAsync(
				DeviceJsonContext.Default.ApiError,
				cancellationToken).ConfigureAwait(false);
			if (error is not null)
				throw new InvalidOperationException($"{error.Code}: {error.Message}");
		}
		catch (JsonException)
		{
		}
		throw new HttpRequestException(
			$"Mobile Canvas host returned {(int)response.StatusCode} {response.ReasonPhrase}.");
	}

	private static string WithContext(string path, CanvasContextKey context) =>
		$"{path}{(path.Contains('?') ? '&' : '?')}sessionId={Escape(context.SessionId)}&instanceId={Escape(context.InstanceId)}";

	private static string Escape(string value) => Uri.EscapeDataString(value);
}
