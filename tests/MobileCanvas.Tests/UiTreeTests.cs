using MobileCanvas.Android;
using MobileCanvas.Contracts;
using MobileCanvas.Core;
using MobileCanvas.iOS;

namespace MobileCanvas.Tests;

/// <summary>
/// Fixtures here are trimmed captures from a real iPhone 11 Pro simulator and Pixel 6 emulator, so
/// the key spellings and coordinate spaces match what the devices actually return.
/// </summary>
public sealed class UiTreeTests
{
	private const string IosAlertJson = """
	{
	  "AXFrame": "{{0, 0}, {375, 812}}",
	  "AXUniqueId": null,
	  "frame": { "y": 0, "x": 0, "width": 375, "height": 812 },
	  "role_description": "application",
	  "AXLabel": " ",
	  "type": "Application",
	  "AXValue": null,
	  "enabled": true,
	  "role": "AXApplication",
	  "children": [
	    {
	      "frame": { "y": 326, "x": 57.5, "width": 260, "height": 42 },
	      "AXLabel": "\u201CCalendar\u201D Would Like to Send You Notifications",
	      "enabled": true,
	      "role": "AXStaticText",
	      "children": []
	    },
	    {
	      "frame": { "y": 454, "x": 43.5, "width": 140, "height": 48 },
	      "AXLabel": "Don\u2019t Allow",
	      "AXUniqueId": "alert-deny",
	      "enabled": true,
	      "role": "AXButton",
	      "children": []
	    },
	    {
	      "frame": { "y": 454, "x": 191.5, "width": 140, "height": 48 },
	      "AXLabel": "Allow",
	      "enabled": true,
	      "role": "AXButton",
	      "children": []
	    }
	  ]
	}
	""";

	// bounds are physical pixels; this emulator reports a scale of 2.625.
	private const string AndroidSettingsXml = """
	<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
	<hierarchy rotation="0">
	  <node index="0" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
	    <node index="0" class="android.widget.ImageButton" content-desc="Navigate up"
	          bounds="[0,128][147,275]" clickable="true" enabled="true" />
	    <node index="1" class="android.widget.TextView" text="Android version"
	          resource-id="com.android.settings:id/title" bounds="[147,300][900,380]" enabled="true" />
	    <node index="2" class="android.widget.Switch" text="Wi-Fi" checked="true"
	          bounds="[900,300][1040,380]" clickable="true" enabled="true" />
	  </node>
	</hierarchy>
	""";

	[Fact]
	public void ParseIos_ReadsLabelsRolesAndPointFrames()
	{
		var root = AccessibilityParser.Parse(IosAlertJson);

		Assert.NotNull(root);
		Assert.Equal(UiRoles.Container, root.Role);
		Assert.Equal(4, UiTree.Count(root));

		var allow = root.Children[2];
		Assert.Equal(UiRoles.Button, allow.Role);
		Assert.Equal("Allow", allow.Label);
		// iOS reports points already, so the frame passes through untouched.
		Assert.Equal(261.5, allow.Frame!.CenterX);
		Assert.Equal(478, allow.Frame.CenterY);
		Assert.True(allow.Interactable);
	}

	[Fact]
	public void ParseIos_UsesAXUniqueIdAsIdentifier()
	{
		var root = AccessibilityParser.Parse(IosAlertJson);

		Assert.Equal("alert-deny", root!.Children[1].Identifier);
	}

	[Fact]
	public void ParseIos_TreatsBlankLabelAsAbsent()
	{
		// The root's label is a single space; surfacing that as text would make it match a blank query.
		var root = AccessibilityParser.Parse(IosAlertJson);

		Assert.Null(root!.Label);
	}

	[Fact]
	public void ParseAndroid_ConvertsPixelBoundsToPoints()
	{
		var root = UiAutomatorParser.Parse(AndroidSettingsXml, 2.625);

		Assert.NotNull(root);
		Assert.Equal(0, root.Frame!.X);
		// 1080 physical pixels at 2.625x is 411.43 points wide.
		Assert.Equal(411.43, root.Frame.Width, 2);
		Assert.Equal(914.29, root.Frame.Height, 2);
	}

	[Fact]
	public void ParseAndroid_MapsClassNamesToRolesAndReadsContentDescription()
	{
		var root = UiAutomatorParser.Parse(AndroidSettingsXml, 2.625);
		var children = root!.Children;

		Assert.Equal(UiRoles.Button, children[0].Role);
		Assert.Equal("Navigate up", children[0].Label);
		Assert.Equal(UiRoles.Text, children[1].Role);
		Assert.Equal("com.android.settings:id/title", children[1].Identifier);
		Assert.Equal(UiRoles.Switch, children[2].Role);
	}

	[Fact]
	public void ParseAndroid_ToleratesShellNoiseAroundTheDocument()
	{
		// adb shell prefixes and suffixes the dump with its own chatter and \r line endings.
		var noisy = "UI hierarchy dumped to: /dev/tty\r\n" + AndroidSettingsXml + "\r\nsome trailing text";

		var root = UiAutomatorParser.Parse(noisy, 2.625);

		Assert.NotNull(root);
		Assert.Equal(4, UiTree.Count(root));
	}

	[Fact]
	public void ParseAndroid_ReturnsNullForUnparseableOutput()
	{
		Assert.Null(UiAutomatorParser.Parse("ERROR: could not get idle state.", 2.625));
	}

	[Fact]
	public void Find_MatchesLabelSubstringCaseInsensitively()
	{
		var root = AccessibilityParser.Parse(IosAlertJson);

		var matches = UiTree.Find(root, new UiQuery { Text = "allow" });

		Assert.Equal(2, matches.Count);
		Assert.Equal("Don\u2019t Allow", matches[0].Element.Label);
	}

	[Fact]
	public void Find_ExactRequiresTheWholeLabel()
	{
		var root = AccessibilityParser.Parse(IosAlertJson);

		var matches = UiTree.Find(root, new UiQuery { Text = "Allow", Exact = true });

		Assert.Single(matches);
		Assert.Equal(261.5, matches[0].CenterX);
	}

	[Fact]
	public void Find_CombinesTermsWithAnd()
	{
		var root = AccessibilityParser.Parse(IosAlertJson);

		// "Allow" alone matches two elements; adding the role narrows it, and a contradictory
		// role rules everything out rather than falling back to the looser term.
		Assert.Equal(2, UiTree.Find(root, new UiQuery { Text = "Allow", Role = UiRoles.Button }).Count);
		Assert.Empty(UiTree.Find(root, new UiQuery { Text = "Allow", Role = UiRoles.Field }));
	}

	[Fact]
	public void Find_WithoutTermsMatchesNothing()
	{
		// An empty query returning the whole tree would let a caller tap an arbitrary element.
		var root = AccessibilityParser.Parse(IosAlertJson);

		Assert.Empty(UiTree.Find(root, new UiQuery()));
	}

	[Fact]
	public void Find_ReportsAStablePathForEachMatch()
	{
		var root = AccessibilityParser.Parse(IosAlertJson);

		var matches = UiTree.Find(root, new UiQuery { Text = "Allow", Exact = true });

		Assert.Equal("2", matches[0].Path);
	}
}
