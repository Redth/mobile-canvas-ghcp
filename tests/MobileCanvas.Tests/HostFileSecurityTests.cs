using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using MobileCanvas.Tool;

namespace MobileCanvas.Tests;

/// <summary>A fact that only runs where the platform's access control model applies.</summary>
public sealed class WindowsFactAttribute : FactAttribute
{
	public WindowsFactAttribute()
	{
		if (!OperatingSystem.IsWindows())
			Skip = "Windows access control is only observable on Windows.";
	}
}

public sealed class UnixFactAttribute : FactAttribute
{
	public UnixFactAttribute()
	{
		if (OperatingSystem.IsWindows())
			Skip = "Unix file modes are only observable off Windows.";
	}
}

public sealed class MacFactAttribute : FactAttribute
{
	public MacFactAttribute()
	{
		if (!OperatingSystem.IsMacOS())
			Skip = "This behavior depends on the macOS Simulator runtime.";
	}
}

public sealed class HostFileSecurityTests : IDisposable
{
	private readonly string root = Path.Combine(
		AppContext.BaseDirectory,
		"host-security-tests",
		Guid.NewGuid().ToString("n"));

	public HostFileSecurityTests() => Directory.CreateDirectory(root);

	public void Dispose()
	{
		if (Directory.Exists(root))
			Directory.Delete(root, recursive: true);
	}

	[Fact]
	public void PrivateDirectories_CoverTheHomeHostsAndProtocolDirectories()
	{
		var home = Path.Combine("home", ".mobile-canvas");

		var directories = DevicePaths.PrivateDirectoriesFor(home, "1.0").ToArray();

		Assert.Equal(
			[
				home,
				Path.Combine(home, "hosts"),
				Path.Combine(home, "hosts", "v1.0"),
			],
			directories);
	}

	[Fact]
	public void CreatePrivateDirectory_IsIdempotentAndKeepsExistingContent()
	{
		var path = Path.Combine(root, "home");
		HostFileSecurity.CreatePrivateDirectory(path);
		File.WriteAllText(Path.Combine(path, "host.json"), "{}");

		HostFileSecurity.CreatePrivateDirectory(path);

		Assert.True(Directory.Exists(path));
		Assert.Equal("{}", File.ReadAllText(Path.Combine(path, "host.json")));
	}

	[Fact]
	public void OpenPrivateFile_CreatesAWritableFile()
	{
		var path = Path.Combine(root, "host.lock");

		using (var stream = HostFileSecurity.OpenPrivateFile(
			path,
			FileMode.OpenOrCreate,
			FileAccess.ReadWrite,
			FileShare.None))
		{
			stream.WriteByte(1);
		}

		Assert.Equal(1, new FileInfo(path).Length);
	}

	[Fact]
	public void ProtectExistingFile_IgnoresAMissingFile()
	{
		HostFileSecurity.ProtectExistingFile(Path.Combine(root, "absent.json"));
	}

	[UnixFact]
	[UnsupportedOSPlatform("windows")]
	public void CreatePrivateDirectory_KeepsUnixOwnerOnlyMode()
	{
		var path = Path.Combine(root, "unix-home");

		HostFileSecurity.CreatePrivateDirectory(path);

		Assert.Equal(
			UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute,
			File.GetUnixFileMode(path));
	}

	[UnixFact]
	[UnsupportedOSPlatform("windows")]
	public void OpenPrivateFile_KeepsUnixOwnerOnlyMode()
	{
		var path = Path.Combine(root, "unix-host.json");

		using (HostFileSecurity.OpenPrivateFile(path, FileMode.Create, FileAccess.Write, FileShare.None))
		{
		}

		Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
	}

	[WindowsFact]
	[SupportedOSPlatform("windows")]
	public void CreatePrivateDirectory_GrantsTheOwnerAlone()
	{
		var path = Path.Combine(root, "windows-home");

		HostFileSecurity.CreatePrivateDirectory(path);

		var security = new DirectoryInfo(path).GetAccessControl(AccessControlSections.Access);
		Assert.True(security.AreAccessRulesProtected);
		Assert.True(WindowsAcl.GrantsOwnerOnly(security));
		var rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier));
		var rule = Assert.IsType<FileSystemAccessRule>(Assert.Single(rules.Cast<AuthorizationRule>()));
		Assert.Equal(WindowsAcl.Owner, rule.IdentityReference);
	}

	[WindowsFact]
	[SupportedOSPlatform("windows")]
	public void CreatePrivateDirectory_LeavesAnAlreadyProtectedDirectoryUntouched()
	{
		var path = Path.Combine(root, "windows-home");
		HostFileSecurity.CreatePrivateDirectory(path);
		var before = Descriptor(path);

		HostFileSecurity.CreatePrivateDirectory(path);

		Assert.Equal(before, Descriptor(path));
	}

	[WindowsFact]
	[SupportedOSPlatform("windows")]
	public void CreatePrivateDirectory_RepairsADirectoryThatInheritedTheProfileAcl()
	{
		var path = Path.Combine(root, "inherited");
		Directory.CreateDirectory(path);
		Assert.False(WindowsAcl.GrantsOwnerOnly(
			new DirectoryInfo(path).GetAccessControl(AccessControlSections.Access)));

		HostFileSecurity.CreatePrivateDirectory(path);

		Assert.True(WindowsAcl.GrantsOwnerOnly(
			new DirectoryInfo(path).GetAccessControl(AccessControlSections.Access)));
	}

	[WindowsFact]
	[SupportedOSPlatform("windows")]
	public void OpenPrivateFile_AppliesTheOwnerOnlyDescriptorAtCreation()
	{
		var path = Path.Combine(root, "host.json");

		using (var stream = HostFileSecurity.OpenPrivateFile(
			path,
			FileMode.Create,
			FileAccess.Write,
			FileShare.None))
		{
			stream.WriteByte(42);
		}

		Assert.True(WindowsAcl.GrantsOwnerOnly(
			new FileInfo(path).GetAccessControl(AccessControlSections.Access)));
	}

	[WindowsFact]
	[SupportedOSPlatform("windows")]
	public void ProtectExistingFile_RepairsAndThenLeavesTheDescriptorAlone()
	{
		var path = Path.Combine(root, "legacy-host.json");
		File.WriteAllText(path, "{}");
		Assert.False(WindowsAcl.GrantsOwnerOnly(
			new FileInfo(path).GetAccessControl(AccessControlSections.Access)));

		HostFileSecurity.ProtectExistingFile(path);
		var repaired = Descriptor(path, directory: false);
		HostFileSecurity.ProtectExistingFile(path);

		Assert.True(WindowsAcl.GrantsOwnerOnly(
			new FileInfo(path).GetAccessControl(AccessControlSections.Access)));
		Assert.Equal(repaired, Descriptor(path, directory: false));
		Assert.Equal("{}", File.ReadAllText(path));
	}

	[WindowsFact]
	[SupportedOSPlatform("windows")]
	public void GrantsOwnerOnly_RejectsADescriptorThatAlsoGrantsSomeoneElse()
	{
		var security = WindowsAcl.CreateDirectorySecurity();
		security.AddAccessRule(new FileSystemAccessRule(
			new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
			FileSystemRights.FullControl,
			InheritanceFlags.None,
			PropagationFlags.None,
			AccessControlType.Allow));

		Assert.False(WindowsAcl.GrantsOwnerOnly(security));
	}

	[WindowsFact]
	[SupportedOSPlatform("windows")]
	public void GrantsOwnerOnly_RejectsAnInheritedDescriptor()
	{
		var security = new DirectorySecurity();
		security.AddAccessRule(new FileSystemAccessRule(
			WindowsAcl.Owner,
			FileSystemRights.FullControl,
			InheritanceFlags.None,
			PropagationFlags.None,
			AccessControlType.Allow));

		Assert.False(WindowsAcl.GrantsOwnerOnly(security));
	}

	[SupportedOSPlatform("windows")]
	private static string Descriptor(string path, bool directory = true) =>
		directory
			? new DirectoryInfo(path)
				.GetAccessControl(AccessControlSections.Access)
				.GetSecurityDescriptorSddlForm(AccessControlSections.Access)
			: new FileInfo(path)
				.GetAccessControl(AccessControlSections.Access)
				.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
}
