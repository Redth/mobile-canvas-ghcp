using MobileCanvas.Contracts;
using MobileCanvas.Tool;

namespace MobileCanvas.Tests;

public sealed class CanvasBootstrapStoreTests
{
	[Fact]
	public void Exchange_RotatesSessionAndKeepsGrantForRendererReload()
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

		var firstSession = store.Exchange(request);
		var secondSession = store.Exchange(request);

		Assert.NotEqual(firstSession, secondSession);
		Assert.False(store.TryGetSession(firstSession, out _));
		Assert.True(store.TryGetSession(secondSession, out var actual));
		Assert.Equal(key, actual);
	}

	[Fact]
	public void Exchange_IsBoundToCanvasContext()
	{
		var store = new CanvasBootstrapStore();
		var secret = store.Create(new CanvasContextKey("session", "instance"));

		Assert.Throws<UnauthorizedAccessException>(() => store.Exchange(new CanvasBootstrapRequest
		{
			Secret = secret,
			SessionId = "other-session",
			InstanceId = "instance",
		}));
	}

	[Fact]
	public void CreatingReplacementGrant_InvalidatesPriorCredentials()
	{
		var store = new CanvasBootstrapStore();
		var key = new CanvasContextKey("session", "instance");
		var firstSecret = store.Create(key);
		var firstSession = store.Exchange(Request(firstSecret, key));

		var secondSecret = store.Create(key);

		Assert.False(store.TryGetSession(firstSession, out _));
		Assert.Throws<UnauthorizedAccessException>(() => store.Exchange(Request(firstSecret, key)));
		Assert.True(store.TryGetSession(store.Exchange(Request(secondSecret, key)), out var actual));
		Assert.Equal(key, actual);
	}

	[Fact]
	public void Close_InvalidatesSessionButKeepsRendererReloadGrant()
	{
		var store = new CanvasBootstrapStore();
		var key = new CanvasContextKey("session", "instance");
		var secret = store.Create(key);
		var request = Request(secret, key);
		var firstSession = store.Exchange(request);

		store.Close(key);

		Assert.False(store.TryGetSession(firstSession, out _));
		Assert.True(store.TryGetSession(store.Exchange(request), out var actual));
		Assert.Equal(key, actual);
	}

	[Fact]
	public void Detach_InvalidatesGrantAndBrowserSession()
	{
		var store = new CanvasBootstrapStore();
		var key = new CanvasContextKey("session", "instance");
		var secret = store.Create(key);
		var request = Request(secret, key);
		var session = store.Exchange(request);

		store.Detach(key);

		Assert.False(store.TryGetSession(session, out _));
		Assert.Throws<UnauthorizedAccessException>(() => store.Exchange(request));
	}

	private static CanvasBootstrapRequest Request(string secret, CanvasContextKey key) => new()
	{
		Secret = secret,
		SessionId = key.SessionId,
		InstanceId = key.InstanceId,
	};
}
