using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using WindowsCanvas.Contracts;

namespace WindowsCanvas.Windows;

/// <summary>
/// Derives and compares the transform token that makes screenshot-guided coordinates safe.
///
/// The token is a fingerprint of one window's identity and its current geometry. A caller measures
/// coordinates against a descriptor, sends the token back with the request, and the host re-reads
/// the live window and recomputes the token. If anything that could move a pixel changed — the
/// window moved, resized, changed monitor DPI, was minimized, or the handle now belongs to a
/// different process — the tokens differ and the request is refused. Nothing here is a secret: it
/// is a state fingerprint, not a capability, and the opaque window ID remains the only authority.
///
/// Capture scale is deliberately excluded. A half-scale stream and a full-scale screenshot describe
/// the same window state, and a caller says which image size its coordinates are in through the
/// request rather than by holding two different tokens.
/// </summary>
internal static class WindowsCaptureTransform
{
	private const string Prefix = "wct1";

	public static string Version(WindowsWindowKey identity, WindowsCaptureGeometry geometry)
	{
		ArgumentNullException.ThrowIfNull(geometry);
		var canonical = new StringBuilder(256)
			.Append(Prefix).Append('|')
			.Append(identity.Handle).Append('|')
			.Append(identity.ProcessId).Append('|')
			.Append(identity.ProcessStartFileTime).Append('|')
			.Append(identity.AppUserModelId ?? "").Append('|')
			.Append(geometry.Minimized ? '1' : '0').Append('|')
			.Append(geometry.Dpi).Append('|')
			.Append(geometry.ContentWidth).Append('x').Append(geometry.ContentHeight).Append('|')
			.Append(Describe(geometry.ContentScreenBounds)).Append('|')
			.Append(Describe(geometry.WindowScreenBounds)).Append('|')
			.Append(Describe(geometry.ClientScreenBounds)).Append('|')
			.Append(geometry.ClientWidth).Append('x').Append(geometry.ClientHeight)
			.ToString();

		var hash = SHA256.HashData(Encoding.UTF8.GetBytes(canonical));
		return $"{Prefix}_{Convert.ToHexString(hash.AsSpan(0, 12)).ToLowerInvariant()}";
	}

	/// <summary>Returns the same geometry carrying the token that describes it.</summary>
	public static WindowsCaptureGeometry Stamp(
		WindowsCaptureGeometry geometry,
		WindowsWindowKey identity) =>
		geometry with { TransformVersion = Version(identity, geometry) };

	public static bool Matches(string? presented, string current) =>
		!string.IsNullOrWhiteSpace(presented)
		&& presented.Trim().Equals(current, StringComparison.Ordinal);

	private static string Describe(WindowsWindowBounds? bounds) =>
		bounds is null
			? "-"
			: string.Create(
				CultureInfo.InvariantCulture,
				$"{bounds.Left},{bounds.Top},{bounds.Width},{bounds.Height}");
}

/// <summary>
/// Turns coordinates in the canonical capture space into places on the desktop.
///
/// Every step is a pure function of the descriptor's own geometry. Nothing about the browser's
/// rendered size, its letterboxing, or its device pixel ratio takes part, which is what lets a
/// panel scale a stream however it likes without ever changing where a click lands.
/// </summary>
internal static class WindowsInputMapper
{
	/// <summary>
	/// Converts a point expressed in a delivered image of <paramref name="captureWidth"/> by
	/// <paramref name="captureHeight"/> pixels into content pixels. A capture size of zero means the
	/// caller is already speaking in content pixels.
	/// </summary>
	public static WindowsInputPoint ToContent(
		double x,
		double y,
		int captureWidth,
		int captureHeight,
		WindowsCaptureGeometry geometry)
	{
		if (!double.IsFinite(x) || !double.IsFinite(y))
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				"Coordinates must be finite numbers.");
		}

		var scaleX = captureWidth > 0 && geometry.ContentWidth > 0
			? (double)geometry.ContentWidth / captureWidth
			: 1;
		var scaleY = captureHeight > 0 && geometry.ContentHeight > 0
			? (double)geometry.ContentHeight / captureHeight
			: 1;
		return new WindowsInputPoint { X = x * scaleX, Y = y * scaleY };
	}

	/// <summary>
	/// Whether a content point is inside the window's visible content. A request that is outside is
	/// refused: clicking just past the edge of the window is clicking somebody else's window.
	/// </summary>
	public static bool IsInsideContent(WindowsInputPoint point, WindowsCaptureGeometry geometry) =>
		geometry.ContentWidth > 0
		&& geometry.ContentHeight > 0
		&& point.X >= 0
		&& point.Y >= 0
		&& point.X <= geometry.ContentWidth - 1
		&& point.Y <= geometry.ContentHeight - 1;

	/// <summary>
	/// The same place in physical virtual-desktop pixels. These are frequently negative on a
	/// multi-monitor desktop whose primary display is not the leftmost or topmost one.
	/// </summary>
	public static (int X, int Y) ToScreen(WindowsInputPoint content, WindowsCaptureGeometry geometry)
	{
		var bounds = geometry.ContentScreenBounds;
		return (
			bounds.Left + (int)Math.Round(content.X, MidpointRounding.AwayFromZero),
			bounds.Top + (int)Math.Round(content.Y, MidpointRounding.AwayFromZero));
	}

	/// <summary>The client-relative point, for callers that reason in client coordinates.</summary>
	public static (int X, int Y) ToClient(WindowsInputPoint content, WindowsCaptureGeometry geometry) =>
		(
			(int)Math.Round(content.X, MidpointRounding.AwayFromZero) - geometry.ClientOffset.X,
			(int)Math.Round(content.Y, MidpointRounding.AwayFromZero) - geometry.ClientOffset.Y);

	/// <summary>
	/// The normalized absolute coordinate <c>SendInput</c> wants with
	/// <c>MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK</c>: the virtual desktop mapped onto
	/// 0 through 65535 on each axis. Doing this arithmetic here rather than inside the P/Invoke
	/// wrapper is what makes multi-monitor and negative-origin desktops testable without a desktop.
	/// </summary>
	public static (int X, int Y) ToAbsolute(int screenX, int screenY, WindowsWindowBounds desktop)
	{
		var width = Math.Max(desktop.Width, 1);
		var height = Math.Max(desktop.Height, 1);
		var normalizedX = width <= 1 ? 0 : (screenX - desktop.Left) * 65535.0 / (width - 1);
		var normalizedY = height <= 1 ? 0 : (screenY - desktop.Top) * 65535.0 / (height - 1);
		return (
			(int)Math.Clamp(Math.Round(normalizedX, MidpointRounding.AwayFromZero), 0, 65535),
			(int)Math.Clamp(Math.Round(normalizedY, MidpointRounding.AwayFromZero), 0, 65535));
	}

	/// <summary>Interpolates a drag path, always including both endpoints.</summary>
	public static WindowsInputPoint[] Path(
		WindowsInputPoint start,
		WindowsInputPoint end,
		int steps)
	{
		var count = WindowsInputLimits.DragSteps(steps);
		var points = new WindowsInputPoint[count + 1];
		for (var index = 0; index <= count; index++)
		{
			var progress = (double)index / count;
			points[index] = new WindowsInputPoint
			{
				X = start.X + ((end.X - start.X) * progress),
				Y = start.Y + ((end.Y - start.Y) * progress),
			};
		}
		return points;
	}
}
