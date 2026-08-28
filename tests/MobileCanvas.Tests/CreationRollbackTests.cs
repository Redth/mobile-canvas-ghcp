using MobileCanvas.Core;

namespace MobileCanvas.Tests;

public sealed class CreationRollbackTests
{
	[Fact]
	public async Task ResolveAsync_DoesNotRollbackWhenResolutionSucceeds()
	{
		var rolledBack = false;

		var result = await CreationRollback.ResolveAsync(
			_ => Task.FromResult("resolved"),
			_ =>
			{
				rolledBack = true;
				return Task.CompletedTask;
			},
			"test resource");

		Assert.Equal("resolved", result);
		Assert.False(rolledBack);
	}

	[Fact]
	public async Task ResolveAsync_RollsBackAndPreservesTheResolutionFailure()
	{
		var expected = new InvalidOperationException("lookup failed");
		var rolledBack = false;

		var actual = await Assert.ThrowsAsync<InvalidOperationException>(() =>
			CreationRollback.ResolveAsync<string>(
				_ => Task.FromException<string>(expected),
				_ =>
				{
					rolledBack = true;
					return Task.CompletedTask;
				},
				"test resource"));

		Assert.Same(expected, actual);
		Assert.True(rolledBack);
	}

	[Fact]
	public async Task ResolveAsync_UsesAnIndependentBoundedTokenAfterCancellation()
	{
		using var request = new CancellationTokenSource();
		request.Cancel();
		var cleanupToken = CancellationToken.None;

		var actual = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
			CreationRollback.ResolveAsync<string>(
				token => Task.FromCanceled<string>(token),
				token =>
				{
					cleanupToken = token;
					return Task.CompletedTask;
				},
				"test resource",
				request.Token));

		Assert.Equal(request.Token, actual.CancellationToken);
		Assert.True(cleanupToken.CanBeCanceled);
		Assert.False(cleanupToken.IsCancellationRequested);
		Assert.NotEqual(request.Token, cleanupToken);
	}

	[Fact]
	public async Task ResolveAsync_ReportsResolutionAndRollbackFailures()
	{
		var resolution = new InvalidOperationException("lookup failed");
		var rollback = new IOException("delete failed");

		var actual = await Assert.ThrowsAsync<AggregateException>(() =>
			CreationRollback.ResolveAsync<string>(
				_ => Task.FromException<string>(resolution),
				_ => Task.FromException(rollback),
				"test resource"));

		Assert.Equal(
			"test resource was created but could not be resolved, and rollback also failed.",
			actual.Message.Split(" (", StringSplitOptions.None)[0]);
		Assert.Equal([resolution, rollback], actual.InnerExceptions);
	}
}
