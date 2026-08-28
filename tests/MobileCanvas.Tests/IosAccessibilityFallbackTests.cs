using MobileCanvas.Core;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

public sealed class IosAccessibilityFallbackTests
{
	[Fact]
	public async Task NativeSuccess_DoesNotStartIdb()
	{
		var idbCalls = 0;

		var result = await IosAccessibilityFallback.ReadAsync(
			() => Task.FromResult("native"),
			() =>
			{
				idbCalls++;
				return Task.FromResult("idb");
			});

		Assert.Equal("native", result);
		Assert.Equal(0, idbCalls);
	}

	[Fact]
	public async Task NativeFailure_UsesIdb()
	{
		var result = await IosAccessibilityFallback.ReadAsync(
			() => Task.FromException<string>(new NativeAccessibilityException("native unavailable")),
			() => Task.FromResult("idb"));

		Assert.Equal("idb", result);
	}

	[Fact]
	public async Task BothUnavailable_ReportBothReasons()
	{
		var exception = await Assert.ThrowsAsync<DeviceCapabilityException>(
			() => IosAccessibilityFallback.ReadAsync(
				() => Task.FromException<string>(new NativeAccessibilityException("native reason")),
				() => Task.FromException<string>(new FileNotFoundException("idb reason"))));

		Assert.Contains("native reason", exception.Message);
		Assert.Contains("idb reason", exception.Message);
	}

	[Fact]
	public async Task Cancellation_DoesNotInvokeIdb()
	{
		var idbCalls = 0;

		await Assert.ThrowsAnyAsync<OperationCanceledException>(
			() => IosAccessibilityFallback.ReadAsync(
				() => Task.FromCanceled<string>(new CancellationToken(canceled: true)),
				() =>
				{
					idbCalls++;
					return Task.FromResult("idb");
				}));

		Assert.Equal(0, idbCalls);
	}
}
