using MobileCanvas.Android;
using MobileCanvas.Contracts;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

/// <summary>
/// Covers the log and crash parsers against output captured from a real simulator and emulator.
/// </summary>
public class DiagnosticsTests
{
	#region Android log

	// Captured from `adb shell logcat -v threadtime -d` on an API 35 emulator.
	private const string ThreadTimeLog = """
		--------- beginning of main
		02-14 09:12:41.113  1622  1622 I ActivityManager: Start proc 10284:com.android.settings/1000
		02-14 09:12:41.220  1622  2041 W BroadcastQueue: Background execution not allowed
		02-14 09:12:41.664 10284 10284 E AndroidRuntime: FATAL EXCEPTION: main
		02-14 09:12:41.664 10284 10284 E AndroidRuntime: Process: com.example.app, PID: 10284
		02-14 09:12:41.664 10284 10284 E AndroidRuntime: java.lang.IllegalStateException: boom
		02-14 09:12:41.664 10284 10284 E AndroidRuntime: 	at com.example.app.MainActivity.onCreate(MainActivity.kt:31)
		""";

	[Fact]
	public void Parse_ReadsThreadTimeFields()
	{
		var entries = LogcatParser.Parse(ThreadTimeLog);

		var first = entries[0];
		Assert.Equal("02-14 09:12:41.113", first.Timestamp);
		Assert.Equal(1622, first.ProcessId);
		Assert.Equal(LogLevels.Info, first.Level);
		Assert.Equal("ActivityManager", first.Source);
		Assert.Equal("Start proc 10284:com.android.settings/1000", first.Message);
	}

	[Fact]
	public void Parse_SkipsBufferBanner()
	{
		var entries = LogcatParser.Parse(ThreadTimeLog);

		Assert.DoesNotContain(entries, entry => entry.Message.Contains("beginning of"));
	}

	[Fact]
	public void Parse_MapsPriorityLetters()
	{
		var entries = LogcatParser.Parse(ThreadTimeLog);

		Assert.Equal(LogLevels.Warning, entries[1].Level);
		Assert.Equal(LogLevels.Error, entries[2].Level);
	}

	[Fact]
	public void Parse_KeepsStackFramesWithTheirException()
	{
		// A frame arrives on its own line with a header of its own here, but a wrapped message does
		// not -- and a trace parted from its exception is the half a caller cannot use.
		var entries = LogcatParser.Parse("""
			02-14 09:12:41.664 10284 10284 E AndroidRuntime: java.lang.IllegalStateException: boom
			 	at com.example.app.MainActivity.onCreate(MainActivity.kt:31)
			 	at android.app.Activity.performCreate(Activity.java:8305)
			""");

		var entry = Assert.Single(entries);
		Assert.Contains("IllegalStateException: boom", entry.Message);
		Assert.Contains("MainActivity.onCreate(MainActivity.kt:31)", entry.Message);
		Assert.Contains("Activity.performCreate(Activity.java:8305)", entry.Message);
	}

	[Fact]
	public void Parse_ReadsMessagesContainingColons()
	{
		var entries = LogcatParser.Parse(
			"02-14 09:12:41.113  1622  1622 I ActivityManager: url: https://example.com/x");

		var entry = Assert.Single(entries);
		Assert.Equal("ActivityManager", entry.Source);
		Assert.Equal("url: https://example.com/x", entry.Message);
	}

	[Fact]
	public void Parse_ReturnsEmptyForNoOutput()
	{
		Assert.Empty(LogcatParser.Parse(null));
		Assert.Empty(LogcatParser.Parse("   "));
	}

	[Theory]
	[InlineData(LogLevels.Verbose, 'V')]
	[InlineData(LogLevels.Debug, 'D')]
	[InlineData(LogLevels.Info, 'I')]
	[InlineData(LogLevels.Warning, 'W')]
	[InlineData(LogLevels.Error, 'E')]
	[InlineData(LogLevels.Fatal, 'F')]
	[InlineData(null, 'V')]
	public void ToPriority_MapsOntoLogcatLetters(string? level, char expected) =>
		Assert.Equal(expected, LogcatParser.ToPriority(level));

	#endregion

	#region Android crashes

	// Captured from `adb shell dumpsys dropbox --file` on an API 35 emulator.
	private const string DropboxListing = """
		Drop box contents: 41 entries
		Max entries: 1000
		Low priority rate limit period: 2000 ms

		2026-07-29 13:57:02 system_app_strictmode (compressed text, 2431 bytes)
		2026-07-31 13:46:33 data_app_anr (compressed text, 7111 bytes)
		2026-08-02 09:14:55 data_app_crash (compressed text, 3902 bytes)
		""";

	[Fact]
	public void ParseDropbox_ReadsTimestampAndTag()
	{
		var reports = LogcatParser.ParseDropbox(DropboxListing);

		Assert.Equal(3, reports.Length);
		Assert.Contains(reports, report => report.Id == "2026-07-31 13:46:33|data_app_anr");
	}

	[Fact]
	public void ParseDropbox_ReturnsNewestFirst()
	{
		// dropbox prints oldest first; a caller chasing a crash wants the one that just happened.
		var reports = LogcatParser.ParseDropbox(DropboxListing);

		Assert.Equal("2026-08-02 09:14:55", reports[0].Timestamp);
		Assert.Equal("2026-07-29 13:57:02", reports[^1].Timestamp);
	}

	[Fact]
	public void ParseDropbox_DescribesTags()
	{
		var reports = LogcatParser.ParseDropbox(DropboxListing);

		Assert.Equal("crash", reports[0].Kind);
		Assert.Equal("anr", reports[1].Kind);
		Assert.Equal("strict mode violation", reports[2].Kind);
	}

	[Fact]
	public void ParseDropbox_IgnoresTheSummaryHeader()
	{
		var reports = LogcatParser.ParseDropbox(DropboxListing);

		Assert.DoesNotContain(reports, report => report.Name.Contains("entries"));
	}

	[Fact]
	public void FindDropboxPackage_ReadsTheProcessHeader() =>
		Assert.Equal(
			"com.example.poolmath",
			LogcatParser.FindDropboxPackage("""
				Subject: Input dispatching timed out
				Process: com.example.poolmath
				Package: com.example.poolmath v42
				"""));

	[Fact]
	public void FindDropboxPackage_ReturnsNullWhenAbsent() =>
		Assert.Null(LogcatParser.FindDropboxPackage("Subject: Input dispatching timed out"));

	[Fact]
	public void ExtractDropboxEntry_StripsThePreamble()
	{
		var body = LogcatParser.ExtractDropboxEntry("""
			Drop box contents: 41 entries
			Max entries: 1000

			========================================
			Process: com.example.poolmath
			Subject: Input dispatching timed out
			""");

		Assert.NotNull(body);
		Assert.StartsWith("Process: com.example.poolmath", body);
		Assert.DoesNotContain("Drop box contents", body);
	}

	[Fact]
	public void ExtractDropboxEntry_ReturnsNullWhenNothingMatched()
	{
		// dumpsys says this and still exits zero, so output length cannot tell a hit from a miss.
		Assert.Null(LogcatParser.ExtractDropboxEntry("""
			Drop box contents: 41 entries

			========================================
			"""));
		Assert.Null(LogcatParser.ExtractDropboxEntry("(No entries found.)"));
	}

	#endregion

	#region iOS log

	// Captured from `xcrun simctl spawn <udid> log show --style ndjson --last 2m`, one object per
	// line, trimmed to the fields the parser reads.
	private const string NdjsonLog = """
		{"traceID":1,"eventMessage":"Settings did finish launching","eventType":"logEvent","source":null,"subsystem":"com.apple.Preferences","category":"lifecycle","processID":9134,"processImagePath":"\/Applications\/Preferences.app\/Preferences","messageType":"Default","timestamp":"2026-02-14 09:12:41.113244-0800"}
		{"traceID":2,"eventMessage":"Unable to load preference bundle","eventType":"logEvent","subsystem":"com.apple.Preferences","category":"loading","processID":9134,"processImagePath":"\/Applications\/Preferences.app\/Preferences","messageType":"Error","timestamp":"2026-02-14 09:12:41.220981-0800"}
		{"traceID":3,"eventMessage":"assertion failed","eventType":"logEvent","processID":9134,"processImagePath":"\/Applications\/Preferences.app\/Preferences","messageType":"Fault","timestamp":"2026-02-14 09:12:41.664012-0800"}
		{"traceID":4,"eventType":"activityCreateEvent","processID":9134,"processImagePath":"\/Applications\/Preferences.app\/Preferences","timestamp":"2026-02-14 09:12:41.900000-0800"}
		""";

	[Fact]
	public void Parse_ReadsNdjsonFields()
	{
		var entries = OsLogParser.Parse(NdjsonLog);

		var first = entries[0];
		Assert.Equal("Settings did finish launching", first.Message);
		Assert.Equal(9134, first.ProcessId);
		Assert.Equal("Preferences", first.Source);
		Assert.Equal("com.apple.Preferences:lifecycle", first.Subsystem);
	}

	[Fact]
	public void Parse_SkipsEventsThatAreNotLogLines()
	{
		// The stream carries activity and state events with no eventMessage at all.
		var entries = OsLogParser.Parse(NdjsonLog);

		Assert.Equal(3, entries.Length);
	}

	[Fact]
	public void Parse_MapsAppleLevelsOntoTheSharedLadder()
	{
		var entries = OsLogParser.Parse(NdjsonLog);

		// Apple's "Default" is the ordinary level an app logs at, not a severity of its own.
		Assert.Equal(LogLevels.Info, entries[0].Level);
		Assert.Equal(LogLevels.Error, entries[1].Level);
		Assert.Equal(LogLevels.Fatal, entries[2].Level);
	}

	[Fact]
	public void Parse_SurvivesANonJsonLine()
	{
		// log show prefixes its output with a header and can interleave notices.
		var entries = OsLogParser.Parse(
			"Filtering the log data using \"process == \\\"Preferences\\\"\"\n"
			+ """{"eventMessage":"ok","processID":1,"messageType":"Info","timestamp":"t"}""");

		Assert.Equal("ok", Assert.Single(entries).Message);
	}

	[Fact]
	public void Parse_OmitsSubsystemWhenAbsent() =>
		Assert.Null(OsLogParser.Parse(NdjsonLog)[2].Subsystem);

	[Theory]
	[InlineData(LogLevels.Warning)]
	[InlineData(LogLevels.Error)]
	public void ToPredicate_AsksForErrorsAndFaults(string level)
	{
		// Apple has no warning rung, so warning yields the next thing up rather than nothing.
		Assert.Equal("messageType == 16 OR messageType == 17", OsLogParser.ToPredicate(level));
	}

	[Fact]
	public void ToPredicate_LeavesQuietLevelsUnfiltered()
	{
		Assert.Null(OsLogParser.ToPredicate(LogLevels.Info));
		Assert.Null(OsLogParser.ToPredicate(null));
	}

	#endregion

	#region iOS crashes

	// The first line of an .ips file in ~/Library/Logs/DiagnosticReports, verbatim but trimmed.
	private const string SimulatedReportHeader =
		"""{"app_name":"Notes","timestamp":"2026-02-14 09:12:41.00 -0800","app_version":"2.1","bug_type":"309","bundleID":"com.example.notes","is_simulated":1,"name":"Notes"}""";

	[Fact]
	public void ParseReportHeader_ReadsTheSummary()
	{
		var report = OsLogParser.ParseReportHeader(SimulatedReportHeader, "Notes-2026-02-14.ips");

		Assert.NotNull(report);
		Assert.Equal("Notes", report.Name);
		Assert.Equal("com.example.notes", report.BundleId);
		Assert.Equal("Notes-2026-02-14.ips", report.Id);
		Assert.Equal("user fault", report.Kind);
	}

	[Fact]
	public void ParseReportHeader_RejectsHostCrashes()
	{
		// The same directory holds the developer's own Mac crashes. Returning those as device
		// crashes would be wrong, and would surface activity nobody asked about.
		Assert.Null(OsLogParser.ParseReportHeader(
			"""{"app_name":"dotnet","bug_type":"309","timestamp":"2026-02-14 09:12:41.00 -0800"}""",
			"dotnet-2026-02-14.ips"));
	}

	[Fact]
	public void ParseReportHeader_ReturnsNullForUnreadableInput()
	{
		Assert.Null(OsLogParser.ParseReportHeader("not json", "x.ips"));
		Assert.Null(OsLogParser.ParseReportHeader(null, "x.ips"));
	}

	#endregion
}
