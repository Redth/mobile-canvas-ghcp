using Idb;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

public sealed class IosHidEventsTests
{
	[Fact]
	public void Tap_PreservesOptionalHoldDuration()
	{
		Assert.Collection(
			IosHidEvents.CreateTap(10, 20, 0.5),
			item => Assert.Equal(new IosHidTouch(10, 20, IosHidTouchPhase.Down), item),
			item => Assert.Equal(new IosHidDelay(0.5), item),
			item => Assert.Equal(new IosHidTouch(10, 20, IosHidTouchPhase.Up), item));
	}

	[Fact]
	public void Text_MapsAsciiAndRejectsUnicode()
	{
		Assert.True(IosHidEvents.TryCreateTextEvents("A!", out var events));
		Assert.Collection(
			events,
			item => Assert.Equal(new IosHidKey(225, IosHidDirection.Down), item),
			item => Assert.Equal(new IosHidKey(4, IosHidDirection.Down), item),
			item => Assert.Equal(new IosHidKey(4, IosHidDirection.Up), item),
			item => Assert.Equal(new IosHidKey(225, IosHidDirection.Up), item),
			item => Assert.Equal(new IosHidKey(225, IosHidDirection.Down), item),
			item => Assert.Equal(new IosHidKey(30, IosHidDirection.Down), item),
			item => Assert.Equal(new IosHidKey(30, IosHidDirection.Up), item),
			item => Assert.Equal(new IosHidKey(225, IosHidDirection.Up), item));

		Assert.False(IosHidEvents.TryCreateTextEvents("café", out var unicode));
		Assert.Empty(unicode);
	}

	[Fact]
	public void Text_EmptyInputProducesNoEvents()
	{
		Assert.True(IosHidEvents.TryCreateTextEvents("", out var events));
		Assert.Empty(events);
	}

	[Fact]
	public void IdbAdapter_RetainsServerSideSwipe()
	{
		var converted = IdbHidAdapter.Convert(
		[new IosHidSwipe(1, 2, 3, 4, 0.75)]);

		var swipe = Assert.Single(converted).Swipe;
		Assert.Equal(1, swipe.Start.X);
		Assert.Equal(2, swipe.Start.Y);
		Assert.Equal(3, swipe.End.X);
		Assert.Equal(4, swipe.End.Y);
		Assert.Equal(0.75, swipe.Duration);
	}

	[Fact]
	public void IdbAdapter_MapsMoveToRepeatedIndigoDown()
	{
		var converted = IdbHidAdapter.Convert(
		[new IosHidTouch(10, 20, IosHidTouchPhase.Move)]);

		var press = Assert.Single(converted).Press;
		Assert.Equal(HIDEvent.Types.HIDDirection.Down, press.Direction);
		Assert.Equal(10, press.Action.Touch.Point.X);
		Assert.Equal(20, press.Action.Touch.Point.Y);
	}

	[Fact]
	public void IdbAdapter_ExpandsButtonPress()
	{
		var converted = IdbHidAdapter.Convert(
		[new IosHidButtonPress(IosHidButton.ApplePay)]);

		Assert.Collection(
			converted,
			down =>
			{
				Assert.Equal(HIDEvent.Types.HIDDirection.Down, down.Press.Direction);
				Assert.Equal(HIDEvent.Types.HIDButtonType.ApplePay, down.Press.Action.Button.Button);
			},
			up =>
			{
				Assert.Equal(HIDEvent.Types.HIDDirection.Up, up.Press.Direction);
				Assert.Equal(HIDEvent.Types.HIDButtonType.ApplePay, up.Press.Action.Button.Button);
			});
	}

	[Fact]
	public void Paste_UsesCommandV()
	{
		Assert.Equal(
			[
				new IosHidKey(227, IosHidDirection.Down),
				new IosHidKey(25, IosHidDirection.Down),
				new IosHidKey(25, IosHidDirection.Up),
				new IosHidKey(227, IosHidDirection.Up),
			],
			IosHidEvents.CreatePasteEvents());
	}
}
