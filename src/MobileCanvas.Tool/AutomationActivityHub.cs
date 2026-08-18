using System.Threading.Channels;
using MobileCanvas.Contracts;

namespace MobileCanvas.Tool;

/// <summary>
/// Broadcasts agent-driven input to canvas clients so the UI can show that something other than the
/// person at the keyboard is currently driving the device.
///
/// Only input authenticated with the control token is published. Canvas requests carry a session
/// cookie instead, so the human's own taps never trigger the overlay and the two origins cannot be
/// confused.
///
/// Delivery is partitioned by <see cref="CanvasContextKey"/>. An event addressed to one panel goes
/// to that panel alone: two canvases driving the same device no longer see each other's gestures,
/// and a panel on one product surface never sees another surface's activity at all. Input that
/// names no panel came from the bare CLI, which speaks for nobody, so it reaches every subscriber
/// on the surface it was issued against and each canvas decides for itself whether to draw it.
///
/// Publishing is fire-and-forget over bounded channels: a canvas that stops reading drops the
/// oldest event rather than applying backpressure to the input path. An input request must never
/// wait on a UI subscriber, because input latency is the whole point of the device lab.
/// </summary>
public sealed class AutomationActivityHub
{
	private readonly Lock gate = new();
	private readonly List<Subscription> subscriptions = [];

	public IDisposable Subscribe(CanvasContextKey key, out ChannelReader<AutomationEvent> reader)
	{
		ArgumentNullException.ThrowIfNull(key);

		// DropOldest keeps the cursor tracking the newest position when a client stalls; a backlog of
		// stale points would animate the cursor along a path the device has already left.
		var channel = Channel.CreateBounded<AutomationEvent>(
			new BoundedChannelOptions(64)
			{
				FullMode = BoundedChannelFullMode.DropOldest,
				SingleReader = true,
			});

		var subscription = new Subscription(this, key, channel);
		lock (gate)
		{
			subscriptions.Add(subscription);
		}

		reader = channel.Reader;
		return subscription;
	}

	/// <summary>Delivers an event to the one canvas context it was addressed to.</summary>
	public void Publish(CanvasContextKey key, AutomationEvent activity)
	{
		ArgumentNullException.ThrowIfNull(key);
		Deliver(
			subscription => subscription.Key == key,
			AutomationEventRedaction.ForSurface(key.Surface, activity));
	}

	/// <summary>
	/// Delivers an event that belongs to no panel to every canvas on one product surface. This is
	/// the bare-CLI path: nothing identified a canvas, so no canvas owns the event, and the surface
	/// boundary is the narrowest scope that still preserves the automation overlay.
	/// </summary>
	public void PublishToSurface(string surface, AutomationEvent activity)
	{
		var scope = CanvasSurfaces.Normalize(surface);
		Deliver(
			subscription => subscription.Key.Surface.Equals(scope, StringComparison.Ordinal),
			AutomationEventRedaction.ForSurface(scope, activity));
	}

	private void Deliver(Func<Subscription, bool> predicate, AutomationEvent activity)
	{
		lock (gate)
		{
			foreach (var subscription in subscriptions)
			{
				if (predicate(subscription))
					subscription.Channel.Writer.TryWrite(activity);
			}
		}
	}

	private void Remove(Subscription subscription)
	{
		lock (gate)
		{
			subscriptions.Remove(subscription);
		}

		subscription.Channel.Writer.TryComplete();
	}

	private sealed class Subscription(
		AutomationActivityHub hub,
		CanvasContextKey key,
		Channel<AutomationEvent, AutomationEvent> channel)
		: IDisposable
	{
		public CanvasContextKey Key { get; } = key;
		public Channel<AutomationEvent, AutomationEvent> Channel { get; } = channel;

		public void Dispose() => hub.Remove(this);
	}
}
