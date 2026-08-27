namespace MobileCanvas.Core;

public static class CreationRollback
{
	private static readonly TimeSpan CleanupTimeout = TimeSpan.FromSeconds(30);

	public static async Task<T> ResolveAsync<T>(
		Func<CancellationToken, Task<T>> resolve,
		Func<CancellationToken, Task> rollback,
		string resourceDescription,
		CancellationToken cancellationToken = default)
	{
		ArgumentNullException.ThrowIfNull(resolve);
		ArgumentNullException.ThrowIfNull(rollback);
		ArgumentException.ThrowIfNullOrWhiteSpace(resourceDescription);

		try
		{
			return await resolve(cancellationToken).ConfigureAwait(false);
		}
		catch (Exception resolutionException)
		{
			using var cleanupSource = new CancellationTokenSource(CleanupTimeout);
			try
			{
				await rollback(cleanupSource.Token).ConfigureAwait(false);
			}
			catch (Exception rollbackException)
			{
				throw new AggregateException(
					$"{resourceDescription} was created but could not be resolved, and rollback also failed.",
					resolutionException,
					rollbackException);
			}

			throw;
		}
	}
}
