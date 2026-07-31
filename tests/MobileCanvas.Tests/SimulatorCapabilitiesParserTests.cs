using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

/// <summary>
/// The corner radius drives how the canvas crops the video feed. These payloads are trimmed copies
/// of what Xcode ships, so the parser stays pinned to the real shape rather than an invented one.
/// </summary>
public sealed class SimulatorCapabilitiesParserTests
{
	[Fact]
	public void ParseBundlePaths_MapsIdentifiersToBundles()
	{
		const string json = """
			{
			  "devicetypes": [
			    {
			      "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro",
			      "name": "iPhone 11 Pro",
			      "bundlePath": "/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone 11 Pro.simdevicetype"
			    },
			    { "identifier": "com.apple.CoreSimulator.SimDeviceType.no-bundle" }
			  ]
			}
			""";

		var paths = SimulatorCapabilitiesParser.ParseBundlePaths(json);

		Assert.Equal(
			"/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone 11 Pro.simdevicetype",
			paths["com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro"]);
		Assert.DoesNotContain("com.apple.CoreSimulator.SimDeviceType.no-bundle", paths.Keys);
	}

	/// <summary>
	/// Profiles describe TV-out, CarPlay and resizable-scene displays alongside the panel, and only
	/// the integrated one is the device in hand.
	/// </summary>
	[Fact]
	public void ParseCornerRadius_ReadsTheIntegratedDisplayMatchingTheFramebuffer()
	{
		const string json = """
			{
			  "capabilities": {
			    "DeviceCornerRadius": 39,
			    "displays": [
			      { "displayType": "tvOut", "width": 1920, "height": 1080, "cornerRadiusUL": 0 },
			      {
			        "displayType": "integrated", "width": 1125, "height": 2436,
			        "cornerRadiusUL": 39, "cornerRadiusUR": 39,
			        "cornerRadiusLL": 39, "cornerRadiusLR": 39
			      },
			      { "displayType": "scene", "width": 100, "height": 100, "cornerRadiusUL": 5 }
			    ]
			  }
			}
			""";

		Assert.Equal(39, SimulatorCapabilitiesParser.ParseCornerRadius(json, 1125, 2436));
	}

	[Fact]
	public void ParseCornerRadius_FallsBackToTheDeviceLevelRadius()
	{
		const string json = """
			{ "capabilities": { "DeviceCornerRadius": 62, "displays": [ { "displayType": "carPlay" } ] } }
			""";

		Assert.Equal(62, SimulatorCapabilitiesParser.ParseCornerRadius(json, 1320, 2868));
	}

	/// <summary>
	/// A squared-off panel such as the iPhone SE reports 0, which has to survive as a real answer
	/// rather than collapsing into "unknown" and re-introducing a guessed radius.
	/// </summary>
	[Fact]
	public void ParseCornerRadius_KeepsZeroDistinctFromUnknown()
	{
		Assert.Equal(0, SimulatorCapabilitiesParser.ParseCornerRadius("""{"capabilities":{"DeviceCornerRadius":0}}""", 750, 1334));
		Assert.Null(SimulatorCapabilitiesParser.ParseCornerRadius("""{"capabilities":{}}""", 750, 1334));
		Assert.Null(SimulatorCapabilitiesParser.ParseCornerRadius("{}", 750, 1334));
	}
}
