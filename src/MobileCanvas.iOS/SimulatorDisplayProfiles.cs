using System.Collections.Concurrent;
using System.Text.Json;
using MobileCanvas.Core;

namespace MobileCanvas.iOS;

/// <summary>
/// Reads the physical display characteristics Xcode ships alongside every simulated device type.
/// </summary>
/// <remarks>
/// The framebuffer a simulator hands out is a plain rectangle: the rounded corners of the real panel
/// are a display-hardware mask, not pixels, so nothing in the video stream reveals them. Xcode does
/// know, though. Each <c>.simdevicetype</c> bundle carries a <c>capabilities.plist</c> whose
/// <c>displays</c> array records <c>cornerRadiusUL/UR/LL/LR</c> in points (39 on an iPhone 11 Pro,
/// 62 on an iPhone 16 Pro, 30 on an 11-inch iPad Pro, 0 on an iPhone SE). Reading it beats guessing
/// a radius or trying to infer one from corner pixels, which would be defeated by any app that
/// happens to paint a dark background.
/// </remarks>
internal sealed class SimulatorDisplayProfiles(IProcessRunner processRunner)
{
	private readonly IProcessRunner _processRunner = processRunner;
	private readonly ConcurrentDictionary<string, double?> _cornerRadii = new(StringComparer.Ordinal);
	private readonly SemaphoreSlim _bundleGate = new(1, 1);
	private IReadOnlyDictionary<string, string>? _bundlePaths;

	/// <summary>
	/// Corner radius in points for a device type's built-in display, or <c>null</c> when the profile
	/// cannot be read. Zero is a real answer and means the panel has square corners.
	/// </summary>
	public async Task<double?> TryGetCornerRadiusAsync(
		string? deviceTypeId,
		int pixelWidth,
		int pixelHeight,
		CancellationToken cancellationToken)
	{
		if (string.IsNullOrWhiteSpace(deviceTypeId) || !OperatingSystem.IsMacOS())
			return null;

		// Device type bundles ship with Xcode and never change while the host runs, so a miss is
		// cached as a miss too: a device without a profile must not re-run plutil on every stream.
		if (_cornerRadii.TryGetValue(deviceTypeId, out var cached))
			return cached;

		double? radius = null;
		try
		{
			var bundlePath = await TryGetBundlePathAsync(deviceTypeId, cancellationToken).ConfigureAwait(false);
			if (bundlePath is not null)
			{
				var plist = Path.Combine(bundlePath, "Contents", "Resources", "capabilities.plist");
				var json = await ReadPlistAsJsonAsync(plist, cancellationToken).ConfigureAwait(false);
				if (json is not null)
					radius = SimulatorCapabilitiesParser.ParseCornerRadius(json, pixelWidth, pixelHeight);
			}
		}
		catch (Exception exception) when (exception is not OperationCanceledException)
		{
			// A missing or unreadable profile only costs the exact corner rounding, so it is never
			// worth failing a display lookup over.
			radius = null;
		}

		_cornerRadii[deviceTypeId] = radius;
		return radius;
	}

	private async Task<string?> TryGetBundlePathAsync(string deviceTypeId, CancellationToken cancellationToken)
	{
		if (_bundlePaths is null)
		{
			await _bundleGate.WaitAsync(cancellationToken).ConfigureAwait(false);
			try
			{
				_bundlePaths ??= await LoadBundlePathsAsync(cancellationToken).ConfigureAwait(false);
			}
			finally
			{
				_bundleGate.Release();
			}
		}

		return _bundlePaths.TryGetValue(deviceTypeId, out var path) ? path : null;
	}

	private async Task<IReadOnlyDictionary<string, string>> LoadBundlePathsAsync(CancellationToken cancellationToken)
	{
		// `simctl list --json` omits bundlePath; the devicetypes-only listing includes it, and is
		// the only supported way to find a profile bundle without hardcoding Xcode's layout.
		var result = await _processRunner.RunAsync(
			new ProcessRequest("xcrun", ["simctl", "list", "devicetypes", "--json"]),
			cancellationToken).ConfigureAwait(false);

		return result.ExitCode == 0
			? SimulatorCapabilitiesParser.ParseBundlePaths(result.StandardOutput)
			: new Dictionary<string, string>(StringComparer.Ordinal);
	}

	private async Task<string?> ReadPlistAsJsonAsync(string path, CancellationToken cancellationToken)
	{
		if (!File.Exists(path))
			return null;

		// capabilities.plist is a binary plist; plutil is the system converter and is always present
		// on a machine that has simulators at all.
		var result = await _processRunner.RunAsync(
			new ProcessRequest("plutil", ["-convert", "json", "-o", "-", path]),
			cancellationToken).ConfigureAwait(false);
		return result.ExitCode == 0 ? result.StandardOutput : null;
	}
}
