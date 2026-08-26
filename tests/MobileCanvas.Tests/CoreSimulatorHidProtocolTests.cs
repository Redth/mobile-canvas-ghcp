using System.Text.Json;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

public sealed class CoreSimulatorHidProtocolTests
{
	[Fact]
	public void SerializeRequest_WritesEveryEventWithoutReflectionSerialization()
	{
		var json = CoreSimulatorHidProtocol.SerializeRequest(
			42,
			[
				new IosHidTouch(1.5, 2.5, IosHidTouchPhase.Down),
				new IosHidDelay(0.25),
				new IosHidSwipe(1, 2, 3, 4, 0.5),
				new IosHidKey(40, IosHidDirection.Up),
				new IosHidButtonPress(IosHidButton.ApplePay),
			]);

		using var document = JsonDocument.Parse(json);
		var root = document.RootElement;
		Assert.Equal(1, root.GetProperty("version").GetInt32());
		Assert.Equal(42, root.GetProperty("id").GetInt64());
		Assert.Equal("events", root.GetProperty("type").GetString());

		var events = root.GetProperty("events").EnumerateArray().ToArray();
		Assert.Equal(5, events.Length);
		Assert.Equal("touch", events[0].GetProperty("type").GetString());
		Assert.Equal("down", events[0].GetProperty("phase").GetString());
		Assert.Equal(1.5, events[0].GetProperty("x").GetDouble());
		Assert.Equal("delay", events[1].GetProperty("type").GetString());
		Assert.Equal(0.25, events[1].GetProperty("duration").GetDouble());
		Assert.Equal("swipe", events[2].GetProperty("type").GetString());
		Assert.Equal(4, events[2].GetProperty("endY").GetDouble());
		Assert.Equal("key", events[3].GetProperty("type").GetString());
		Assert.Equal((ulong)40, events[3].GetProperty("usage").GetUInt64());
		Assert.Equal("up", events[3].GetProperty("direction").GetString());
		Assert.Equal("button", events[4].GetProperty("type").GetString());
		Assert.Equal("apple-pay", events[4].GetProperty("button").GetString());
	}

	[Fact]
	public void SerializeRequest_RejectsInvalidBatchBeforeWriting()
	{
		Assert.Throws<ArgumentException>(
			() => CoreSimulatorHidProtocol.SerializeRequest(1, []));
		Assert.Throws<ArgumentOutOfRangeException>(
			() => CoreSimulatorHidProtocol.SerializeRequest(
				1,
				[new IosHidTouch(double.NaN, 1, IosHidTouchPhase.Down)]));
		Assert.Throws<ArgumentOutOfRangeException>(
			() => CoreSimulatorHidProtocol.SerializeRequest(
				1,
				[new IosHidDelay(-1)]));
	}

	[Fact]
	public void ParseResponse_ReadsReadyAndCapabilities()
	{
		var response = Assert.IsType<CoreSimulatorHidReady>(
			CoreSimulatorHidProtocol.ParseResponse(
				"""{"protocolVersion":1,"type":"ready","transport":"dtuhid","capabilities":["touch","keyboard"]}"""));

		Assert.Equal("dtuhid", response.Transport);
		Assert.Equal(["touch", "keyboard"], response.Capabilities);
	}

	[Fact]
	public void ParseResponse_ReadsUnavailableAndResultErrors()
	{
		var unavailable = Assert.IsType<CoreSimulatorHidUnavailable>(
			CoreSimulatorHidProtocol.ParseResponse(
				"""{"protocolVersion":1,"type":"unavailable","code":"service-missing","message":"No HID service"}"""));
		Assert.Equal("service-missing", unavailable.Code);

		var result = Assert.IsType<CoreSimulatorHidResult>(
			CoreSimulatorHidProtocol.ParseResponse(
				"""{"id":7,"type":"result","ok":false,"code":"invalid-event","message":"Bad touch","beforeDelivery":true}"""));
		Assert.False(result.Success);
		Assert.True(result.BeforeDelivery);
		Assert.Equal("invalid-event", result.Code);
	}

	[Fact]
	public void HidDoctor_ParseReadsStaticNegotiationPolicy()
	{
		var result = CoreSimulatorHidDoctor.Parse(
			"""
			{
			  "type": "hid-doctor",
			  "protocolVersion": 1,
			  "coreSimulatorAvailable": true,
			  "coreSimulatorVersion": "1155.4",
			  "transportPolicy": "dtuhid",
			  "legacyKeyboardSuppressed": true,
			  "dtuhidSymbolsAvailable": true,
			  "simulatorKitPath": null,
			  "negotiable": true,
			  "detail": "DTUHID symbols are present."
			}
			""");

		Assert.True(result.Negotiable);
		Assert.True(result.CoreSimulatorAvailable);
		Assert.True(result.LegacyKeyboardSuppressed);
		Assert.Equal("dtuhid", result.TransportPolicy);
		Assert.Equal("1155.4", result.CoreSimulatorVersion);
		Assert.Null(result.SimulatorKitPath);
	}

	[Theory]
	[InlineData("{}")]
	[InlineData("""{"type":"hid-doctor","protocolVersion":2}""")]
	[InlineData(
		"""{"type":"hid-doctor","protocolVersion":1,"negotiable":"yes","coreSimulatorAvailable":true,"dtuhidSymbolsAvailable":true,"legacyKeyboardSuppressed":true,"transportPolicy":"dtuhid","detail":"ok"}""")]
	public void HidDoctor_RejectsMalformedStaticDiagnostics(string json)
	{
		Assert.Throws<InvalidDataException>(() => CoreSimulatorHidDoctor.Parse(json));
	}

	[Theory]
	[InlineData("")]
	[InlineData("not-json")]
	[InlineData("""{"protocolVersion":1}""")]
	[InlineData("""{"protocolVersion":1,"type":"unknown"}""")]
	[InlineData("""{"type":"result","id":1}""")]
	public void ParseResponse_RejectsMalformedProtocol(string line)
	{
		Assert.Throws<InvalidDataException>(() => CoreSimulatorHidProtocol.ParseResponse(line));
	}
}
