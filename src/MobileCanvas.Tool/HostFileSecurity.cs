using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;

namespace MobileCanvas.Tool;

/// <summary>
/// Owner-only access control for the host's private state. The host home holds the control token
/// that authorizes device automation, so on Windows the inherited profile ACL is replaced with a
/// protected DACL that grants the current user alone. Unix keeps the 0700/0600 modes it already
/// used; the two platforms express the same rule with their own primitives.
///
/// Every entry point is idempotent: the current descriptor is read first and left untouched when
/// it already grants nobody else, so repeated host starts do not rewrite security descriptors.
/// </summary>
internal static class HostFileSecurity
{
	private const UnixFileMode PrivateDirectoryMode =
		UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
	private const UnixFileMode PrivateFileMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;

	public static void CreatePrivateDirectory(string path)
	{
		if (OperatingSystem.IsWindows())
		{
			WindowsAcl.CreateOwnerOnlyDirectory(path);
			return;
		}

		Directory.CreateDirectory(path);
		File.SetUnixFileMode(path, PrivateDirectoryMode);
	}

	/// <summary>
	/// Restricts a file that already exists. Files are created with the right descriptor wherever
	/// the platform allows it, so this is the repair path for state written by earlier versions.
	/// </summary>
	public static void ProtectExistingFile(string path)
	{
		if (!File.Exists(path))
			return;
		if (OperatingSystem.IsWindows())
		{
			WindowsAcl.ProtectFile(path);
			return;
		}

		File.SetUnixFileMode(path, PrivateFileMode);
	}

	/// <summary>
	/// Creates or opens a private file, applying the owner-only descriptor at creation time on
	/// Windows so a secret is never briefly readable by other accounts.
	/// </summary>
	public static FileStream OpenPrivateFile(
		string path,
		FileMode mode,
		FileAccess access,
		FileShare share)
	{
		if (OperatingSystem.IsWindows())
			return WindowsAcl.OpenOwnerOnlyFile(path, mode, access, share);

		var stream = new FileStream(path, mode, access, share);
		try
		{
			File.SetUnixFileMode(path, PrivateFileMode);
		}
		catch (IOException)
		{
			stream.Dispose();
			throw;
		}
		catch (UnauthorizedAccessException)
		{
			stream.Dispose();
			throw;
		}
		return stream;
	}
}

[SupportedOSPlatform("windows")]
internal static class WindowsAcl
{
	private static SecurityIdentifier? owner;

	/// <summary>
	/// The account the host runs as. Read once: the identity cannot change inside a process, and
	/// every protected path uses the same single-ACE descriptor.
	/// </summary>
	public static SecurityIdentifier Owner => owner ??= CurrentUser();

	public static DirectorySecurity CreateDirectorySecurity()
	{
		var security = new DirectorySecurity();
		security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
		security.AddAccessRule(new FileSystemAccessRule(
			Owner,
			FileSystemRights.FullControl,
			InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
			PropagationFlags.None,
			AccessControlType.Allow));
		return security;
	}

	public static FileSecurity CreateFileSecurity()
	{
		var security = new FileSecurity();
		security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
		security.AddAccessRule(new FileSystemAccessRule(
			Owner,
			FileSystemRights.FullControl,
			AccessControlType.Allow));
		return security;
	}

	public static void CreateOwnerOnlyDirectory(string path)
	{
		var directory = new DirectoryInfo(path);
		if (!directory.Exists)
		{
			// Created with the descriptor rather than created and then repaired: a directory that
			// briefly inherits the profile ACL is a directory another account can read from.
			directory.Create(CreateDirectorySecurity());
			return;
		}

		if (GrantsOwnerOnly(directory.GetAccessControl(AccessControlSections.Access)))
			return;
		directory.SetAccessControl(CreateDirectorySecurity());
	}

	public static void ProtectFile(string path)
	{
		var file = new FileInfo(path);
		if (!file.Exists ||
			GrantsOwnerOnly(file.GetAccessControl(AccessControlSections.Access)))
		{
			return;
		}
		file.SetAccessControl(CreateFileSecurity());
	}

	public static FileStream OpenOwnerOnlyFile(
		string path,
		FileMode mode,
		FileAccess access,
		FileShare share)
	{
		// A security descriptor supplied at open time only applies when the file is created, so an
		// existing file is repaired first, while no handle is held that would block a DACL write.
		ProtectFile(path);
		return new FileInfo(path).Create(
			mode,
			access == FileAccess.Read ? FileSystemRights.Read : FileSystemRights.FullControl,
			share,
			bufferSize: 4096,
			FileOptions.None,
			CreateFileSecurity());
	}

	/// <summary>
	/// True when a descriptor already grants the host's own account and nothing else. Kept separate
	/// from the file system so the rule that decides "this is already locked down" is testable.
	/// </summary>
	public static bool GrantsOwnerOnly(FileSystemSecurity security) =>
		GrantsOwnerOnly(security, Owner);

	public static bool GrantsOwnerOnly(FileSystemSecurity security, SecurityIdentifier expected)
	{
		if (!security.AreAccessRulesProtected)
			return false;

		var rules = security.GetAccessRules(
			includeExplicit: true,
			includeInherited: true,
			typeof(SecurityIdentifier));
		if (rules.Count == 0)
			return false;

		foreach (AuthorizationRule rule in rules)
		{
			if (rule is not FileSystemAccessRule access ||
				access.AccessControlType != AccessControlType.Allow ||
				!expected.Equals(access.IdentityReference) ||
				(access.FileSystemRights & FileSystemRights.FullControl) != FileSystemRights.FullControl)
			{
				return false;
			}
		}
		return true;
	}

	private static SecurityIdentifier CurrentUser()
	{
		using var identity = WindowsIdentity.GetCurrent();
		return identity.User
			?? throw new InvalidOperationException(
				"The current Windows identity has no user SID, so host state cannot be secured.");
	}
}
