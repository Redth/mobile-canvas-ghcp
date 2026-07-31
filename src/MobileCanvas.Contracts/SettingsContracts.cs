namespace MobileCanvas.Contracts;

/// <summary>
/// The display and accessibility settings a developer usually needs to flip while testing: dark
/// mode, and the text size that breaks a layout.
/// </summary>
public sealed record DeviceSettings
{
	public string SchemaVersion { get; init; } = MobileCanvasProtocol.Version;
	public string DeviceId { get; init; } = "";
	public string Platform { get; init; } = "";

	/// <summary>One of the <see cref="DeviceAppearances"/> values, or null when unknown.</summary>
	public string? Appearance { get; init; }

	/// <summary>
	/// Text size as a multiplier, where 1.0 is the platform default. iOS reports named content size
	/// categories instead, so <see cref="ContentSize"/> carries the exact value there.
	/// </summary>
	public double? FontScale { get; init; }

	/// <summary>iOS content size category, such as <c>large</c> or <c>accessibility-extra-large</c>.</summary>
	public string? ContentSize { get; init; }

	public bool? IncreaseContrast { get; init; }
}

/// <summary>
/// Changes settings. Every property is optional; the ones left null are left alone.
/// </summary>
public sealed record DeviceSettingsRequest
{
	/// <summary>One of the <see cref="DeviceAppearances"/> values.</summary>
	public string? Appearance { get; init; }

	public double? FontScale { get; init; }

	/// <summary>An iOS content size category, or <c>increment</c> / <c>decrement</c> to step one.</summary>
	public string? ContentSize { get; init; }

	public bool? IncreaseContrast { get; init; }
}

public static class DeviceAppearances
{
	public const string Light = "light";
	public const string Dark = "dark";

	public static readonly string[] All = [Light, Dark];
}
