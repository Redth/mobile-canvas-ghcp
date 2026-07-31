using MobileCanvas.Android;
using MobileCanvas.Contracts;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

/// <summary>
/// Covers the app inventory parsers against output captured from a real simulator and emulator.
/// </summary>
public class AppInventoryTests
{
	#region iOS

	// Trimmed from `xcrun simctl listapps <udid> | plutil -convert json -o - -` on iOS 26.5.
	private const string ListAppsJson = """
		{
		  "com.apple.webapp": {
		    "CFBundleName": "Web",
		    "CFBundleIdentifier": "com.apple.webapp",
		    "ApplicationType": "System",
		    "CFBundleVersion": "8624.2.5",
		    "Path": "/Library/Developer/CoreSimulator/Volumes/iOS_23F77/Applications/Web.app",
		    "GroupContainers": {}
		  },
		  "com.example.notes": {
		    "CFBundleName": "notes",
		    "CFBundleDisplayName": "Notes",
		    "CFBundleIdentifier": "com.example.notes",
		    "ApplicationType": "User",
		    "CFBundleShortVersionString": "2.1",
		    "CFBundleVersion": "44",
		    "Path": "/Users/dev/Library/Developer/CoreSimulator/Devices/ABCD/data/Containers/Bundle/Application/1/Notes.app",
		    "DataContainer": "file:///Users/dev/Library/Developer/CoreSimulator/Devices/ABCD/data/Containers/Data/Application/2/"
		  }
		}
		""";

	[Fact]
	public void ParsesBundleMetadata()
	{
		var apps = SimctlAppParser.Parse(ListAppsJson);

		var notes = Assert.Single(apps, app => app.BundleId == "com.example.notes");
		Assert.Equal("Notes", notes.Name);
		Assert.Equal("2.1", notes.Version);
		Assert.Equal("44", notes.Build);
		Assert.Equal(AppKinds.User, notes.Kind);
	}

	[Fact]
	public void ClassifiesSystemApps()
	{
		var apps = SimctlAppParser.Parse(ListAppsJson);

		var web = Assert.Single(apps, app => app.BundleId == "com.apple.webapp");
		Assert.Equal(AppKinds.System, web.Kind);
		// No CFBundleDisplayName, so the shorter internal name stands in.
		Assert.Equal("Web", web.Name);
	}

	[Fact]
	public void ConvertsDataContainerUrlToPath()
	{
		var notes = Assert.Single(SimctlAppParser.Parse(ListAppsJson), app => app.BundleId == "com.example.notes");

		// A file:// URL is useless to every filesystem call a caller would make next, and the trailing
		// slash simctl adds would double up when joined with a child path.
		Assert.Equal(
			"/Users/dev/Library/Developer/CoreSimulator/Devices/ABCD/data/Containers/Data/Application/2",
			notes.DataContainer);
	}

	[Fact]
	public void MatchesRunningProcessesToApps()
	{
		var running = SimctlAppParser.ParseRunning(
			"47142\t0\tUIKitApplication:com.example.notes[003d][rb-legacy]\n"
			+ "-\t0\tcom.apple.backgroundtaskmanagement\n");

		var apps = SimctlAppParser.Parse(ListAppsJson, running);

		var notes = Assert.Single(apps, app => app.BundleId == "com.example.notes");
		Assert.True(notes.Running);
		Assert.Equal(47142, notes.ProcessId);

		var web = Assert.Single(apps, app => app.BundleId == "com.apple.webapp");
		Assert.False(web.Running);
		Assert.Null(web.ProcessId);
	}

	[Fact]
	public void IgnoresJobsThatAreNotApps()
	{
		// launchctl lists every job on the simulator; only UIKitApplication entries are apps.
		var running = SimctlAppParser.ParseRunning(
			"501\t0\tcom.apple.mobiletimerd\n"
			+ "47142\t0\tUIKitApplication:com.example.notes[003d][rb-legacy]\n");

		Assert.Equal(["com.example.notes"], running.Keys);
	}

	[Theory]
	[InlineData("com.apple.Preferences: 52795", 52795)]
	[InlineData("com.example.notes: 1", 1)]
	[InlineData("", null)]
	[InlineData("no colon here", null)]
	public void ReadsLaunchedProcessId(string output, int? expected) =>
		Assert.Equal(expected, SimctlAppParser.ParseLaunchedPid(output));

	#endregion

	#region Android

	// Captured from `adb shell pm list packages -3 -f --show-versioncode` on API 35.
	private const string PackageList = """
		package:/data/app/~~apHDpbgqvHVDwDT3_muf1Q==/com.companyname.avapp-efXZ8z5rh0R68Wn6nRru7g==/base.apk=com.companyname.avapp versionCode:1
		package:/data/app/~~ptNgkA_dWk2bXFsHUX5pXw==/com.troublefreepool.poolmath-bkP6T9D6AXKe9-qrwsPnCA==/base.apk=com.troublefreepool.poolmath versionCode:12
		""";

	[Fact]
	public void SplitsPackagePathsThatContainEqualsSigns()
	{
		var apps = PackageListParser.Parse(PackageList, AppKinds.User);

		// The APK directory is base64 and routinely ends in "==", so splitting on the first '=' would
		// truncate the path and report a package name of "=/com.companyname...".
		var avapp = Assert.Single(apps, app => app.BundleId == "com.companyname.avapp");
		Assert.Equal(
			"/data/app/~~apHDpbgqvHVDwDT3_muf1Q==/com.companyname.avapp-efXZ8z5rh0R68Wn6nRru7g==/base.apk",
			avapp.Path);
	}

	[Fact]
	public void ReadsVersionCodeAsBuild()
	{
		var apps = PackageListParser.Parse(PackageList, AppKinds.User);

		var poolmath = Assert.Single(apps, app => app.BundleId == "com.troublefreepool.poolmath");
		Assert.Equal("12", poolmath.Build);
		Assert.Equal(AppKinds.User, poolmath.Kind);
		// Android keeps the display label in compiled resources, which needs the APK unpacked.
		Assert.Null(poolmath.Name);
	}

	[Fact]
	public void ParsesPackagesWithoutPathOrVersion()
	{
		var apps = PackageListParser.Parse("package:com.example.plain\n", AppKinds.System);

		var app = Assert.Single(apps);
		Assert.Equal("com.example.plain", app.BundleId);
		Assert.Null(app.Path);
		Assert.Null(app.Build);
	}

	[Fact]
	public void MatchesRunningPackagesToProcesses()
	{
		var running = PackageListParser.ParseRunning("""
			  PID NAME
			 5645 com.troublefreepool.poolmath
			 3323 com.google.android.settings.intelligence
			    1 init
			    2 [kthreadd]
			""");

		var apps = PackageListParser.Parse(PackageList, AppKinds.User, running);

		var poolmath = Assert.Single(apps, app => app.BundleId == "com.troublefreepool.poolmath");
		Assert.True(poolmath.Running);
		Assert.Equal(5645, poolmath.ProcessId);

		var avapp = Assert.Single(apps, app => app.BundleId == "com.companyname.avapp");
		Assert.False(avapp.Running);
	}

	[Fact]
	public void IgnoresKernelThreadsAndNonAppProcesses()
	{
		var running = PackageListParser.ParseRunning("""
			    1 init
			    2 [kthreadd]
			 1234 com.example.app
			""");

		Assert.Equal(["com.example.app"], running.Keys);
	}

	[Fact]
	public void CreditsChildProcessesToTheirPackage()
	{
		// An app's extra processes are named "<package>:<suffix>". A child keeps the package visible as
		// running, but the main process must win the PID regardless of the order ps happens to list
		// them in, so a reported PID is the one worth attaching to.
		var childFirst = PackageListParser.ParseRunning("""
			 2222 com.example.app:remote
			 1111 com.example.app
			""");

		var mainFirst = PackageListParser.ParseRunning("""
			 1111 com.example.app
			 2222 com.example.app:remote
			""");

		Assert.Equal(1111, childFirst["com.example.app"]);
		Assert.Equal(1111, mainFirst["com.example.app"]);
	}

	[Fact]
	public void ReportsAPackageWithOnlyAChildProcessAsRunning()
	{
		var running = PackageListParser.ParseRunning(" 2222 com.example.app:remote\n");

		Assert.Equal(2222, running["com.example.app"]);
	}

	[Fact]
	public void ReadsResolvedLauncherActivity()
	{
		// resolve-activity prints a block of resolution detail and puts the answer last.
		var component = PackageListParser.ParseResolvedActivity("""
			priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true
			com.android.settings/.Settings
			""");

		Assert.Equal("com.android.settings/.Settings", component);
	}

	[Fact]
	public void ReportsNoLauncherActivity()
	{
		Assert.Null(PackageListParser.ParseResolvedActivity("No activity found\n"));
		Assert.Null(PackageListParser.ParseResolvedActivity(""));
	}

	[Fact]
	public void ParsesBarePackageNames()
	{
		// `pm list packages -3` output, used to spot what an install added.
		var names = PackageListParser.ParseNames("""
			package:com.companyname.avapp
			package:com.android.chrome
			""");

		Assert.Equal(["com.companyname.avapp", "com.android.chrome"], names);
	}

	[Fact]
	public void ParsesNamesFromPathAnnotatedOutput()
	{
		// Tolerates -f output so a caller cannot silently get apk paths back as "names".
		var names = PackageListParser.ParseNames(
			"package:/data/app/~~apHDpbgqvHVDwDT3_muf1Q==/com.example.app-x==/base.apk=com.example.app versionCode:12\n");

		Assert.Equal(["com.example.app"], names);
	}

	[Fact]
	public void IgnoresNoiseWhenParsingNames()
	{
		Assert.Empty(PackageListParser.ParseNames("error: device offline\n"));
		Assert.Empty(PackageListParser.ParseNames(""));
		Assert.Empty(PackageListParser.ParseNames(null));
	}

	[Fact]
	public void AcceptsASuccessfulLaunch()
	{
		// Captured from `am start -W` on API 35.
		Assert.Null(PackageListParser.FindLaunchFailure("""
			Starting: Intent { cmp=com.example.app/.MainActivity }
			Status: ok
			LaunchState: COLD
			Activity: com.example.app/.MainActivity
			TotalTime: 543
			WaitTime: 550
			Complete
			"""));
	}

	[Fact]
	public void DetectsALaunchThatFailedWhileExitingZero()
	{
		// am reports this on stdout and still exits zero, so the exit code says the app started.
		var failure = PackageListParser.FindLaunchFailure("""
			Starting: Intent { cmp=com.example.nope/.Main }
			Error type 3
			Error: Activity class {com.example.nope/com.example.nope.Main} does not exist.
			""");

		Assert.Contains("does not exist", failure);
	}

	[Fact]
	public void DetectsANonOkStatus()
	{
		var failure = PackageListParser.FindLaunchFailure("Status: timeout\n");

		Assert.Contains("timeout", failure);
	}

	[Fact]
	public void TreatsAMissingStatusLineAsSuccess()
	{
		// Older platform versions do not print a Status line, and the launch still happened.
		Assert.Null(PackageListParser.FindLaunchFailure(
			"Starting: Intent { cmp=com.example.app/.MainActivity }\n"));
	}

	#endregion
}
