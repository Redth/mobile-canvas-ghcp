using System.Threading.Channels;
using MobileCanvas.Contracts;
using MobileCanvas.Tool;

namespace MobileCanvas.Tests;

public sealed class AutomationActivityHubTests
{
	private static readonly CanvasContextKey PanelA = new("session", "panel-a");
	private static readonly CanvasContextKey PanelB = new("session", "panel-b");
	private static readonly CanvasContextKey WindowsPanel =
		new("session", "panel-a", CanvasSurfaces.Windows);

	[Fact]
	public void Publish_ReachesTheAddressedPanelOnly()
	{
		var hub = new AutomationActivityHub();
		using var first = hub.Subscribe(PanelA, out var readerA);
		using var second = hub.Subscribe(PanelB, out var readerB);

		hub.Publish(PanelA, Tap("ios:one"));

		Assert.Equal("ios:one", Read(readerA).DeviceId);
		Assert.False(readerB.TryRead(out _));
	}

	[Fact]
	public void Publish_DoesNotCrossProductSurfaces()
	{
		var hub = new AutomationActivityHub();
		using var mobile = hub.Subscribe(PanelA, out var mobileReader);
		using var windows = hub.Subscribe(WindowsPanel, out var windowsReader);

		hub.Publish(WindowsPanel, Tap("windows:app"));

		Assert.Equal("windows:app", Read(windowsReader).DeviceId);
		Assert.False(mobileReader.TryRead(out _));
	}

	[Fact]
	public void Publish_ReachesEverySocketOfTheSamePanel()
	{
		var hub = new AutomationActivityHub();
		using var first = hub.Subscribe(PanelA, out var firstReader);
		using var second = hub.Subscribe(PanelA, out var secondReader);

		hub.Publish(PanelA, Tap("ios:one"));

		Assert.Equal("ios:one", Read(firstReader).DeviceId);
		Assert.Equal("ios:one", Read(secondReader).DeviceId);
	}

	[Fact]
	public void PublishToSurface_ReachesEveryPanelOnThatSurfaceOnly()
	{
		var hub = new AutomationActivityHub();
		using var first = hub.Subscribe(PanelA, out var readerA);
		using var second = hub.Subscribe(PanelB, out var readerB);
		using var windows = hub.Subscribe(WindowsPanel, out var windowsReader);

		hub.PublishToSurface(CanvasSurfaces.Mobile, Tap("ios:one"));

		Assert.Equal("ios:one", Read(readerA).DeviceId);
		Assert.Equal("ios:one", Read(readerB).DeviceId);
		Assert.False(windowsReader.TryRead(out _));
	}

	[Fact]
	public void Publish_KeepsTypedTextForMobilePanels()
	{
		var hub = new AutomationActivityHub();
		using var subscription = hub.Subscribe(PanelA, out var reader);

		hub.Publish(PanelA, new AutomationEvent
		{
			Kind = AutomationEventKinds.Text,
			DeviceId = "ios:one",
			Detail = "hello",
		});

		var activity = Read(reader);
		Assert.Equal("hello", activity.Detail);
		Assert.Null(activity.CharacterCount);
	}

	[Fact]
	public void Publish_RedactsTypedTextForOtherSurfaces()
	{
		var hub = new AutomationActivityHub();
		using var subscription = hub.Subscribe(WindowsPanel, out var reader);

		hub.Publish(WindowsPanel, new AutomationEvent
		{
			Kind = AutomationEventKinds.Text,
			DeviceId = "windows:app",
			Detail = "s3cret",
		});

		var activity = Read(reader);
		Assert.Null(activity.Detail);
		Assert.Equal(6, activity.CharacterCount);
	}

	[Fact]
	public void Dispose_StopsDeliveryAndCompletesTheChannel()
	{
		var hub = new AutomationActivityHub();
		var subscription = hub.Subscribe(PanelA, out var reader);

		subscription.Dispose();
		hub.Publish(PanelA, Tap("ios:one"));

		Assert.False(reader.TryRead(out _));
		Assert.True(reader.Completion.IsCompleted);
	}

	private static AutomationEvent Tap(string deviceId) => new()
	{
		Kind = AutomationEventKinds.Tap,
		DeviceId = deviceId,
		X = 10,
		Y = 20,
	};

	private static AutomationEvent Read(ChannelReader<AutomationEvent> reader)
	{
		Assert.True(reader.TryRead(out var activity));
		return activity!;
	}
}
