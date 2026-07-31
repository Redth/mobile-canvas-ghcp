using MobileCanvas.Contracts;

namespace MobileCanvas.Core;

/// <summary>
/// Search over a captured element tree. Kept out of the backends so both platforms answer a query
/// identically once their native description has been normalized.
/// </summary>
public static class UiTree
{
	public static int Count(UiElement? root)
	{
		if (root is null)
			return 0;

		var total = 1;
		foreach (var child in root.Children)
			total += Count(child);
		return total;
	}

	/// <summary>
	/// Depth-first matches, so results arrive in the order a person reads the screen. Ancestors are
	/// still searched after they match, because a matching container usually holds the more specific
	/// element the caller actually wants.
	/// </summary>
	public static List<UiMatch> Find(UiElement? root, UiQuery query)
	{
		var matches = new List<UiMatch>();
		if (root is not null)
			Walk(root, query, "", matches);
		return matches;
	}

	private static void Walk(UiElement element, UiQuery query, string path, List<UiMatch> matches)
	{
		if (Matches(element, query))
		{
			var frame = element.Frame;
			matches.Add(new UiMatch
			{
				Element = element with { Children = [] },
				CenterX = frame?.CenterX ?? 0,
				CenterY = frame?.CenterY ?? 0,
				Path = path.Length == 0 ? "0" : path,
			});
		}

		for (var index = 0; index < element.Children.Length; index++)
		{
			var childPath = path.Length == 0
				? index.ToString(System.Globalization.CultureInfo.InvariantCulture)
				: $"{path}/{index.ToString(System.Globalization.CultureInfo.InvariantCulture)}";
			Walk(element.Children[index], query, childPath, matches);
		}
	}

	private static bool Matches(UiElement element, UiQuery query)
	{
		if (query.InteractableOnly && !element.Interactable)
			return false;

		if (!string.IsNullOrWhiteSpace(query.Role) &&
			!string.Equals(element.Role, query.Role, StringComparison.OrdinalIgnoreCase) &&
			!string.Equals(element.RawRole, query.Role, StringComparison.OrdinalIgnoreCase))
		{
			return false;
		}

		if (!string.IsNullOrWhiteSpace(query.Identifier) &&
			!FieldMatches(element.Identifier, query.Identifier, query.Exact))
		{
			return false;
		}

		if (!string.IsNullOrWhiteSpace(query.Text) &&
			!FieldMatches(element.Label, query.Text, query.Exact) &&
			!FieldMatches(element.Value, query.Text, query.Exact) &&
			!FieldMatches(element.Hint, query.Text, query.Exact))
		{
			return false;
		}

		// A query with no terms at all would match every node, which is never what a caller wants.
		return !string.IsNullOrWhiteSpace(query.Text) ||
			!string.IsNullOrWhiteSpace(query.Identifier) ||
			!string.IsNullOrWhiteSpace(query.Role);
	}

	private static bool FieldMatches(string? candidate, string term, bool exact)
	{
		if (string.IsNullOrEmpty(candidate))
			return false;
		return exact
			? candidate.Equals(term, StringComparison.OrdinalIgnoreCase)
			: candidate.Contains(term, StringComparison.OrdinalIgnoreCase);
	}
}
