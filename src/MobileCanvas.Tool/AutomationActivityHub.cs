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
/// Publishing is fire-and-forget over bounded channels: a canvas that stops reading drops the
/// oldest event rather than applying backpressure to the input path. An input request must never
/// wait on a UI subscriber, because input latency is the whole point of the device lab.
/// </summary>
public sealed class AutomationActivityHub
{
	private readonly Lock gate = new();
	private readonly List<Subscription> subscriptions = [];

	public IDisposable Subscribe(out ChannelReader<AutomationEvent> reader)
	{
		// DropOldest keeps the cursor tracking the newest position when a client stalls; a backlog of
		// stale points would animate the cursor along a path the device has already left.
		var channel = Channel.CreateBounded<AutomationEvent>(
			new BoundedChannelOptions(64)
			{
				FullMode = BoundedChannelFullMode.DropOldest,
				SingleReader = true,
			});

		var subscription = new Subscription(this, channel);
		lock (gate)
		{
			subscriptions.Add(subscription);
		}

		reader = channel.Reader;
		return subscription;
	}

	public void Publish(AutomationEvent activity)
	{
		lock (gate)
		{
			foreach (var subscription in subscriptions)
			{
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

	private sealed class Subscription(AutomationActivityHub hub, Channel<AutomationEvent, AutomationEvent> channel)
		: IDisposable
	{
		public Channel<AutomationEvent, AutomationEvent> Channel { get; } = channel;

		public void Dispose() => hub.Remove(this);
	}
}
