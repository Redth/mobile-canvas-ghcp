using MobileCanvas.Core;

namespace MobileCanvas.Tests;

public sealed class NativeHelperLocatorTests
{
	[Fact]
	public void Resolve_PrefersConfiguredPath()
	{
		var root = Directory.CreateTempSubdirectory("mobile-canvas-helper-").FullName;
		try
		{
			var bundled = CreateFile(root, NativeHelperLocator.ExecutableName);
			var configured = CreateFile(root, "configured-helper");

			var resolved = NativeHelperLocator.Resolve(root, configured);

			Assert.Equal(configured, resolved);
			Assert.NotEqual(bundled, resolved);
		}
		finally
		{
			Directory.Delete(root, recursive: true);
		}
	}

	[Theory]
	[InlineData("")]
	[InlineData("native")]
	[InlineData("runtimes/native")]
	[InlineData("bin")]
	public void Resolve_RecognizesAllPackagedLayouts(string relativeDirectory)
	{
		var root = Directory.CreateTempSubdirectory("mobile-canvas-helper-").FullName;
		try
		{
			var directory = relativeDirectory.Length == 0
				? root
				: Path.Combine(root, relativeDirectory);
			var helper = CreateFile(directory, NativeHelperLocator.ExecutableName);

			Assert.Equal(helper, NativeHelperLocator.Resolve(root, configuredPath: null));
		}
		finally
		{
			Directory.Delete(root, recursive: true);
		}
	}

	[Fact]
	public void Resolve_WalksToDevelopmentOutput()
	{
		var root = Directory.CreateTempSubdirectory("mobile-canvas-helper-").FullName;
		try
		{
			var helper = CreateFile(
				Path.Combine(root, "native", NativeHelperLocator.ExecutableName, "out"),
				NativeHelperLocator.ExecutableName);
			var baseDirectory = Path.Combine(root, "src", "MobileCanvas.Tool", "bin", "Debug");
			Directory.CreateDirectory(baseDirectory);

			Assert.Equal(helper, NativeHelperLocator.Resolve(baseDirectory, configuredPath: null));
		}
		finally
		{
			Directory.Delete(root, recursive: true);
		}
	}

	private static string CreateFile(string directory, string name)
	{
		Directory.CreateDirectory(directory);
		var path = Path.GetFullPath(Path.Combine(directory, name));
		File.WriteAllText(path, "test");
		return path;
	}
}
