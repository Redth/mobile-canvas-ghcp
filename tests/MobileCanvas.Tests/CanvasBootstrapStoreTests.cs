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

	[Fact]
	public void Exchange_IsBoundToTheGrantedProductSurface()
	{
		var store = new CanvasBootstrapStore();
		var windows = new CanvasContextKey("session", "instance", CanvasSurfaces.Windows);
		var secret = store.Create(windows);

		// The same panel identity on the mobile surface is a different credential entirely.
		Assert.Throws<UnauthorizedAccessException>(() => store.Exchange(new CanvasBootstrapRequest
		{
			Secret = secret,
			SessionId = windows.SessionId,
			InstanceId = windows.InstanceId,
			Surface = CanvasSurfaces.Mobile,
		}));

		Assert.True(store.TryGetSession(store.Exchange(Request(secret, windows)), out var actual));
		Assert.Equal(windows, actual);
		Assert.Equal(CanvasSurfaces.Windows, actual.Surface);
	}

	[Fact]
	public void Exchange_WithoutASurface_StaysMobile()
	{
		var store = new CanvasBootstrapStore();
		var key = new CanvasContextKey("session", "instance");
		var secret = store.Create(key);

		// The shape every shipped client sends: no surface field at all.
		var session = store.Exchange(new CanvasBootstrapRequest
		{
			Secret = secret,
			SessionId = key.SessionId,
			InstanceId = key.InstanceId,
			Surface = "",
		});

		Assert.True(store.TryGetSession(session, out var actual));
		Assert.Equal(CanvasSurfaces.Mobile, actual.Surface);
	}

	[Fact]
	public void OpeningOneSurface_LeavesTheOtherSurfaceSignedIn()
	{
		var store = new CanvasBootstrapStore();
		var mobile = new CanvasContextKey("session", "instance");
		var windows = new CanvasContextKey("session", "instance", CanvasSurfaces.Windows);
		var mobileSession = store.Exchange(Request(store.Create(mobile), mobile));

		var windowsSession = store.Exchange(Request(store.Create(windows), windows));

		Assert.True(store.TryGetSession(mobileSession, out var mobileKey));
		Assert.Equal(mobile, mobileKey);
		Assert.True(store.TryGetSession(windowsSession, out var windowsKey));
		Assert.Equal(windows, windowsKey);
	}

	[Fact]
	public void Detach_OnOneSurface_KeepsTheOtherSurfaceUsable()
	{
		var store = new CanvasBootstrapStore();
		var mobile = new CanvasContextKey("session", "instance");
		var windows = new CanvasContextKey("session", "instance", CanvasSurfaces.Windows);
		var mobileSession = store.Exchange(Request(store.Create(mobile), mobile));
		var windowsSession = store.Exchange(Request(store.Create(windows), windows));

		store.Detach(windows);

		Assert.False(store.TryGetSession(windowsSession, out _));
		Assert.True(store.TryGetSession(mobileSession, out _));
	}

	private static CanvasBootstrapRequest Request(string secret, CanvasContextKey key) => new()
	{
		Secret = secret,
		SessionId = key.SessionId,
		InstanceId = key.InstanceId,
		Surface = key.Surface,
	};
}
