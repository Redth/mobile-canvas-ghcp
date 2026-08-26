using System.Text.Json;
using MobileCanvas.Core;

namespace MobileCanvas.iOS;

internal sealed record CoreSimulatorHidDoctorResult
{
	public bool HelperAvailable { get; init; }
	public bool Negotiable { get; init; }
	public bool CoreSimulatorAvailable { get; init; }
	public bool DtuHidSymbolsAvailable { get; init; }
	public bool LegacyKeyboardSuppressed { get; init; }
	public string? CoreSimulatorVersion { get; init; }
	public string? TransportPolicy { get; init; }
	public string? SimulatorKitPath { get; init; }
	public string Detail { get; init; } = "";
}

internal static class CoreSimulatorHidDoctor
{
	public static async Task<CoreSimulatorHidDoctorResult> ProbeAsync(
		IProcessRunner processRunner,
		string? developerDirectory,
		CancellationToken cancellationToken)
	{
		var helperPath = NativeHelperLocator.Path;
		if (helperPath is null)
		{
			return new CoreSimulatorHidDoctorResult
			{
				Detail =
					$"{NativeHelperLocator.ExecutableName} was not found next to mobile-canvas.",
			};
		}

		if (string.IsNullOrWhiteSpace(developerDirectory))
		{
			return new CoreSimulatorHidDoctorResult
			{
				HelperAvailable = true,
				Detail = "Select a full Xcode installation before checking CoreSimulator HID.",
			};
		}

		ProcessResult result;
		try
		{
			result = await processRunner.RunAsync(
				new ProcessRequest(
					helperPath,
					["hid-doctor", "--developer-dir", developerDirectory]),
				cancellationToken).ConfigureAwait(false);
		}
		catch (OperationCanceledException)
		{
			throw;
		}
		catch (Exception exception) when (
			exception is IOException or UnauthorizedAccessException or InvalidOperationException)
		{
			return new CoreSimulatorHidDoctorResult
			{
				HelperAvailable = true,
				Detail = $"Could not run the bundled HID diagnostic: {exception.Message}",
			};
		}

		try
		{
			return Parse(result.StandardOutput) with { HelperAvailable = true };
		}
		catch (InvalidDataException exception)
		{
			var detail = string.IsNullOrWhiteSpace(result.StandardError)
				? exception.Message
				: result.StandardError.Trim();
			return new CoreSimulatorHidDoctorResult
			{
				HelperAvailable = true,
				Detail = $"The bundled HID diagnostic returned invalid output: {detail}",
			};
		}
	}

	internal static CoreSimulatorHidDoctorResult Parse(string json)
	{
		JsonDocument document;
		try
		{
			document = JsonDocument.Parse(json);
		}
		catch (JsonException exception)
		{
			throw new InvalidDataException("hid-doctor did not return JSON.", exception);
		}

		using (document)
		{
			var root = document.RootElement;
			if (root.ValueKind != JsonValueKind.Object ||
				!root.TryGetProperty("type", out var type) ||
				type.GetString() != "hid-doctor")
			{
				throw new InvalidDataException("hid-doctor returned an unexpected response type.");
			}
			if (!root.TryGetProperty("protocolVersion", out var version) ||
				!version.TryGetInt32(out var protocolVersion) ||
				protocolVersion != CoreSimulatorHidProtocol.Version)
			{
				throw new InvalidDataException("hid-doctor returned an unsupported protocol version.");
			}

			return new CoreSimulatorHidDoctorResult
			{
				Negotiable = RequireBoolean(root, "negotiable"),
				CoreSimulatorAvailable = RequireBoolean(root, "coreSimulatorAvailable"),
				DtuHidSymbolsAvailable = RequireBoolean(root, "dtuhidSymbolsAvailable"),
				LegacyKeyboardSuppressed = RequireBoolean(root, "legacyKeyboardSuppressed"),
				CoreSimulatorVersion = GetString(root, "coreSimulatorVersion"),
				TransportPolicy = RequireString(root, "transportPolicy"),
				SimulatorKitPath = GetString(root, "simulatorKitPath"),
				Detail = RequireString(root, "detail"),
			};
		}
	}

	private static bool RequireBoolean(JsonElement root, string name)
	{
		if (!root.TryGetProperty(name, out var value) ||
			value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
		{
			throw new InvalidDataException($"hid-doctor omitted boolean '{name}'.");
		}
		return value.GetBoolean();
	}

	private static string RequireString(JsonElement root, string name) =>
		GetString(root, name)
		?? throw new InvalidDataException($"hid-doctor omitted string '{name}'.");

	private static string? GetString(JsonElement root, string name) =>
		root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
			? value.GetString()
			: null;
}
