using System.Text.Json;
using MobileCanvas.Core;

namespace MobileCanvas.iOS;

internal sealed class NativeAccessibilityException(string message, Exception? innerException = null)
	: IOException(message, innerException);

/// <summary>Reads the iOS Simulator hierarchy through the bundled native helper.</summary>
internal sealed class NativeAccessibilityReader(IProcessRunner processRunner)
{
	public Task<string> ReadAsync(
		string udid,
		string? developerDirectory,
		CancellationToken cancellationToken) =>
		ReadAsync(
			processRunner,
			NativeHelperLocator.Path,
			udid,
			developerDirectory,
			cancellationToken);

	internal static async Task<string> ReadAsync(
		IProcessRunner processRunner,
		string? helperPath,
		string udid,
		string? developerDirectory,
		CancellationToken cancellationToken)
	{
		if (string.IsNullOrWhiteSpace(helperPath))
		{
			throw new NativeAccessibilityException(
				$"{NativeHelperLocator.ExecutableName} was not found next to mobile-canvas.");
		}

		var arguments = new List<string> { "accessibility", "--udid", udid };
		if (!string.IsNullOrWhiteSpace(developerDirectory))
		{
			arguments.Add("--developer-dir");
			arguments.Add(developerDirectory);
		}

		ProcessResult result;
		try
		{
			result = await processRunner.RunAsync(
				new ProcessRequest(helperPath, arguments),
				cancellationToken).ConfigureAwait(false);
		}
		catch (OperationCanceledException)
		{
			throw;
		}
		catch (Exception exception) when (
			exception is IOException
				or UnauthorizedAccessException
				or InvalidOperationException)
		{
			throw new NativeAccessibilityException(
				$"Could not run the bundled accessibility reader: {exception.Message}",
				exception);
		}

		if (result.ExitCode != 0)
		{
			throw new NativeAccessibilityException(
				ExtractError(result.StandardError, result.StandardOutput));
		}

		var json = result.StandardOutput.Trim();
		if (AccessibilityParser.Parse(json) is null)
			throw new NativeAccessibilityException("The bundled accessibility reader returned an invalid hierarchy.");

		return json;
	}

	internal static string ExtractError(string standardError, string standardOutput)
	{
		foreach (var line in new[] { standardError, standardOutput }
			.SelectMany(value => value.Split('\n', StringSplitOptions.RemoveEmptyEntries).Reverse()))
		{
			try
			{
				using var document = JsonDocument.Parse(line);
				var root = document.RootElement;
				if (root.ValueKind == JsonValueKind.Object &&
					root.TryGetProperty("message", out var message) &&
					message.ValueKind == JsonValueKind.String &&
					!string.IsNullOrWhiteSpace(message.GetString()))
				{
					return message.GetString()!;
				}
			}
			catch (JsonException)
			{
				// Keep looking for a structured error line before falling back to raw process output.
			}
		}

		var detail = string.IsNullOrWhiteSpace(standardError)
			? standardOutput.Trim()
			: standardError.Trim();
		return string.IsNullOrWhiteSpace(detail)
			? "The bundled accessibility reader exited without an error message."
			: detail;
	}
}
