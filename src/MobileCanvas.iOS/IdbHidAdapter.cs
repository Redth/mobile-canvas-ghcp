using Idb;

namespace MobileCanvas.iOS;

internal static class IdbHidAdapter
{
	public static IReadOnlyList<HIDEvent> Convert(IEnumerable<IosHidEvent> events)
	{
		var result = new List<HIDEvent>();
		foreach (var hidEvent in events)
		{
			switch (hidEvent)
			{
				case IosHidTouch touch:
					result.Add(Touch(touch));
					break;
				case IosHidDelay delay:
					result.Add(new HIDEvent
					{
						Delay = new HIDEvent.Types.HIDDelay { Duration = delay.Duration },
					});
					break;
				case IosHidSwipe swipe:
					result.Add(new HIDEvent
					{
						Swipe = new HIDEvent.Types.HIDSwipe
						{
							Start = new Point { X = swipe.StartX, Y = swipe.StartY },
							End = new Point { X = swipe.EndX, Y = swipe.EndY },
							Duration = swipe.Duration,
						},
					});
					break;
				case IosHidKey key:
					result.Add(Key(key));
					break;
				case IosHidButtonPress button:
					var grpcButton = new HIDEvent.Types.HIDButton { Button = Convert(button.Button) };
					result.Add(Button(grpcButton, HIDEvent.Types.HIDDirection.Down));
					result.Add(Button(grpcButton, HIDEvent.Types.HIDDirection.Up));
					break;
				default:
					throw new ArgumentOutOfRangeException(
						nameof(events),
						hidEvent,
						"Unsupported iOS HID event.");
			}
		}
		return result;
	}

	private static HIDEvent Touch(IosHidTouch touch) => new()
	{
		Press = new HIDEvent.Types.HIDPress
		{
			Action = new HIDEvent.Types.HIDPressAction
			{
				Touch = new HIDEvent.Types.HIDTouch
				{
					Point = new Point { X = touch.X, Y = touch.Y },
				},
			},
			Direction = touch.Phase == IosHidTouchPhase.Up
				? HIDEvent.Types.HIDDirection.Up
				: HIDEvent.Types.HIDDirection.Down,
		},
	};

	private static HIDEvent Key(IosHidKey key) => new()
	{
		Press = new HIDEvent.Types.HIDPress
		{
			Action = new HIDEvent.Types.HIDPressAction
			{
				Key = new HIDEvent.Types.HIDKey { Keycode = key.Usage },
			},
			Direction = key.Direction == IosHidDirection.Down
				? HIDEvent.Types.HIDDirection.Down
				: HIDEvent.Types.HIDDirection.Up,
		},
	};

	private static HIDEvent.Types.HIDButtonType Convert(IosHidButton button) =>
		button switch
		{
			IosHidButton.Home => HIDEvent.Types.HIDButtonType.Home,
			IosHidButton.Lock => HIDEvent.Types.HIDButtonType.Lock,
			IosHidButton.SideButton => HIDEvent.Types.HIDButtonType.SideButton,
			IosHidButton.Siri => HIDEvent.Types.HIDButtonType.Siri,
			IosHidButton.ApplePay => HIDEvent.Types.HIDButtonType.ApplePay,
			_ => throw new ArgumentOutOfRangeException(nameof(button), button, "Unsupported iOS button."),
		};

	private static HIDEvent Button(
		HIDEvent.Types.HIDButton button,
		HIDEvent.Types.HIDDirection direction) => new()
	{
		Press = new HIDEvent.Types.HIDPress
		{
			Action = new HIDEvent.Types.HIDPressAction { Button = button },
			Direction = direction,
		},
	};
}
