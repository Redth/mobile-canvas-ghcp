using System.ComponentModel;
using System.Diagnostics;
using WindowsCanvas.Contracts;

namespace WindowsCanvas.Windows;

/// <summary>A process the host started, identified by more than its reusable process ID.</summary>
public readonly record struct WindowsLaunchedProcess(
	int ProcessId,
	DateTimeOffset? StartedAt,
	string ExecutablePath);

/// <summary>
/// Starts an executable the catalog cannot name. Behind an interface so the validation rules can
/// be tested without starting real processes, and so a non-Windows host can refuse cleanly.
/// </summary>
public interface IWindowsProcessLauncher
{
	WindowsLaunchedProcess Launch(string executablePath, string[] arguments, string? workingDirectory);
}

/// <summary>
/// The explicit-launch path, and the narrowest one that still starts an app.
///
/// It takes an absolute path to an existing <c>.exe</c> and a structured argument array. There is
/// no command-line string for Windows to re-parse, no PATH search, no Shell verb, no <c>runas</c>,
/// and no URL, because every one of those turns "launch this app" into "run whatever the caller
/// wrote". <c>UseShellExecute</c> stays false for the same reason: the Shell resolves things this
/// API is deliberately unable to express.
/// </summary>
public sealed class SystemWindowsProcessLauncher : IWindowsProcessLauncher
{
	public WindowsLaunchedProcess Launch(
		string executablePath,
		string[] arguments,
		string? workingDirectory)
	{
		var startInfo = new ProcessStartInfo
		{
			FileName = executablePath,
			UseShellExecute = false,
		};
		if (workingDirectory is not null)
			startInfo.WorkingDirectory = workingDirectory;
		foreach (var argument in arguments)
			startInfo.ArgumentList.Add(argument);

		Process process;
		try
		{
			process = Process.Start(startInfo)
				?? throw WindowsCanvasException.Gateway(
					WindowsErrorCodes.LaunchFailed,
					$"Windows did not start '{executablePath}'.");
		}
		catch (Win32Exception exception)
		{
			throw WindowsCanvasException.Gateway(
				WindowsErrorCodes.LaunchFailed,
				$"Windows refused to start '{executablePath}': {exception.Message}");
		}

		using (process)
		{
			DateTimeOffset? startedAt = null;
			try
			{
				startedAt = process.StartTime;
			}
			catch (InvalidOperationException)
			{
				// A process that exits immediately no longer reports a start time. The PID alone
				// is not an identity, so the session simply has no correlation hint to use.
			}
			catch (Win32Exception)
			{
			}

			return new WindowsLaunchedProcess(process.Id, startedAt, executablePath);
		}
	}
}

/// <summary>
/// Validates an explicit launch request before anything is started. Kept separate from the
/// launcher so the rules are testable on any operating system.
/// </summary>
internal static class WindowsExecutableRequest
{
	private const int MaximumArguments = 64;
	private const int MaximumArgumentLength = 8192;

	public static (string ExecutablePath, string[] Arguments, string? WorkingDirectory) Validate(
		WindowsExecutableLaunchRequest request)
	{
		ArgumentNullException.ThrowIfNull(request);

		var path = request.ExecutablePath?.Trim();
		if (string.IsNullOrEmpty(path))
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				"An absolute executable path is required.");
		}
		if (path.IndexOfAny(['"', '<', '>', '|', '\0']) >= 0)
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				"The executable path contains characters that are not part of a file name.");
		}
		if (!Path.IsPathFullyQualified(path))
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				$"'{path}' is not an absolute path. Explicit launch never searches PATH.");
		}

		// A .lnk, .bat, .cmd, .url, or .ps1 would need the Shell or an interpreter to run, which
		// is exactly the indirection this API refuses to offer.
		if (!Path.GetExtension(path).Equals(".exe", StringComparison.OrdinalIgnoreCase))
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				$"'{path}' is not an .exe. Shortcuts, scripts, and protocol handlers are not " +
				"launchable this way; use the app catalog instead.");
		}

		var full = Path.GetFullPath(path);
		RejectHostileNamespace(path, full);
		if (!File.Exists(full))
		{
			throw WindowsCanvasException.NotFound(
				WindowsErrorCodes.ExecutableNotFound,
				$"'{full}' does not exist.");
		}

		var arguments = request.Arguments ?? [];
		if (arguments.Length > MaximumArguments)
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				$"At most {MaximumArguments} arguments are allowed.");
		}
		foreach (var argument in arguments)
		{
			if (argument is null)
			{
				throw new WindowsCanvasException(
					WindowsErrorCodes.InvalidRequest,
					"Arguments must not be null.");
			}
			if (argument.Length > MaximumArgumentLength || argument.Contains('\0'))
			{
				throw new WindowsCanvasException(
					WindowsErrorCodes.InvalidRequest,
					"An argument was too long or contained a null character.");
			}
		}

		string? workingDirectory = null;
		if (!string.IsNullOrWhiteSpace(request.WorkingDirectory))
		{
			var candidate = request.WorkingDirectory.Trim();
			if (!Path.IsPathFullyQualified(candidate))
			{
				throw new WindowsCanvasException(
					WindowsErrorCodes.InvalidRequest,
					$"'{candidate}' is not an absolute working directory.");
			}
			workingDirectory = Path.GetFullPath(candidate);
			RejectHostileNamespace(candidate, workingDirectory);
			if (!Directory.Exists(workingDirectory))
			{
				throw WindowsCanvasException.NotFound(
					WindowsErrorCodes.WorkingDirectoryNotFound,
					$"'{workingDirectory}' does not exist.");
			}
		}

		return (full, [.. arguments], workingDirectory);
	}

	/// <summary>
	/// Refuses the Windows path forms that are absolute but do not name a plain local file.
	///
	/// A UNC path would run an executable served by whatever machine the caller named, handing
	/// that machine the host user's credentials on the way. The <c>\\?\</c> and <c>\\.\</c>
	/// namespaces skip normalization and reach devices. An alternate data stream hides a payload
	/// behind the name of a file that looks harmless. None of them are things "launch this
	/// installed app" needs, so all of them are refused rather than reasoned about.
	/// </summary>
	private static void RejectHostileNamespace(string original, string resolved)
	{
		foreach (var form in new[] { original, resolved })
		{
			if (form.StartsWith(@"\\", StringComparison.Ordinal) ||
				form.StartsWith("//", StringComparison.Ordinal))
			{
				throw new WindowsCanvasException(
					WindowsErrorCodes.InvalidRequest,
					$"'{original}' is a UNC or device path. Only a local file may be launched.");
			}

			// The one legitimate colon is the drive letter's.
			var afterDrive = form.Length > 2 && form[1] == ':' ? form[2..] : form;
			if (afterDrive.Contains(':', StringComparison.Ordinal))
			{
				throw new WindowsCanvasException(
					WindowsErrorCodes.InvalidRequest,
					$"'{original}' names an alternate data stream or device, not a file.");
			}
		}

		var name = Path.GetFileName(resolved);
		if (name.EndsWith(' ') || name.EndsWith('.'))
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				$"'{original}' ends in a dot or space, which does not name the file it appears to.");
		}
	}
}
