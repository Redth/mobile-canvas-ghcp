using System.Text.RegularExpressions;
using MobileCanvas.Contracts;

namespace MobileCanvas.Android;

/// <summary>
/// Reads the calls out of <c>dumpsys telecom</c>.
/// </summary>
/// <remarks>
/// The emulator console has a <c>gsm list</c> verb that looks like the obvious source, but it answers
/// a bare <c>OK</c> with no calls listed even while one is ringing -- so it reports an established
/// call and no call identically. telecom is the one that actually knows.
/// </remarks>
public static partial class TelecomCallParser
{
	[GeneratedRegex(
		@"Call id=(?<id>[^,]+),\s*state=(?<state>[A-Z_]+)",
		RegexOptions.ExplicitCapture)]
	private static partial Regex CallPattern { get; }

	[GeneratedRegex(@"handle=tel:(?<number>[^,\]]+)", RegexOptions.ExplicitCapture)]
	private static partial Regex HandlePattern { get; }

	[GeneratedRegex(@"mCallIncomingNumber\s*=\s*(?<number>\+?\d+)", RegexOptions.ExplicitCapture)]
	private static partial Regex IncomingNumberPattern { get; }

	/// <summary>
	/// Reads the unmasked number out of <c>dumpsys telephony.registry</c>.
	/// </summary>
	/// <remarks>
	/// telecom masks the number it reports, and the emulator console needs the real digits to name a
	/// call -- feeding the masked form back gets "bad phone number format". The registry keeps one
	/// unmasked number for the call in progress.
	/// </remarks>
	public static string? ReadIncomingNumber(string? registryDump)
	{
		if (string.IsNullOrWhiteSpace(registryDump))
			return null;

		var match = IncomingNumberPattern.Match(registryDump);
		return match.Success ? match.Groups["number"].Value : null;
	}

	/// <summary>
	/// Replaces a masked number with the unmasked one, when they are demonstrably the same call.
	/// </summary>
	/// <remarks>
	/// telecom masks all but the last few digits, so the visible tail is the evidence. Substituting
	/// without checking it would put an unrelated number on a call whenever the two dumps disagree.
	/// </remarks>
	public static IReadOnlyList<PhoneCall> Unmask(IReadOnlyList<PhoneCall> calls, string? unmasked)
	{
		if (string.IsNullOrEmpty(unmasked) || calls.Count == 0)
			return calls;

		var updated = new List<PhoneCall>(calls.Count);
		foreach (var call in calls)
		{
			var tail = call.Number.TrimStart('*');
			var matches = call.Number.Contains('*')
				&& tail.Length > 0
				&& unmasked.EndsWith(tail, StringComparison.Ordinal);

			updated.Add(matches ? call with { Number = unmasked } : call);
		}

		return updated;
	}

	public static IReadOnlyList<PhoneCall> Parse(string? dump)
	{
		if (string.IsNullOrWhiteSpace(dump))
			return [];

		// Every call appears several times over -- once in the top-level list and again under whichever
		// of "Ringing calls:" / "Holding calls:" it belongs to -- so the same call would otherwise be
		// reported two or three times.
		var seen = new HashSet<string>(StringComparer.Ordinal);
		var calls = new List<PhoneCall>();

		foreach (var line in dump.Split('\n'))
		{
			var match = CallPattern.Match(line);
			if (!match.Success)
				continue;

			var id = match.Groups["id"].Value.Trim();
			if (!seen.Add(id))
				continue;

			var handle = HandlePattern.Match(line);

			calls.Add(new PhoneCall
			{
				// telecom masks all but the last digits on a userdebug build. It is passed through as
				// written here; the caller unmasks it from the registry, which has the real number.
				Number = handle.Success ? handle.Groups["number"].Value.Trim() : "",
				State = match.Groups["state"].Value.Trim(),
			});
		}

		return calls;
	}
}
