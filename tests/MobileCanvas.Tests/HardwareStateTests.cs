using MobileCanvas.Android;
using MobileCanvas.Contracts;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

/// <summary>
/// Tests over hardware state as the emulator console and simctl actually report it.
/// </summary>
public class HardwareStateTests
{
	// Verbatim from `adb emu power display`.
	private const string PowerDisplay = """
		AC: online
		status: Charging
		health: Good
		present: true
		capacity: 100
		OK
		""";

	// Verbatim from `adb emu network status` on an unthrottled emulator.
	private const string UnthrottledNetwork = """
		Current network status:
		  download speed:          0 bits/s (0.0 KB/s)
		  upload speed:            0 bits/s (0.0 KB/s)
		  minimum latency:  0 ms
		  maximum latency:  0 ms
		OK
		""";

	[Fact]
	public void ReadsBatteryLevelAndState()
	{
		var (level, state) = AndroidEmulatorBackend.ParsePowerDisplay(PowerDisplay);

		Assert.Equal(100, level);
		Assert.Equal(BatteryStates.Charging, state);
	}

	[Fact]
	public void MapsTheConsolesStateNamesOntoTheSharedOnes()
	{
		// 'not-charging' means a charger is attached but the battery is not taking any, which for an
		// app's purposes is the same as discharging: it is not gaining charge.
		Assert.Equal(
			BatteryStates.Discharging,
			AndroidEmulatorBackend.ParsePowerDisplay("status: Not-charging").State);

		Assert.Equal(BatteryStates.Full, AndroidEmulatorBackend.ParsePowerDisplay("status: Full").State);

		// 'unknown' is a state the console accepts and reports, and it is not one of the three.
		Assert.Null(AndroidEmulatorBackend.ParsePowerDisplay("status: Unknown").State);
	}

	[Fact]
	public void ReportsAnUnthrottledNetworkAsAbsentRatherThanZero()
	{
		var (download, upload, latency) = AndroidEmulatorBackend.ParseNetworkStatus(UnthrottledNetwork);

		// The console writes an unlimited connection as 0 bits/s. Passing that through would describe
		// a working emulator as one with no bandwidth at all.
		Assert.Null(download);
		Assert.Null(upload);
		Assert.Null(latency);
	}

	[Fact]
	public void ReadsAThrottledNetwork()
	{
		var (download, upload, latency) = AndroidEmulatorBackend.ParseNetworkStatus(
			"""
			Current network status:
			  download speed:      473600 bits/s (462.5 KB/s)
			  upload speed:         57600 bits/s (56.2 KB/s)
			  minimum latency:  150 ms
			  maximum latency:  400 ms
			OK
			""");

		Assert.Equal(473600, download);
		Assert.Equal(57600, upload);
		Assert.Equal(400, latency);
	}

	[Fact]
	public void ReturnsNothingForOutputThatNeverArrived()
	{
		// Every adb probe helper collapses a failure to null, so both parsers see one.
		Assert.Equal((null, null), AndroidEmulatorBackend.ParsePowerDisplay(null));
		Assert.Equal((null, null, null), AndroidEmulatorBackend.ParseNetworkStatus(null));
		Assert.Equal((null, null), AndroidEmulatorBackend.ParsePowerDisplay(""));
	}

	[Fact]
	public void ReadsAnIosBatteryOverride()
	{
		// Verbatim from `simctl status_bar <udid> list` after an override was set.
		var (level, state) = IosSimulatorBackend.ParseStatusBarBattery(
			"""
			Current Status Bar Overrides:
			=============================
			Battery State: 0, Battery Level: 42, Not Charging: 0
			""");

		Assert.Equal(42, level);
		Assert.Equal(BatteryStates.Discharging, state);
	}

	[Fact]
	public void UsesTheCodesSimctlActuallyWrites()
	{
		// Measured by setting each state and reading the list back. UIDevice.BatteryState numbers the
		// same three ideas differently -- 1 unplugged, 2 charging, 3 full -- so an assumption carried
		// over from the app-facing API would report every state as the wrong one.
		Assert.Equal(BatteryStates.Discharging, IosSimulatorBackend.ParseStatusBarBattery("Battery State: 0").State);
		Assert.Equal(BatteryStates.Charging, IosSimulatorBackend.ParseStatusBarBattery("Battery State: 1").State);
		Assert.Equal(BatteryStates.Full, IosSimulatorBackend.ParseStatusBarBattery("Battery State: 2").State);
	}

	[Fact]
	public void ReportsNoIosOverrideAsUnknown()
	{
		// simctl lists overrides, not actual values, so an empty list means the simulator is showing
		// its own battery -- which is not the same as a battery at zero.
		var (level, state) = IosSimulatorBackend.ParseStatusBarBattery(
			"""
			Current Status Bar Overrides:
			=============================
			""");

		Assert.Null(level);
		Assert.Null(state);
	}

	[Fact]
	public void ReadsAnIosLevelSetWithoutAState()
	{
		var (level, state) = IosSimulatorBackend.ParseStatusBarBattery("Battery Level: 5");

		Assert.Equal(5, level);
		Assert.Null(state);
	}

	// `simctl status_bar override` replaces the battery group rather than merging into it, so a call
	// naming only a state silently resets the level to 100 (and vice versa). SetBatteryAsync reads the
	// current override and re-sends the half the caller did not name. This pins the read half of that
	// repair: if parsing a partial override ever returned nulls, the merge would have nothing to carry
	// forward and the reset would come back -- as a plausible-looking level, not an error.
	[Fact]
	public void ReadsBothHalvesOfAnOverrideSoAPartialUpdateCanCarryTheOtherForward()
	{
		var (level, state) = IosSimulatorBackend.ParseStatusBarBattery(
			"""
			Current Status Bar Overrides:
			=============================
			Battery State: 0
			Battery Level: 8
			""");

		Assert.Equal(8, level);
		Assert.Equal(BatteryStates.Discharging, state);
	}
}
