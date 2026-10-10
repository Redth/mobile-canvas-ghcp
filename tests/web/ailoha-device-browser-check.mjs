async (page) => {
  const { url, evidenceUrl, recording, recordingAvailable = recording, recordingLostStart, workspaceCards = false } = await page.evaluate(
    () => window.ailohaBrowserTestOptions);
  const verify = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const evidence = async () => {
    const response = await fetch(evidenceUrl, { signal: AbortSignal.timeout(5000) });
    verify(response.ok, "The synthetic host evidence endpoint failed.");
    const result = await response.json();
    verify(result.synthetic === true, "This browser check can only control the synthetic fixture.");
    return result;
  };
  const videoPosts = (result) => result.calls.filter((call) =>
    call.method === "POST" && call.path?.endsWith("/video/sessions")).length;
  const videoDeletes = (result) => result.calls.filter((call) => call.method === "DELETE").length;
  const waitFor = async (condition) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await evidence();
      if (condition(result)) return result;
      await page.waitForTimeout(10);
    }
    throw new Error("The synthetic device UI did not reach its expected owned resource state.");
  };

  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#stream-mode")?.textContent === "ALHV H.264");
  await page.waitForFunction(() => document.querySelector("#semantic-inspection")?.hidden === false);
  verify(await page.locator("#semantic-inspection").getByText("System (Target Host)").count() > 0,
    "Read-only System inspection is not visible alongside the live video.");
  if (workspaceCards) {
    await page.waitForFunction(() => document.querySelector("#workspace-inspection")?.dataset.status === "ready");
    await page.locator("#workspace-inspection").getByRole("button", { name: "Inspect", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#workspace-inspection")?.dataset.status === "complete");
    verify(await page.locator(".workspace-app-card").count() === 8, "The resized media check did not include actual workspace cards.");
    const application = (await evidence()).workspace.inspection.applications.find((entry) => entry.missingSteps.length);
    verify(Boolean(application), "The canonical fixture has no concrete missing-step evidence.");
    const card = page.locator(".workspace-app-card").filter({ hasText: application.primaryManifest });
    await card.locator("summary").click();
    const text = await card.locator(".workspace-app-details").textContent();
    verify(application.missingSteps.every((step) => text.includes(step.description))
      && application.recommendedSkillIds.every((id) => text.includes(id))
      && text.includes("Approval and workspace mutation required") && text.includes("Informational IDs only"),
    "The media check did not include actual read-only scanner guidance.");
  }
  for (const width of [1200, 700, 1000, 900]) {
    await page.setViewportSize({ width, height: 700 });
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(500);
  let observed = await evidence();
  verify(videoPosts(observed) === 1 && videoDeletes(observed) === 0 && observed.errors.length === 0,
    "Resize/idle or the startup selection announcement recreated an Ailoha video session.");

  await page.locator("#device-screen").click();
  const box = await page.locator("#device-screen").boundingBox();
  verify(box?.width > 0 && box?.height > 0, "The actual device canvas is not visible.");
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 3 * box.width / 4, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  observed = await waitFor((result) => result.calls.filter((call) => call.path?.includes("/input/actions/")).length === 2);
  const calls = observed.calls.filter((call) => call.path?.includes("/input/actions/"));
  const tap = JSON.parse(calls.find((call) => call.path.endsWith("/tap")).body);
  const gesture = JSON.parse(calls.find((call) => call.path.endsWith("/gesture")).body);
  verify(Math.abs(tap.x - 24) < 0.1 && Math.abs(tap.y - 16) < 0.1 && tap.geometryRevision === 14,
    "Pointer input did not use observed logical bounds and geometry revision.");
  verify(gesture.geometryRevision === 14 && gesture.actions[0].x === 12
    && gesture.actions.at(-1).x === 36 && gesture.actions.every((action) => action.y === undefined || action.y === 16),
  "The captured swipe was scaled using encoded pixels or unrelated geometry.");
  const view = await page.evaluate(() => {
    const canvas = document.querySelector("#device-screen");
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    return {
      mode: document.querySelector("#stream-mode").textContent,
      geometry: document.querySelector("#geometry").value,
      input: document.querySelector("#input-status").textContent,
      width: canvas.width,
      height: canvas.height,
      painted: pixels.some((value, index) => index % 4 !== 3 && value > 0),
      createDisabled: document.querySelector("#create-button").disabled,
      recordHidden: document.querySelector("#record-button").hidden,
    };
  });
  verify(view.painted && view.width === 96 && view.height === 64 && view.createDisabled
    && view.recordHidden === !recordingAvailable,
    "The consumed UI did not paint real WebCodecs frames or gate unsupported controls.");

  await page.locator('[data-action="home"]').click();
  await page.locator("#device-screen").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.type("A");
  await page.evaluate(() => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => "literal text" } });
    document.querySelector("#device-screen").dispatchEvent(event);
  });
  observed = await waitFor((result) => result.calls.filter((call) =>
    call.path?.endsWith("/input/actions/key")).length >= 2);
  const keys = observed.calls.filter((call) => call.path?.endsWith("/input/actions/key"))
    .map((call) => JSON.parse(call.body).key);
  const unsupportedText = await page.locator("#toast").textContent();
  verify(keys.includes("home") && keys.includes("40")
    && unsupportedText?.includes("cursor-preserving text input")
    && !observed.calls.some((call) => call.path?.endsWith("/input/actions/fill")),
  "The real toolbar/keyboard must preserve key/button transport and reject unsafe plain text.");
  await page.locator('[data-action="rotate"]').click();
  observed = await waitFor((result) => result.calls.some((call) =>
    call.path?.endsWith("/presentation") && call.method === "PATCH"));
  verify(videoPosts(observed) === 1 && videoDeletes(observed) === 0,
    "Rotation recreated or deleted the owned Ailoha live video resource.");
  const orientation = JSON.parse(observed.calls.find((call) =>
    call.path?.endsWith("/presentation") && call.method === "PATCH").body);
  verify(["portrait", "landscape"].includes(orientation.orientation),
    "Rotation did not send a canonical orientation.");
  const statusBar = await page.evaluate(async () => {
    const route = "/api/v1/devices/opaque%2Ftarget/presentation";
    const set = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, time: "09:41" }) });
    const get = await fetch(route);
    return { setStatus: set.status, getStatus: get.status, body: await get.json() };
  });
  verify(statusBar.setStatus === 200 && statusBar.getStatus === 200
    && statusBar.body.enabled === true && statusBar.body.overrides.some((value) =>
      value.name === "time" && value.value === "09:41"),
  "Status-bar presentation did not preserve the compatibility read/write shape.");

  if (recordingAvailable) {
    const recordButton = page.locator("#record-button");
    await recordButton.click();
    await page.waitForFunction((lost) =>
      document.querySelector("#record-button")?.getAttribute("aria-label") === (lost ? "Resolve recording" : "Stop recording"),
    recordingLostStart);
    if (recordingLostStart) {
      const lost = await evidence();
      verify(lost.recordingCommands.filter((action) => action === "start").length === 1
        && !lost.recordingCommands.includes("stop"),
      "A lost start response was replayed or did not remain pending for captured cleanup.");
    }
    await recordButton.click();
    await page.waitForFunction(() => document.querySelector("#record-button")?.getAttribute("aria-label") === "Start recording");
    const finalized = await evidence();
    verify(finalized.recordingCommands.filter((action) => action === "start").length === 1
      && finalized.recordingCommands.filter((action) => action === "stop").length === 1
      && finalized.recordingCommands.filter((action) => action === "recover").length === 1
      && finalized.recordingFiles === 1,
    "The prepared renderer did not finalize exactly its first owned recording.");
    await recordButton.click();
    await page.waitForFunction(() => document.querySelector("#record-button")?.getAttribute("aria-label") === "Stop recording");
  }
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hidden = await waitFor((result) => result.leases === 0 && result.videoResources === 0);
  verify(videoPosts(hidden) === 1 && videoDeletes(hidden) === 1
    && hidden.errors.length === (recordingLostStart ? 1 : 0)
    && (!recordingLostStart || hidden.errors[0].code === "ailoha_cli_failed"),
    "Hiding the real shared renderer did not retire exactly its owned video/lease.");
  if (recordingAvailable) verify(hidden.recordingCommands.filter((action) => action === "stop").length === 2
    && hidden.recordingCommands.filter((action) => action === "recover").length === 2
    && hidden.recordingFiles === 2,
    "Hiding the view did not finalize its captured recording before lease release.");
  if (recording && !recordingAvailable) verify(hidden.recordingCommands.every((action) => action === "status")
    && hidden.recordingFiles === 0,
    "A capture-capable host without verified recovery started recording.");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const resumed = await waitFor((result) => videoPosts(result) === 2 && result.leases === 1 && result.videoResources === 1);
  await page.waitForTimeout(1000);
  const settled = await evidence();
  verify(videoPosts(settled) === 2 && videoDeletes(settled) === 1
    && settled.errors.length === (recordingLostStart ? 1 : 0),
    "Explicit resume triggered an automatic video creation loop.");
  verify(!settled.calls.some((call) => call.path === "/api/v1/host/stop"),
    "View cleanup stopped a shared host.");
  return {
    synthetic: true, realWebCodecs: true, resizeEvents: 4, workspaceCards, readOnlyGuidance: workspaceCards,
    initialVideoPosts: 1, initialVideoDeletes: 0,
    view, tap, gesture,
    hidden: { leases: hidden.leases, videoResources: hidden.videoResources },
    resumed: { leases: resumed.leases, videoResources: resumed.videoResources, videoPosts: videoPosts(settled), videoDeletes: videoDeletes(settled) },
    errors: settled.errors,
    ...(recordingAvailable ? { recordingStarts: 2, recordingStops: 2, recordingLostStart: Boolean(recordingLostStart) }
      : recording ? { recordingStarts: 0, recordingStops: 0, recordingAvailable: false } : {}),
  };
}
