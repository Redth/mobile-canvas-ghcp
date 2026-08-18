using WindowsCanvas.Contracts;

namespace WindowsCanvas.Windows;

/// <summary>
/// Validates capture requests and turns the native helper's answers into public descriptors.
///
/// Bounds are applied here rather than at each caller so the API, the CLI, and the agent tools all
/// refuse the same values, and so a helper that reported something impossible — a zero-sized
/// window, a capture of a different window than the one that was authorized — is caught before its
/// bytes are handed to anybody.
/// </summary>
internal static class WindowsCaptureNormalizer
{
	public static WindowsScreenshotRequest Screenshot(WindowsScreenshotRequest? request)
	{
		request ??= new WindowsScreenshotRequest();
		var maximum = request.MaximumDimension;
		if (maximum < 0)
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				"maximumDimension cannot be negative.");
		}
		return request with
		{
			Scale = WindowsCaptureLimits.CaptureScale(request.Scale),
			MaximumDimension = maximum == 0
				? 0
				: Math.Clamp(
					maximum,
					WindowsCaptureLimits.MinimumDimension,
					WindowsCaptureLimits.MaximumDimension),
		};
	}

	/// <summary>
	/// The longest edge a thumbnail request actually gets, refusing a negative one outright. A
	/// caller learns its request was nonsense before any window is enumerated on its behalf.
	/// </summary>
	public static int ThumbnailDimension(int maximumDimension)
	{
		if (maximumDimension < 0)
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				"maximumDimension cannot be negative.");
		}
		return WindowsThumbnailLimits.Dimension(maximumDimension);
	}

	/// <summary>
	/// Turns a picker's requested card size into a capture request for one candidate window.
	///
	/// The scale is derived from the window's own content size rather than asked for, so the
	/// longest delivered edge lands at or under the caller's bound whatever size the window is, and
	/// the bound travels along as a hard clamp too: a window that resized between measuring and
	/// capturing must still not deliver a desktop-sized image into a picker card.
	/// </summary>
	public static WindowsScreenshotRequest Thumbnail(
		int maximumDimension,
		int contentWidth,
		int contentHeight)
	{
		var bounded = ThumbnailDimension(maximumDimension);
		var longest = Math.Max(contentWidth, contentHeight);
		var scale = longest <= 0
			? WindowsCaptureLimits.DefaultScale
			: Math.Min(WindowsCaptureLimits.MaximumScale, (double)bounded / longest);
		return new WindowsScreenshotRequest
		{
			Scale = WindowsCaptureLimits.CaptureScale(scale),
			MaximumDimension = bounded,
			// A preview of a window nobody attached never draws the user's cursor into somebody
			// else's picture.
			IncludeCursor = false,
		};
	}

	/// <summary>Refuses a thumbnail that came back too large to hand to a picker.</summary>
	public static void RequireThumbnailSize(int byteCount)
	{
		if (byteCount <= WindowsThumbnailLimits.MaximumBytes)
			return;

		throw WindowsCanvasException.Gateway(
			WindowsErrorCodes.CaptureFailed,
			$"That window's thumbnail came back as {byteCount} bytes, past the " +
			$"{WindowsThumbnailLimits.MaximumBytes}-byte limit a window preview may occupy.");
	}

	public static WindowsStreamRequest Stream(WindowsStreamRequest? request)
	{
		request ??= new WindowsStreamRequest();
		return request with
		{
			FramesPerSecond = WindowsCaptureLimits.FramesPerSecond(request.FramesPerSecond),
			Scale = WindowsCaptureLimits.CaptureScale(request.Scale),
			AverageBitrate = WindowsCaptureLimits.Bitrate(request.AverageBitrate),
		};
	}

	/// <summary>
	/// Refuses a helper line that reported a failure, mapping its capture status onto the code and
	/// HTTP status a caller can branch on. A protected or minimized window is a conflict the caller
	/// can resolve; a broken encoder is a gateway failure.
	/// </summary>
	public static void RequireOk(WindowsHelperCapture status, string command)
	{
		if (status.SchemaVersion != WindowsCanvasProtocol.HelperSchemaVersion)
		{
			throw WindowsCanvasException.Conflict(
				WindowsErrorCodes.HelperIncompatible,
				$"{ProcessWindowsNativeBridge.HelperFileName} {command} reported schema version " +
				$"{status.SchemaVersion}; this host requires " +
				$"{WindowsCanvasProtocol.HelperSchemaVersion}. Reinstall the matching Mobile " +
				"Canvas runtime.");
		}
		if (status.Ok)
			return;

		var detail = status.Error is null
			? status.SourceDetail
			: string.IsNullOrWhiteSpace(status.Error.Hresult)
				? $"{status.Error.Code}: {status.Error.Message}"
				: $"{status.Error.Code}: {status.Error.Message} ({status.Error.Hresult})";
		throw status.Status switch
		{
			WindowsCaptureStatuses.Minimized => WindowsCanvasException.Conflict(
				WindowsErrorCodes.WindowMinimized,
				detail ?? "That window is minimized, so it has no visible content to capture."),
			WindowsCaptureStatuses.ProtectedContent => WindowsCanvasException.Conflict(
				WindowsErrorCodes.CaptureProtected,
				detail ?? "That window excludes itself from screen capture."),
			WindowsCaptureStatuses.Closed => WindowsCanvasException.NotFound(
				WindowsErrorCodes.WindowNotFound,
				detail ?? "That window closed before it could be captured."),
			WindowsCaptureStatuses.Unavailable => WindowsCanvasException.Conflict(
				WindowsErrorCodes.CaptureUnavailable,
				detail ?? "Windows.Graphics.Capture is not available on this machine."),
			_ => WindowsCanvasException.Gateway(
				WindowsErrorCodes.CaptureFailed,
				detail ?? $"{ProcessWindowsNativeBridge.HelperFileName} {command} failed."),
		};
	}

	/// <summary>
	/// Proves the bytes describe the window that was authorized. The helper is handed a live handle
	/// only after the service resolved an opaque grant; echoing the identity back and checking it
	/// closes the gap where a recycled handle could return somebody else's screen.
	/// </summary>
	public static void RequireIdentity(WindowsHelperCapture status, WindowsHelperWindow window)
	{
		if (status.Handle == window.Handle &&
			status.ProcessId == window.ProcessId &&
			status.ProcessStartFileTime == window.ProcessStartFileTime)
		{
			return;
		}

		throw WindowsCanvasException.Conflict(
			WindowsErrorCodes.CaptureIdentityMismatch,
			"windows-app-helper.exe returned a capture of a different window than the one this " +
			"canvas is authorized to see, so the bytes were discarded.");
	}

	/// <summary>
	/// The geometry a helper reported, refused when it could not describe a real coordinate space.
	/// A zero-sized or absurd frame must not become a coordinate space an agent then clicks in.
	/// </summary>
	public static WindowsCaptureGeometry Geometry(WindowsCaptureGeometry? geometry, string command)
	{
		if (geometry is null)
		{
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.CaptureFailed,
				$"windows-app-helper.exe {command} omitted its capture geometry.");
		}
		if (!IsSane(geometry.ContentWidth) ||
			!IsSane(geometry.ContentHeight) ||
			!IsSane(geometry.CaptureWidth) ||
			!IsSane(geometry.CaptureHeight))
		{
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.CaptureFailed,
				$"windows-app-helper.exe {command} reported a capture size outside the supported " +
				$"range of {WindowsCaptureLimits.MinimumDimension} through " +
				$"{WindowsCaptureLimits.MaximumDimension} pixels.");
		}
		return geometry;
	}

	/// <summary>Merges the helper's startup line into the descriptor the caller asked for.</summary>
	public static WindowsStreamDescriptor Descriptor(
		WindowsStreamDescriptor seed,
		WindowsHelperCapture startup) =>
		seed with
		{
			FramesPerSecond = startup.FramesPerSecond > 0
				? startup.FramesPerSecond
				: seed.FramesPerSecond,
			Scale = startup.Scale > 0 ? startup.Scale : seed.Scale,
			AverageBitrate = startup.AverageBitrate > 0
				? startup.AverageBitrate
				: seed.AverageBitrate,
			Status = string.IsNullOrWhiteSpace(startup.Status)
				? WindowsCaptureStatuses.Ok
				: startup.Status,
			Source = string.IsNullOrWhiteSpace(startup.Source)
				? WindowsCaptureSources.WindowsGraphicsCapture
				: startup.Source,
			SourceDetail = startup.SourceDetail,
			Geometry = Geometry(startup.Geometry, "capture"),
			Capabilities = startup.Capabilities ?? new WindowsCaptureCapabilities(),
		};

	private static bool IsSane(int value) =>
		value >= WindowsCaptureLimits.MinimumDimension
		&& value <= WindowsCaptureLimits.MaximumDimension;
}
