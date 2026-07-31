using MobileCanvas.Android;
using MobileCanvas.Contracts;
using MobileCanvas.Core;

namespace MobileCanvas.Tests;

/// <summary>
/// Tests over the interrupt domain, against output captured verbatim from a live emulator.
/// </summary>
public class InterruptTests
{
	// Verbatim from `adb shell dumpsys telecom` while `gsm call 15551234567` was ringing. The same
	// call is listed twice -- once in the top-level list and again under "Ringing calls:" -- which is
	// the whole reason the parser dedupes. The number really does come back masked on a userdebug
	// build; that is not a redaction applied here.
	private const string RingingDump = """
		Elapsed 1ms
		mCallAudioManager:
		    All calls:
		    [Call id=TC@4, state=RINGING, tpac=ComponentInfo{com.android.phone/com.android.services.telephony.TelephonyConnectionService}, 1, UserHandle{0}, cmgr=ComponentInfo{com.android.phone/com.android.services.telephony.TelephonyConnectionService}, 1, UserHandle{0}, handle=tel:*********67, vidst=A, childs(0), has_parent(false), cap=[ sup_hld mut !v2a spd_aud], prop=[]], voip=false
		    Active dialing, or connecting call:
		    null
		    Ringing call:
		    [Call id=TC@4, state=RINGING, tpac=ComponentInfo{com.android.phone/com.android.services.telephony.TelephonyConnectionService}, 1, UserHandle{0}, cmgr=ComponentInfo{com.android.phone/com.android.services.telephony.TelephonyConnectionService}, 1, UserHandle{0}, handle=tel:*********67, vidst=A, childs(0), has_parent(false), cap=[ sup_hld mut !v2a spd_aud], prop=[]], voip=false
		    Foreground call:
		    null
		""";

	// The same call after `gsm accept`. Only the state and the capability list change.
	private const string ActiveDump = """
		    [Call id=TC@4, state=ACTIVE, tpac=ComponentInfo{com.android.phone/com.android.services.telephony.TelephonyConnectionService}, 1, UserHandle{0}, cmgr=ComponentInfo{com.android.phone/com.android.services.telephony.TelephonyConnectionService}, 1, UserHandle{0}, handle=tel:*********67, vidst=A, childs(0), has_parent(false), cap=[ hld sup_hld mut !v2a spd_aud], prop=[]], voip=false
		""";

	// After `gsm cancel`. telecom still answers, at length -- it just has no calls in it. An empty
	// list and a failed command have to be told apart, since both would otherwise read as "no calls".
	private const string NoCallsDump = """
		Elapsed 1ms
		mCallAudioManager:
		    All calls:
		    Active dialing, or connecting call:
		    null
		    Ringing call:
		    null
		""";

	[Fact]
	public void ReadsARingingCall()
	{
		var calls = TelecomCallParser.Parse(RingingDump);

		var call = Assert.Single(calls);
		Assert.Equal("RINGING", call.State);
		Assert.Equal("*********67", call.Number);
	}

	[Fact]
	public void ReportsACallOnceEvenThoughTelecomListsItTwice()
	{
		// Guards the dedupe: without it a single ringing call reads as two, and an agent deciding
		// whether the device is busy would get the wrong answer.
		Assert.Single(TelecomCallParser.Parse(RingingDump));
	}

	[Fact]
	public void ReadsAnAnsweredCall()
	{
		var call = Assert.Single(TelecomCallParser.Parse(ActiveDump));

		Assert.Equal("ACTIVE", call.State);
	}

	[Fact]
	public void ReadsNoCallsFromADumpThatHasNone()
	{
		Assert.Empty(TelecomCallParser.Parse(NoCallsDump));
	}

	[Theory]
	[InlineData(null)]
	[InlineData("")]
	[InlineData("   ")]
	public void ReadsNoCallsFromNothing(string? dump)
	{
		Assert.Empty(TelecomCallParser.Parse(dump));
	}

	[Theory]
	[InlineData("place")]
	[InlineData("PLACE")]
	[InlineData("  accept  ")]
	[InlineData("Hold")]
	[InlineData("cancel")]
	public void AcceptsTheCallActionsInAnyCasing(string action)
	{
		Assert.Contains(
			AndroidEmulatorBackend.NormalizeCallAction(action),
			CallActions.All);
	}

	[Fact]
	public void RefusesAnUnknownCallActionAndNamesTheOnesItTakes()
	{
		var error = Assert.Throws<DeviceCapabilityException>(
			() => AndroidEmulatorBackend.NormalizeCallAction("answer"));

		// "answer" is the word a person reaches for, so the message has to point at "accept".
		Assert.Contains("accept", error.Message, StringComparison.Ordinal);
	}

	[Theory]
	[InlineData("match")]
	[InlineData("NoMatch")]
	[InlineData("  nomatch ")]
	public void AcceptsTheBiometricActionsInAnyCasing(string action)
	{
		Assert.Contains(
			AndroidEmulatorBackend.NormalizeBiometricAction(action),
			BiometricActions.All);
	}

	[Fact]
	public void RefusesAnUnknownBiometricAction()
	{
		Assert.Throws<DeviceCapabilityException>(
			() => AndroidEmulatorBackend.NormalizeBiometricAction("fail"));
	}

	[Fact]
	public void RefusesAMediaPathThatIsNotThere()
	{
		// simctl's own failure here is an uncaught exception and a signal, so the path has to be
		// checked before the command runs rather than after it dies.
		var missing = Path.Combine(Path.GetTempPath(), $"mobile-canvas-{Guid.NewGuid():N}.png");

		var error = Assert.Throws<DeviceCapabilityException>(
			() => AndroidEmulatorBackend.RequireMediaPaths(new MediaRequest { HostPaths = [missing] }));

		Assert.Contains(missing, error.Message, StringComparison.Ordinal);
	}

	[Fact]
	public void RefusesAnEmptyMediaRequest()
	{
		Assert.Throws<DeviceCapabilityException>(
			() => AndroidEmulatorBackend.RequireMediaPaths(new MediaRequest { HostPaths = [] }));
	}

	// Verbatim from `adb shell dumpsys telephony.registry` with 15559998888 ringing. This is the one
	// place the unmasked number appears -- telecom, telephony and phone were all searched for it.
	private const string RegistryDump = """
		    mPreciseCallState=Ringing call state: 5, Foreground call state: 0, Background call state: 0
		    mCallDisconnectCause=2
		    mCallIncomingNumber=15559998888
		    mVoiceActivationState= 0
		""";

	[Fact]
	public void ReadsTheUnmaskedNumberFromTheRegistry()
	{
		Assert.Equal("15559998888", TelecomCallParser.ReadIncomingNumber(RegistryDump));
	}

	[Fact]
	public void ReadsNoNumberFromARegistryWithoutOne()
	{
		Assert.Null(TelecomCallParser.ReadIncomingNumber("mCallDisconnectCause=2"));
	}

	[Fact]
	public void ReplacesAMaskedNumberWithTheRealOne()
	{
		// The masked form is useless twice over: unreadable, and rejected by `gsm accept` as a bad
		// phone number, which is what made a hold or cancel fail.
		var calls = TelecomCallParser.Parse(ActiveDump);

		var unmasked = Assert.Single(TelecomCallParser.Unmask(calls, "15551234567"));

		Assert.Equal("15551234567", unmasked.Number);
	}

	[Fact]
	public void KeepsTheMaskedNumberWhenTheRealOneIsADifferentCall()
	{
		// The visible tail is the only evidence the two dumps describe the same call. Without this
		// check a stale registry entry would put someone else's number on the call in progress.
		var calls = TelecomCallParser.Parse(ActiveDump);

		var call = Assert.Single(TelecomCallParser.Unmask(calls, "15550009999"));

		Assert.Equal("*********67", call.Number);
	}

	[Fact]
	public void KeepsTheNumberWhenThereIsNoRegistryReading()
	{
		var calls = TelecomCallParser.Parse(ActiveDump);

		Assert.Equal("*********67", Assert.Single(TelecomCallParser.Unmask(calls, null)).Number);
	}

	[Fact]
	public void ResolvesMediaPathsToAbsoluteOnes()
	{
		var file = Path.Combine(Path.GetTempPath(), $"mobile-canvas-{Guid.NewGuid():N}.png");
		File.WriteAllBytes(file, [0x89, 0x50, 0x4E, 0x47]);
		try
		{
			var resolved = Assert.Single(
				AndroidEmulatorBackend.RequireMediaPaths(new MediaRequest { HostPaths = [file] }));

			Assert.True(Path.IsPathRooted(resolved));
		}
		finally
		{
			File.Delete(file);
		}
	}

	[Fact]
	public void KeepsMediaNameWhenNothingElseUsesIt()
	{
		var taken = new HashSet<string>(StringComparer.Ordinal) { "other.png" };

		Assert.Equal("photo.png", AndroidEmulatorBackend.UniqueMediaName("photo.png", taken));
	}

	[Fact]
	public void RenamesMediaAroundNamesAlreadyTaken()
	{
		var taken = new HashSet<string>(StringComparer.Ordinal) { "photo.png", "photo-1.png" };

		Assert.Equal("photo-2.png", AndroidEmulatorBackend.UniqueMediaName("photo.png", taken));
	}

	[Fact]
	public void ReadsPathsFromContentQueryRows()
	{
		const string rows = """
			Row: 0 _data=/storage/emulated/0/Pictures/one.png
			Row: 1 _data=/storage/emulated/0/Pictures/two.jpg
			""";

		Assert.Equal(
			["/storage/emulated/0/Pictures/one.png", "/storage/emulated/0/Pictures/two.jpg"],
			AndroidEmulatorBackend.ReadQueriedPaths(rows));
	}

	[Fact]
	public void ReadsNoPathsWhenMediaStoreHasNoRows()
	{
		Assert.Empty(AndroidEmulatorBackend.ReadQueriedPaths("No result found."));
	}
}
