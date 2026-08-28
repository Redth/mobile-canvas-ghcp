using MobileCanvas.Core;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

public sealed class NativeAccessibilityReaderTests
{
	private const string Hierarchy = """
		{
		  "role": "AXApplication",
		  "frame": { "x": 0, "y": 0, "width": 390, "height": 844 },
		  "children": [
		    {
		      "role": "AXButton",
		      "AXLabel": "Continue",
		      "frame": { "x": 20, "y": 700, "width": 350, "height": 44 },
		      "children": []
		    }
		  ]
		}
		""";

	[Fact]
	public async Task ReadAsync_TargetsUdidAndDeveloperDirectory()
	{
		var runner = new RecordingProcessRunner(new ProcessResult(0, Hierarchy, ""));

		var json = await NativeAccessibilityReader.ReadAsync(
			runner,
			"/tmp/mobile-screencap",
			"SIM-UDID",
			"/Applications/Xcode.app/Contents/Developer",
			CancellationToken.None);

		Assert.Equal(Hierarchy.Trim(), json);
		var request = Assert.Single(runner.Requests);
		Assert.Equal("/tmp/mobile-screencap", request.FileName);
		Assert.Equal(
			[
				"accessibility",
				"--udid",
				"SIM-UDID",
				"--developer-dir",
				"/Applications/Xcode.app/Contents/Developer",
			],
			request.Arguments);
	}

	[Fact]
	public async Task ReadAsync_RejectsInvalidHierarchy()
	{
		var runner = new RecordingProcessRunner(new ProcessResult(0, "not-json", ""));

		var exception = await Assert.ThrowsAsync<NativeAccessibilityException>(
			() => NativeAccessibilityReader.ReadAsync(
				runner,
				"/tmp/mobile-screencap",
				"SIM-UDID",
				null,
				CancellationToken.None));

		Assert.Contains("invalid hierarchy", exception.Message);
	}

	[Fact]
	public async Task ReadAsync_UsesStructuredHelperError()
	{
		var runner = new RecordingProcessRunner(new ProcessResult(
			1,
			"""
			{"type":"unavailable","code":"timeout","message":"accessibility translation timed out"}
			""",
			""));

		var exception = await Assert.ThrowsAsync<NativeAccessibilityException>(
			() => NativeAccessibilityReader.ReadAsync(
				runner,
				"/tmp/mobile-screencap",
				"SIM-UDID",
				null,
				CancellationToken.None));

		Assert.Equal("accessibility translation timed out", exception.Message);
	}

	private sealed class RecordingProcessRunner(ProcessResult result) : IProcessRunner
	{
		public List<ProcessRequest> Requests { get; } = [];

		public Task<ProcessResult> RunAsync(
			ProcessRequest request,
			CancellationToken cancellationToken = default)
		{
			Requests.Add(request);
			return Task.FromResult(result);
		}
	}
}
