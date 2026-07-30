using System.Collections.Concurrent;
using System.Security.Cryptography;
using MobileCanvas.Contracts;

namespace MobileCanvas.Tool;

internal sealed class CanvasBootstrapStore
{
	private readonly ConcurrentDictionary<string, BootstrapGrant> _grants = new();
	private readonly ConcurrentDictionary<string, CanvasContextKey> _sessions = new();

	public string Create(CanvasContextKey key)
	{
		CleanupExpired();
		var secret = CreateSecret();
		_grants[secret] = new BootstrapGrant(key, DateTimeOffset.UtcNow.AddMinutes(1));
		return secret;
	}

	public string Exchange(CanvasBootstrapRequest request)
	{
		if (!_grants.TryRemove(request.Secret, out var grant) ||
			grant.ExpiresAt < DateTimeOffset.UtcNow ||
			!grant.Key.SessionId.Equals(request.SessionId, StringComparison.Ordinal) ||
			!grant.Key.InstanceId.Equals(request.InstanceId, StringComparison.Ordinal))
		{
			throw new UnauthorizedAccessException("The canvas bootstrap secret is invalid or expired.");
		}

		var session = CreateSecret();
		_sessions[session] = grant.Key;
		return session;
	}

	public bool TryGetSession(string session, out CanvasContextKey key) =>
		_sessions.TryGetValue(session, out key!);

	public void Detach(CanvasContextKey key)
	{
		foreach (var session in _sessions.Where(pair => pair.Value == key).Select(pair => pair.Key))
			_sessions.TryRemove(session, out _);
		foreach (var grant in _grants.Where(pair => pair.Value.Key == key).Select(pair => pair.Key))
			_grants.TryRemove(grant, out _);
	}

	private void CleanupExpired()
	{
		var now = DateTimeOffset.UtcNow;
		foreach (var grant in _grants.Where(pair => pair.Value.ExpiresAt < now).Select(pair => pair.Key))
			_grants.TryRemove(grant, out _);
	}

	private static string CreateSecret() =>
		Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();

	private sealed record BootstrapGrant(CanvasContextKey Key, DateTimeOffset ExpiresAt);
}
