using System.Buffers;
using System.Text;
using System.Text.Json;

namespace MobileCanvas.iOS;

internal abstract record CoreSimulatorHidResponse(int Version);

internal sealed record CoreSimulatorHidReady(
	int Version,
	string Transport,
	IReadOnlyList<string> Capabilities) : CoreSimulatorHidResponse(Version);

internal sealed record CoreSimulatorHidUnavailable(
	int Version,
	string Code,
	string Message) : CoreSimulatorHidResponse(Version);

internal sealed record CoreSimulatorHidResult(
	int Version,
	long Id,
	bool Success,
	string? Code,
	string? Message,
	bool BeforeDelivery) : CoreSimulatorHidResponse(Version);

internal sealed record CoreSimulatorHidFatal(
	int Version,
	string Code,
	string Message) : CoreSimulatorHidResponse(Version);

internal static class CoreSimulatorHidProtocol
{
	public const int Version = 1;

	public static void ValidateEvents(IReadOnlyList<IosHidEvent> events)
	{
		ArgumentNullException.ThrowIfNull(events);
		if (events.Count == 0)
			throw new ArgumentException("At least one iOS HID event is required.", nameof(events));

		foreach (var hidEvent in events)
		{
			switch (hidEvent)
			{
				case IosHidTouch touch:
					RequireFinite(touch.X, nameof(touch.X));
					RequireFinite(touch.Y, nameof(touch.Y));
					break;
				case IosHidDelay delay:
					RequireDuration(delay.Duration, nameof(delay.Duration));
					break;
				case IosHidSwipe swipe:
					RequireFinite(swipe.StartX, nameof(swipe.StartX));
					RequireFinite(swipe.StartY, nameof(swipe.StartY));
					RequireFinite(swipe.EndX, nameof(swipe.EndX));
					RequireFinite(swipe.EndY, nameof(swipe.EndY));
					RequireDuration(swipe.Duration, nameof(swipe.Duration));
					break;
				case IosHidKey key when key.Usage <= ushort.MaxValue:
				break;
				case IosHidKey key:
				throw new ArgumentOutOfRangeException(
					nameof(key.Usage),
					"USB HID usages must be between 0 and 65535.");
				case IosHidButtonPress:
				break;
				default:
					throw new ArgumentOutOfRangeException(
						nameof(events),
						hidEvent,
						"Unsupported iOS HID event.");
			}
		}
	}

	public static string SerializeRequest(long id, IReadOnlyList<IosHidEvent> events)
	{
		if (id <= 0)
			throw new ArgumentOutOfRangeException(nameof(id), "Request IDs must be positive.");
		ValidateEvents(events);

		var buffer = new ArrayBufferWriter<byte>();
		using (var writer = new Utf8JsonWriter(buffer))
		{
			writer.WriteStartObject();
			writer.WriteNumber("version", Version);
			writer.WriteNumber("id", id);
			writer.WriteString("type", "events");
			writer.WriteStartArray("events");
			foreach (var hidEvent in events)
				WriteEvent(writer, hidEvent);
			writer.WriteEndArray();
			writer.WriteEndObject();
		}

		return Encoding.UTF8.GetString(buffer.WrittenSpan);
	}

	public static CoreSimulatorHidResponse ParseResponse(string line)
	{
		if (string.IsNullOrWhiteSpace(line))
			throw new InvalidDataException("The CoreSimulator HID helper emitted an empty protocol line.");

		JsonDocument document;
		try
		{
			document = JsonDocument.Parse(line);
		}
		catch (JsonException exception)
		{
			throw new InvalidDataException(
				"The CoreSimulator HID helper emitted malformed JSON.",
				exception);
		}

		using (document)
		{
			var root = document.RootElement;
			if (root.ValueKind != JsonValueKind.Object)
				throw new InvalidDataException("A CoreSimulator HID response must be a JSON object.");

			var type = RequireString(root, "type");
			var version = ReadVersion(root, type);
			return type switch
			{
				"ready" => ParseReady(root, version),
				"unavailable" => new CoreSimulatorHidUnavailable(
					version,
					OptionalString(root, "code") ?? "unavailable",
					OptionalString(root, "message") ?? "CoreSimulator HID is unavailable."),
				"result" => ParseResult(root, version, null),
				"success" => ParseResult(root, version, success: true),
				"error" => ParseResult(root, version, success: false),
				"fatal" => new CoreSimulatorHidFatal(
					version,
					OptionalString(root, "code") ?? "transport_failed",
					OptionalString(root, "message") ?? "The CoreSimulator HID transport failed."),
				_ => throw new InvalidDataException(
					$"Unknown CoreSimulator HID response type '{type}'."),
			};
		}
	}

	private static CoreSimulatorHidReady ParseReady(JsonElement root, int version)
	{
		var capabilities = new List<string>();
		if (root.TryGetProperty("capabilities", out var values))
		{
			if (values.ValueKind != JsonValueKind.Array)
				throw new InvalidDataException("The HID ready capabilities must be an array.");
			foreach (var value in values.EnumerateArray())
			{
				if (value.ValueKind != JsonValueKind.String)
					throw new InvalidDataException("Every HID capability must be a string.");
				capabilities.Add(value.GetString()!);
			}
		}

		return new CoreSimulatorHidReady(
			version,
			RequireString(root, "transport"),
			capabilities);
	}

	private static CoreSimulatorHidResult ParseResult(
		JsonElement root,
		int version,
		bool? success)
	{
		var id = RequireInt64(root, "id");
		if (success is null)
		{
			if (root.TryGetProperty("success", out var successValue) &&
				successValue.ValueKind is JsonValueKind.True or JsonValueKind.False)
			{
				success = successValue.GetBoolean();
			}
			else if (root.TryGetProperty("ok", out var okValue) &&
				okValue.ValueKind is JsonValueKind.True or JsonValueKind.False)
			{
				success = okValue.GetBoolean();
			}
			else
			{
				throw new InvalidDataException("A HID result must contain a boolean success value.");
			}
		}

		var beforeDelivery = root.TryGetProperty("beforeDelivery", out var deliveryValue) &&
			deliveryValue.ValueKind is JsonValueKind.True or JsonValueKind.False &&
			deliveryValue.GetBoolean();

		return new CoreSimulatorHidResult(
			version,
			id,
			success.Value,
			OptionalString(root, "code"),
			OptionalString(root, "message"),
			beforeDelivery);
	}

	private static void WriteEvent(Utf8JsonWriter writer, IosHidEvent hidEvent)
	{
		writer.WriteStartObject();
		switch (hidEvent)
		{
			case IosHidTouch touch:
				writer.WriteString("type", "touch");
				writer.WriteNumber("x", touch.X);
				writer.WriteNumber("y", touch.Y);
				writer.WriteString("phase", touch.Phase switch
				{
					IosHidTouchPhase.Down => "down",
					IosHidTouchPhase.Move => "move",
					IosHidTouchPhase.Up => "up",
					_ => throw new ArgumentOutOfRangeException(nameof(touch.Phase)),
				});
				break;
			case IosHidDelay delay:
				writer.WriteString("type", "delay");
				writer.WriteNumber("duration", delay.Duration);
				break;
			case IosHidSwipe swipe:
				writer.WriteString("type", "swipe");
				writer.WriteNumber("startX", swipe.StartX);
				writer.WriteNumber("startY", swipe.StartY);
				writer.WriteNumber("endX", swipe.EndX);
				writer.WriteNumber("endY", swipe.EndY);
				writer.WriteNumber("duration", swipe.Duration);
				break;
			case IosHidKey key:
				writer.WriteString("type", "key");
				writer.WriteNumber("usage", key.Usage);
				writer.WriteString(
					"direction",
					key.Direction == IosHidDirection.Down ? "down" : "up");
				break;
			case IosHidButtonPress button:
				writer.WriteString("type", "button");
				writer.WriteString("button", button.Button switch
				{
					IosHidButton.Home => "home",
					IosHidButton.Lock => "lock",
					IosHidButton.SideButton => "side-button",
					IosHidButton.Siri => "siri",
					IosHidButton.ApplePay => "apple-pay",
					_ => throw new ArgumentOutOfRangeException(nameof(button.Button)),
				});
				break;
			default:
				throw new ArgumentOutOfRangeException(
					nameof(hidEvent),
					hidEvent,
					"Unsupported iOS HID event.");
		}
		writer.WriteEndObject();
	}

	private static int RequireInt32(JsonElement root, string name)
	{
		if (!root.TryGetProperty(name, out var value) || !value.TryGetInt32(out var result))
			throw new InvalidDataException($"A CoreSimulator HID response requires integer '{name}'.");
		return result;
	}

	private static int ReadVersion(JsonElement root, string type)
	{
		if (root.TryGetProperty("version", out var version) && version.TryGetInt32(out var declared))
			return declared;
		if (root.TryGetProperty("protocolVersion", out var protocolVersion) &&
			protocolVersion.TryGetInt32(out declared))
		{
			return declared;
		}

		// Version 1 result and fatal frames omit the version after startup has negotiated it.
		if (type is "result" or "success" or "error" or "fatal")
			return Version;

		throw new InvalidDataException(
			"A CoreSimulator HID startup response requires integer 'protocolVersion'.");
	}

	private static long RequireInt64(JsonElement root, string name)
	{
		if (!root.TryGetProperty(name, out var value) || !value.TryGetInt64(out var result) || result <= 0)
			throw new InvalidDataException($"A CoreSimulator HID response requires positive integer '{name}'.");
		return result;
	}

	private static string RequireString(JsonElement root, string name) =>
		OptionalString(root, name)
		?? throw new InvalidDataException($"A CoreSimulator HID response requires string '{name}'.");

	private static string? OptionalString(JsonElement root, string name) =>
		root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
			? value.GetString()
			: null;

	private static void RequireFinite(double value, string name)
	{
		if (!double.IsFinite(value))
			throw new ArgumentOutOfRangeException(name, "HID coordinates must be finite.");
	}

	private static void RequireDuration(double value, string name)
	{
		if (!double.IsFinite(value) || value is < 0 or > 600)
			throw new ArgumentOutOfRangeException(name, "HID durations must be between 0 and 600 seconds.");
	}
}
