using MobileCanvas.Android;

namespace MobileCanvas.Tests;

public sealed class EmulatorDiscoveryParserTests
{
	/// <summary>
	/// The discovery file is the only place that joins an AVD name, an adb serial, and a gRPC
	/// endpoint together, so every field the backend depends on is asserted here.
	/// </summary>
	[Fact]
	public void Parse_JoinsAvdSerialAndGrpcEndpoint()
	{
		const string ini = """
		port.serial=5554
		port.adb=5555
		avd.name=Pixel_8_Pro_API_36
		avd.dir=/Users/dev/.android/avd/Pixel_8_Pro_API_36.avd
		avd.id=Pixel_8_Pro_API_36
		cmdline="/opt/android/emulator/emulator" "-avd" "Pixel_8_Pro_API_36" "-gpu" "host"
		grpc.port=8554
		emulator.version=36.4.10
		pid=54321
		""";

		var instance = EmulatorDiscoveryParser.Parse(ini);

		Assert.NotNull(instance);
		Assert.Equal(54321, instance.ProcessId);
		Assert.Equal("Pixel_8_Pro_API_36", instance.AvdId);
		Assert.Equal("emulator-5554", instance.Serial);
		Assert.Equal(5555, instance.AdbPort);
		Assert.Equal(8554, instance.GrpcPort);
		Assert.True(instance.HasGrpc);
		Assert.Null(instance.GrpcToken);
		Assert.Equal("36.4.10", instance.EmulatorVersion);
		Assert.False(instance.LikelySoftwareRendered);
	}

	/// <summary>
	/// gRPC auto-starts only on port 8554 and only for the first emulator, so a second instance can
	/// legitimately have no endpoint at all. That has to degrade to a capability flag rather than
	/// dropping the emulator from the catalog.
	/// </summary>
	[Fact]
	public void Parse_ReportsMissingGrpcWithoutDroppingTheInstance()
	{
		const string ini = """
		port.serial=5556
		port.adb=5557
		avd.id=Pixel_Tablet_API_35
		pid=54322
		""";

		var instance = EmulatorDiscoveryParser.Parse(ini);

		Assert.NotNull(instance);
		Assert.Equal("emulator-5556", instance.Serial);
		Assert.False(instance.HasGrpc);
	}

	[Fact]
	public void Parse_ReadsTheStaticTokenWhenTheEmulatorRequiresAuth()
	{
		const string ini = """
		avd.id=Pixel_8_Pro_API_36
		grpc.port=8556
		grpc.token=abc123
		""";

		var instance = EmulatorDiscoveryParser.Parse(ini);

		Assert.Equal("abc123", instance?.GrpcToken);
	}

	/// <summary>
	/// Software rendering drops the stream from ~50 FPS to ~3 FPS, which looks exactly like a broken
	/// encoder, so it is detected from the recorded launch command and surfaced as a diagnostic.
	/// </summary>
	[Theory]
	[InlineData("\"emulator\" \"-avd\" \"X\" \"-gpu\" \"guest\"")]
	[InlineData("\"emulator\" \"-avd\" \"X\" \"-gpu\" \"off\"")]
	[InlineData("\"emulator\" \"-avd\" \"X\" \"-feature\" \"SwiftShader\"")]
	public void Parse_FlagsSoftwareRenderedEmulators(string commandLine)
	{
		var instance = EmulatorDiscoveryParser.Parse($"avd.id=X\ncmdline={commandLine}");

		Assert.True(instance?.LikelySoftwareRendered);
	}

	[Fact]
	public void Parse_ReturnsNullWhenThereIsNoAvdIdentity()
	{
		Assert.Null(EmulatorDiscoveryParser.Parse(""));
		Assert.Null(EmulatorDiscoveryParser.Parse("# comment only\n\n"));
		Assert.Null(EmulatorDiscoveryParser.Parse("port.serial=5554\npid=1"));
	}

	[Fact]
	public void Parse_TreatsMalformedNumbersAsAbsent()
	{
		var instance = EmulatorDiscoveryParser.Parse("avd.id=X\nport.serial=nope\ngrpc.port=\n");

		Assert.NotNull(instance);
		Assert.Equal("", instance.Serial);
		Assert.False(instance.HasGrpc);
	}

	/// <summary>
	/// An offline or unauthorized device keeps its reported state instead of disappearing, so a stuck
	/// emulator stays visible in the catalog rather than looking like it was never started.
	/// </summary>
	[Fact]
	public void ParseAdbDevices_KeepsNonReadyStates()
	{
		const string output = """
		List of devices attached
		emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64
		emulator-5556          offline
		4C1B2D3E               unauthorized

		""";

		var devices = EmulatorDiscoveryParser.ParseAdbDevices(output);

		Assert.Equal(3, devices.Count);
		Assert.Equal(("emulator-5554", "device"), devices[0]);
		Assert.Equal(("emulator-5556", "offline"), devices[1]);
		Assert.Equal(("4C1B2D3E", "unauthorized"), devices[2]);
	}

	[Fact]
	public void ParseAvdList_IgnoresWarningLines()
	{
		const string output = """
		INFO    | Storing crashdata in: /tmp/emu-crash.db
		Pixel_8_Pro_API_36
		Pixel_Tablet_API_35

		""";

		Assert.Equal(["Pixel_8_Pro_API_36", "Pixel_Tablet_API_35"], EmulatorDiscoveryParser.ParseAvdList(output));
	}

	[Fact]
	public void ParseWmSize_PrefersAnActiveOverride()
	{
		Assert.Equal((1080, 2400), EmulatorDiscoveryParser.ParseWmSize("Physical size: 1080x2400"));
		Assert.Equal(
			(720, 1600),
			EmulatorDiscoveryParser.ParseWmSize("Physical size: 1080x2400\nOverride size: 720x1600"));
		Assert.Null(EmulatorDiscoveryParser.ParseWmSize("something went wrong"));
	}

	[Fact]
	public void ParseWmDensity_PrefersAnActiveOverride()
	{
		Assert.Equal(480, EmulatorDiscoveryParser.ParseWmDensity("Physical density: 480"));
		Assert.Equal(
			320,
			EmulatorDiscoveryParser.ParseWmDensity("Physical density: 480\nOverride density: 320"));
		Assert.Null(EmulatorDiscoveryParser.ParseWmDensity("Physical density: unknown"));
	}

	/// <summary>
	/// The panel radius drives how the canvas crops the video feed, and dumpsys is the only place
	/// that reports it, so the shape of that block is pinned here.
	/// </summary>
	[Fact]
	public void ParseRoundedCornerRadius_TakesTheLargestCorner()
	{
		const string output = """
			  mDisplayInfo=DisplayInfo{"Built-in Screen", displayId 0, FLAG_TRUSTED, real 1080 x 2400
			    roundedCorners RoundedCorners{[RoundedCorner{position=TopLeft, radius=28, center=Point(28, 28)}, RoundedCorner{position=TopRight, radius=28, center=Point(1052, 28)}, RoundedCorner{position=BottomRight, radius=34, center=Point(1052, 2372)}, RoundedCorner{position=BottomLeft, radius=28, center=Point(28, 2372)}]}
			    density 2.625
			""";

		Assert.Equal(34, EmulatorDiscoveryParser.ParseRoundedCornerRadius(output));
	}

	[Fact]
	public void ParseRoundedCornerRadius_IsNullWhenTheDisplayIsSquare()
	{
		Assert.Null(EmulatorDiscoveryParser.ParseRoundedCornerRadius("real 1080 x 2400, density 420"));
		Assert.Null(EmulatorDiscoveryParser.ParseRoundedCornerRadius("roundedCorners RoundedCorners{[]}"));
	}
}
