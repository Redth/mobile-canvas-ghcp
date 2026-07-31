using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

/// <summary>
/// Tests over locationd's client list, whose shape was captured from a running simulator.
/// </summary>
public class LocationAuthorizationTests
{
	// Trimmed from `plutil -convert xml1` over a simulator's Library/Caches/locationd/clients.plist.
	private const string Clients = """
		<?xml version="1.0" encoding="UTF-8"?>
		<plist version="1.0">
		<dict>
			<key>icom.apple.Maps:</key>
			<dict>
				<key>Authorization</key>
				<integer>2</integer>
				<key>BundleId</key>
				<string>com.apple.Maps</string>
			</dict>
			<key>icom.microsoft.maui.sandbox:</key>
			<dict>
				<key>Authorization</key>
				<integer>2</integer>
				<key>BundleId</key>
				<string>com.microsoft.maui.sandbox</string>
				<key>Registered</key>
				<true/>
				<key>SupportedAuthorizationMask</key>
				<integer>3</integer>
			</dict>
			<key>icom.companyname.avapp:</key>
			<dict>
				<key>Authorization</key>
				<integer>0</integer>
				<key>BundleId</key>
				<string>com.companyname.avapp</string>
			</dict>
		</dict>
		</plist>
		""";

	[Fact]
	public void ReadsAnAuthorizedApp()
	{
		Assert.True(IosSimulatorBackend.ParseLocationAuthorization(Clients, "com.microsoft.maui.sandbox"));
	}

	[Fact]
	public void ReadsADeniedApp()
	{
		// 0 is "not determined" and 2 is authorized, so anything below 2 is not a grant.
		Assert.False(IosSimulatorBackend.ParseLocationAuthorization(Clients, "com.companyname.avapp"));
	}

	[Fact]
	public void IgnoresTheMaskThatSitsBesideTheAuthorization()
	{
		// SupportedAuthorizationMask is an integer in the same dict and would read as 3 -- authorized --
		// for an app that is not. It has to not match the Authorization key.
		Assert.False(IosSimulatorBackend.ParseLocationAuthorization(
			"""
			<dict>
				<key>icom.companyname.avapp:</key>
				<dict>
					<key>SupportedAuthorizationMask</key>
					<integer>3</integer>
					<key>Authorization</key>
					<integer>0</integer>
				</dict>
			</dict>
			""",
			"com.companyname.avapp"));
	}

	[Fact]
	public void DoesNotBorrowTheNextAppsAuthorization()
	{
		// An app registered with locationd but never asked has no Authorization of its own. Reading
		// past its dict would report the next app's answer as this one's.
		Assert.Null(IosSimulatorBackend.ParseLocationAuthorization(
			"""
			<dict>
				<key>icom.companyname.avapp:</key>
				<dict>
					<key>BundleId</key>
					<string>com.companyname.avapp</string>
				</dict>
				<key>icom.apple.Maps:</key>
				<dict>
					<key>Authorization</key>
					<integer>2</integer>
				</dict>
			</dict>
			""",
			"com.companyname.avapp"));
	}

	[Fact]
	public void ReturnsUnknownForAnAppLocationdHasNeverSeen()
	{
		Assert.Null(IosSimulatorBackend.ParseLocationAuthorization(Clients, "com.example.absent"));
		Assert.Null(IosSimulatorBackend.ParseLocationAuthorization("", "com.example.absent"));
	}

	[Fact]
	public void DoesNotMatchAnAppWhoseIdMerelyStartsTheSame()
	{
		// "com.example.app" and "com.example.app2" would both match a prefix test; the trailing colon
		// locationd appends is what separates them.
		Assert.Null(IosSimulatorBackend.ParseLocationAuthorization(
			"""
			<dict>
				<key>icom.example.app2:</key>
				<dict>
					<key>Authorization</key>
					<integer>2</integer>
				</dict>
			</dict>
			""",
			"com.example.app"));
	}
}
