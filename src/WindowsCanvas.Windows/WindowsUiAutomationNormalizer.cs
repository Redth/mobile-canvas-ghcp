using WindowsCanvas.Contracts;

namespace WindowsCanvas.Windows;

/// <summary>
/// Enforces the public UI Automation contract at the managed boundary as defense in depth. The
/// native helper already caps and redacts its output, but a helper update, a malformed provider, or
/// a test double must not be able to make a password value or an unbounded tree cross into an API,
/// CLI, MCP response, or activity event.
/// </summary>
internal static class WindowsUiAutomationNormalizer
{
	private const int MaximumTextLength = 4_096;
	private const int MaximumSelectorCharacters = 8_192;
	private const int MaximumDetailLength = 512;
	private const int MaximumAncestors = 16;

	public static WindowsUiSnapshotRequest SnapshotRequest(WindowsUiSnapshotRequest? request)
	{
		request ??= new WindowsUiSnapshotRequest();
		return new WindowsUiSnapshotRequest
		{
			MaximumDepth = Bounded(
				request.MaximumDepth,
				WindowsUiAutomationLimits.DefaultMaximumDepth,
				1,
				WindowsUiAutomationLimits.MaximumDepth,
				"maximumDepth"),
			MaximumNodes = Bounded(
				request.MaximumNodes,
				WindowsUiAutomationLimits.DefaultMaximumNodes,
				1,
				WindowsUiAutomationLimits.MaximumNodes,
				"maximumNodes"),
			TimeoutMilliseconds = Bounded(
				request.TimeoutMilliseconds,
				WindowsUiAutomationLimits.DefaultTimeoutMilliseconds,
				1,
				WindowsUiAutomationLimits.MaximumTimeoutMilliseconds,
				"timeoutMilliseconds"),
		};
	}

	public static WindowsUiQuery Query(WindowsUiQuery? query)
	{
		query ??= new WindowsUiQuery();
		var snapshot = SnapshotRequest(new WindowsUiSnapshotRequest
		{
			MaximumDepth = query.MaximumDepth,
			MaximumNodes = query.MaximumNodes,
			TimeoutMilliseconds = query.TimeoutMilliseconds,
		});
		return new WindowsUiQuery
		{
			Selector = Selector(query.Selector),
			Limit = Bounded(
				query.Limit,
				WindowsUiAutomationLimits.DefaultQueryLimit,
				1,
				WindowsUiAutomationLimits.MaximumQueryLimit,
				"limit"),
			MaximumDepth = snapshot.MaximumDepth,
			MaximumNodes = snapshot.MaximumNodes,
			TimeoutMilliseconds = snapshot.TimeoutMilliseconds,
		};
	}

	public static WindowsUiActionRequest Action(WindowsUiActionRequest? request)
	{
		ArgumentNullException.ThrowIfNull(request);
		var action = NormalizeAction(request.Action);
		var snapshot = SnapshotRequest(new WindowsUiSnapshotRequest
		{
			MaximumDepth = request.MaximumDepth,
			MaximumNodes = request.MaximumNodes,
			TimeoutMilliseconds = request.TimeoutMilliseconds,
		});

		if (action == WindowsUiActionKinds.SetValue)
		{
			if (request.Value is null)
			{
				throw Invalid("SetValue requires a value.");
			}
			if (request.Value.Length > MaximumTextLength)
			{
				throw Invalid($"SetValue accepts at most {MaximumTextLength} characters.");
			}
			if (request.Value.Contains('\0'))
				throw Invalid("SetValue must not contain a null character.");
		}
		else if (request.Value is not null)
		{
			throw Invalid("Only SetValue accepts a value.");
		}

		WindowsUiScrollRequest? scroll = null;
		if (action == WindowsUiActionKinds.Scroll)
		{
			scroll = Scroll(request.Scroll);
		}
		else if (request.Scroll is not null)
		{
			throw Invalid("Only Scroll accepts scroll options.");
		}

		return new WindowsUiActionRequest
		{
			Action = action,
			Selector = Selector(request.Selector),
			Value = request.Value,
			Scroll = scroll,
			MaximumDepth = snapshot.MaximumDepth,
			MaximumNodes = snapshot.MaximumNodes,
			TimeoutMilliseconds = snapshot.TimeoutMilliseconds,
		};
	}

	public static WindowsUiWaitRequest Wait(WindowsUiWaitRequest? request)
	{
		ArgumentNullException.ThrowIfNull(request);
		var condition = Normalize(
			request.Condition,
			WindowsUiWaitConditions.Exists,
			WindowsUiWaitConditions.Exists,
			WindowsUiWaitConditions.NotExists,
			WindowsUiWaitConditions.Property,
			WindowsUiWaitConditions.State);
		var snapshot = SnapshotRequest(new WindowsUiSnapshotRequest
		{
			MaximumDepth = request.MaximumDepth,
			MaximumNodes = request.MaximumNodes,
			TimeoutMilliseconds = request.TimeoutMilliseconds,
		});
		var property = Trim(request.Property, "property");
		var expected = request.ExpectedValue;

		if (condition is WindowsUiWaitConditions.Property or WindowsUiWaitConditions.State)
		{
			if (string.IsNullOrEmpty(expected))
				throw Invalid($"{condition} waits require expectedValue.");
			if (expected.Length > MaximumTextLength)
				throw Invalid($"expectedValue accepts at most {MaximumTextLength} characters.");
			if (expected.Contains('\0'))
				throw Invalid("expectedValue must not contain a null character.");
			if (condition == WindowsUiWaitConditions.Property)
			{
				property = Normalize(
					property,
					null,
					"name",
					"enabled",
					"offscreen",
					"focusable",
					"focused",
					"value");
			}
			else if (property is not null)
			{
				throw Invalid("state waits do not accept property.");
			}
		}
		else if (property is not null || expected is not null)
		{
			throw Invalid($"{condition} waits do not accept property or expectedValue.");
		}

		return new WindowsUiWaitRequest
		{
			Selector = Selector(request.Selector),
			Condition = condition,
			Property = property,
			ExpectedValue = expected,
			TimeoutMilliseconds = snapshot.TimeoutMilliseconds,
			PollIntervalMilliseconds = Bounded(
				request.PollIntervalMilliseconds,
				WindowsUiAutomationLimits.DefaultPollIntervalMilliseconds,
				WindowsUiAutomationLimits.MinimumPollIntervalMilliseconds,
				WindowsUiAutomationLimits.MaximumTimeoutMilliseconds,
				"pollIntervalMilliseconds"),
			MaximumDepth = snapshot.MaximumDepth,
			MaximumNodes = snapshot.MaximumNodes,
		};
	}

	public static WindowsUiSelector Selector(WindowsUiSelector? selector)
	{
		ArgumentNullException.ThrowIfNull(selector);
		var automationId = Trim(selector.AutomationId, "automationId");
		var controlType = Trim(selector.ControlType, "controlType");
		var role = Trim(selector.Role, "role");
		var name = Trim(selector.Name, "name");
		var value = Trim(selector.Value, "value");
		if (name?.Length > MaximumTextLength || value?.Length > MaximumTextLength)
			throw Invalid($"Selector name and value accept at most {MaximumTextLength} characters.");

		var ancestors = selector.Ancestors ?? [];
		var path = selector.Path ?? [];
		var normalizedSelector = new WindowsUiSelector
		{
			AutomationId = automationId,
			ControlType = controlType,
			Role = role,
			Name = name,
			Value = value,
			Ancestors = ancestors,
			Path = path,
			Index = selector.Index,
		};
		if (WindowsUiSelectorPrecedence.Classify(normalizedSelector) is null)
		{
			throw Invalid(
				"A selector needs an automation ID, control type, role, name, value, ancestry, " +
				"index, or path.");
		}
		if (ancestors.Length > MaximumAncestors)
			throw Invalid($"A selector accepts at most {MaximumAncestors} ancestors.");
		if (path.Length > WindowsUiAutomationLimits.MaximumDepth)
			throw Invalid("A selector path exceeds the maximum UI Automation depth.");
		if (path.Any(index => index < 0) || selector.Index is < 0)
			throw Invalid("Selector indexes must be zero or greater.");
		if (SelectorCharacterCount(selector) > MaximumSelectorCharacters)
		{
			throw Invalid(
				$"Selector text accepts at most {MaximumSelectorCharacters} characters in total.");
		}

		return new WindowsUiSelector
		{
			AutomationId = automationId,
			ControlType = controlType,
			Role = role,
			Name = name,
			Value = value,
			Exact = selector.Exact,
			Ancestors =
			[
				.. ancestors.Select(ancestor => Ancestor(ancestor)),
			],
			Path = [.. path],
			Index = selector.Index,
		};
	}

	public static WindowsUiSnapshot Snapshot(
		WindowsUiSnapshot? snapshot,
		WindowsUiSnapshotRequest request)
	{
		request = SnapshotRequest(request);
		var state = new TreeState(request.MaximumNodes, request.MaximumDepth);
		var root = snapshot?.Root is null ? null : Element(snapshot.Root, state, 0);
		var metadata = Metadata(snapshot?.Metadata, state, request);
		return new WindowsUiSnapshot { Root = root, Metadata = metadata };
	}

	public static WindowsUiFindResult Find(
		WindowsUiFindResult? result,
		WindowsUiQuery request)
	{
		request = Query(request);
		var matches = result?.Matches ?? [];
		var limited = matches.Take(request.Limit).Select(SanitizeMatch).ToArray();
		var metadata = Metadata(
			result?.Metadata,
			new TreeState(request.MaximumNodes, request.MaximumDepth),
			new WindowsUiSnapshotRequest
			{
				MaximumDepth = request.MaximumDepth,
				MaximumNodes = request.MaximumNodes,
				TimeoutMilliseconds = request.TimeoutMilliseconds,
			});
		return new WindowsUiFindResult
		{
			Matches = limited,
			TotalMatches = Math.Max(result?.TotalMatches ?? matches.Length, matches.Length),
			Metadata = metadata with
			{
				Truncated = metadata.Truncated || matches.Length > limited.Length,
			},
		};
	}

	public static WindowsUiActionResult ActionResult(
		WindowsUiActionResult? result,
		WindowsUiActionRequest request)
	{
		request = Action(request);
		var raw = result ?? new WindowsUiActionResult
		{
			Success = false,
			Action = request.Action,
			Code = WindowsErrorCodes.HelperFailed,
			Detail = "The Windows UI Automation helper returned no action result.",
		};
		var setValue = request.Action == WindowsUiActionKinds.SetValue;
		return new WindowsUiActionResult
		{
			Success = raw.Success,
			Action = request.Action,
			Code = TrimCode(raw.Code),
			Detail = setValue
				? raw.Success
					? "Value updated."
					: raw.Code == WindowsErrorCodes.UiPasswordValueForbidden
						? "SetValue is unavailable for password controls."
						: "Value was not updated."
				: SafeDetail(raw.Detail),
			Match = raw.Match is null ? null : SanitizeMatch(raw.Match),
			ValueLength = setValue && request.Value is not null ? request.Value.Length : null,
			Metadata = Metadata(
				raw.Metadata,
				new TreeState(request.MaximumNodes, request.MaximumDepth),
				new WindowsUiSnapshotRequest
				{
					MaximumDepth = request.MaximumDepth,
					MaximumNodes = request.MaximumNodes,
					TimeoutMilliseconds = request.TimeoutMilliseconds,
				}),
		};
	}

	public static WindowsUiWaitResult WaitResult(
		WindowsUiWaitResult? result,
		WindowsUiWaitRequest request)
	{
		request = Wait(request);
		var raw = result ?? new WindowsUiWaitResult
		{
			Condition = request.Condition,
			Code = WindowsErrorCodes.HelperFailed,
			Detail = "The Windows UI Automation helper returned no wait result.",
		};
		return new WindowsUiWaitResult
		{
			Satisfied = raw.Satisfied,
			Condition = request.Condition,
			Code = TrimCode(raw.Code),
			Detail = SafeDetail(raw.Detail),
			Match = raw.Match is null ? null : SanitizeMatch(raw.Match),
			Metadata = Metadata(
				raw.Metadata,
				new TreeState(request.MaximumNodes, request.MaximumDepth),
				new WindowsUiSnapshotRequest
				{
					MaximumDepth = request.MaximumDepth,
					MaximumNodes = request.MaximumNodes,
					TimeoutMilliseconds = request.TimeoutMilliseconds,
				}),
		};
	}

	private static WindowsUiSelector Ancestor(WindowsUiSelector? selector)
	{
		if (selector is null)
			throw Invalid("Selector ancestors must not be null.");
		if ((selector.Ancestors?.Length ?? 0) != 0 ||
			(selector.Path?.Length ?? 0) != 0 ||
			selector.Index.HasValue)
		{
			throw Invalid("Ancestor selectors cannot themselves contain ancestry, path, or index.");
		}

		var automationId = Trim(selector.AutomationId, "ancestor automationId");
		var controlType = Trim(selector.ControlType, "ancestor controlType");
		var role = Trim(selector.Role, "ancestor role");
		var name = Trim(selector.Name, "ancestor name");
		if (automationId is null && controlType is null && role is null && name is null)
			throw Invalid("Each ancestor must contain a semantic constraint.");
		return new WindowsUiSelector
		{
			AutomationId = automationId,
			ControlType = controlType,
			Role = role,
			Name = name,
			Exact = selector.Exact,
		};
	}

	private static int SelectorCharacterCount(WindowsUiSelector selector)
	{
		var total = StringLength(selector.AutomationId) +
			StringLength(selector.ControlType) +
			StringLength(selector.Role) +
			StringLength(selector.Name) +
			StringLength(selector.Value);
		foreach (var ancestor in selector.Ancestors ?? [])
		{
			total += StringLength(ancestor?.AutomationId) +
				StringLength(ancestor?.ControlType) +
				StringLength(ancestor?.Role) +
				StringLength(ancestor?.Name);
		}
		return total;
	}

	private static int StringLength(string? value) => value?.Length ?? 0;

	private static WindowsUiScrollRequest Scroll(WindowsUiScrollRequest? scroll)
	{
		if (scroll is null)
			throw Invalid("Scroll requires direction and amount.");
		return new WindowsUiScrollRequest
		{
			Direction = Normalize(
				scroll.Direction,
				WindowsUiScrollDirections.Down,
				WindowsUiScrollDirections.Up,
				WindowsUiScrollDirections.Down,
				WindowsUiScrollDirections.Left,
				WindowsUiScrollDirections.Right),
			Amount = Normalize(
				scroll.Amount,
				WindowsUiScrollAmounts.Small,
				WindowsUiScrollAmounts.Small,
				WindowsUiScrollAmounts.Large),
		};
	}

	private static string NormalizeAction(string? action) =>
		Normalize(
			action,
			null,
			WindowsUiActionKinds.Invoke,
			WindowsUiActionKinds.SetValue,
			WindowsUiActionKinds.Select,
			WindowsUiActionKinds.Toggle,
			WindowsUiActionKinds.Expand,
			WindowsUiActionKinds.Collapse,
			WindowsUiActionKinds.Scroll,
			WindowsUiActionKinds.Focus);

	private static string Normalize(string? value, string? fallback, params string[] permitted)
	{
		var normalized = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
		if (normalized is not null)
		{
			foreach (var permittedValue in permitted)
			{
				if (normalized.Equals(permittedValue, StringComparison.OrdinalIgnoreCase))
					return permittedValue;
			}
		}
		throw Invalid(
			$"'{value}' is not supported. Expected one of: {string.Join(", ", permitted)}.");
	}

	private static int Bounded(int value, int fallback, int minimum, int maximum, string name)
	{
		if (value == 0)
			return fallback;
		if (value < minimum || value > maximum)
			throw Invalid($"{name} must be between {minimum} and {maximum}.");
		return value;
	}

	private static WindowsUiElement Element(WindowsUiElement element, TreeState state, int depth)
	{
		state.Nodes++;
		var truncated = state.Nodes > state.MaximumNodes || depth >= state.MaximumDepth;
		if (state.Nodes > state.MaximumNodes)
		{
			state.Truncated = true;
			return new WindowsUiElement();
		}

		var sourceChildren = element.Children ?? [];
		WindowsUiElement[] children;
		if (truncated)
		{
			if (sourceChildren.Length > 0)
				state.Truncated = true;
			children = [];
		}
		else
		{
			var materialized = new List<WindowsUiElement>();
			foreach (var child in sourceChildren)
			{
				if (state.Nodes >= state.MaximumNodes)
				{
					state.Truncated = true;
					break;
				}
				materialized.Add(Element(child, state, depth + 1));
			}
			children = [.. materialized];
		}

		var properties = element.Properties ?? new WindowsUiProperties();
		// A provider that cannot determine whether a field is a password must fail closed. Returning
		// a Value pattern only after an explicit false prevents an inaccessible password control from
		// becoming a text disclosure through a sparse tree.
		var nonPassword = properties.Password == false;
		return new WindowsUiElement
		{
			RuntimeId = TrimDiagnostic(element.RuntimeId),
			ControlType = NormalizeControlType(element.ControlType),
			Role = NormalizeRole(element.Role),
			Bounds = element.Bounds,
			Properties = new WindowsUiProperties
			{
				Name = TrimText(properties.Name),
				AutomationId = TrimText(properties.AutomationId),
				ClassName = TrimText(properties.ClassName),
				FrameworkId = TrimText(properties.FrameworkId),
				Enabled = properties.Enabled,
				Offscreen = properties.Offscreen,
				Focusable = properties.Focusable,
				Focused = properties.Focused,
				Password = properties.Password,
				Value = nonPassword ? TrimText(properties.Value) : null,
				State = TrimText(properties.State),
			},
			SupportedActions = (element.SupportedActions ?? new WindowsUiSupportedActions()) with
			{
				SetValue = nonPassword && element.SupportedActions?.SetValue == true,
			},
			Children = children,
		};
	}

	private static WindowsUiMatch SanitizeMatch(WindowsUiMatch match) =>
		new()
		{
			Element = Element(match.Element ?? new WindowsUiElement(), new TreeState(1, 1), 0),
			Selector = Selector(match.Selector),
		};

	private static WindowsUiOperationMetadata Metadata(
		WindowsUiOperationMetadata? metadata,
		TreeState state,
		WindowsUiSnapshotRequest request) =>
		new()
		{
			Truncated = metadata?.Truncated == true || state.Truncated,
			TimedOut = metadata?.TimedOut == true,
			NodeCount = Math.Min(
				Math.Max(metadata?.NodeCount ?? state.Nodes, state.Nodes),
				request.MaximumNodes),
			MaximumDepth = request.MaximumDepth,
			MaximumNodes = request.MaximumNodes,
			ElapsedMilliseconds = Math.Clamp(
				metadata?.ElapsedMilliseconds ?? 0,
				0,
				request.TimeoutMilliseconds),
			Detail = SafeDetail(metadata?.Detail),
		};

	private static string? Trim(string? value, string field)
	{
		if (string.IsNullOrWhiteSpace(value))
			return null;
		var trimmed = value.Trim();
		if (trimmed.Length > MaximumTextLength || trimmed.IndexOf('\0') >= 0)
			throw Invalid($"{field} is too long or contains a null character.");
		return trimmed;
	}

	private static string? TrimText(string? value)
	{
		if (string.IsNullOrEmpty(value))
			return null;
		return value.Length <= MaximumTextLength ? value : value[..MaximumTextLength];
	}

	private static string? TrimDiagnostic(string? value)
	{
		if (string.IsNullOrEmpty(value))
			return null;
		return value.Length <= 256 ? value : value[..256];
	}

	private static string? TrimCode(string? value) =>
		string.IsNullOrWhiteSpace(value) || value.Length > 128 ? null : value.Trim();

	private static string? SafeDetail(string? value)
	{
		if (string.IsNullOrWhiteSpace(value))
			return null;
		var trimmed = value.Trim();
		return trimmed.Length <= MaximumDetailLength ? trimmed : trimmed[..MaximumDetailLength];
	}

	private static string NormalizeControlType(string? value) =>
		string.IsNullOrWhiteSpace(value) ? WindowsUiControlTypes.Unknown : value.Trim();

	private static string NormalizeRole(string? value) =>
		string.IsNullOrWhiteSpace(value) ? WindowsUiRoles.Unknown : value.Trim();

	private static WindowsCanvasException Invalid(string message) =>
		new(WindowsErrorCodes.UiInvalidSelector, message);

	private sealed class TreeState(int maximumNodes, int maximumDepth)
	{
		public int MaximumNodes { get; } = maximumNodes;
		public int MaximumDepth { get; } = maximumDepth;
		public int Nodes { get; set; }
		public bool Truncated { get; set; }
	}
}
