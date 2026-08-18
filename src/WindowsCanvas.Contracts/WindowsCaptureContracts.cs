namespace WindowsCanvas.Contracts;

/// <summary>
/// Bounds shared by the public capture surface, the managed service, and the native helper. They
/// exist so a caller cannot ask a desktop-sized encoder for something a machine has no business
/// producing, and so every layer refuses the same values rather than each inventing a limit.
/// </summary>
public static class WindowsCaptureLimits
{
	public const int MinimumFramesPerSecond = 1;
	public const int DefaultFramesPerSecond = 30;
	public const int MaximumFramesPerSecond = 60;

	public const double MinimumScale = 0.1;
	public const double DefaultScale = 1;
	public const double MaximumScale = 1;

	public const long MinimumBitrate = 200_000;
	public const long DefaultBitrate = 12_000_000;
	public const long MaximumBitrate = 40_000_000;

	/// <summary>
	/// Smallest encodable edge. H.264 macroblocks are 16x16 and Media Foundation refuses degenerate
	/// frames, so a window smaller than this is reported rather than encoded into noise.
	/// </summary>
	public const int MinimumDimension = 16;

	/// <summary>
	/// Largest edge any capture may deliver. Well beyond an 8K display, and far below what would
	/// let a hostile window size exhaust host memory through a single frame.
	/// </summary>
	public const int MaximumDimension = 16_384;

	/// <summary>Largest PNG the helper may return, so a screenshot cannot become a memory attack.</summary>
	public const int MaximumScreenshotBytes = 64 * 1024 * 1024;

	public const int DefaultStartupTimeoutMilliseconds = 10_000;
	public const int MaximumStartupTimeoutMilliseconds = 30_000;

	/// <summary>
	/// How long capture may wait for one frame before reporting a stall. A window that is not
	/// redrawing produces no WGC frames at all, which is a state to report, not a hang.
	/// </summary>
	public const int DefaultFrameTimeoutMilliseconds = 5_000;

	public static int FramesPerSecond(int value) =>
		value <= 0
			? DefaultFramesPerSecond
			: Math.Clamp(value, MinimumFramesPerSecond, MaximumFramesPerSecond);

	public static double CaptureScale(double value) =>
		!double.IsFinite(value) || value <= 0
			? DefaultScale
			: Math.Clamp(value, MinimumScale, MaximumScale);

	public static long Bitrate(long value) =>
		value <= 0 ? DefaultBitrate : Math.Clamp(value, MinimumBitrate, MaximumBitrate);
}

/// <summary>A point in the canonical capture coordinate space, in whole physical pixels.</summary>
public sealed record WindowsCapturePoint
{
	public int X { get; init; }
	public int Y { get; init; }
}

/// <summary>
/// Everything needed to turn a pixel in a screenshot or a video frame back into a place on the
/// desktop, and to know when that answer has expired.
///
/// The canonical public coordinate space is <em>selected-window-relative physical capture
/// pixels</em>: the origin is the top-left of the window's visible content, the units are physical
/// device pixels at the window's current DPI, and nothing about the browser's rendered size or
/// letterboxing takes part. <see cref="ContentWidth"/> and <see cref="ContentHeight"/> describe
/// that space; <see cref="CaptureWidth"/>, <see cref="CaptureHeight"/>, and <see cref="Scale"/>
/// describe the image that was actually delivered, so a caller reading coordinates off a scaled
/// stream can say which size its numbers are in instead of guessing.
///
/// <see cref="TransformVersion"/> is the token that makes coordinate input safe. It is derived from
/// the window's identity and its current geometry, and every input request must present the token
/// it measured against. A window that moved, resized, changed DPI, or was minimized produces a
/// different token, and the request is refused instead of clicking a place that has since moved.
/// </summary>
public sealed record WindowsCaptureGeometry
{
	/// <summary>Visible content size in physical pixels. This is the canonical coordinate space.</summary>
	public int ContentWidth { get; init; }
	public int ContentHeight { get; init; }

	/// <summary>Size of the image actually delivered, after <see cref="Scale"/>.</summary>
	public int CaptureWidth { get; init; }
	public int CaptureHeight { get; init; }

	/// <summary>Delivered pixels per content pixel, from 0.1 through 1.</summary>
	public double Scale { get; init; } = 1;

	/// <summary>
	/// Size of the raw surface Windows produced before the visible crop. A window's capture surface
	/// includes its invisible resize border, which is why the visible content is a crop rather than
	/// the whole frame.
	/// </summary>
	public int SurfaceWidth { get; init; }
	public int SurfaceHeight { get; init; }

	/// <summary>Where the visible content begins inside that raw surface, in physical pixels.</summary>
	public WindowsCapturePoint VisibleOffset { get; init; } = new();

	/// <summary>
	/// The window frame's origin relative to the content origin. Usually negative on Windows 10 and
	/// later, because the frame extends past the visible content by the invisible resize border.
	/// </summary>
	public WindowsCapturePoint FrameOffset { get; init; } = new();

	/// <summary>The client area's origin relative to the content origin, and its size.</summary>
	public WindowsCapturePoint ClientOffset { get; init; } = new();
	public int ClientWidth { get; init; }
	public int ClientHeight { get; init; }

	/// <summary>
	/// Where the visible content currently sits on the virtual desktop, in physical pixels. On a
	/// multi-monitor desktop these values are frequently negative, and they are reported rather
	/// than normalized so a caller can reason about the real desktop.
	/// </summary>
	public WindowsWindowBounds ContentScreenBounds { get; init; } = new();

	/// <summary>The window frame rectangle on the virtual desktop, in physical pixels.</summary>
	public WindowsWindowBounds WindowScreenBounds { get; init; } = new();

	/// <summary>The client rectangle on the virtual desktop, in physical pixels.</summary>
	public WindowsWindowBounds ClientScreenBounds { get; init; } = new();

	/// <summary>Effective DPI of the window, from <c>GetDpiForWindow</c>. 96 means 100% scaling.</summary>
	public uint Dpi { get; init; } = 96;

	/// <summary>Physical pixels per logical pixel, which is <see cref="Dpi"/> divided by 96.</summary>
	public double DpiScale { get; init; } = 1;

	/// <summary>
	/// Whether the window is minimized. A minimized window has no visible content to capture and no
	/// coordinate space to click in, so this is a first-class reported state.
	/// </summary>
	public bool Minimized { get; init; }

	/// <summary>
	/// Opaque token covering the window's identity and every geometry field above. Input requests
	/// must present it; a stale token is an explicit error rather than a best-guess click.
	/// </summary>
	public string TransformVersion { get; init; } = "";
}

/// <summary>Which mechanism produced a capture, so a degraded path is visible rather than silent.</summary>
public static class WindowsCaptureSources
{
	/// <summary>Windows.Graphics.Capture on the window itself. The only supported live source.</summary>
	public const string WindowsGraphicsCapture = "windowsGraphicsCapture";

	/// <summary>
	/// A <c>PrintWindow</c> redirection copy. Only ever used for a still screenshot, only when
	/// Windows.Graphics.Capture is unavailable on the machine, and always reported as degraded:
	/// it can miss layered, GPU-composited, and hardware-overlay content.
	/// </summary>
	public const string PrintWindow = "printWindow";
}

/// <summary>The state a capture attempt ended in.</summary>
public static class WindowsCaptureStatuses
{
	public const string Ok = "ok";
	public const string Minimized = "minimized";

	/// <summary>The window sets display affinity to exclude itself from capture.</summary>
	public const string ProtectedContent = "protected";
	public const string Closed = "closed";
	public const string Unavailable = "unavailable";
	public const string Error = "error";
}

/// <summary>
/// Which optional capture behaviours this machine actually offers. Every one of these arrived in a
/// later Windows release than picker-free capture itself, so they are feature-detected and reported
/// rather than required: a machine without them still captures.
/// </summary>
public sealed record WindowsCaptureCapabilities
{
	/// <summary>
	/// <c>Direct3D11CaptureFramePool.CreateFreeThreaded</c> is present, so frames arrive on a pool
	/// thread instead of requiring a dispatcher the helper would have to pump.
	/// </summary>
	public bool FreeThreadedFramePool { get; init; }

	/// <summary><c>IGraphicsCaptureSession2.IsCursorCaptureEnabled</c> is present.</summary>
	public bool CursorCaptureToggle { get; init; }

	/// <summary><c>IGraphicsCaptureSession3.IsBorderRequired</c> is present.</summary>
	public bool BorderRequiredToggle { get; init; }

	/// <summary><c>IGraphicsCaptureSession4.IncludeSecondaryWindows</c> is present.</summary>
	public bool SecondaryWindowCapture { get; init; }

	/// <summary><c>IGraphicsCaptureSession5.DirtyRegionMode</c> is present.</summary>
	public bool DirtyRegionMode { get; init; }

	/// <summary>Whether the cursor was actually drawn into these frames.</summary>
	public bool CursorCaptured { get; init; }

	/// <summary>
	/// Whether the system capture border is drawn. It is left on unless Windows itself allows it
	/// off for this process: suppressing the indicator that a window is being captured is not
	/// something this product does behind a user's back.
	/// </summary>
	public bool BorderRequired { get; init; } = true;

	/// <summary>Whether the H.264 encoder is a hardware MFT rather than the software fallback.</summary>
	public bool HardwareEncoder { get; init; }

	/// <summary>Friendly name of the encoder that was selected.</summary>
	public string? Encoder { get; init; }

	/// <summary>Description of the Direct3D adapter frames were captured on.</summary>
	public string? Adapter { get; init; }
}

/// <summary>
/// Transport headers for capture responses. A screenshot answers with the image itself, so its
/// descriptor travels beside the bytes rather than wrapping them in JSON.
/// </summary>
public static class WindowsCaptureHeaders
{
	/// <summary>Base64 of the screenshot descriptor JSON.</summary>
	public const string Descriptor = "x-windows-capture-descriptor";
}

/// <summary>A request for one still frame of an authorized window.</summary>
public sealed record WindowsScreenshotRequest
{
	/// <summary>Opaque authorized window ID. Omit to use the session's selected window.</summary>
	public string? WindowId { get; init; }

	/// <summary>
	/// Delivered pixels per content pixel. Screenshots default to 1 so an agent reading pixel
	/// coordinates off the image is already in the canonical space.
	/// </summary>
	public double Scale { get; init; } = WindowsCaptureLimits.DefaultScale;

	/// <summary>
	/// Optional additional clamp on the longest delivered edge. Zero means only the hard limit in
	/// <see cref="WindowsCaptureLimits.MaximumDimension"/> applies.
	/// </summary>
	public int MaximumDimension { get; init; }

	/// <summary>Whether to draw the mouse cursor, when this machine allows the choice.</summary>
	public bool IncludeCursor { get; init; }
}

/// <summary>
/// What a screenshot is a picture of. It carries exactly the geometry a live stream carries, so an
/// agent can inspect a still frame and send coordinates without converting between two spaces.
/// </summary>
public sealed record WindowsScreenshotDescriptor
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;
	public string WindowId { get; init; } = "";
	public string Format { get; init; } = "png";
	public string Status { get; init; } = WindowsCaptureStatuses.Ok;
	public string Source { get; init; } = WindowsCaptureSources.WindowsGraphicsCapture;

	/// <summary>Why a degraded source was used, when one was.</summary>
	public string? SourceDetail { get; init; }
	public WindowsCaptureGeometry Geometry { get; init; } = new();
	public WindowsCaptureCapabilities Capabilities { get; init; } = new();
	public int ByteCount { get; init; }
	public DateTimeOffset CapturedAt { get; init; }
}

/// <summary>
/// PNG bytes plus the descriptor that gives them meaning. Deliberately not part of the JSON
/// vocabulary: the bytes travel as an image body, and the descriptor travels beside them.
/// </summary>
public sealed record WindowsScreenshot
{
	public WindowsScreenshotDescriptor Descriptor { get; init; } = new();
	public byte[] Png { get; init; } = [];
}

/// <summary>A screenshot that was written to disk, as the CLI and agent tools report it.</summary>
public sealed record WindowsScreenshotArtifact
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;
	public string Path { get; init; } = "";
	public string MimeType { get; init; } = "image/png";
	public int Bytes { get; init; }
	public DateTimeOffset CreatedAt { get; init; }
	public WindowsScreenshotDescriptor Descriptor { get; init; } = new();
}

/// <summary>A request to open one live low-delay stream of an authorized window.</summary>
public sealed record WindowsStreamRequest
{
	public string? WindowId { get; init; }
	public int FramesPerSecond { get; init; } = WindowsCaptureLimits.DefaultFramesPerSecond;
	public double Scale { get; init; } = WindowsCaptureLimits.DefaultScale;
	public long AverageBitrate { get; init; } = WindowsCaptureLimits.DefaultBitrate;
	public bool IncludeCursor { get; init; }
}

/// <summary>
/// The first message of a video stream, sent as one JSON text frame before any bytes. It is the
/// same geometry a screenshot carries, so switching between a still and a stream never changes the
/// coordinate space a caller is working in.
/// </summary>
public sealed record WindowsStreamDescriptor
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;

	/// <summary>Discriminator for the JSON messages on this socket.</summary>
	public string Type { get; init; } = WindowsStreamMessageTypes.Descriptor;
	public string WindowId { get; init; } = "";
	public string Encoding { get; init; } = "h264-annexb";
	public int FramesPerSecond { get; init; }
	public double Scale { get; init; } = 1;
	public long AverageBitrate { get; init; }
	public string Status { get; init; } = WindowsCaptureStatuses.Ok;
	public string Source { get; init; } = WindowsCaptureSources.WindowsGraphicsCapture;
	public string? SourceDetail { get; init; }
	public WindowsCaptureGeometry Geometry { get; init; } = new();
	public WindowsCaptureCapabilities Capabilities { get; init; } = new();
}

/// <summary>
/// The last message of a video stream, sent as one JSON text frame after the final byte. A stream
/// always ends for a stated reason, because the browser has to know whether to reconnect for a
/// fresh descriptor and keyframe or to show an error.
/// </summary>
public sealed record WindowsStreamEnd
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;
	public string Type { get; init; } = WindowsStreamMessageTypes.End;
	public string WindowId { get; init; } = "";
	public string Reason { get; init; } = WindowsStreamEndReasons.ClientClosed;
	public string? Detail { get; init; }

	/// <summary>Whether reconnecting is expected to produce a working stream again.</summary>
	public bool Reconnect { get; init; }
}

public static class WindowsStreamMessageTypes
{
	public const string Descriptor = "descriptor";
	public const string End = "end";
}

/// <summary>
/// Why a stream stopped. Resize, DPI, and content-size changes end the stream deliberately: an
/// H.264 decoder cannot be handed frames of a different size, so the browser reconnects and gets a
/// fresh descriptor and keyframe instead of a corrupt picture.
/// </summary>
public static class WindowsStreamEndReasons
{
	public const string ClientClosed = "clientClosed";
	public const string ContentSizeChanged = "contentSizeChanged";
	public const string DpiChanged = "dpiChanged";
	public const string Minimized = "minimized";
	public const string WindowClosed = "windowClosed";
	public const string CaptureFailed = "captureFailed";
	public const string EncoderFailed = "encoderFailed";
	public const string HostStopping = "hostStopping";

	/// <summary>Whether a browser should immediately reopen the stream after this reason.</summary>
	public static bool ShouldReconnect(string? reason) =>
		reason is ContentSizeChanged or DpiChanged;
}

/// <summary>
/// One line of the native capture protocol. The helper writes these to standard error as
/// newline-delimited JSON while standard output stays a byte-exact PNG or Annex-B stream, so the
/// two never mix. Screenshot, stream start, and stream end all use this one shape.
/// </summary>
public sealed record WindowsHelperCapture
{
	public int SchemaVersion { get; init; }
	public bool Ok { get; init; }
	public string HelperVersion { get; init; } = "";

	/// <summary><c>descriptor</c> or <c>end</c>.</summary>
	public string Type { get; init; } = "";
	public string Status { get; init; } = "";
	public string Source { get; init; } = "";
	public string? SourceDetail { get; init; }

	/// <summary>Present on <c>end</c> lines, from <see cref="WindowsStreamEndReasons"/>.</summary>
	public string? Reason { get; init; }

	/// <summary>
	/// The window the helper actually captured, echoed so the host can prove the bytes belong to
	/// the window it authorized rather than to whatever the helper happened to find.
	/// </summary>
	public long Handle { get; init; }
	public int ProcessId { get; init; }
	public long ProcessStartFileTime { get; init; }

	public int FramesPerSecond { get; init; }
	public double Scale { get; init; }
	public long AverageBitrate { get; init; }

	/// <summary>Payload length for a screenshot, so a truncated pipe is detectable.</summary>
	public int ByteCount { get; init; }
	public WindowsCaptureGeometry? Geometry { get; init; }
	public WindowsCaptureCapabilities? Capabilities { get; init; }
	public WindowsHelperErrorDetail? Error { get; init; }
}
