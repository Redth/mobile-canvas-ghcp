using System.Security.Cryptography;
using MobileCanvas.Contracts;

namespace MobileCanvas.Tool;

internal sealed class CanvasBootstrapStore
{
	internal static readonly TimeSpan CredentialLifetime = TimeSpan.FromDays(30);

	private readonly object _gate = new();
	private readonly Dictionary<string, BootstrapGrant> _grants = [];
	private readonly Dictionary<string, BrowserSession> _sessions = [];

	/// <summary>
	/// Issues a bootstrap secret for one panel on one product surface. Replacing a panel's grant
	/// only retires credentials for that exact context: opening the desktop panel must not sign the
	/// mobile panel out of the same host.
	/// </summary>
	public string Create(CanvasContextKey key)
	{
		lock (_gate)
		{
			var now = DateTimeOffset.UtcNow;
			CleanupExpired(now);
			RemoveGrants(key);
			RemoveSessions(key);

			var secret = CreateSecret();
			_grants[secret] = new BootstrapGrant(key, now.Add(CredentialLifetime));
			return secret;
		}
	}

	public string Exchange(CanvasBootstrapRequest request)
	{
		lock (_gate)
		{
			var now = DateTimeOffset.UtcNow;
			CleanupExpired(now);
			var surface = CanvasSurfaces.Normalize(request.Surface);
			if (!_grants.TryGetValue(request.Secret, out var grant) ||
				!grant.Key.SessionId.Equals(request.SessionId, StringComparison.Ordinal) ||
				!grant.Key.InstanceId.Equals(request.InstanceId, StringComparison.Ordinal) ||
				!grant.Key.Surface.Equals(surface, StringComparison.Ordinal))
			{
				throw new UnauthorizedAccessException("The canvas bootstrap secret is invalid or expired.");
			}

			// Canvas renderers reload without invoking the provider's open callback. Keep the scoped
			// grant reusable, but rotate the browser session so only the newest renderer stays active.
			RemoveSessions(grant.Key);
			_grants[request.Secret] = grant with { ExpiresAt = now.Add(CredentialLifetime) };
			var session = CreateSecret();
			_sessions[session] = new BrowserSession(grant.Key, now.Add(CredentialLifetime));
			return session;
		}
	}

	public bool TryGetSession(string session, out CanvasContextKey key)
	{
		lock (_gate)
		{
			if (_sessions.TryGetValue(session, out var browserSession) &&
				browserSession.ExpiresAt >= DateTimeOffset.UtcNow)
			{
				key = browserSession.Key;
				return true;
			}

			_sessions.Remove(session);
			key = null!;
			return false;
		}
	}

	public void Close(CanvasContextKey key)
	{
		lock (_gate)
			RemoveSessions(key);
	}

	public void Detach(CanvasContextKey key)
	{
		lock (_gate)
		{
			RemoveSessions(key);
			RemoveGrants(key);
		}
	}

	private void CleanupExpired(DateTimeOffset now)
	{
		foreach (var grant in _grants
			.Where(pair => pair.Value.ExpiresAt < now)
			.Select(pair => pair.Key)
			.ToArray())
			_grants.Remove(grant);
		foreach (var session in _sessions
			.Where(pair => pair.Value.ExpiresAt < now)
			.Select(pair => pair.Key)
			.ToArray())
			_sessions.Remove(session);
	}

	private void RemoveGrants(CanvasContextKey key)
	{
		foreach (var grant in _grants
			.Where(pair => pair.Value.Key == key)
			.Select(pair => pair.Key)
			.ToArray())
			_grants.Remove(grant);
	}

	private void RemoveSessions(CanvasContextKey key)
	{
		foreach (var session in _sessions
			.Where(pair => pair.Value.Key == key)
			.Select(pair => pair.Key)
			.ToArray())
			_sessions.Remove(session);
	}

	private static string CreateSecret() =>
		Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

	private sealed record BootstrapGrant(CanvasContextKey Key, DateTimeOffset ExpiresAt);
	private sealed record BrowserSession(CanvasContextKey Key, DateTimeOffset ExpiresAt);
}
