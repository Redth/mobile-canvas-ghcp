using System.Text.Json;
using MobileCanvas.Contracts;

namespace MobileCanvas.Tests;

public sealed class CanvasSurfaceTests
{
	[Fact]
	public void Normalize_TreatsAnAbsentSurfaceAsMobile()
	{
		Assert.Equal(CanvasSurfaces.Mobile, CanvasSurfaces.Normalize(null));
		Assert.Equal(CanvasSurfaces.Mobile, CanvasSurfaces.Normalize(""));
		Assert.Equal(CanvasSurfaces.Mobile, CanvasSurfaces.Normalize("   "));
	}

	[Theory]
	[InlineData("mobile", CanvasSurfaces.Mobile)]
	[InlineData("MOBILE", CanvasSurfaces.Mobile)]
	[InlineData("windows", CanvasSurfaces.Windows)]
	[InlineData(" Windows ", CanvasSurfaces.Windows)]
	public void Normalize_AcceptsSupportedSurfaces(string value, string expected)
	{
		Assert.Equal(expected, CanvasSurfaces.Normalize(value));
	}

	[Fact]
	public void Normalize_RejectsUnknownSurfacesRatherThanFallingBack()
	{
		Assert.Throws<ArgumentException>(() => CanvasSurfaces.Normalize("linux"));
		Assert.False(CanvasSurfaces.IsSupported("linux"));
	}

	[Fact]
	public void ContextKey_DefaultsToMobileAndSeparatesSurfaces()
	{
		var mobile = new CanvasContextKey("session", "instance");
		var windows = new CanvasContextKey("session", "instance", CanvasSurfaces.Windows);

		Assert.Equal(CanvasSurfaces.Mobile, mobile.Surface);
		Assert.Equal(mobile, new CanvasContextKey("session", "instance", CanvasSurfaces.Mobile));
		Assert.NotEqual(mobile, windows);
	}

	[Fact]
	public void ContextKey_DeserializesAPayloadThatPredatesSurfacesAsMobile()
	{
		var key = JsonSerializer.Deserialize(
			"""{"sessionId":"session","instanceId":"instance"}""",
			DeviceJsonContext.Default.CanvasContextKey);

		Assert.Equal(new CanvasContextKey("session", "instance"), key);
	}

	[Theory]
	[InlineData("""{"sessionId":"s","instanceId":"i"}""")]
	[InlineData("""{"sessionId":"s","instanceId":"i","surface":""}""")]
	public void CanvasRequests_WithoutASurface_AreMobile(string payload)
	{
		var open = JsonSerializer.Deserialize(payload, DeviceJsonContext.Default.CanvasOpenRequest);
		var close = JsonSerializer.Deserialize(payload, DeviceJsonContext.Default.CanvasCloseRequest);

		Assert.Equal(CanvasSurfaces.Mobile, CanvasSurfaces.Normalize(open!.Surface));
		Assert.Equal(CanvasSurfaces.Mobile, CanvasSurfaces.Normalize(close!.Surface));
	}

	[Fact]
	public void Redaction_LeavesMobileEventsExactlyAsPublished()
	{
		var activity = new AutomationEvent
		{
			Kind = AutomationEventKinds.Text,
			DeviceId = "ios:device",
			Detail = "hunter2",
		};

		Assert.Same(activity, AutomationEventRedaction.ForSurface(CanvasSurfaces.Mobile, activity));
		Assert.Same(activity, AutomationEventRedaction.ForSurface(null, activity));
	}

	[Fact]
	public void Redaction_ReplacesTypedTextWithACountOnOtherSurfaces()
	{
		var activity = new AutomationEvent
		{
			Kind = AutomationEventKinds.Text,
			DeviceId = "windows:app",
			Detail = "hunter2",
		};

		var redacted = AutomationEventRedaction.ForSurface(CanvasSurfaces.Windows, activity);

		Assert.Null(redacted.Detail);
		Assert.Equal(7, redacted.CharacterCount);
		Assert.Equal(activity.Kind, redacted.Kind);
		Assert.Equal(activity.DeviceId, redacted.DeviceId);
	}

	[Fact]
	public void Redaction_KeepsNonTextDetailSuchAsButtonNames()
	{
		var activity = new AutomationEvent
		{
			Kind = AutomationEventKinds.Button,
			DeviceId = "windows:app",
			Detail = "home",
		};

		Assert.Same(activity, AutomationEventRedaction.ForSurface(CanvasSurfaces.Windows, activity));
	}
}
