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
	public void Parse_DeduplicatesRuntimeIdentifiersAndResolvesDeviceMetadata()
	{
		const string json = """
		{
		  "runtimes": [{
		    "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
		    "buildversion": "24A5279h",
		    "name": "iOS 27.0",
		    "version": "27.0",
		    "isAvailable": true,
		    "supportedArchitectures": ["arm64"],
		    "supportedDeviceTypes": [{
		      "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
		    }]
		  }, {
		    "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
		    "buildversion": "24A5298h",
		    "name": "iOS 27.0",
		    "version": "27.0",
		    "isAvailable": true,
		    "supportedArchitectures": ["arm64"],
		    "supportedDeviceTypes": [{
		      "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
		    }]
		  }],
		  "devicetypes": [{
		    "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
		    "name": "iPhone 17 Pro",
		    "productFamily": "iPhone",
		    "modelIdentifier": "iPhone18,1"
		  }],
		  "devices": {
		    "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{
		      "name": "Beta Test iPhone",
		      "udid": "EFGH-5678",
		      "state": "Shutdown",
		      "isAvailable": true,
		      "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"
		    }]
		  }
		}
		""";

		var catalog = SimctlCatalogParser.Parse(json);
		var runtime = Assert.Single(catalog.Runtimes);
		var device = Assert.Single(catalog.Devices);

		Assert.Equal("com.apple.CoreSimulator.SimRuntime.iOS-27-0", runtime.Id);
		Assert.Equal(runtime.Id, device.RuntimeId);
		Assert.Equal("iOS 27.0", device.RuntimeName);
		Assert.Equal("27.0", device.OsVersion);
		Assert.Equal("iPhone 17 Pro", device.DeviceTypeName);
	}

	[Fact]
	public void Parse_OnlyExposesCanonicalIosRuntimes()
	{
		const string json = """
		{
		  "runtimes": [{
		    "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
		    "name": "iOS 18.6",
		    "version": "18.6",
		    "platform": "iOS",
		    "isAvailable": true
		  }, {
		    "identifier": "com.apple.CoreSimulator.SimRuntime.tvOS-18-6",
		    "name": "tvOS 18.6",
		    "version": "18.6",
		    "platform": "tvOS",
		    "isAvailable": true
		  }, {
		    "identifier": "com.apple.CoreSimulator.SimRuntime.watchOS-11-6",
		    "name": "watchOS 11.6",
		    "version": "11.6",
		    "platform": "watchOS",
		    "isAvailable": true
		  }],
		  "devicetypes": [],
		  "devices": {}
		}
		""";

		var catalog = SimctlCatalogParser.Parse(json);
		var runtime = Assert.Single(catalog.Runtimes);

		Assert.Equal("com.apple.CoreSimulator.SimRuntime.iOS-18-6", runtime.Id);
		Assert.Equal(DevicePlatforms.Ios, runtime.Platform);
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

	[Fact]
	public void DisplayParser_PrefersIntegratedDisplayOverExternalScreens()
	{
		const string output = """
		Connected Screens:
		    (2) TVOut:
		        Screen Type: TVOut
		        Pixel Size: {720, 480}
		        Preferred UI Scale: 1
		        UI Orientation: Ambiguous
		    (1) LCD:
		        Screen Type: Integrated
		        Pixel Size: {1125, 2436}
		        Preferred UI Scale: 3
		        UI Orientation: Portrait
		    (3) Wireless:
		        Screen Type: CarPlay
		        Pixel Size: {720, 480}
		        Preferred UI Scale: 1
		        UI Orientation: Ambiguous
		""";

		var display = SimctlDisplayParser.Parse(output);

		Assert.Equal(1125, display.PixelWidth);
		Assert.Equal(2436, display.PixelHeight);
		Assert.Equal(375, display.PointWidth);
		Assert.Equal(812, display.PointHeight);
		Assert.Equal(3, display.Scale);
		Assert.Equal("portrait", display.Orientation);
	}
}
