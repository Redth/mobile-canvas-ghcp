using MobileCanvas.Android;
using MobileCanvas.Contracts;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

/// <summary>
/// Parses captured from real devices, because both platforms report these in shapes that are easy
/// to guess wrong and that fail quietly when guessed wrong.
/// </summary>
public sealed class PresentationTests
{
	/// <summary>
	/// Verbatim <c>dumpsys appops --package com.companyname.avapp</c> from an API 35 emulator.
	/// </summary>
	private const string AppOpsDump = """
		Current AppOps Service state:
		  Settings:
		    top_state_settle_time=+5s0ms
		    fg_service_state_settle_time=+5s0ms
		    bg_state_settle_time=+1s0ms


		  Uid u0a229:
		    state=cch
		    capability=-------
		    appWidgetVisible=false
		      COARSE_LOCATION: mode=ignore
		      FINE_LOCATION: mode=ignore
		      READ_CONTACTS: mode=ignore
		      CAMERA: mode=ignore
		    Package com.companyname.avapp:
		      WRITE_SETTINGS (default): 
		      SYSTEM_ALERT_WINDOW (default): 
		      CAMERA (allow): 
		      RECORD_AUDIO (allow): 
		      REQUEST_INSTALL_PACKAGES (ignore): 
		      ACCESS_RESTRICTED_SETTINGS (default): 


		  AppOps policy location tags:
		""";

	[Fact]
	public void AppOps_ReadsThePackageModes()
	{
		var operations = AndroidEmulatorBackend.ParseAppOperations(AppOpsDump, "com.companyname.avapp")
			.Where(operation => !operation.UidScoped)
			.ToArray();

		Assert.Equal(6, operations.Length);
		Assert.Equal("default", operations.Single(o => o.Name == "SYSTEM_ALERT_WINDOW").Mode);
		Assert.Equal("allow", operations.Single(o => o.Name == "CAMERA").Mode);
		Assert.Equal("ignore", operations.Single(o => o.Name == "REQUEST_INSTALL_PACKAGES").Mode);
	}

	[Fact]
	public void AppOps_KeepsUidModesApartFromPackageModes()
	{
		var operations = AndroidEmulatorBackend.ParseAppOperations(AppOpsDump, "com.companyname.avapp");

		// The same operation appears in both blocks with different modes. Collapsing them would report
		// whichever was parsed last, and the uid one silently wins on the device.
		var camera = operations.Where(operation => operation.Name == "CAMERA").ToArray();
		Assert.Equal(2, camera.Length);
		Assert.Equal("ignore", camera.Single(operation => operation.UidScoped).Mode);
		Assert.Equal("allow", camera.Single(operation => !operation.UidScoped).Mode);
	}

	[Fact]
	public void AppOps_IgnoresTheBlocksOwnFields()
	{
		var operations = AndroidEmulatorBackend.ParseAppOperations(AppOpsDump, "com.companyname.avapp");

		// state=, capability= and appWidgetVisible= share the operations' indentation.
		Assert.DoesNotContain(operations, operation => operation.Name.Contains("state"));
		Assert.DoesNotContain(operations, operation => operation.Name.Contains("capability"));
		Assert.DoesNotContain(operations, operation => operation.Name.Contains("appWidget"));
	}

	[Fact]
	public void AppOps_SkipsAPackageThatWasNotAskedFor()
	{
		// dumpsys answers --package with every package sharing the uid, so matching the wrong header
		// would report another app's modes as this one's.
		var operations = AndroidEmulatorBackend.ParseAppOperations(AppOpsDump, "com.example.other");

		Assert.DoesNotContain(operations, operation => !operation.UidScoped);
	}

	/// <summary>Verbatim <c>simctl status_bar list</c> from a booted iPhone 11 Pro.</summary>
	private const string StatusBarList = """
		Current Status Bar Overrides:
		=============================
		Time: 9:41 
		DataNetworkType: 11
		WiFi Mode: 3, WiFi Bars: 3
		Cell Mode: 3, Cell Bars: 4
		Operator Name: Mobile
		Battery State: 2, Battery Level: 100, Not Charging: 0
		""";

	[Fact]
	public void StatusBar_ReadsEveryOverride()
	{
		var overrides = IosSimulatorBackend.ParseStatusBar(StatusBarList);

		Assert.Equal("9:41", overrides.Time);
		Assert.Equal(3, overrides.WifiBars);
		Assert.Equal(4, overrides.CellularBars);
		Assert.Equal("Mobile", overrides.CarrierName);
		Assert.Equal(100, overrides.BatteryLevel);
	}

	[Fact]
	public void StatusBar_TakesTheBarsRatherThanTheMode()
	{
		// 'WiFi Mode: 3, WiFi Bars: 3' puts two numbers on one line and they are not the same thing.
		var overrides = IosSimulatorBackend.ParseStatusBar(
			"Current Status Bar Overrides:\nWiFi Mode: 3, WiFi Bars: 1\nCell Mode: 2, Cell Bars: 0");

		Assert.Equal(1, overrides.WifiBars);
		Assert.Equal(0, overrides.CellularBars);
	}

	[Fact]
	public void StatusBar_SaysNothingWhenNothingIsOverridden()
	{
		// An empty list means the simulator is showing its own values, which simctl will not report.
		// Defaulting these to zero would claim a dead battery and no signal.
		var overrides = IosSimulatorBackend.ParseStatusBar(
			"Current Status Bar Overrides:\n=============================");

		Assert.Null(overrides.Time);
		Assert.Null(overrides.BatteryLevel);
		Assert.Null(overrides.WifiBars);
		Assert.Null(overrides.CarrierName);
	}

	[Fact]
	public void StatusBar_ReportsAFullBatteryInSimctlsOwnWord()
	{
		// The shared vocabulary calls state 2 'full', but re-sending that to simctl is rejected --
		// and it is re-sent on every change, because a partial override resets the rest of the group.
		var overrides = IosSimulatorBackend.ParseStatusBar(StatusBarList);

		Assert.Equal("charged", overrides.BatteryState);
	}

	[Theory]
	[InlineData("09:41", 9, 41)]
	[InlineData("9:41", 9, 41)]
	[InlineData("00:00", 0, 0)]
	[InlineData("23:59", 23, 59)]
	public void Clock_ReadsATime(string value, int hours, int minutes)
	{
		Assert.True(PresentationClock.TryParse(value, out var readHours, out var readMinutes));
		Assert.Equal(hours, readHours);
		Assert.Equal(minutes, readMinutes);
	}

	[Theory]
	[InlineData("24:00")]
	[InlineData("09:60")]
	[InlineData("9.41")]
	[InlineData("941")]
	[InlineData("")]
	[InlineData("-1:00")]
	[InlineData("09:41:22")]
	public void Clock_RefusesWhatThePlatformWouldSilentlyDrop(string value)
	{
		// Both platforms accept a time they cannot parse and leave the clock alone, so a loose check
		// here turns a typo into a screenshot with the wrong time on it.
		Assert.False(PresentationClock.TryParse(value, out _, out _));
	}
}
