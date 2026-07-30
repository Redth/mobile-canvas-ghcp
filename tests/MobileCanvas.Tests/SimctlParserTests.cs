using MobileCanvas.Contracts;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

public sealed class SimctlParserTests
{
	[Fact]
	public void Parse_MapsStableDeployableDeviceRecords()
	{
		const string json = """
		{
		  "runtimes": [{
		    "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
		    "name": "iOS 18.6",
		    "version": "18.6",
		    "isAvailable": true,
		    "supportedArchitectures": ["arm64"],
		    "supportedDeviceTypes": [{
		      "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"
		    }]
		  }],
		  "devicetypes": [{
		    "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
		    "name": "iPhone 16 Pro",
		    "productFamily": "iPhone",
		    "modelIdentifier": "iPhone17,1",
		    "minRuntimeVersionString": "18.0.0",
		    "maxRuntimeVersionString": "65535.255.255"
		  }],
		  "devices": {
		    "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [{
		      "name": "UI Test iPhone",
		      "udid": "ABCD-1234",
		      "state": "Booted",
		      "isAvailable": true,
		      "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"
		    }]
		  }
		}
		""";

		var catalog = SimctlCatalogParser.Parse(json);
		var device = Assert.Single(catalog.Devices);

		Assert.Equal("ios:core-simulator:ABCD-1234", device.Id);
		Assert.Equal("ABCD-1234", device.Udid);
		Assert.Equal(DeviceStates.Booted, device.State);
		Assert.Equal("18.6", device.OsVersion);
		Assert.Equal("iPhone 16 Pro", device.DeviceTypeName);
		Assert.True(device.Capabilities.LiveStream);
	}

	[Fact]
	public void DisplayParser_MapsLogicalGeometryAndOrientation()
	{
		const string output = """
		Connected Screens:
		    (1) LCD:
		        Pixel Size: {1125, 2436}
		        Preferred UI Scale: 3
		        UI Orientation: Landscape Left
		""";

		var display = SimctlDisplayParser.Parse(output);

		Assert.Equal(1125, display.PixelWidth);
		Assert.Equal(2436, display.PixelHeight);
		Assert.Equal(375, display.PointWidth);
		Assert.Equal(812, display.PointHeight);
		Assert.Equal("landscape-left", display.Orientation);
	}
}
