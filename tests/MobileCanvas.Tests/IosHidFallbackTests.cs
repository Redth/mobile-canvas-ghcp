using MobileCanvas.Core;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

public sealed class IosHidFallbackTests
{
	[Fact]
	public async Task NativeSuccess_DoesNotStartIdb()
	{
		var idbCalls = 0;

		await IosHidFallback.SendAsync(
			() => Task.CompletedTask,
			() =>
			{
				idbCalls++;
				return Task.CompletedTask;
			});

		Assert.Equal(0, idbCalls);
	}

	[Fact]
	public async Task PreDeliveryFailure_UsesIdb()
	{
		var idbCalls = 0;

		await IosHidFallback.SendAsync(
			() => Task.FromException(
				new CoreSimulatorHidException("helper unavailable", beforeDelivery: true)),
			() =>
			{
				idbCalls++;
				return Task.CompletedTask;
			});

		Assert.Equal(1, idbCalls);
	}

	[Fact]
	public async Task AmbiguousFailure_IsNotReplayed()
	{
		var idbCalls = 0;
		var expected = new CoreSimulatorHidException("connection invalidated", beforeDelivery: false);

		var actual = await Assert.ThrowsAsync<CoreSimulatorHidException>(
			() => IosHidFallback.SendAsync(
				() => Task.FromException(expected),
				() =>
				{
					idbCalls++;
					return Task.CompletedTask;
				}));

		Assert.Same(expected, actual);
		Assert.Equal(0, idbCalls);
	}

	[Fact]
	public async Task BothUnavailable_ReportsBothReasons()
	{
		var exception = await Assert.ThrowsAsync<DeviceCapabilityException>(
			() => IosHidFallback.SendAsync(
				() => Task.FromException(
					new CoreSimulatorHidException("native reason", beforeDelivery: true)),
				() => Task.FromException(new IdbHidException("idb reason"))));

		Assert.Contains("native reason", exception.Message);
		Assert.Contains("idb reason", exception.Message);
	}

	[Fact]
	public async Task Cancellation_DoesNotInvokeIdb()
	{
		var idbCalls = 0;

		await Assert.ThrowsAnyAsync<OperationCanceledException>(
			() => IosHidFallback.SendAsync(
				() => Task.FromCanceled(new CancellationToken(canceled: true)),
				() =>
				{
					idbCalls++;
					return Task.CompletedTask;
				}));

		Assert.Equal(0, idbCalls);
	}
}
