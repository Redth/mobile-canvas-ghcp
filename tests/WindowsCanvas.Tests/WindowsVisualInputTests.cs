using MobileCanvas.Contracts;
using WindowsCanvas.Contracts;
using WindowsCanvas.Windows;

namespace WindowsCanvas.Tests;

/// <summary>
/// Screenshot-guided pointer and keyboard control.
///
/// This is the riskiest surface in the product: it drives the user's real mouse and keyboard. The
/// tests here are about the guards rather than the gestures — a stale coordinate is refused, a
/// covered point is refused, a window that is not in front is refused, and nothing is ever left
/// held down.
/// </summary>
public sealed class WindowsVisualInputTests
{
	private static readonly CanvasContextKey Panel =
		new("session", "panel", CanvasSurfaces.Windows);

	[Fact]
	public async Task Click_MapsCaptureCoordinatesOntoTheDesktopAndReleasesEverything()
	{
		var harness = await Harness.AttachedAsync();

		var result = await harness.Service.ClickAsync(
			Panel,
			new WindowsClickRequest
			{
				TransformVersion = await harness.TokenAsync(),
				X = 100,
				Y = 50,
				Modifiers = ["ctrl"],
			});

		Assert.True(result.Success);
		Assert.Equal("click:left", result.Operation);
		Assert.Equal(harness.WindowId, result.WindowId);
		Assert.Equal(100, result.Point!.X);
		// The fixture window sits on a second monitor whose origin is negative.
		Assert.Equal(-1820, result.ScreenPoint!.X);
		Assert.Equal(-150, result.ScreenPoint.Y);
		Assert.Equal(
			new[]
			{
				"move:-1820,-150",
				"key:17:down",
				"down:left@-1820,-150",
				"up:left@-1820,-150",
				"key:17:up",
			},
			harness.Input.Operations);
	}

	[Fact]
	public async Task Click_AcceptsCoordinatesMeasuredOnAScaledImage()
	{
		var harness = await Harness.AttachedAsync();

		var result = await harness.Service.ClickAsync(
			Panel,
			new WindowsClickRequest
			{
				TransformVersion = await harness.TokenAsync(),
				X = 50,
				Y = 25,
				CaptureWidth = 400,
				CaptureHeight = 300,
			});

		// Half-scale image, so the same place in the window. Nothing about the browser's rendered
		// size or its letterboxing takes part in the mapping.
		Assert.Equal(100, result.Point!.X);
		Assert.Equal(50, result.Point.Y);
		Assert.Contains("down:left@-1820,-150", harness.Input.Operations);
	}

	[Fact]
	public async Task DoubleClick_SendsTwoPressesWithoutLeavingAButtonDown()
	{
		var harness = await Harness.AttachedAsync();

		var result = await harness.Service.ClickAsync(
			Panel,
			new WindowsClickRequest
			{
				TransformVersion = await harness.TokenAsync(),
				X = 10,
				Y = 10,
				Button = WindowsPointerButtons.Right,
				Count = 2,
			});

		Assert.Equal("doubleClick:right", result.Operation);
		Assert.Equal(2, harness.Input.Operations.Count(op => op.StartsWith("down:right", StringComparison.Ordinal)));
		Assert.Equal(2, harness.Input.Operations.Count(op => op.StartsWith("up:right", StringComparison.Ordinal)));
	}

	[Fact]
	public async Task Click_RefusesAStaleTransformInsteadOfGuessing()
	{
		var harness = await Harness.AttachedAsync();
		var token = await harness.TokenAsync();
		// The window moved to the other monitor between the screenshot and the click.
		harness.Geometry.Default = Fixtures.Geometry(left: 100, top: 100);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.ClickAsync(
				Panel,
				new WindowsClickRequest { TransformVersion = token, X = 10, Y = 10 }));

		Assert.Equal(WindowsErrorCodes.InputTransformStale, failure.Code);
		Assert.Empty(harness.Input.Operations);
	}

	[Fact]
	public async Task Click_RefusesAStaleTransformAfterAResize()
	{
		var harness = await Harness.AttachedAsync();
		var token = await harness.TokenAsync();
		// Same position, same monitor, but the window is 40 pixels narrower than the screenshot the
		// coordinates were measured against.
		harness.Geometry.Default = Fixtures.Geometry(contentWidth: 760);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.ClickAsync(
				Panel,
				new WindowsClickRequest { TransformVersion = token, X = 700, Y = 10 }));

		Assert.Equal(WindowsErrorCodes.InputTransformStale, failure.Code);
		Assert.Contains("resized", failure.Message, StringComparison.OrdinalIgnoreCase);
		Assert.Empty(harness.Input.Operations);
	}

	[Fact]
	public async Task Click_RequiresATransformAtAll()
	{
		var harness = await Harness.AttachedAsync();

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.ClickAsync(
				Panel,
				new WindowsClickRequest { X = 10, Y = 10 }));

		Assert.Equal(WindowsErrorCodes.InputTransformStale, failure.Code);
		Assert.Empty(harness.Input.Operations);
	}

	[Fact]
	public async Task Click_RefusesAPointOutsideTheWindow()
	{
		var harness = await Harness.AttachedAsync();
		var token = await harness.TokenAsync();

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.ClickAsync(
				Panel,
				new WindowsClickRequest
				{
					TransformVersion = token,
					X = 900,
					Y = 10,
				}));

		Assert.Equal(WindowsErrorCodes.InputOutOfBounds, failure.Code);
		Assert.Empty(harness.Input.Operations);
	}

	[Fact]
	public async Task Click_RefusesWhenWindowsWillNotGiveTheWindowTheForeground()
	{
		var harness = await Harness.AttachedAsync();
		var token = await harness.TokenAsync();
		harness.Input.Foreground = 0;
		harness.Controller.RevealOutcome = WindowsWindowActionOutcome.Refused(
			"Windows declined to bring the window to the foreground.");

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.ClickAsync(
				Panel,
				new WindowsClickRequest { TransformVersion = token, X = 10, Y = 10 }));

		Assert.Equal(WindowsErrorCodes.InputForegroundRefused, failure.Code);
		Assert.Contains("declined", failure.Message, StringComparison.OrdinalIgnoreCase);
		Assert.Empty(harness.Input.Operations);
	}

	[Fact]
	public async Task Click_RefusesAPointAnotherWindowIsCovering()
	{
		var harness = await Harness.AttachedAsync();
		var token = await harness.TokenAsync();
		harness.Input.Covering = 99;

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.ClickAsync(
				Panel,
				new WindowsClickRequest { TransformVersion = token, X = 10, Y = 10 }));

		Assert.Equal(WindowsErrorCodes.InputForegroundRefused, failure.Code);
		Assert.Empty(harness.Input.Operations);
	}

	[Fact]
	public async Task Click_ReleasesModifiersAndButtonsWhenWindowsRefusesMidGesture()
	{
		var harness = await Harness.AttachedAsync();
		var token = await harness.TokenAsync();
		harness.Input.Refuse = operation => operation.StartsWith("down:left", StringComparison.Ordinal)
			? WindowsInputOutcome.Refused("UIPI blocked the click.")
			: null;

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.ClickAsync(
				Panel,
				new WindowsClickRequest
				{
					TransformVersion = token,
					X = 10,
					Y = 10,
					Modifiers = ["shift"],
				}));

		Assert.Equal(WindowsErrorCodes.InputFailed, failure.Code);
		// Shift must not be left held on the user's real keyboard because a click failed.
		Assert.Contains("key:16:up", harness.Input.Operations);
		Assert.DoesNotContain(
			harness.Input.Operations,
			operation => operation.StartsWith("key:16:down", StringComparison.Ordinal)
				&& harness.Input.Operations.Count(o => o == "key:16:up") == 0);
	}

	[Fact]
	public async Task Pointer_LeavesTheButtonDownUntilItIsReleasedOrTheSessionEnds()
	{
		var harness = await Harness.AttachedAsync();
		var token = await harness.TokenAsync();

		await harness.Service.PointerAsync(
			Panel,
			new WindowsPointerRequest
			{
				TransformVersion = token,
				Action = WindowsPointerActions.Down,
				X = 10,
				Y = 10,
			});
		harness.Input.Operations.Clear();

		await harness.Service.ReleaseAsync(Panel);

		// A panel that walked away mid-drag must not leave a mouse button held.
		Assert.Equal(["up:left@-1910,-190"], harness.Input.Operations);
	}

	[Fact]
	public async Task Detach_ReleasesHeldInput()
	{
		var harness = await Harness.AttachedAsync();
		var token = await harness.TokenAsync();
		await harness.Service.KeyAsync(
			Panel,
			new WindowsKeyRequest
			{
				TransformVersion = token,
				Keys = ["ctrl"],
				Action = WindowsKeyActions.Down,
			});
		harness.Input.Operations.Clear();

		harness.Service.Detach(Panel);

		Assert.Equal(["key:17:up"], harness.Input.Operations);
	}

	[Fact]
	public async Task ExpiredPanel_ReleasesHeldInputBeforeItsGrantIsRemoved()
	{
		var harness = await Harness.AttachedAsync();
		var token = await harness.TokenAsync();
		await harness.Service.PointerAsync(
			Panel,
			new WindowsPointerRequest
			{
				TransformVersion = token,
				Action = WindowsPointerActions.Down,
				X = 10,
				Y = 10,
			});
		harness.Input.Operations.Clear();

		harness.Service.PruneExpiredPanels(DateTimeOffset.UtcNow.AddHours(5));

		Assert.Equal(["up:left@-1910,-190"], harness.Input.Operations);
	}

	[Fact]
	public async Task Drag_PressesMovesAndReleases()
	{
		var harness = await Harness.AttachedAsync();

		var result = await harness.Service.DragAsync(
			Panel,
			new WindowsDragRequest
			{
				TransformVersion = await harness.TokenAsync(),
				StartX = 10,
				StartY = 10,
				EndX = 110,
				EndY = 60,
				DurationMilliseconds = 0,
				Steps = 4,
			});

		Assert.Equal("drag:left", result.Operation);
		Assert.Equal(110, result.EndPoint!.X);
		Assert.Equal("down:left@-1910,-190", harness.Input.Operations[1]);
		Assert.Equal("up:left@-1810,-140", harness.Input.Operations[^1]);
		Assert.Equal(5, harness.Input.Operations.Count(op => op.StartsWith("move:", StringComparison.Ordinal)) - 1);
	}

	[Fact]
	public async Task Wheel_RequiresANonZeroDeltaAndBoundsIt()
	{
		var harness = await Harness.AttachedAsync();
		var token = await harness.TokenAsync();

		var empty = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.WheelAsync(
				Panel,
				new WindowsWheelRequest { TransformVersion = token, X = 10, Y = 10 }));
		var huge = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.WheelAsync(
				Panel,
				new WindowsWheelRequest
				{
					TransformVersion = token,
					X = 10,
					Y = 10,
					DeltaY = 5000,
				}));
		var scrolled = await harness.Service.WheelAsync(
			Panel,
			new WindowsWheelRequest
			{
				TransformVersion = token,
				X = 10,
				Y = 10,
				DeltaY = 3,
				DeltaX = -2,
			});

		Assert.Equal(WindowsErrorCodes.InvalidRequest, empty.Code);
		Assert.Equal(WindowsErrorCodes.InvalidRequest, huge.Code);
		Assert.Equal("wheel", scrolled.Operation);
		Assert.Contains("wheel:3,-2@-1910,-190", harness.Input.Operations);
	}

	[Fact]
	public async Task Key_HoldsAChordInOrderAndReleasesItInReverse()
	{
		var harness = await Harness.AttachedAsync();

		var result = await harness.Service.KeyAsync(
			Panel,
			new WindowsKeyRequest
			{
				TransformVersion = await harness.TokenAsync(),
				Keys = ["ctrl", "shift", "p"],
			});

		Assert.Equal("key:press", result.Operation);
		Assert.Equal(3, result.KeyCount);
		Assert.Equal(
			new[]
			{
				"key:17:down",
				"key:16:down",
				"key:80:down",
				"key:80:up",
				"key:16:up",
				"key:17:up",
			},
			harness.Input.Operations);
	}

	[Fact]
	public async Task Key_RefusesAnUnknownName()
	{
		var harness = await Harness.AttachedAsync();
		var token = await harness.TokenAsync();

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.KeyAsync(
				Panel,
				new WindowsKeyRequest
				{
					TransformVersion = token,
					Keys = ["hyper"],
				}));

		Assert.Equal(WindowsErrorCodes.InvalidRequest, failure.Code);
		Assert.Empty(harness.Input.Operations);
	}

	[Fact]
	public async Task TypeText_ReportsOnlyHowMuchWasTypedAndNeverTheTextItself()
	{
		var harness = await Harness.AttachedAsync();

		var result = await harness.Service.TypeTextAsync(
			Panel,
			new WindowsTypeTextRequest
			{
				TransformVersion = await harness.TokenAsync(),
				Text = "hi\r\n\tok",
			});

		Assert.Equal("text", result.Operation);
		Assert.Equal(7, result.CharacterCount);
		Assert.Null(result.Detail);
		Assert.DoesNotContain("hi", System.Text.Json.JsonSerializer.Serialize(
			result,
			WindowsJsonContext.Default.WindowsInputResult), StringComparison.Ordinal);
		// A carriage return is dropped, a newline becomes Return, and a tab becomes Tab, because
		// Windows does not deliver those reliably as Unicode key events.
		Assert.Contains("unicode:104:down", harness.Input.Operations);
		Assert.Contains("key:13:down", harness.Input.Operations);
		Assert.Contains("key:9:down", harness.Input.Operations);
		Assert.DoesNotContain("unicode:13:down", harness.Input.Operations);
	}

	[Fact]
	public async Task TypeText_BoundsItsLength()
	{
		var harness = await Harness.AttachedAsync();
		var token = await harness.TokenAsync();

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.TypeTextAsync(
				Panel,
				new WindowsTypeTextRequest
				{
					TransformVersion = token,
					Text = new string('x', WindowsInputLimits.MaximumTextLength + 1),
				}));

		Assert.Equal(WindowsErrorCodes.InvalidRequest, failure.Code);
		Assert.Empty(harness.Input.Operations);
	}

	[Fact]
	public async Task Input_RefusesAMinimizedWindow()
	{
		var harness = await Harness.AttachedAsync();
		var token = await harness.TokenAsync();
		harness.Geometry.Default = Fixtures.Geometry(minimized: true);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.ClickAsync(
				Panel,
				new WindowsClickRequest { TransformVersion = token, X = 10, Y = 10 }));

		Assert.Equal(WindowsErrorCodes.WindowMinimized, failure.Code);
		Assert.Empty(harness.Input.Operations);
	}

	[Fact]
	public async Task Input_RefusesAWindowThatClosedBetweenReadAndAct()
	{
		var harness = await Harness.AttachedAsync();
		var token = await harness.TokenAsync();
		harness.Geometry.Default = null;

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.ClickAsync(
				Panel,
				new WindowsClickRequest { TransformVersion = token, X = 10, Y = 10 }));

		Assert.Equal(WindowsErrorCodes.WindowNotFound, failure.Code);
	}

	[Fact]
	public async Task Input_IsNotReachableFromAnotherPanel()
	{
		var harness = await Harness.AttachedAsync();
		var token = await harness.TokenAsync();
		var other = new CanvasContextKey("session", "other-panel", CanvasSurfaces.Windows);

		var failure = await Assert.ThrowsAsync<WindowsCanvasException>(
			() => harness.Service.ClickAsync(
				other,
				new WindowsClickRequest
				{
					WindowId = harness.WindowId,
					TransformVersion = token,
					X = 10,
					Y = 10,
				}));

		Assert.Equal(WindowsErrorCodes.SessionNotFound, failure.Code);
		Assert.Empty(harness.Input.Operations);
	}

	[Fact]
	public async Task Input_IsRateLimited()
	{
		var harness = await Harness.AttachedAsync();
		var token = await harness.TokenAsync();

		WindowsCanvasException? failure = null;
		for (var attempt = 0; attempt <= WindowsInputLimits.MaximumOperationsPerSecond; attempt++)
		{
			try
			{
				await harness.Service.ClickAsync(
					Panel,
					new WindowsClickRequest { TransformVersion = token, X = 10, Y = 10 });
			}
			catch (WindowsCanvasException exception)
			{
				failure = exception;
				break;
			}
		}

		Assert.NotNull(failure);
		Assert.Equal(WindowsErrorCodes.InputRateLimited, failure!.Code);
		Assert.Equal(429, failure.Status);
	}

	[Fact]
	public void Modifiers_MustActuallyBeModifiers()
	{
		Assert.True(WindowsVirtualKeys.IsModifier("ctrl"));
		Assert.True(WindowsVirtualKeys.IsModifier("Shift"));
		Assert.False(WindowsVirtualKeys.IsModifier("enter"));
	}

	[Fact]
	public void TypedTextIsRedactedForTheWindowsSurface()
	{
		var redacted = AutomationEventRedaction.ForSurface(
			CanvasSurfaces.Windows,
			new AutomationEvent { Kind = AutomationEventKinds.Text, Detail = "hunter2" });
		var mobile = AutomationEventRedaction.ForSurface(
			CanvasSurfaces.Mobile,
			new AutomationEvent { Kind = AutomationEventKinds.Text, Detail = "hunter2" });

		Assert.Null(redacted.Detail);
		Assert.Equal(7, redacted.CharacterCount);
		// Mobile's status pill has always shown what an agent typed into a simulator the user is
		// already watching, and that behaviour is unchanged.
		Assert.Equal("hunter2", mobile.Detail);
	}

	private sealed class Harness
	{
		public required WindowsAppService Service { get; init; }
		public required FakeWindowsNativeBridge Bridge { get; init; }
		public required FakeWindowGeometry Geometry { get; init; }
		public required FakeInputController Input { get; init; }
		public required FakeWindowController Controller { get; init; }
		public required string WindowId { get; init; }

		public async Task<string> TokenAsync() =>
			(await Service.GetGeometryAsync(Panel)).TransformVersion;

		public static async Task<Harness> AttachedAsync()
		{
			var bridge = new FakeWindowsNativeBridge
			{
				Windows = Fixtures.WindowList(Fixtures.Window(11, 100, "Fixture window")),
			};
			var geometry = new FakeWindowGeometry();
			var input = new FakeInputController { Foreground = 11 };
			var controller = new FakeWindowController();
			var service = new WindowsAppService(
				bridge,
				controller,
				new FakeProcessLauncher(),
				geometry,
				input);

			var candidates = await service.ListWindowCandidatesAsync(Panel);
			var session = await service.AttachAsync(
				Panel,
				new WindowsAttachRequest { CandidateId = candidates.Windows[0].Id });

			return new Harness
			{
				Service = service,
				Bridge = bridge,
				Geometry = geometry,
				Input = input,
				Controller = controller,
				WindowId = session.Windows[0].Id,
			};
		}
	}
}
