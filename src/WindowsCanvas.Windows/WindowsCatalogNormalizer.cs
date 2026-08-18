using System.Globalization;
using WindowsCanvas.Contracts;

namespace WindowsCanvas.Windows;

/// <summary>
/// Turns the helper's per-source rows into one launchable-app catalog.
///
/// Two rules do the real work. Identity is the launch provenance, never the friendly name, so the
/// same app found in AppsFolder and in the Start Menu collapses into one entry that remembers both
/// ways of starting it. And a friendly name shared by genuinely different apps stays ambiguous:
/// search reports every match rather than choosing one, because choosing one is how automation
/// silently drives the wrong build of the app under test.
/// </summary>
internal static class WindowsCatalogNormalizer
{
	public const int MaximumLimit = 500;

	public static WindowsCatalogResult Normalize(
		WindowsHelperCatalog catalog,
		WindowsCatalogQuery? query)
	{
		var merged = Merge(catalog.Entries);
		MarkAmbiguity(merged);

		var limit = Math.Clamp(query?.Limit is > 0 ? query.Limit : 100, 1, MaximumLimit);
		IEnumerable<WindowsCatalogEntry> matches = merged;
		if (query?.AmbiguousOnly == true)
			matches = matches.Where(entry => entry.AmbiguousWith.Length > 0);
		if (!string.IsNullOrWhiteSpace(query?.Text))
			matches = matches.Where(entry => Matches(entry, query.Text!.Trim()));

		var ordered = matches
			.OrderBy(entry => entry.DisplayName, StringComparer.CurrentCultureIgnoreCase)
			.ThenBy(entry => entry.Id, StringComparer.Ordinal)
			.ToArray();

		return new WindowsCatalogResult
		{
			Entries = [.. ordered.Take(limit)],
			TotalMatches = ordered.Length,
			Truncated = catalog.Truncated || ordered.Length > limit,
			Sources =
			[
				.. catalog.Sources.Select(source => new WindowsCatalogSourceState
				{
					Name = source.Name,
					Supported = source.Supported,
					Count = source.Count,
					Detail = source.Detail,
				}),
			],
		};
	}

	/// <summary>
	/// Resolves a caller-supplied identifier or friendly name against the whole catalog. Paging is
	/// deliberately not applied here: resolving against a page could miss the second app that
	/// answers to a name and turn an ambiguity into a confident launch of the wrong build.
	/// </summary>
	public static WindowsCatalogEntry Resolve(WindowsHelperCatalog catalog, string entryId)
	{
		if (string.IsNullOrWhiteSpace(entryId))
		{
			throw new WindowsCanvasException(
				WindowsErrorCodes.InvalidRequest,
				"A catalog entry identifier is required.");
		}

		var entries = Merge(catalog.Entries);
		MarkAmbiguity(entries);

		var trimmed = entryId.Trim();
		var exact = entries.FindAll(entry => entry.Id.Equals(trimmed, StringComparison.Ordinal));
		if (exact.Count == 1)
			return exact[0];

		var named = entries.FindAll(entry =>
			entry.DisplayName.Equals(trimmed, StringComparison.CurrentCultureIgnoreCase));
		if (named.Count > 1)
		{
			throw WindowsCanvasException.Conflict(
				WindowsErrorCodes.CatalogEntryAmbiguous,
				$"'{trimmed}' matches {named.Count} installed apps: " +
				$"{string.Join(", ", named.Select(Describe))}. Launch one by its id.");
		}
		if (named.Count == 1)
		{
			// A truncated enumeration cannot prove a friendly name is unique, and an identifier is
			// the caller's way to be certain. Refuse rather than guess.
			if (catalog.Truncated)
			{
				throw WindowsCanvasException.Conflict(
					WindowsErrorCodes.CatalogEntryAmbiguous,
					$"The installed-app list was truncated, so '{trimmed}' cannot be proven to " +
					"name only one app. Launch it by its id.");
			}
			return named[0];
		}

		throw WindowsCanvasException.NotFound(
			WindowsErrorCodes.CatalogEntryNotFound,
			$"No launchable app matches '{trimmed}'.");
	}

	private static string Describe(WindowsCatalogEntry entry) =>
		$"{entry.Id} ({entry.AppUserModelId ?? entry.ExecutablePath ?? entry.Kind})";

	private static List<WindowsCatalogEntry> Merge(WindowsHelperCatalogEntry[] rows)
	{
		var order = new List<string>();
		var byIdentity = new Dictionary<string, WindowsCatalogEntry>(StringComparer.Ordinal);

		foreach (var row in rows)
		{
			if (string.IsNullOrWhiteSpace(row.Id))
				continue;

			var identity = IdentityOf(row);
			var provenance = new WindowsLaunchProvenance
			{
				Source = row.Source,
				LaunchMethod = row.LaunchMethod,
				ParsingName = Trim(row.ParsingName),
				ShortcutPath = Trim(row.ShortcutPath),
				RegistryKey = Trim(row.RegistryKey),
				Arguments = Trim(row.Arguments),
				WorkingDirectory = Trim(row.WorkingDirectory),
			};

			if (byIdentity.TryGetValue(identity, out var existing))
			{
				byIdentity[identity] = existing with
				{
					// The first source to report an app wins its identity and display name, so a
					// merge cannot make an entry's ID move between listings.
					AppUserModelId = existing.AppUserModelId ?? Trim(row.AppUserModelId),
					PackageFamilyName = existing.PackageFamilyName ?? Trim(row.PackageFamilyName),
					ExecutablePath = existing.ExecutablePath ?? Trim(row.ExecutablePath),
					Publisher = existing.Publisher ?? Trim(row.Publisher),
					Provenance = [.. existing.Provenance, provenance],
				};
				continue;
			}

			order.Add(identity);
			byIdentity[identity] = new WindowsCatalogEntry
			{
				Id = row.Id,
				DisplayName = string.IsNullOrWhiteSpace(row.DisplayName)
					? row.Id
					: row.DisplayName.Trim(),
				Kind = string.IsNullOrWhiteSpace(row.Kind) ? WindowsCatalogKinds.Desktop : row.Kind,
				AppUserModelId = Trim(row.AppUserModelId),
				PackageFamilyName = Trim(row.PackageFamilyName),
				ExecutablePath = Trim(row.ExecutablePath),
				Publisher = Trim(row.Publisher),
				Provenance = [provenance],
			};
		}

		return [.. order.Select(identity => byIdentity[identity])];
	}

	/// <summary>
	/// What makes two rows the same app. An AUMID or package family is a real identity; a resolved
	/// executable is the best a classic app offers. Rows with neither stay distinct, because the
	/// only thing left to compare would be the display name.
	/// </summary>
	private static string IdentityOf(WindowsHelperCatalogEntry row)
	{
		if (!string.IsNullOrWhiteSpace(row.AppUserModelId))
			return "aumid:" + row.AppUserModelId.Trim().ToLowerInvariant();
		if (!string.IsNullOrWhiteSpace(row.PackageFamilyName))
			return "package:" + row.PackageFamilyName.Trim().ToLowerInvariant();
		if (!string.IsNullOrWhiteSpace(row.ExecutablePath))
		{
			var arguments = Trim(row.Arguments);
			return "exe:" + row.ExecutablePath.Trim().ToLowerInvariant() +
				(arguments is null ? "" : "|" + arguments.ToLowerInvariant());
		}
		return "id:" + row.Id;
	}

	private static void MarkAmbiguity(List<WindowsCatalogEntry> entries)
	{
		var byName = new Dictionary<string, List<int>>(StringComparer.CurrentCultureIgnoreCase);
		for (var index = 0; index < entries.Count; index++)
		{
			var name = entries[index].DisplayName;
			if (!byName.TryGetValue(name, out var bucket))
				byName[name] = bucket = [];
			bucket.Add(index);
		}

		foreach (var bucket in byName.Values)
		{
			if (bucket.Count < 2)
				continue;
			foreach (var index in bucket)
			{
				entries[index] = entries[index] with
				{
					AmbiguousWith =
					[
						.. bucket.Where(other => other != index).Select(other => entries[other].Id),
					],
				};
			}
		}
	}

	private static bool Matches(WindowsCatalogEntry entry, string text) =>
		Contains(entry.DisplayName, text)
		|| Contains(entry.AppUserModelId, text)
		|| Contains(entry.PackageFamilyName, text)
		|| Contains(entry.ExecutablePath, text)
		|| Contains(entry.Publisher, text)
		|| entry.Id.Equals(text, StringComparison.Ordinal);

	private static bool Contains(string? value, string text) =>
		value is not null
		&& CultureInfo.CurrentCulture.CompareInfo.IndexOf(
			value,
			text,
			CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace) >= 0;

	private static string? Trim(string? value) =>
		string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
