using System.Text.Json;
using WindowsCanvas.Contracts;
using WindowsCanvas.Windows;

namespace WindowsCanvas.Tests;

/// <summary>
/// The helper is a separate signed binary that can be older, newer, or broken. These tests pin the
/// exact wire shape the host binds, and prove that anything else fails loudly rather than being
/// half-read.
/// </summary>
public sealed class WindowsHelperProtocolTests
{
	[Fact]
	public void ReadOnlyHelperCommand_DoesNotConfigureUnredirectedStandardInput()
	{
		var startInfo = ProcessWindowsNativeBridge.CreateJsonStartInfo(
			"windows-app-helper.exe",
			["catalog", "--json"],
			redirectInput: false);

		Assert.False(startInfo.RedirectStandardInput);
		Assert.Null(startInfo.StandardInputEncoding);
		Assert.Equal(["catalog", "--json"], startInfo.ArgumentList);
	}

	[Fact]
	public void HelperJsonInput_UsesUtf8WithoutABom()
	{
		var startInfo = ProcessWindowsNativeBridge.CreateJsonStartInfo(
			"windows-app-helper.exe",
			["uia-find", "--json"],
			redirectInput: true);

		Assert.True(startInfo.RedirectStandardInput);
		Assert.Empty(startInfo.StandardInputEncoding!.GetPreamble());
	}

	[Fact]
	public void Capabilities_BindEveryFieldTheHelperDocuments()
	{
		const string payload = """
			{
			  "schemaVersion": 1,
			  "ok": true,
			  "helperVersion": "0.1.16",
			  "architecture": "arm64",
			  "os": {
			    "family": "Windows",
			    "major": 10,
			    "minor": 0,
			    "build": 26100,
			    "nativeArchitecture": "arm64"
			  },
			  "session": {
			    "id": 2,
			    "interactive": true,
			    "integrityLevel": "medium",
			    "integrityValue": 8192
			  },
			  "features": {
			    "shellAppCatalog": { "available": true, "hresult": "0x00000000" },
			    "uiAutomation": { "available": true, "hresult": "0x00000000" },
			    "windowsGraphicsCapture": {
			      "available": false,
			      "minimumBuild": 18362,
			      "reportedBuild": 17763,
			      "hresult": "0x8007047E"
			    },
			    "mediaFoundationH264": { "available": true, "hresult": "0x00000000" },
			    "sendInput": { "available": true, "hresult": "0x00000000" },
			    "authenticodeSignature": {
			      "valid": false,
			      "status": "unsigned",
			      "hresult": "0x800B0100"
			    }
			  }
			}
			""";

		var capabilities = ProcessWindowsNativeBridge.Parse(
			WindowsJsonContext.Default.WindowsHelperCapabilities,
			"capabilities",
			payload);

		Assert.Equal("0.1.16", capabilities.HelperVersion);
		Assert.Equal("arm64", capabilities.Architecture);
		Assert.Equal(26100u, capabilities.Os!.Build);
		Assert.Equal(2u, capabilities.Session!.Id);
		Assert.True(capabilities.Session.Interactive);
		Assert.Equal(8192u, capabilities.Session.IntegrityValue);
		Assert.False(capabilities.Features!.WindowsGraphicsCapture!.Available);
		Assert.Equal(18362u, capabilities.Features.WindowsGraphicsCapture.MinimumBuild);
		Assert.Equal("unsigned", capabilities.Features.AuthenticodeSignature!.Status);
	}

	[Fact]
	public void Windows_BindTheIdentityFieldsCorrelationDependsOn()
	{
		const string payload = """
			{
			  "schemaVersion": 1,
			  "ok": true,
			  "helperVersion": "0.1.16",
			  "truncated": false,
			  "session": {
			    "id": 1,
			    "interactive": true,
			    "integrityLevel": "medium",
			    "integrityValue": 8192
			  },
			  "windows": [
			    {
			      "handle": 4325376,
			      "processId": 9112,
			      "processStartFileTime": 133700000000000000,
			      "sessionId": 1,
			      "title": "Untitled - Notepad",
			      "className": "Notepad",
			      "bounds": { "left": -7, "top": 0, "width": 1200, "height": 800 },
			      "visible": true,
			      "minimized": false,
			      "cloaked": false,
			      "toolWindow": false,
			      "ownerHandle": 0,
			      "processPath": "C:\\Windows\\System32\\notepad.exe",
			      "appUserModelId": null,
			      "packageFamilyName": null,
			      "packageFullName": null,
			      "integrityLevel": "medium",
			      "integrityValue": 8192,
			      "elevated": false,
			      "identityAccess": "full"
			    }
			  ]
			}
			""";

		var list = ProcessWindowsNativeBridge.Parse(
			WindowsJsonContext.Default.WindowsHelperWindowList,
			"windows",
			payload);

		var window = Assert.Single(list.Windows);
		Assert.Equal(4325376, window.Handle);
		Assert.Equal(9112, window.ProcessId);
		Assert.Equal(133700000000000000, window.ProcessStartFileTime);
		Assert.Equal(-7, window.Bounds!.Left);
		Assert.Equal("C:\\Windows\\System32\\notepad.exe", window.ProcessPath);
		Assert.Null(window.AppUserModelId);
		Assert.Equal(WindowsIdentityAccess.Full, window.IdentityAccess);
		Assert.Equal(1u, list.Session!.Id);
	}

	[Fact]
	public void Catalog_BindsProvenanceForEverySource()
	{
		const string payload = """
			{
			  "schemaVersion": 1,
			  "ok": true,
			  "helperVersion": "0.1.16",
			  "truncated": true,
			  "sources": [
			    { "name": "appsFolder", "supported": true, "count": 2, "hresult": "0x00000000" },
			    {
			      "name": "startMenuShortcuts",
			      "supported": false,
			      "count": 0,
			      "hresult": "0x80070005",
			      "detail": "Access was denied."
			    }
			  ],
			  "entries": [
			    {
			      "id": "8f14e45fceea167a",
			      "displayName": "Calculator",
			      "source": "appsFolder",
			      "kind": "packaged",
			      "launchMethod": "shellItem",
			      "appUserModelId": "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
			      "packageFamilyName": "Microsoft.WindowsCalculator_8wekyb3d8bbwe",
			      "executablePath": null,
			      "arguments": null,
			      "workingDirectory": null,
			      "parsingName": "shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
			      "shortcutPath": null,
			      "registryKey": null
			    }
			  ]
			}
			""";

		var catalog = ProcessWindowsNativeBridge.Parse(
			WindowsJsonContext.Default.WindowsHelperCatalog,
			"catalog",
			payload);

		Assert.True(catalog.Truncated);
		Assert.Equal(2, catalog.Sources.Length);
		Assert.False(catalog.Sources[1].Supported);
		Assert.Equal("Access was denied.", catalog.Sources[1].Detail);
		var entry = Assert.Single(catalog.Entries);
		Assert.Equal("8f14e45fceea167a", entry.Id);
		Assert.Equal(WindowsCatalogKinds.Packaged, entry.Kind);
		Assert.Null(entry.ExecutablePath);
	}

	[Fact]
	public void UiAction_BindsTheVersionedPrivateHelperEnvelopeWithoutExposingAHandle()
	{
		const string payload = """
			{
			  "schemaVersion": 1,
			  "ok": true,
			  "helperVersion": "0.1.16",
			  "result": {
			    "schemaVersion": "1.0",
			    "success": false,
			    "action": "invoke",
			    "code": "windows_uia_element_ambiguous",
			    "detail": "The selector matches more than one current UI Automation element.",
			    "metadata": {
			      "truncated": false,
			      "timedOut": false,
			      "nodeCount": 12,
			      "maximumDepth": 12,
			      "maximumNodes": 500,
			      "elapsedMilliseconds": 34
			    }
			  }
			}
			""";

		var action = ProcessWindowsNativeBridge.Parse(
			WindowsJsonContext.Default.WindowsHelperUiAction,
			"uia-action",
			payload);

		Assert.True(action.Ok);
		Assert.Equal("0.1.16", action.HelperVersion);
		Assert.False(action.Result!.Success);
		Assert.Equal(WindowsErrorCodes.UiElementAmbiguous, action.Result.Code);
		Assert.Equal(12, action.Result.Metadata.NodeCount);
		Assert.DoesNotContain("\"handle\"", payload, StringComparison.Ordinal);
	}

	[Fact]
	public void UiResultWithUnknownPublicSchema_IsRefused()
	{
		var failure = Assert.Throws<WindowsCanvasException>(() =>
			ProcessWindowsNativeBridge.Parse(
				WindowsJsonContext.Default.WindowsHelperUiSnapshot,
				"uia-snapshot",
				"""
				{"schemaVersion":1,"ok":true,"result":{"schemaVersion":"9.0","metadata":{}}}
				"""));

		Assert.Equal(WindowsErrorCodes.HelperIncompatible, failure.Code);
	}

	[Fact]
	public void UnknownSchemaVersion_IsRefusedRatherThanBound()
	{
		var failure = Assert.Throws<WindowsCanvasException>(() =>
			ProcessWindowsNativeBridge.Parse(
				WindowsJsonContext.Default.WindowsHelperCapabilities,
				"capabilities",
				"""{"schemaVersion":9,"ok":true}"""));

		Assert.Equal(WindowsErrorCodes.HelperIncompatible, failure.Code);
		Assert.Contains("schema version 9", failure.Message, StringComparison.Ordinal);
	}

	[Fact]
	public void HelperReportedFailure_KeepsItsOwnCodeAndHresult()
	{
		var failure = Assert.Throws<WindowsCanvasException>(() =>
			ProcessWindowsNativeBridge.Parse(
				WindowsJsonContext.Default.WindowsHelperCatalog,
				"catalog",
				"""
				{"schemaVersion":1,"ok":false,"error":{"code":"com_initialization_failed",
				"message":"Could not initialize COM.","hresult":"0x80010106"}}
				"""));

		Assert.Equal(WindowsErrorCodes.HelperFailed, failure.Code);
		Assert.Contains("com_initialization_failed", failure.Message, StringComparison.Ordinal);
		Assert.Contains("0x80010106", failure.Message, StringComparison.Ordinal);
	}

	[Theory]
	[InlineData("")]
	[InlineData("   ")]
	[InlineData("not json at all")]
	[InlineData("{\"schemaVersion\":1,\"ok\":true")]
	public void MalformedOutput_FailsWithAGatewayError(string payload)
	{
		var failure = Assert.Throws<WindowsCanvasException>(() =>
			ProcessWindowsNativeBridge.Parse(
				WindowsJsonContext.Default.WindowsHelperCatalog,
				"catalog",
				payload));

		Assert.Equal(WindowsErrorCodes.HelperFailed, failure.Code);
		Assert.Equal(502, failure.Status);
	}

	[Fact]
	public void NonZeroExit_SurfacesTheHelpersOwnStructuredError()
	{
		var failure = ProcessWindowsNativeBridge.HelperFailure(
			"launch",
			"""{"schemaVersion":1,"ok":false,"error":{"code":"entry_not_found","message":"No catalog entry matches that identifier."}}""",
			1);

		Assert.Equal(WindowsErrorCodes.HelperFailed, failure.Code);
		Assert.Contains("entry_not_found", failure.Message, StringComparison.Ordinal);
	}

	[Fact]
	public void NonZeroExitWithoutJson_StillProducesSomethingActionable()
	{
		var failure = ProcessWindowsNativeBridge.HelperFailure(
			"catalog",
			"The application was unable to start correctly (0xc0000135).",
			-1073741515);

		Assert.Contains("0xc0000135", failure.Message, StringComparison.Ordinal);
		Assert.Contains("exited with", failure.Message, StringComparison.Ordinal);
	}

	[Fact]
	public void WindowsPayloads_RoundTripThroughTheWindowsSourceGeneratedContext()
	{
		var session = new WindowsAppSession
		{
			Id = "was_abc",
			DisplayName = "Fixture",
			Origin = WindowsSessionOrigins.Attach,
			CreatedAt = DateTimeOffset.UnixEpoch,
			Windows =
			[
				new WindowsAuthorizedWindow
				{
					Id = "win_abc",
					Title = "Main",
					Correlation = WindowsCorrelationReasons.Attached,
					Selected = true,
				},
			],
			SelectedWindowId = "win_abc",
		};

		var json = JsonSerializer.Serialize(session, WindowsJsonContext.Default.WindowsAppSession);
		var restored = JsonSerializer.Deserialize(
			json,
			WindowsJsonContext.Default.WindowsAppSession);

		Assert.Contains("\"selectedWindowId\":\"win_abc\"", json, StringComparison.Ordinal);
		// Absent values are omitted rather than serialized as null, so a payload stays small and a
		// reader cannot tell "unset" apart from "explicitly nothing" by accident.
		Assert.DoesNotContain("\"catalogEntryId\"", json, StringComparison.Ordinal);
		Assert.Equal("was_abc", restored!.Id);
		Assert.Equal("win_abc", Assert.Single(restored.Windows).Id);
	}

	[Fact]
	public void CaptureDescriptor_BindsTheGeometryAndIdentityTheHelperEchoes()
	{
		const string payload = """
			{"schemaVersion":1,"ok":true,"helperVersion":"0.1.16","type":"descriptor",
			 "status":"ok","source":"windowsGraphicsCapture","handle":66052,"processId":4242,
			 "processStartFileTime":133700000000000000,"framesPerSecond":30,"scale":0.5,
			 "averageBitrate":8000000,"byteCount":2048,
			 "geometry":{"contentWidth":800,"contentHeight":600,"captureWidth":400,
			  "captureHeight":300,"scale":0.5,"surfaceWidth":816,"surfaceHeight":608,
			  "visibleOffset":{"x":8,"y":0},"frameOffset":{"x":-8,"y":0},
			  "clientOffset":{"x":1,"y":32},"clientWidth":798,"clientHeight":567,
			  "contentScreenBounds":{"left":-1920,"top":-200,"width":800,"height":600},
			  "windowScreenBounds":{"left":-1928,"top":-200,"width":816,"height":608},
			  "clientScreenBounds":{"left":-1919,"top":-168,"width":798,"height":567},
			  "dpi":144,"dpiScale":1.5,"minimized":false},
			 "capabilities":{"freeThreadedFramePool":true,"cursorCaptureToggle":true,
			  "borderRequiredToggle":true,"secondaryWindowCapture":false,
			  "dirtyRegionMode":false,"cursorCaptured":false,"borderRequired":true,
			  "hardwareEncoder":true,"encoder":"Intel Quick Sync","adapter":"Intel Arc"}}
			""";

		var capture = ProcessWindowsVideoSession.TryParse(payload.ReplaceLineEndings(""));

		Assert.NotNull(capture);
		Assert.Equal("descriptor", capture!.Type);
		Assert.Equal(66052, capture.Handle);
		Assert.Equal(4242, capture.ProcessId);
		Assert.Equal(133700000000000000, capture.ProcessStartFileTime);
		Assert.Equal(30, capture.FramesPerSecond);
		Assert.Equal(0.5, capture.Scale);
		Assert.Equal(2048, capture.ByteCount);
		Assert.Equal(800, capture.Geometry!.ContentWidth);
		Assert.Equal(400, capture.Geometry.CaptureWidth);
		Assert.Equal(-1920, capture.Geometry.ContentScreenBounds.Left);
		Assert.Equal(144u, capture.Geometry.Dpi);
		Assert.Equal(8, capture.Geometry.VisibleOffset.X);
		Assert.True(capture.Capabilities!.FreeThreadedFramePool);
		Assert.Equal("Intel Quick Sync", capture.Capabilities.Encoder);
	}

	[Fact]
	public void CaptureEnd_CarriesAStructuredReason()
	{
		var end = ProcessWindowsVideoSession.TryParse(
			"""{"schemaVersion":1,"ok":true,"type":"end","status":"ok","reason":"contentSizeChanged","sourceDetail":"The window was resized."}""");

		Assert.NotNull(end);
		Assert.Equal("end", end!.Type);
		Assert.Equal(WindowsStreamEndReasons.ContentSizeChanged, end.Reason);
		Assert.True(WindowsStreamEndReasons.ShouldReconnect(end.Reason));
	}

	[Fact]
	public void CaptureStatusLines_AreReadFromTheLastFramedLineOnly()
	{
		// The helper drains diagnostics onto standard error. Only well-formed framed lines count,
		// and the last one is the outcome.
		var status = ProcessWindowsNativeBridge.ParseCaptureStatus(
			"not json\n" +
			"""{"schemaVersion":1,"ok":true,"type":"descriptor","status":"ok"}""" + "\r\n" +
			"""{"schemaVersion":1,"ok":false,"type":"descriptor","status":"protected"}""" + "\n");

		Assert.NotNull(status);
		Assert.False(status!.Ok);
		Assert.Equal(WindowsCaptureStatuses.ProtectedContent, status.Status);
	}

	[Fact]
	public void CaptureStatusLines_RefuseAnythingThatIsNotAFramedObject()
	{
		Assert.Null(ProcessWindowsVideoSession.TryParse(""));
		Assert.Null(ProcessWindowsVideoSession.TryParse("[1,2,3]"));
		Assert.Null(ProcessWindowsVideoSession.TryParse("{ broken"));
		Assert.Null(ProcessWindowsNativeBridge.ParseCaptureStatus("no lines here"));
	}
}
