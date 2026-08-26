using System.Diagnostics.CodeAnalysis;
using MobileCanvas.Core;

namespace MobileCanvas.iOS;

internal enum SimulatorKitLayout
{
	DeveloperPrivateFrameworks,
	SharedFrameworks,
}

internal sealed record SimulatorKitInstallation(
	string DeveloperDirectory,
	string FrameworkPath,
	string LegacyFrameworkPath,
	string SharedFrameworkPath,
	SimulatorKitLayout Layout)
{
	public string PrepareIdbDeveloperDirectory(string workingDirectory)
	{
		if (Layout == SimulatorKitLayout.DeveloperPrivateFrameworks)
			return DeveloperDirectory;

		// Homebrew's stable idb_companion still hard-codes the pre-Xcode 27 path. Give only that
		// process a private Xcode bundle view that exposes the moved framework at both layouts.
		var sourceDeveloper = new DirectoryInfo(DeveloperDirectory);
		var sourceContents = sourceDeveloper.Parent
			?? throw new DirectoryNotFoundException(
				$"Xcode developer directory '{DeveloperDirectory}' has no Contents directory.");
		var destinationContents = Path.Combine(workingDirectory, "Xcode.app", "Contents");
		var destinationDeveloper = Path.Combine(destinationContents, "Developer");

		MirrorDirectory(sourceContents.FullName, destinationContents, "Developer");
		MirrorDirectory(sourceDeveloper.FullName, destinationDeveloper, "Library");

		var sourceLibrary = Path.Combine(sourceDeveloper.FullName, "Library");
		var destinationLibrary = Path.Combine(destinationDeveloper, "Library");
		MirrorDirectory(sourceLibrary, destinationLibrary, "PrivateFrameworks");

		var sourcePrivateFrameworks = Path.Combine(sourceLibrary, "PrivateFrameworks");
		var destinationPrivateFrameworks = Path.Combine(destinationLibrary, "PrivateFrameworks");
		if (Directory.Exists(sourcePrivateFrameworks))
			MirrorDirectory(sourcePrivateFrameworks, destinationPrivateFrameworks, "SimulatorKit.framework");
		else
			Directory.CreateDirectory(destinationPrivateFrameworks);

		Directory.CreateSymbolicLink(
			Path.Combine(destinationPrivateFrameworks, "SimulatorKit.framework"),
			FrameworkPath);
		return destinationDeveloper;
	}

	private static void MirrorDirectory(string source, string destination, string excludedName)
	{
		if (!Directory.Exists(source))
			throw new DirectoryNotFoundException($"Required Xcode directory '{source}' does not exist.");

		Directory.CreateDirectory(destination);
		foreach (var entry in Directory.EnumerateFileSystemEntries(source))
		{
			var name = Path.GetFileName(entry);
			if (name.Equals(excludedName, StringComparison.Ordinal))
				continue;

			var link = Path.Combine(destination, name);
			if (Directory.Exists(entry))
				Directory.CreateSymbolicLink(link, entry);
			else
				File.CreateSymbolicLink(link, entry);
		}
	}
}

internal static class SimulatorKitLocator
{
	private const string FrameworkName = "SimulatorKit.framework";

	public static async Task<SimulatorKitInstallation> ResolveSelectedAsync(
		IProcessRunner processRunner,
		CancellationToken cancellationToken)
	{
		var developerDirectory = await XcodeDeveloperDirectory.ResolveSelectedAsync(
			processRunner,
			cancellationToken).ConfigureAwait(false);
		return Resolve(developerDirectory);
	}

	public static SimulatorKitInstallation Resolve(string developerDirectory)
	{
		if (TryResolve(developerDirectory, out var installation))
			return installation;

		throw new DirectoryNotFoundException(GetMissingFrameworkMessage(developerDirectory));
	}

	public static bool TryResolve(
		string developerDirectory,
		[NotNullWhen(true)] out SimulatorKitInstallation? installation)
	{
		var fullDeveloperDirectory = Path.GetFullPath(developerDirectory);
		var legacyPath = Path.Combine(
			fullDeveloperDirectory,
			"Library",
			"PrivateFrameworks",
			FrameworkName);
		var sharedPath = Path.GetFullPath(Path.Combine(
			fullDeveloperDirectory,
			"..",
			"SharedFrameworks",
			FrameworkName));

		if (Directory.Exists(legacyPath))
		{
			installation = new SimulatorKitInstallation(
				fullDeveloperDirectory,
				legacyPath,
				legacyPath,
				sharedPath,
				SimulatorKitLayout.DeveloperPrivateFrameworks);
			return true;
		}

		if (Directory.Exists(sharedPath))
		{
			installation = new SimulatorKitInstallation(
				fullDeveloperDirectory,
				sharedPath,
				legacyPath,
				sharedPath,
				SimulatorKitLayout.SharedFrameworks);
			return true;
		}

		installation = null;
		return false;
	}

	public static string GetMissingFrameworkMessage(string developerDirectory)
	{
		var fullDeveloperDirectory = Path.GetFullPath(developerDirectory);
		var legacyPath = Path.Combine(
			fullDeveloperDirectory,
			"Library",
			"PrivateFrameworks",
			FrameworkName);
		var sharedPath = Path.GetFullPath(Path.Combine(
			fullDeveloperDirectory,
			"..",
			"SharedFrameworks",
			FrameworkName));
		return $"SimulatorKit.framework was not found for the selected Xcode developer directory "
			+ $"'{fullDeveloperDirectory}'. Expected either '{legacyPath}' (Xcode 26 and earlier) or "
			+ $"'{sharedPath}' (Xcode 27 and later). Set DEVELOPER_DIR when launching Mobile Canvas "
			+ "to a full Xcode installation, or select that installation with xcode-select.";
	}
}
