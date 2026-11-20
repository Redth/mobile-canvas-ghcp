using System.Diagnostics;
using MobileCanvas.Contracts;
using MobileCanvas.Core;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

public class NativeCaptureTests
{
	[Theory]
	[InlineData(1206, 2622)]
	[InlineData(2622, 1206)]
	public void FramebufferArguments_TargetTheUdidAndNativePanelScale(int pixelWidth, int pixelHeight)
	{
		var startInfo = IosScreenCaptureVideoSession.CreateFramebufferStartInfo(
			"/tmp/mobile-screencap",
			"SIMULATOR-UDID",
			new StreamOptions
			{
				FramesPerSecond = 42,
				AverageBitrate = 5_000_000,
				Scale = 0.5,
			},
			new DisplayGeometry { PixelWidth = pixelWidth, PixelHeight = pixelHeight });

		Assert.Equal(
			[
				"framebuffer",
				"--udid",
				"SIMULATOR-UDID",
				"--fps",
				"42",
				"--bitrate",
				"5000000",
				"--max-height",
				"1311",
			],
			startInfo.ArgumentList);
	}

	[Theory]
	[InlineData(1.0, 1320, 2868, 1920)]
	[InlineData(0.9, 1320, 2868, 1920)]
	[InlineData(0.5, 1320, 2868, 1434)]
	[InlineData(1.0, 2868, 1320, 1920)]
	[InlineData(1.0, 1080, 1920, null)]
	[InlineData(1.0, 750, 1334, null)]
	public void FramebufferArguments_CapUnscaledVideoAtTheDefaultCeiling(
		double scale,
		int pixelWidth,
		int pixelHeight,
		int? expectedMaxHeight)
	{
		var startInfo = IosScreenCaptureVideoSession.CreateFramebufferStartInfo(
			"/tmp/mobile-screencap",
			"SIMULATOR-UDID",
			new StreamOptions { FramesPerSecond = 60, Scale = scale },
			new DisplayGeometry { PixelWidth = pixelWidth, PixelHeight = pixelHeight });

		var arguments = startInfo.ArgumentList.ToList();
		var index = arguments.IndexOf("--max-height");
		if (expectedMaxHeight is null)
		{
			Assert.Equal(-1, index);
		}
		else
		{
			Assert.True(index >= 0, "expected --max-height");
			Assert.Equal(expectedMaxHeight.Value.ToString(), arguments[index + 1]);
		}
	}

	[Fact]
	public async Task FramebufferStartup_DrainsVideoWrittenBeforeReady()
	{
		// More than the 64 KB pipe buffer: a host that reads stdout only after `ready` deadlocks
		// the helper here, because its write blocks before it can report ready.
		const int bytesBeforeReady = 256 * 1024;
		var startInfo = new ProcessStartInfo("/bin/sh")
		{
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			UseShellExecute = false,
		};
		startInfo.ArgumentList.Add("-c");
		startInfo.ArgumentList.Add(
			$"head -c {bytesBeforeReady} /dev/zero; echo '{{\"type\":\"ready\",\"fps\":60}}' >&2; sleep 30");
		var releases = 0;
		var runner = new CaptureProcessRunner();

		var session = await IosScreenCaptureVideoSession.StartProcessAsync(
			startInfo,
			new StreamOptions(),
			new DisplayGeometry(),
			"framebuffer",
			sourceDetail: null,
			() => releases++,
			runner,
			CancellationToken.None,
			TimeSpan.FromSeconds(5));
		var received = 0;
		try
		{
			using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
			await foreach (var chunk in session.ReadAsync(timeout.Token))
			{
				received += chunk.Length;
				if (received >= bytesBeforeReady)
					break;
			}
		}
		finally
		{
			await session.DisposeAsync();
		}

		Assert.Equal(60, session.Descriptor.FramesPerSecond);
		Assert.Equal(bytesBeforeReady, received);
		Assert.Equal(1, releases);
		Assert.Same(startInfo, runner.StartInfo);
	}

	[Fact]
	public async Task CaptureStartup_ReleasesOwnershipWhenInjectedRunnerCannotLaunch()
	{
		var failure = new InvalidOperationException("launch refused");
		var runner = new CaptureProcessRunner(failure);
		var releases = 0;

		var actual = await Assert.ThrowsAsync<InvalidOperationException>(() =>
			IosScreenCaptureVideoSession.StartProcessAsync(
				new ProcessStartInfo("must-not-launch"),
				new StreamOptions(),
				new DisplayGeometry(),
				"framebuffer",
				null,
				() => releases++,
				runner,
				CancellationToken.None,
				TimeSpan.FromSeconds(5)));

		Assert.Same(failure, actual);
		Assert.Equal(1, releases);
	}

	private sealed class CaptureProcessRunner(Exception? failure = null) : IProcessRunner
	{
		public ProcessStartInfo? StartInfo { get; private set; }

		public Process Start(ProcessStartInfo startInfo)
		{
			StartInfo = startInfo;
			if (failure is not null)
				throw failure;
			return new SystemProcessRunner().Start(startInfo);
		}

		public Task<ProcessResult> RunAsync(ProcessRequest request, CancellationToken cancellationToken = default) =>
			throw new InvalidOperationException("Live capture must not use the text runner.");
	}

	[Fact]
	public async Task FramebufferStartup_ReleasesWhenTheHelperExitsBeforeReady()
	{
		var startInfo = new ProcessStartInfo("/bin/sh")
		{
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			UseShellExecute = false,
		};
		startInfo.ArgumentList.Add("-c");
		startInfo.ArgumentList.Add("head -c 200000 /dev/zero; exit 3");
		var releases = 0;

		await Assert.ThrowsAsync<InvalidOperationException>(() =>
			IosScreenCaptureVideoSession.StartProcessAsync(
				startInfo,
				new StreamOptions(),
				new DisplayGeometry(),
				"framebuffer",
				sourceDetail: null,
				() => releases++,
				new SystemProcessRunner(),
				CancellationToken.None,
				TimeSpan.FromSeconds(5)));

		Assert.Equal(1, releases);
	}

	[Theory]
	[InlineData("Device Hub", true, "Device Hub is not showing this device.")]
	[InlineData("Simulator", false, "Simulator has no device windows open.")]
	[InlineData(null, true, "The simulator host app is not showing this device.")]
	public void CaptureWindowFailure_NamesTheSelectedHostApp(string? host, bool anyWindows, string expectedStart)
	{
		var message = IosSimulatorBackend.DescribeMissingCaptureWindow(host, anyWindows);

		Assert.StartsWith(expectedStart, message);
		Assert.Contains("Show simulator window", message);
	}

	[Fact]
	public void ScreenCaptureArguments_KeepTheExistingWindowCaptureContract()
	{
		var startInfo = IosScreenCaptureVideoSession.CreateScreenCaptureStartInfo(
			"/tmp/mobile-screencap",
			new ScreencapWindow
			{
				WindowId = 123,
				ScreenHeight = 800,
				BackingScale = 2,
			},
			new StreamOptions
			{
				FramesPerSecond = 30,
				AverageBitrate = 12_000_000,
				Scale = 0.75,
			});

		Assert.Equal(
			[
				"capture",
				"--window-id",
				"123",
				"--fps",
				"30",
				"--bitrate",
				"12000000",
				"--max-height",
				"1200",
			],
			startInfo.ArgumentList);
	}

	[Fact]
	public void Diagnostics_ParsesFramebufferAndFallbackAvailability()
	{
		var diagnostics = ScreenCaptureHelper.ParseDiagnostics("""
			{
			  "framebufferAvailable": true,
			  "framebufferDetail": "CoreSimulator IOSurface capture is available.",
			  "screenRecordingGranted": false,
			  "screenRecordingDetail": "Permission preflight only.",
			  "accessibilityGranted": true
			}
			""");

		Assert.True(diagnostics.FramebufferAvailable);
		Assert.Equal("CoreSimulator IOSurface capture is available.", diagnostics.FramebufferDetail);
		Assert.False(diagnostics.ScreenRecordingGranted);
		Assert.True(diagnostics.AccessibilityGranted);
	}

	[Fact]
	public void FallbackDetail_PreservesBothFailedNativeSources()
	{
		var detail = IosSimulatorBackend.BuildCaptureFallbackDetail(
			"private API changed",
			"Screen Recording denied");

		Assert.Equal(
			"Direct framebuffer capture unavailable: private API changed "
			+ "ScreenCaptureKit fallback unavailable: Screen Recording denied",
			detail);
	}

	[Fact]
	public async Task FramebufferStartup_RetriesOneTimeoutThenSucceeds()
	{
		var attempts = new List<TimeSpan>();

		var result = await IosSimulatorBackend.StartFramebufferWithRetryAsync(
			(timeout, _) =>
			{
				attempts.Add(timeout);
				return attempts.Count == 1
					? Task.FromException<string>(new TimeoutException("first timeout"))
					: Task.FromResult("framebuffer");
			},
			CancellationToken.None,
			static (_, _) => Task.CompletedTask);

		Assert.Equal("framebuffer", result);
		Assert.Equal([TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(8)], attempts);
	}

	[Fact]
	public async Task FramebufferStartup_DoesNotRetryExplicitFailure()
	{
		var attempts = 0;

		var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
			IosSimulatorBackend.StartFramebufferWithRetryAsync<string>(
				(_, _) =>
				{
					attempts++;
					return Task.FromException<string>(new InvalidOperationException("unsupported"));
				},
				CancellationToken.None,
				static (_, _) => Task.CompletedTask));

		Assert.Equal("unsupported", exception.Message);
		Assert.Equal(1, attempts);
	}

	[Fact]
	public async Task FramebufferStartup_PreservesBothTimeoutFailures()
	{
		var attempts = 0;

		var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
			IosSimulatorBackend.StartFramebufferWithRetryAsync<string>(
				(_, _) =>
				{
					attempts++;
					return Task.FromException<string>(
						new TimeoutException(attempts == 1 ? "first timeout" : "second timeout"));
				},
				CancellationToken.None,
				static (_, _) => Task.CompletedTask));

		Assert.Contains("first timeout", exception.Message);
		Assert.Contains("second timeout", exception.Message);
		Assert.Equal(2, attempts);
	}

	[Fact]
	public void VideoUnavailable_ReportsNativeAndOptionalIdbFailures()
	{
		var exception = IosSimulatorBackend.BuildVideoUnavailableException(
			"Direct framebuffer capture unavailable: private API changed",
			"idb_companion is not installed.");

		Assert.Contains("private API changed", exception.Message);
		Assert.Contains("Optional idb final fallback", exception.Message);
		Assert.Contains("not installed", exception.Message);
	}

	[Fact]
	public void HidCheck_MentionsIdbOnlyWhenNativeInputNeedsIt()
	{
		var healthy = IosSimulatorBackend.BuildHidCheck(
			new CoreSimulatorHidDoctorResult
			{
				Negotiable = true,
				Detail = "DTUHID is available.",
			},
			companion: null);
		var unavailable = IosSimulatorBackend.BuildHidCheck(
			new CoreSimulatorHidDoctorResult
			{
				Negotiable = false,
				Detail = "DTUHID is unavailable.",
			},
			companion: null);

		Assert.DoesNotContain("IDB", healthy.Message, StringComparison.OrdinalIgnoreCase);
		Assert.Equal("error", unavailable.Status);
		Assert.Contains("IDB input fallback is unavailable", unavailable.Message);
	}

	[Fact]
	public void ScreencapCheck_DoesNotPromptForOptionalFallbackPermissions()
	{
		var check = IosSimulatorBackend.BuildScreencapCheck(
			"/tmp/mobile-screencap",
			new ScreencapDiagnostics
			{
				ScreenRecordingGranted = false,
				AccessibilityGranted = false,
			},
			framebufferReady: true,
			idbAvailable: false);

		Assert.Equal("ok", check.Status);
		Assert.Contains("fallback grants are optional", check.Message);
		Assert.Empty(check.Actions);
	}

	[Fact]
	public void ScreencapCheck_PromptsWhenDirectCaptureIsUnavailable()
	{
		var check = IosSimulatorBackend.BuildScreencapCheck(
			"/tmp/mobile-screencap",
			new ScreencapDiagnostics
			{
				ScreenRecordingGranted = false,
				AccessibilityGranted = false,
			},
			framebufferReady: false,
			idbAvailable: true);

		Assert.Equal("warning", check.Status);
		Assert.StartsWith("Grant Screen Recording and Accessibility", check.Message);
		Assert.Collection(
			check.Actions,
			action => Assert.Equal(SystemSettingsTargets.ScreenRecording, action.Target),
			action => Assert.Equal(SystemSettingsTargets.Accessibility, action.Target));
	}

	[Fact]
	public void ScreencapCheck_ReportsIdbOnlyWhenNativeVideoNeedsIt()
	{
		var healthy = IosSimulatorBackend.BuildScreencapCheck(
			"/tmp/mobile-screencap",
			new ScreencapDiagnostics(),
			framebufferReady: true,
			idbAvailable: false);
		var unavailable = IosSimulatorBackend.BuildScreencapCheck(
			"/tmp/mobile-screencap",
			new ScreencapDiagnostics(),
			framebufferReady: false,
			idbAvailable: false);

		Assert.DoesNotContain("IDB", healthy.Message, StringComparison.OrdinalIgnoreCase);
		Assert.Equal("error", unavailable.Status);
		Assert.Contains("IDB fallback is also unavailable", unavailable.Message);
	}

	[Fact]
	public void ScreencapActions_OnlyIncludeMissingPermissions()
	{
		var actions = IosSimulatorBackend.BuildScreencapActions(new ScreencapDiagnostics
		{
			ScreenRecordingGranted = true,
			AccessibilityGranted = false,
		});

		var action = Assert.Single(actions);
		Assert.Equal(DiagnosticActionTypes.OpenSystemSettings, action.Type);
		Assert.Equal(SystemSettingsTargets.Accessibility, action.Target);
		Assert.Equal("Open Accessibility", action.Label);
		Assert.Empty(IosSimulatorBackend.BuildScreencapActions(new ScreencapDiagnostics
		{
			ScreenRecordingGranted = true,
			AccessibilityGranted = true,
		}));
	}

	[Fact]
	public void ScreencapActions_PreservePermissionOrder()
	{
		var actions = IosSimulatorBackend.BuildScreencapActions(new ScreencapDiagnostics());

		Assert.Collection(
			actions,
			action => Assert.Equal(SystemSettingsTargets.ScreenRecording, action.Target),
			action => Assert.Equal(SystemSettingsTargets.Accessibility, action.Target));
	}
}
