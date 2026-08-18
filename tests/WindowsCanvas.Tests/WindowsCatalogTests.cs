using MobileCanvas.Contracts;
using WindowsCanvas.Contracts;
using WindowsCanvas.Windows;

namespace WindowsCanvas.Tests;

public sealed class WindowsCatalogTests
{
	private static readonly CanvasContextKey Panel =
		new("session", "panel", CanvasSurfaces.Windows);

	[Fact]
	public async Task Catalog_MergesTheSameAppFromSeveralSourcesIntoOneEntry()
	{
		var service = Service(out var bridge);
		bridge.Catalog = Catalog(
			Fixtures.Entry(
				"a1",
				"Fixture Editor",
				WindowsCatalogSources.AppsFolder,
				aumid: "Fixture.Editor_8wekyb3d8bbwe!App",
				parsingName: "shell:AppsFolder\\Fixture.Editor_8wekyb3d8bbwe!App"),
			Fixtures.Entry(
				"b2",
				"Fixture Editor (Start)",
				WindowsCatalogSources.StartMenuShortcuts,
				launchMethod: WindowsLaunchMethods.Shortcut,
				aumid: "fixture.editor_8wekyb3d8bbwe!app",
				shortcutPath: "C:\\Start\\Fixture Editor.lnk"));

		var catalog = await service.ListCatalogAsync();

		var entry = Assert.Single(catalog.Entries);
		Assert.Equal("a1", entry.Id);
		Assert.Equal("Fixture Editor", entry.DisplayName);
		Assert.Equal(2, entry.Provenance.Length);
		Assert.Equal(WindowsCatalogSources.AppsFolder, entry.Provenance[0].Source);
		Assert.Equal(WindowsCatalogSources.StartMenuShortcuts, entry.Provenance[1].Source);
		Assert.Equal("C:\\Start\\Fixture Editor.lnk", entry.Provenance[1].ShortcutPath);
	}

	[Fact]
	public async Task Catalog_KeepsTwoDifferentBuildsThatShareAName()
	{
		var service = Service(out var bridge);
		bridge.Catalog = Catalog(
			Fixtures.Entry("a1", "Fixture", executablePath: "C:\\stable\\fixture.exe"),
			Fixtures.Entry("b2", "Fixture", executablePath: "C:\\beta\\fixture.exe"));

		var catalog = await service.ListCatalogAsync();

		Assert.Equal(2, catalog.Entries.Length);
		Assert.All(catalog.Entries, entry => Assert.Single(entry.AmbiguousWith));
		Assert.Equal("b2", catalog.Entries[0].AmbiguousWith[0]);
		Assert.Equal("a1", catalog.Entries[1].AmbiguousWith[0]);
	}

	[Fact]
	public async Task Catalog_SearchesIdentityAsWellAsDisplayName()
	{
		var service = Service(out var bridge);
		bridge.Catalog = Catalog(
			Fixtures.Entry("a1", "Fixture Editor", aumid: "Contoso.Editor_8wekyb3d8bbwe!App"),
			Fixtures.Entry("b2", "Something Else", executablePath: "C:\\tools\\contoso-cli.exe"));

		var byName = await service.ListCatalogAsync(new WindowsCatalogQuery { Text = "editor" });
		var byIdentity = await service.ListCatalogAsync(new WindowsCatalogQuery { Text = "contoso" });

		Assert.Equal("a1", Assert.Single(byName.Entries).Id);
		Assert.Equal(
			new[] { "a1", "b2" },
			byIdentity.Entries.Select(entry => entry.Id).Order().ToArray());
	}

	[Fact]
	public async Task Catalog_ReportsTotalMatchesAndTruncationSeparately()
	{
		var service = Service(out var bridge);
		bridge.Catalog = Catalog(
			Fixtures.Entry("a1", "One", executablePath: "C:\\one.exe"),
			Fixtures.Entry("b2", "Two", executablePath: "C:\\two.exe"),
			Fixtures.Entry("c3", "Three", executablePath: "C:\\three.exe"));

		var page = await service.ListCatalogAsync(new WindowsCatalogQuery { Limit = 2 });

		Assert.Equal(2, page.Entries.Length);
		Assert.Equal(3, page.TotalMatches);
		Assert.True(page.Truncated);
	}

	[Fact]
	public async Task Catalog_ReportsASourceThatCouldNotBeRead()
	{
		var service = Service(out var bridge);
		bridge.Catalog = new WindowsHelperCatalog
		{
			SchemaVersion = 1,
			Ok = true,
			Sources =
			[
				new WindowsHelperCatalogSource
				{
					Name = WindowsCatalogSources.AppsFolder,
					Supported = false,
					Detail = "The Shell refused to enumerate AppsFolder.",
				},
			],
		};

		var catalog = await service.ListCatalogAsync();

		var source = Assert.Single(catalog.Sources);
		Assert.False(source.Supported);
		Assert.Equal("The Shell refused to enumerate AppsFolder.", source.Detail);
	}

	[Fact]
	public async Task Launch_ByAmbiguousFriendlyNameRefusesInsteadOfPickingOne()
	{
		var service = Service(out var bridge);
		bridge.Catalog = Catalog(
			Fixtures.Entry("a1", "Fixture", executablePath: "C:\\stable\\fixture.exe"),
			Fixtures.Entry("b2", "Fixture", executablePath: "C:\\beta\\fixture.exe"));

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.LaunchCatalogAppAsync(
				Panel,
				new WindowsCatalogLaunchRequest { EntryId = "Fixture", CorrelationTimeout = 0 }));

		Assert.Equal(WindowsErrorCodes.CatalogEntryAmbiguous, failure.Code);
		Assert.Contains("a1", failure.Message, StringComparison.Ordinal);
		Assert.Contains("b2", failure.Message, StringComparison.Ordinal);
		Assert.Empty(bridge.Launched);
	}

	[Fact]
	public async Task Launch_ByUnambiguousFriendlyNameResolvesToTheOpaqueIdentifier()
	{
		var service = Service(out var bridge);
		bridge.Catalog = Catalog(
			Fixtures.Entry("a1", "Fixture Editor", executablePath: "C:\\stable\\fixture.exe"));

		await service.LaunchCatalogAppAsync(
			Panel,
			new WindowsCatalogLaunchRequest { EntryId = "Fixture Editor", CorrelationTimeout = 0 });

		Assert.Equal("a1", Assert.Single(bridge.Launched));
	}

	[Fact]
	public async Task Launch_OfAnUnknownEntryIsNotFound()
	{
		var service = Service(out var bridge);
		bridge.Catalog = Catalog(Fixtures.Entry("a1", "Fixture", executablePath: "C:\\fixture.exe"));

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.LaunchCatalogAppAsync(
				Panel,
				new WindowsCatalogLaunchRequest { EntryId = "nope", CorrelationTimeout = 0 }));

		Assert.Equal(WindowsErrorCodes.CatalogEntryNotFound, failure.Code);
		Assert.Equal(404, failure.Status);
	}

	[Fact]
	public async Task Launch_ByFriendlyNameRefusesWhenTheCatalogWasTruncated()
	{
		var service = Service(out var bridge);
		bridge.Catalog = Catalog(
			Fixtures.Entry("a1", "Fixture Editor", executablePath: "C:\\stable\\fixture.exe"))
			with
		{ Truncated = true };

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.LaunchCatalogAppAsync(
				Panel,
				new WindowsCatalogLaunchRequest
				{
					EntryId = "Fixture Editor",
					CorrelationTimeout = 0,
				}));

		Assert.Equal(WindowsErrorCodes.CatalogEntryAmbiguous, failure.Code);
		Assert.Contains("truncated", failure.Message, StringComparison.OrdinalIgnoreCase);
		Assert.Empty(bridge.Launched);
	}

	[Fact]
	public async Task Launch_ByIdentifierStillWorksWhenTheCatalogWasTruncated()
	{
		var service = Service(out var bridge);
		bridge.Catalog = Catalog(
			Fixtures.Entry("a1", "Fixture Editor", executablePath: "C:\\stable\\fixture.exe"))
			with
		{ Truncated = true };

		await service.LaunchCatalogAppAsync(
			Panel,
			new WindowsCatalogLaunchRequest { EntryId = "a1", CorrelationTimeout = 0 });

		Assert.Equal("a1", Assert.Single(bridge.Launched));
	}

	private static WindowsHelperCatalog Catalog(params WindowsHelperCatalogEntry[] entries) => new()
	{
		SchemaVersion = 1,
		Ok = true,
		HelperVersion = "1.2.3",
		Entries = entries,
		Sources =
		[
			new WindowsHelperCatalogSource
			{
				Name = WindowsCatalogSources.AppsFolder,
				Supported = true,
				Count = entries.Length,
			},
		],
	};

	private static WindowsAppService Service(out FakeWindowsNativeBridge bridge)
	{
		bridge = new FakeWindowsNativeBridge();
		return new WindowsAppService(bridge, new FakeWindowController(), new FakeProcessLauncher());
	}
}
