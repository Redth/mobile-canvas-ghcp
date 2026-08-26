using MobileCanvas.Contracts;

namespace MobileCanvas.iOS;

internal abstract record IosHidEvent;

internal enum IosHidTouchPhase
{
	Down,
	Move,
	Up,
}

internal enum IosHidDirection
{
	Down,
	Up,
}

internal enum IosHidButton
{
	Home,
	Lock,
	SideButton,
	Siri,
	ApplePay,
}

internal sealed record IosHidTouch(double X, double Y, IosHidTouchPhase Phase) : IosHidEvent;

internal sealed record IosHidDelay(double Duration) : IosHidEvent;

internal sealed record IosHidSwipe(
	double StartX,
	double StartY,
	double EndX,
	double EndY,
	double Duration) : IosHidEvent;

internal sealed record IosHidKey(ulong Usage, IosHidDirection Direction) : IosHidEvent;

internal sealed record IosHidButtonPress(IosHidButton Button) : IosHidEvent;

internal static class IosHidEvents
{
	private const ulong LeftShift = 225;
	private const ulong LeftCommand = 227;

	private static readonly IReadOnlyDictionary<char, (ulong KeyCode, bool Shift)> Punctuation =
		new Dictionary<char, (ulong, bool)>
		{
			['\n'] = (40, false),
			[' '] = (44, false),
			['-'] = (45, false),
			['='] = (46, false),
			['['] = (47, false),
			[']'] = (48, false),
			['\\'] = (49, false),
			[';'] = (51, false),
			['\''] = (52, false),
			['`'] = (53, false),
			[','] = (54, false),
			['.'] = (55, false),
			['/'] = (56, false),
			['_'] = (45, true),
			['+'] = (46, true),
			['{'] = (47, true),
			['}'] = (48, true),
			['|'] = (49, true),
			[':'] = (51, true),
			['"'] = (52, true),
			['~'] = (53, true),
			['<'] = (54, true),
			['>'] = (55, true),
			['?'] = (56, true),
			['!'] = (30, true),
			['@'] = (31, true),
			['#'] = (32, true),
			['$'] = (33, true),
			['%'] = (34, true),
			['^'] = (35, true),
			['&'] = (36, true),
			['*'] = (37, true),
			['('] = (38, true),
			[')'] = (39, true),
		};

	public static IReadOnlyList<IosHidEvent> CreateTap(double x, double y, double duration)
	{
		var result = new List<IosHidEvent>(duration > 0 ? 3 : 2)
		{
			new IosHidTouch(x, y, IosHidTouchPhase.Down),
		};
		if (duration > 0)
			result.Add(new IosHidDelay(duration));
		result.Add(new IosHidTouch(x, y, IosHidTouchPhase.Up));
		return result;
	}

	public static IosHidTouch CreateTouch(double x, double y, string phase)
	{
		var parsed = phase.ToLowerInvariant() switch
		{
			TouchPhases.Down => IosHidTouchPhase.Down,
			TouchPhases.Move => IosHidTouchPhase.Move,
			TouchPhases.Up => IosHidTouchPhase.Up,
			_ => throw new ArgumentException("Phase must be down, move, or up.", nameof(phase)),
		};
		return new IosHidTouch(x, y, parsed);
	}

	public static IosHidSwipe CreateSwipe(
		double startX,
		double startY,
		double endX,
		double endY,
		double duration) =>
		new(startX, startY, endX, endY, duration);

	public static bool TryCreateTextEvents(string text, out IReadOnlyList<IosHidEvent> events)
	{
		var result = new List<IosHidEvent>(text.Length * 4);
		foreach (var character in text)
		{
			if (!TryGetKey(character, out var keyCode, out var shift))
			{
				events = [];
				return false;
			}

			if (shift)
				result.Add(new IosHidKey(LeftShift, IosHidDirection.Down));
			result.Add(new IosHidKey(keyCode, IosHidDirection.Down));
			result.Add(new IosHidKey(keyCode, IosHidDirection.Up));
			if (shift)
				result.Add(new IosHidKey(LeftShift, IosHidDirection.Up));
		}

		events = result;
		return true;
	}

	public static IReadOnlyList<IosHidEvent> CreatePasteEvents() =>
	[
		new IosHidKey(LeftCommand, IosHidDirection.Down),
		new IosHidKey(25, IosHidDirection.Down),
		new IosHidKey(25, IosHidDirection.Up),
		new IosHidKey(LeftCommand, IosHidDirection.Up),
	];

	public static IReadOnlyList<IosHidEvent> CreateKeyPress(ulong keyCode) =>
	[
		new IosHidKey(keyCode, IosHidDirection.Down),
		new IosHidKey(keyCode, IosHidDirection.Up),
	];

	public static IosHidButtonPress CreateButtonPress(string button) =>
		new(button.ToLowerInvariant() switch
		{
			"home" => IosHidButton.Home,
			"lock" => IosHidButton.Lock,
			"side" or "side-button" => IosHidButton.SideButton,
			"siri" => IosHidButton.Siri,
			"apple-pay" => IosHidButton.ApplePay,
			_ => throw new ArgumentException(
				"Button must be home, lock, side-button, siri, or apple-pay.",
				nameof(button)),
		});

	private static bool TryGetKey(char character, out ulong keyCode, out bool shift)
	{
		if (character is >= 'a' and <= 'z')
		{
			keyCode = (ulong)(4 + character - 'a');
			shift = false;
			return true;
		}

		if (character is >= 'A' and <= 'Z')
		{
			keyCode = (ulong)(4 + character - 'A');
			shift = true;
			return true;
		}

		if (character is >= '1' and <= '9')
		{
			keyCode = (ulong)(30 + character - '1');
			shift = false;
			return true;
		}

		if (character == '0')
		{
			keyCode = 39;
			shift = false;
			return true;
		}

		if (Punctuation.TryGetValue(character, out var mapped))
		{
			(keyCode, shift) = mapped;
			return true;
		}

		keyCode = 0;
		shift = false;
		return false;
	}
}
