using MobileCanvas.Android;

namespace MobileCanvas.Tests;

/// <summary>
/// Tests over verbatim <c>ls -lAL</c> output captured from a running emulator.
/// </summary>
public class LsParserTests
{
	// Captured from `adb shell run-as com.troublefreepool.poolmath ls -lAL .`
	private const string AppContainer = """
		total 48
		drwxrws--x 7 u0_a227 u0_a227_cache 4096 2026-07-28 17:30 cache
		drwxrws--x 2 u0_a227 u0_a227_cache 4096 2026-07-28 17:30 code_cache
		drwxrwx--x 2 u0_a227 u0_a227       4096 2026-07-28 17:30 databases
		drwxrwx--x 5 u0_a227 u0_a227       4096 2026-07-31 14:21 files
		drwxrwx--x 2 u0_a227 u0_a227       4096 2026-07-28 17:30 no_backup
		drwxrwx--x 2 u0_a227 u0_a227       4096 2026-07-28 17:30 shared_prefs
		""";

	[Fact]
	public void ReadsEveryEntryAndSkipsTheTotalHeader()
	{
		var files = LsParser.Parse(AppContainer, ".");

		Assert.Equal(6, files.Length);
		Assert.Equal(
			["cache", "code_cache", "databases", "files", "no_backup", "shared_prefs"],
			files.Select(file => file.Name));
		Assert.All(files, file => Assert.True(file.IsDirectory));
	}

	[Fact]
	public void JoinsPathsRelativeToTheAppContainer()
	{
		// run-as starts in the data directory, so "." is the root and must not leak into the path.
		var files = LsParser.Parse(AppContainer, ".");

		Assert.Equal("databases", files[2].Path);
		Assert.Equal("databases/notes.db", LsParser.Parse(
			"-rw-rw---- 1 u0_a227 u0_a227 40960 2026-07-31 14:21 notes.db",
			"databases")[0].Path);
	}

	[Fact]
	public void ReportsSizeForFilesAndZeroForDirectories()
	{
		var files = LsParser.Parse(
			"""
			-rw-rw---- 1 u0_a227 u0_a227 40960 2026-07-31 14:21 notes.db
			drwxrwx--x 2 u0_a227 u0_a227  4096 2026-07-28 17:30 databases
			-rw-rw---- 1 u0_a227 u0_a227     0 2026-07-31 14:21 empty.log
			""",
			"files");

		Assert.Equal(40960, files[0].Size);
		Assert.False(files[0].IsDirectory);

		// A directory's 4096 is its own inode, not the bytes underneath, so reporting it would mislead.
		Assert.Equal(0, files[1].Size);

		// An empty file is a real answer, distinct from a directory.
		Assert.Equal(0, files[2].Size);
		Assert.False(files[2].IsDirectory);
	}

	[Fact]
	public void KeepsSpacesInNames()
	{
		// Owner and group columns are not fixed width, so the name can only be everything past the time.
		var files = LsParser.Parse(
			"-rw-rw---- 1 media_rw ext_data_rw 1024 2026-07-31 14:21 My Holiday Photo.jpg",
			"/sdcard/DCIM");

		Assert.Equal("My Holiday Photo.jpg", Assert.Single(files).Name);
		Assert.Equal("/sdcard/DCIM/My Holiday Photo.jpg", files[0].Path);
	}

	[Fact]
	public void DropsTheTargetOfASymlinkItCouldNotFollow()
	{
		var file = Assert.Single(LsParser.Parse(
			"lrwxrwxrwx 1 root root 21 2026-07-25 00:19 sdcard -> /storage/self/primary",
			"/"));

		Assert.Equal("sdcard", file.Name);
		Assert.Equal("/sdcard", file.Path);
	}

	[Fact]
	public void IgnoresLinesThatAreNotEntries()
	{
		// run-as reports its refusal on stdout and still exits zero, so the parser is the last line of
		// defence against a refusal being read as a directory listing.
		Assert.Empty(LsParser.Parse(
			"""
			run-as: package not debuggable: com.example.release
			ls: /nope: No such file or directory
			""",
			"."));

		Assert.Empty(LsParser.Parse("", "."));
		Assert.Empty(LsParser.Parse(null, "."));
	}

	[Fact]
	public void ReadsSelinuxAndSecondPrecisionVariants()
	{
		// Toybox appends '+' or '.' for extended attributes, and some builds print seconds.
		var files = LsParser.Parse(
			"""
			drwxrws--x 5 media_rw media_rw 4096 2026-07-25 00:19:33 Android
			-rw-rw----+ 1 root root 8 2026-07-25 00:19 .nomedia
			""",
			"/sdcard");

		Assert.Equal(2, files.Length);
		Assert.Equal("2026-07-25 00:19:33", files[0].Modified);
		Assert.Equal(".nomedia", files[1].Name);
	}
}
