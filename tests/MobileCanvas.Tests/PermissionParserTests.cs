using MobileCanvas.Android;

namespace MobileCanvas.Tests;

/// <summary>
/// Tests over verbatim <c>dumpsys package</c> output captured from a running emulator.
/// </summary>
public class PermissionParserTests
{
	// Captured from `adb shell dumpsys package com.android.chrome`.
	private const string Dumpsys = """
		    requested permissions:
		      android.permission.CAMERA
		      android.permission.INTERNET
		    install permissions:
		      android.permission.INTERNET: granted=true
		    runtime permissions:
		      android.permission.POST_NOTIFICATIONS: granted=false, flags=[ USER_SENSITIVE_WHEN_GRANTED|USER_SENSITIVE_WHEN_DENIED]
		      android.permission.ACCESS_FINE_LOCATION: granted=true, flags=[ GRANTED_BY_DEFAULT|USER_SENSITIVE_WHEN_GRANTED|USER_SENSITIVE_WHEN_DENIED]
		      android.permission.READ_EXTERNAL_STORAGE: granted=false, flags=[ USER_SENSITIVE_WHEN_GRANTED|USER_SENSITIVE_WHEN_DENIED|RESTRICTION_UPGRADE_EXEMPT]
		      android.permission.ACCESS_COARSE_LOCATION: granted=true, flags=[ GRANTED_BY_DEFAULT|USER_SENSITIVE_WHEN_GRANTED|USER_SENSITIVE_WHEN_DENIED]
		    enabledComponents:
		      org.chromium.chrome.browser.ChromeTabbedActivity
		""";

	[Fact]
	public void ReadsGrantStateFromTheRuntimeBlock()
	{
		var permissions = PermissionParser.ParseRuntimePermissions(Dumpsys);

		Assert.True(permissions["android.permission.ACCESS_FINE_LOCATION"]);
		Assert.True(permissions["android.permission.ACCESS_COARSE_LOCATION"]);
		Assert.False(permissions["android.permission.POST_NOTIFICATIONS"]);
		Assert.False(permissions["android.permission.READ_EXTERNAL_STORAGE"]);
	}

	[Fact]
	public void IgnoresTheRequestedAndInstallBlocks()
	{
		var permissions = PermissionParser.ParseRuntimePermissions(Dumpsys);

		// CAMERA appears under 'requested permissions' with no grant state. Reading it from there
		// would report it as denied when the truth is that it is not a runtime permission for this
		// app at all -- a difference that decides whether granting it can work.
		Assert.DoesNotContain("android.permission.CAMERA", permissions.Keys);

		// INTERNET is an install permission: granted at install and never revocable.
		Assert.DoesNotContain("android.permission.INTERNET", permissions.Keys);

		Assert.Equal(4, permissions.Count);
	}

	[Fact]
	public void StopsAtTheNextBlock()
	{
		var permissions = PermissionParser.ParseRuntimePermissions(Dumpsys);

		Assert.DoesNotContain(permissions.Keys, key => key.Contains("Chrome", StringComparison.Ordinal));
	}

	[Fact]
	public void ReturnsNothingWhenThereIsNoRuntimeBlock()
	{
		// An app that declares no runtime permissions still has the heading, with nothing under it.
		Assert.Empty(PermissionParser.ParseRuntimePermissions(
			"""
			    runtime permissions:
			    enabledComponents:
			      androidx.work.impl.background.systemalarm.RescheduleReceiver
			"""));

		Assert.Empty(PermissionParser.ParseRuntimePermissions(""));
		Assert.Empty(PermissionParser.ParseRuntimePermissions(null));
	}

	[Fact]
	public void ReadsAPermissionThatIsNotAndroidsOwn()
	{
		// An app can define its own runtime permission, and it is still one a caller may want to set.
		var permissions = PermissionParser.ParseRuntimePermissions(
			"""
			      runtime permissions:
			        com.example.app.SPECIAL_ACCESS: granted=true, flags=[ ]
			""");

		Assert.True(Assert.Single(permissions).Value);
		Assert.Equal("com.example.app.SPECIAL_ACCESS", permissions.Keys.Single());
	}
}
