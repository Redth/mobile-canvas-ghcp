async (page) => {
  const { url, evidenceUrl } = await page.evaluate(() => window.ailohaBrowserTestOptions);
  const verify = (condition, message) => { if (!condition) throw new Error(message); };
  const evidence = async () => {
    const value = await (await page.request.get(evidenceUrl)).json();
    verify(value.synthetic === true, "Only the owned synthetic fixture may be inspected.");
    return value;
  };
  const control = async (input) => {
    verify((await page.request.post(`${evidenceUrl}/control`, { data: input })).status() === 204,
      "The synthetic control was refused.");
  };
  const videoPosts = (value) => value.calls.filter((call) => call.method === "POST" && call.path.endsWith("/video/sessions")).length;
  const inputs = (value) => value.calls.filter((call) => call.method === "POST" && call.path.includes("/input/")).length;
  const starts = (value) => value.calls.filter((call) => call.method === "POST" && call.path.endsWith("/actions/start")).length;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#stream-mode")?.textContent === "ALHV H.264");
  await page.waitForFunction(() => document.querySelector("#workspace-inspection")?.dataset.collapsed !== undefined
    && document.querySelector("#semantic-inspection")?.dataset.collapsed !== undefined);
  verify(await page.locator("#workspace-inspection").getAttribute("data-collapsed") === "true"
    && await page.locator("#semantic-inspection").getAttribute("data-collapsed") === "true",
  "Secondary panels must start collapsed.");
  const initial = await evidence();
  for (const [title, id] of [["Workspace", "workspace"], ["Live inspection", "semantic"]]) {
    await page.getByRole("button", { name: `Expand ${title}`, exact: true }).click();
    const handle = page.getByRole("separator", { name: `Resize ${title}`, exact: true });
    await handle.focus();
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) await page.keyboard.press(key);
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 25, box.y + box.height / 2);
    await page.mouse.up();
    const toggle = page.getByRole("button", { name: `Collapse ${title}`, exact: true });
    await toggle.focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("Enter");
    verify(await page.locator(`#${id}-inspection`).getAttribute("data-collapsed") === "false",
      "Native keyboard collapse/expand did not restore the panel.");
  }
  const afterPanels = await evidence();
  verify(inputs(afterPanels) === inputs(initial) && videoPosts(afterPanels) === videoPosts(initial)
    && afterPanels.leases === initial.leases && JSON.stringify(afterPanels.context) === JSON.stringify(initial.context),
  "Panel gestures/keys changed device input, media resources, leases or selection.");
  for (const title of ["Workspace", "Live inspection"]) {
    await page.getByRole("button", { name: `Collapse ${title}`, exact: true }).click();
  }
  await page.setViewportSize({ width: 360, height: 700 });
  await page.getByRole("button", { name: "Expand Workspace", exact: true }).click();
  const narrowHandle = page.getByRole("separator", { name: "Resize Workspace", exact: true });
  verify(await narrowHandle.getAttribute("aria-orientation") === "horizontal", "Narrow resize axis did not change.");
  await narrowHandle.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowUp");
  await page.getByRole("button", { name: "Collapse Workspace", exact: true }).click();

  await control({ type: "target-state", status: "stopped", runtimeFailure: true });
  await page.locator("#refresh-button").click();
  await page.waitForFunction(() => document.querySelector("#device-frame")?.dataset.status === "offline");
  await page.evaluate(() => {
    const canvas = document.querySelector("#device-screen");
    canvas.width = 180;
    canvas.height = 400;
  });
  await page.setViewportSize({ width: 809, height: 430 });
  await page.locator('[data-action="boot"]').click();
  await page.waitForFunction(() => document.querySelector("#stream-overlay-title")?.textContent === "Boot failed");
  const detail = await page.locator("#stream-overlay-detail").textContent();
  verify(detail.includes("runtime is missing or unavailable") && !/xcrun|simctl|private\/synthetic/.test(detail),
    "Known native failure did not produce only its fixed safe hint.");
  verify(await page.locator("#stream-overlay-action").textContent().then((text) => text.includes("Refresh devices")),
    "Accepted lifecycle failure offered a mutating replay.");
  const accepted = await evidence();
  verify(starts(accepted) === 1, "The synthetic boot was submitted more than once.");
  await page.locator("#stream-overlay-action").click();
  await page.waitForFunction(() => document.querySelector("#device-frame")?.dataset.status === "unavailable");
  verify(await page.locator('[data-action="boot"]').isHidden()
    && await page.locator('[data-action="restart"]').isHidden()
    && starts(await evidence()) === 1, "Unavailable target retained impossible operations.");

  await control({ type: "target-state", status: "stopped" });
  await page.locator("#refresh-button").click();
  await page.waitForFunction(() => document.querySelector("#device-frame")?.dataset.status === "offline");
  const longText = "Long safe unavailable explanation " + "unbroken-safe-token-".repeat(80) + " <img src=x>";
  await page.route("**/api/v1/devices/*/boot", (route) => route.fulfill({
    status: 409, contentType: "application/json",
    body: JSON.stringify({ code: "target_unavailable", message: longText }),
  }));
  await page.locator('[data-action="boot"]').click();
  const measurements = [];
  for (const viewport of [{ width: 1200, height: 700 }, { width: 809, height: 430 }, { width: 360, height: 500 }]) {
    await page.setViewportSize(viewport);
    const action = page.locator("#stream-overlay-action");
    await action.scrollIntoViewIfNeeded();
    const layout = await page.evaluate(() => {
      const overlay = document.querySelector("#stream-overlay");
      const viewport = document.querySelector(".stage-viewport");
      const action = document.querySelector("#stream-overlay-action");
      const rect = action.getBoundingClientRect();
      const bounds = overlay.getBoundingClientRect();
      return {
        overlayWidth: bounds.width, stageWidth: viewport.getBoundingClientRect().width,
        actionHeight: rect.height, actionTop: rect.top, actionBottom: rect.bottom,
        overlayTop: bounds.top, overlayBottom: bounds.bottom,
        horizontalOverflow: overlay.scrollWidth - overlay.clientWidth,
        insideFrame: Boolean(overlay.closest(".device-frame")),
        text: document.querySelector("#stream-overlay-detail").textContent,
        injected: overlay.querySelectorAll("img").length,
      };
    });
    verify(!layout.insideFrame && layout.overlayWidth >= layout.stageWidth - 2
      && layout.actionHeight >= 44 && layout.horizontalOverflow <= 1
      && layout.actionTop >= layout.overlayTop - 1 && layout.actionBottom <= layout.overlayBottom + 1
      && layout.text === longText && layout.injected === 0,
    `Status text/action was cropped or scaled with device pixels: ${JSON.stringify({ viewport, layout })}`);
    measurements.push({ viewport, overlayWidth: layout.overlayWidth, stageWidth: layout.stageWidth, actionHeight: layout.actionHeight });
  }
  await page.unroute("**/api/v1/devices/*/boot");
  verify(errors.length === 0, `Shared renderer errors: ${errors.join("; ")}`);
  return {
    syntheticOnly: true, sharedPreparedRenderer: true, panelsIndependent: true,
    keyboardPointerResizeNoDeviceInput: true, selectionAndLeasePreserved: true,
    unavailableControlsGated: true, acceptedBootPosts: starts(await evidence()),
    safeNativeHint: true, longTextLiteral: true, measurements,
  };
}
