using MobileCanvas.Contracts;
using MobileCanvas.Tool;

namespace MobileCanvas.Tests;

public sealed class CanvasBootstrapStoreTests
{
	[Fact]
	public void Exchange_IsOneTimeAndBoundToCanvasContext()
	{
		var store = new CanvasBootstrapStore();
		var key = new CanvasContextKey("session", "instance");
		var secret = store.Create(key);
		var request = new CanvasBootstrapRequest
		{
			Secret = secret,
			SessionId = key.SessionId,
			InstanceId = key.InstanceId,
		};

		var session = store.Exchange(request);

		Assert.True(store.TryGetSession(session, out var actual));
		Assert.Equal(key, actual);
		Assert.Throws<UnauthorizedAccessException>(() => store.Exchange(request));
	}

	[Fact]
	public void Detach_InvalidatesBrowserSession()
	{
		var store = new CanvasBootstrapStore();
		var key = new CanvasContextKey("session", "instance");
		var session = store.Exchange(new CanvasBootstrapRequest
		{
			Secret = store.Create(key),
			SessionId = key.SessionId,
			InstanceId = key.InstanceId,
		});

		store.Detach(key);

		Assert.False(store.TryGetSession(session, out _));
	}
}
