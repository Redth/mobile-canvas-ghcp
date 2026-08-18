using MobileCanvas.Contracts;
using WindowsCanvas.Contracts;
using WindowsCanvas.Windows;

namespace WindowsCanvas.Tests;

public sealed class WindowsUiAutomationTests
{
	private static readonly CanvasContextKey Panel =
		new("session", "uia-panel", CanvasSurfaces.Windows);

	private static readonly CanvasContextKey OtherPanel =
		new("session", "other-uia-panel", CanvasSurfaces.Windows);

	[Fact]
	public void SelectorPrecedence_PrefersStableSemanticIdentityBeforeFallbacks()
	{
		Assert.Equal(
			WindowsUiSelectorPrecedence.AutomationIdAndControlType,
			WindowsUiSelectorPrecedence.Classify(new WindowsUiSelector
			{
				AutomationId = "save",
				ControlType = WindowsUiControlTypes.Button,
				Name = "Save",
				Index = 0,
			}));
		Assert.Equal(
			WindowsUiSelectorPrecedence.ControlTypeAndNameOrValue,
			WindowsUiSelectorPrecedence.Classify(new WindowsUiSelector
			{
				ControlType = WindowsUiControlTypes.Edit,
				Value = "draft",
			}));
		Assert.Equal(
			WindowsUiSelectorPrecedence.QualifiedFallback,
			WindowsUiSelectorPrecedence.Classify(new WindowsUiSelector { Path = [2, 1] }));
		Assert.Null(WindowsUiSelectorPrecedence.Classify(new WindowsUiSelector { Name = "Save" }));
	}

	[Fact]
	public async Task Snapshot_CapsAndRedactsATrustBoundaryResult()
	{
		var (service, bridge, windowId) = await AttachedAsync();
		bridge.OnSnapshot = (_, _) => new WindowsUiSnapshot
		{
			Root = new WindowsUiElement
			{
				ControlType = WindowsUiControlTypes.Window,
				Role = WindowsUiRoles.Window,
				Children =
				[
					new WindowsUiElement
					{
						ControlType = WindowsUiControlTypes.Edit,
						Role = WindowsUiRoles.Field,
						Properties = new WindowsUiProperties
						{
							Password = true,
							Value = "never-return-this",
							Name = "Password",
						},
					},
					new WindowsUiElement { ControlType = WindowsUiControlTypes.Button },
					new WindowsUiElement { ControlType = WindowsUiControlTypes.Button },
				],
			},
			Metadata = new WindowsUiOperationMetadata
			{
				NodeCount = 999_999,
				MaximumDepth = 999,
				MaximumNodes = 999_999,
			},
		};

		var snapshot = await service.GetUiSnapshotAsync(
			Panel,
			windowId,
			new WindowsUiSnapshotRequest { MaximumDepth = 2, MaximumNodes = 2 });

		Assert.True(snapshot.Metadata.Truncated);
		Assert.Equal(2, snapshot.Metadata.NodeCount);
		Assert.Equal(2, snapshot.Metadata.MaximumDepth);
		Assert.Equal(2, snapshot.Metadata.MaximumNodes);
		var password = Assert.Single(snapshot.Root!.Children);
		Assert.True(password.Properties.Password);
		Assert.Null(password.Properties.Value);
		Assert.False(password.SupportedActions.SetValue);
	}

	[Fact]
	public async Task SetValueResult_RedactsInputAndPasswordValue()
	{
		var (service, bridge, windowId) = await AttachedAsync();
		bridge.OnAction = (_, request) => new WindowsUiActionResult
		{
			Action = request.Action,
			Success = false,
			Code = WindowsErrorCodes.UiPasswordValueForbidden,
			Detail = "The provider reflected super-secret-text.",
			Match = new WindowsUiMatch
			{
				Element = new WindowsUiElement
				{
					ControlType = WindowsUiControlTypes.Edit,
					Role = WindowsUiRoles.Field,
					Properties = new WindowsUiProperties
					{
						Password = true,
						Name = "Password",
						Value = "super-secret-text",
					},
				},
				Selector = ButtonSelector(),
			},
		};

		var result = await service.ActUiAsync(
			Panel,
			windowId,
			new WindowsUiActionRequest
			{
				Action = WindowsUiActionKinds.SetValue,
				Selector = ButtonSelector(),
				Value = "super-secret-text",
			});

		Assert.False(result.Success);
		Assert.Equal(WindowsErrorCodes.UiPasswordValueForbidden, result.Code);
		Assert.Equal("SetValue is unavailable for password controls.", result.Detail);
		Assert.Equal("super-secret-text".Length, result.ValueLength);
		Assert.Null(result.Match!.Element.Properties.Value);
		Assert.DoesNotContain("super-secret-text", result.Detail!, StringComparison.Ordinal);
	}

	[Fact]
	public async Task EveryPatternAction_IsForwardedOnlyAfterGuardedResolution()
	{
		var (service, bridge, windowId) = await AttachedAsync();
		var actions = new[]
		{
			WindowsUiActionKinds.Invoke,
			WindowsUiActionKinds.SetValue,
			WindowsUiActionKinds.Select,
			WindowsUiActionKinds.Toggle,
			WindowsUiActionKinds.Expand,
			WindowsUiActionKinds.Collapse,
			WindowsUiActionKinds.Scroll,
			WindowsUiActionKinds.Focus,
		};

		foreach (var action in actions)
		{
			var result = await service.ActUiAsync(
				Panel,
				windowId,
				new WindowsUiActionRequest
				{
					Action = action,
					Selector = ButtonSelector(),
					Value = action == WindowsUiActionKinds.SetValue ? "draft" : null,
					Scroll = action == WindowsUiActionKinds.Scroll
						? new WindowsUiScrollRequest
						{
							Direction = WindowsUiScrollDirections.Down,
							Amount = WindowsUiScrollAmounts.Small,
						}
						: null,
				});
			Assert.True(result.Success);
		}

		Assert.Equal(actions, bridge.UiActions.Select(action => action.Action));
		Assert.All(bridge.UiTargets, target => Assert.Equal(11, target));
	}

	[Fact]
	public async Task ActionAndWait_KeepExplicitNotFoundAmbiguityAndTimeoutResults()
	{
		var (service, bridge, windowId) = await AttachedAsync();
		bridge.OnAction = (_, request) => new WindowsUiActionResult
		{
			Action = request.Action,
			Code = WindowsErrorCodes.UiElementAmbiguous,
			Detail = "Two buttons matched.",
		};
		bridge.OnWait = (_, request) => new WindowsUiWaitResult
		{
			Condition = request.Condition,
			Code = WindowsErrorCodes.UiTimeout,
			Detail = "No element appeared.",
			Metadata = new WindowsUiOperationMetadata { TimedOut = true },
		};

		var action = await service.ActUiAsync(
			Panel,
			windowId,
			new WindowsUiActionRequest
			{
				Action = WindowsUiActionKinds.Invoke,
				Selector = ButtonSelector(),
			});
		var wait = await service.WaitUiAsync(
			Panel,
			windowId,
			new WindowsUiWaitRequest
			{
				Selector = ButtonSelector(),
				Condition = WindowsUiWaitConditions.Exists,
				TimeoutMilliseconds = 100,
				PollIntervalMilliseconds = 50,
			});

		Assert.False(action.Success);
		Assert.Equal(WindowsErrorCodes.UiElementAmbiguous, action.Code);
		Assert.False(wait.Satisfied);
		Assert.Equal(WindowsErrorCodes.UiTimeout, wait.Code);
		Assert.True(wait.Metadata.TimedOut);
	}

	[Fact]
	public async Task UiOperation_RevalidatesTheAuthorizedWindowImmediatelyBeforeBridgeUse()
	{
		var (service, bridge, windowId) = await AttachedAsync();
		bridge.Windows = Fixtures.WindowList(
			Fixtures.Window(11, 200, "Replacement", processPath: "C:\\apps\\replacement.exe"));

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.GetUiSnapshotAsync(Panel, windowId));

		Assert.Equal(WindowsErrorCodes.WindowNotAuthorized, failure.Code);
		Assert.Empty(bridge.UiTargets);
	}

	[Fact]
	public async Task UiOperation_RejectsAnotherPanelsOpaqueWindowCapability()
	{
		var (service, _, windowId) = await AttachedAsync();
		var otherCandidates = await service.ListWindowCandidatesAsync(OtherPanel);
		await service.AttachAsync(
			OtherPanel,
			new WindowsAttachRequest { CandidateId = Assert.Single(otherCandidates.Windows).Id });

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(() =>
			service.FindUiAsync(
				OtherPanel,
				windowId,
				new WindowsUiQuery { Selector = ButtonSelector() }));

		Assert.Equal(WindowsErrorCodes.WindowNotAuthorized, failure.Code);
	}

	[Fact]
	public async Task QueryAndWait_UseTheBoundedNormalizedRequest()
	{
		var (service, bridge, windowId) = await AttachedAsync();
		WindowsUiQuery? observedQuery = null;
		WindowsUiWaitRequest? observedWait = null;
		bridge.OnFind = (_, query) =>
		{
			observedQuery = query;
			return new WindowsUiFindResult();
		};
		bridge.OnWait = (_, request) =>
		{
			observedWait = request;
			return new WindowsUiWaitResult { Condition = request.Condition, Satisfied = true };
		};

		await service.FindUiAsync(
			Panel,
			windowId,
			new WindowsUiQuery
			{
				Selector = ButtonSelector(),
				MaximumDepth = WindowsUiAutomationLimits.MaximumDepth,
				MaximumNodes = WindowsUiAutomationLimits.MaximumNodes,
				Limit = WindowsUiAutomationLimits.MaximumQueryLimit,
			});
		await service.WaitUiAsync(
			Panel,
			windowId,
			new WindowsUiWaitRequest
			{
				Selector = ButtonSelector(),
				Condition = WindowsUiWaitConditions.NotExists,
				TimeoutMilliseconds = 100,
				PollIntervalMilliseconds = WindowsUiAutomationLimits.MinimumPollIntervalMilliseconds,
				MaximumDepth = 2,
				MaximumNodes = 3,
			});

		Assert.Equal(WindowsUiAutomationLimits.MaximumDepth, observedQuery!.MaximumDepth);
		Assert.Equal(WindowsUiAutomationLimits.MaximumNodes, observedQuery.MaximumNodes);
		Assert.Equal(WindowsUiAutomationLimits.MaximumQueryLimit, observedQuery.Limit);
		Assert.Equal(2, observedWait!.MaximumDepth);
		Assert.Equal(3, observedWait.MaximumNodes);
		Assert.Equal(WindowsUiAutomationLimits.MinimumPollIntervalMilliseconds, observedWait.PollIntervalMilliseconds);
	}

	private static WindowsUiSelector ButtonSelector() =>
		new()
		{
			AutomationId = "save",
			ControlType = WindowsUiControlTypes.Button,
		};

	private static async Task<(WindowsAppService Service, FakeWindowsNativeBridge Bridge, string WindowId)>
		AttachedAsync()
	{
		var bridge = new FakeWindowsNativeBridge
		{
			Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Main")),
		};
		var service = new WindowsAppService(
			bridge,
			new FakeWindowController(),
			new FakeProcessLauncher());
		var candidates = await service.ListWindowCandidatesAsync(Panel);
		var session = await service.AttachAsync(
			Panel,
			new WindowsAttachRequest { CandidateId = Assert.Single(candidates.Windows).Id });
		return (service, bridge, Assert.Single(session.Windows).Id);
	}
}
