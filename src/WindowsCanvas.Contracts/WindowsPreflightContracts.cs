namespace WindowsCanvas.Contracts;

/// <summary>
/// What the Windows surface can actually do on this machine right now, and what to do about it
/// when it cannot. Every Windows endpoint answers this before it answers anything else, so a
/// missing, stale, or unsigned helper produces one actionable diagnostic instead of a different
/// obscure failure per feature.
/// </summary>
public sealed record WindowsPreflight
{
	public string SchemaVersion { get; init; } = WindowsCanvasProtocol.Version;

	/// <summary>Whether discovery, launch, and attach can run.</summary>
	public bool Ready { get; init; }

	/// <summary>Whether this process is running on Windows at all.</summary>
	public bool PlatformSupported { get; init; }

	/// <summary>Machine-readable reason <see cref="Ready"/> is false, from <see cref="WindowsErrorCodes"/>.</summary>
	public string? Code { get; init; }

	/// <summary>One sentence a user can act on, such as which file is missing and where.</summary>
	public string? Detail { get; init; }

	/// <summary>Where the host looked for the helper, so a packaging mistake is visible.</summary>
	public string? HelperPath { get; init; }
	public bool HelperPresent { get; init; }
	public string? HelperVersion { get; init; }
	public string? HelperArchitecture { get; init; }
	public int HelperSchemaVersion { get; init; }

	/// <summary>
	/// Authenticode state of the helper: <c>valid</c>, <c>unsigned</c>, <c>invalid</c>, or absent
	/// when the helper never ran. Development builds are unsigned on purpose, so this is reported
	/// rather than enforced, and it is never silently claimed to be signed.
	/// </summary>
	public string? SignatureStatus { get; init; }
	public bool SignatureValid { get; init; }

	public WindowsFeatureState[] Features { get; init; } = [];
	public WindowsSessionEnvironment? Environment { get; init; }
}

public sealed record WindowsFeatureState
{
	public string Name { get; init; } = "";
	public bool Available { get; init; }
	public string? Detail { get; init; }
}

/// <summary>The Windows logon session and integrity the host is working inside.</summary>
public sealed record WindowsSessionEnvironment
{
	public uint SessionId { get; init; }
	public bool Interactive { get; init; }
	public string IntegrityLevel { get; init; } = WindowsIntegrityLevels.Unknown;
	public uint IntegrityValue { get; init; }
	public string? OperatingSystem { get; init; }
}

public static class WindowsFeatureNames
{
	public const string ShellAppCatalog = "shellAppCatalog";
	public const string UiAutomation = "uiAutomation";
	public const string WindowsGraphicsCapture = "windowsGraphicsCapture";
	public const string MediaFoundationH264 = "mediaFoundationH264";
	public const string SendInput = "sendInput";
}
