using Idb;

namespace MobileCanvas.iOS;

internal static class IdbKeyboard
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

	public static bool TryCreateTextEvents(string text, out IReadOnlyList<HIDEvent> events)
	{
		var result = new List<HIDEvent>(text.Length * 4);
		foreach (var character in text)
		{
			if (!TryGetKey(character, out var keyCode, out var shift))
			{
				events = [];
				return false;
			}

			if (shift)
				result.Add(KeyEvent(LeftShift, HIDEvent.Types.HIDDirection.Down));
			result.Add(KeyEvent(keyCode, HIDEvent.Types.HIDDirection.Down));
			result.Add(KeyEvent(keyCode, HIDEvent.Types.HIDDirection.Up));
			if (shift)
				result.Add(KeyEvent(LeftShift, HIDEvent.Types.HIDDirection.Up));
		}

		events = result;
		return true;
	}

	public static IReadOnlyList<HIDEvent> CreatePasteEvents() =>
	[
		KeyEvent(LeftCommand, HIDEvent.Types.HIDDirection.Down),
		KeyEvent(25, HIDEvent.Types.HIDDirection.Down),
		KeyEvent(25, HIDEvent.Types.HIDDirection.Up),
		KeyEvent(LeftCommand, HIDEvent.Types.HIDDirection.Up),
	];

	public static IReadOnlyList<HIDEvent> CreateKeyPress(ulong keyCode) =>
	[
		KeyEvent(keyCode, HIDEvent.Types.HIDDirection.Down),
		KeyEvent(keyCode, HIDEvent.Types.HIDDirection.Up),
	];

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

	private static HIDEvent KeyEvent(ulong keyCode, HIDEvent.Types.HIDDirection direction) => new()
	{
		Press = new HIDEvent.Types.HIDPress
		{
			Action = new HIDEvent.Types.HIDPressAction
			{
				Key = new HIDEvent.Types.HIDKey { Keycode = keyCode },
			},
			Direction = direction,
		},
	};
}
