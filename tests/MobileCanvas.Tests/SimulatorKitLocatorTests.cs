using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

public sealed class SimulatorKitLocatorTests
{
	[Fact]
	public void Resolve_UsesLegacyLayoutWithoutCompatibilityDirectory()
	{
		var (root, developerDirectory) = CreateXcode();
		try
		{
			var framework = Path.Combine(
				developerDirectory,
				"Library",
				"PrivateFrameworks",
				"SimulatorKit.framework");
			Directory.CreateDirectory(framework);

			var installation = SimulatorKitLocator.Resolve(developerDirectory);

			Assert.Equal(SimulatorKitLayout.DeveloperPrivateFrameworks, installation.Layout);
			Assert.Equal(framework, installation.FrameworkPath);
			Assert.Equal(
				developerDirectory,
				installation.PrepareIdbDeveloperDirectory(Path.Combine(root, "session")));
		}
		finally
		{
			Directory.Delete(root, recursive: true);
		}
	}

	[Fact]
	public void Resolve_MapsXcode27SharedLayoutForLegacyCompanions()
	{
		var (root, developerDirectory) = CreateXcode();
		try
		{
			var contents = Directory.GetParent(developerDirectory)!.FullName;
			var framework = Path.Combine(contents, "SharedFrameworks", "SimulatorKit.framework");
			Directory.CreateDirectory(framework);
			File.WriteAllText(Path.Combine(contents, "Info.plist"), "test");
			Directory.CreateDirectory(Path.Combine(developerDirectory, "usr", "bin"));
			Directory.CreateDirectory(Path.Combine(developerDirectory, "Library", "PrivateFrameworks"));
			var workingDirectory = Path.Combine(root, "session");
			Directory.CreateDirectory(workingDirectory);

			var installation = SimulatorKitLocator.Resolve(developerDirectory);
			var idbDeveloperDirectory = installation.PrepareIdbDeveloperDirectory(workingDirectory);

			Assert.Equal(SimulatorKitLayout.SharedFrameworks, installation.Layout);
			Assert.Equal(framework, installation.FrameworkPath);
			Assert.EndsWith(
				Path.Combine("Xcode.app", "Contents", "Developer"),
				idbDeveloperDirectory,
				StringComparison.Ordinal);
			var legacyLink = Path.Combine(
				idbDeveloperDirectory,
				"Library",
				"PrivateFrameworks",
				"SimulatorKit.framework");
			Assert.True(Directory.Exists(legacyLink));
			Assert.Equal(framework, new DirectoryInfo(legacyLink).LinkTarget);
			Assert.True(File.Exists(Path.Combine(idbDeveloperDirectory, "..", "Info.plist")));
			Assert.True(Directory.Exists(Path.Combine(idbDeveloperDirectory, "usr")));

			Directory.Delete(workingDirectory, recursive: true);
			Assert.True(Directory.Exists(framework));
		}
		finally
		{
			Directory.Delete(root, recursive: true);
		}
	}

	[Fact]
	public void Resolve_WhenNeitherLayoutExists_ExplainsBothExpectedPaths()
	{
		var (root, developerDirectory) = CreateXcode();
		try
		{
			var exception = Assert.Throws<DirectoryNotFoundException>(
				() => SimulatorKitLocator.Resolve(developerDirectory));

			Assert.Contains(
				Path.Combine(
					developerDirectory,
					"Library",
					"PrivateFrameworks",
					"SimulatorKit.framework"),
				exception.Message,
				StringComparison.Ordinal);
			Assert.Contains(
				Path.GetFullPath(Path.Combine(
					developerDirectory,
					"..",
					"SharedFrameworks",
					"SimulatorKit.framework")),
				exception.Message,
				StringComparison.Ordinal);
			Assert.Contains("DEVELOPER_DIR", exception.Message, StringComparison.Ordinal);
		}
		finally
		{
			Directory.Delete(root, recursive: true);
		}
	}

	private static (string Root, string DeveloperDirectory) CreateXcode()
	{
		var root = Directory.CreateTempSubdirectory("mobile-canvas-simulatorkit-").FullName;
		var developerDirectory = Path.Combine(root, "Xcode.app", "Contents", "Developer");
		Directory.CreateDirectory(Path.Combine(developerDirectory, "Library"));
		return (root, developerDirectory);
	}
}
