async (page) => {
  const { url, evidenceUrl, mode } = await page.evaluate(() => window.ailohaBrowserTestOptions);
  if (!["retry", "reselect", "changed-host", "fenced-read", "fenced-reselect", "fenced-echo"].includes(mode)) {
    throw new Error("Unknown explicit rotation recovery mode.");
  }
  let intercepted = 0;
  let selectionPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/selection") {
      selectionPosts += 1;
    }
  });
  await page.route("**/api/v1/devices/**/input/rotate", (route) => {
    intercepted += 1;
    return route.fulfill({
      status: 408, contentType: "application/json",
      body: JSON.stringify({ code: "request_timeout", message: "Synthetic original rotation outcome unknown." }),
    });
  });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#stream-mode")?.textContent === "ALHV H.264"
    && document.querySelector("#geometry")?.value.includes("revision 14"));
  await page.locator('[data-action="rotate"]').click();
  await page.waitForFunction(() => document.querySelector("#input-status")?.textContent === "Rotate failed");

  if (mode === "fenced-echo") {
    await page.route("**/api/v1/selection", (route) => route.request().method() === "GET"
      ? route.fulfill({
        status: 409, contentType: "application/json",
        body: JSON.stringify({ code: "context_owner_changed", message: "Synthetic private owner incarnation changed." }),
      }) : route.continue());
    await page.locator("#refresh-button").click();
    await page.waitForFunction(() => document.querySelector("#toast")?.textContent
      ?.includes("Synthetic private owner incarnation changed."));
    const screen = await page.evaluate(() => {
      const canvas = document.querySelector("#device-screen");
      return {
        painted: canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data
          .some((value, index) => index % 4 !== 3 && value > 0),
        status: document.querySelector("#input-status")?.textContent,
      };
    });
    if (screen.painted || screen.status === "Geometry-bound input ready") {
      throw new Error("Fenced same-ID announcement retained stale owner pixels or enabled input.");
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const current = await (await page.request.get(evidenceUrl)).json();
      if (current.videoResources === 0) break;
      await page.waitForTimeout(20);
    }
  } else if (mode === "changed-host") {
    await page.route("**/api/v1/catalog", async (route) => {
      const response = await route.fetch();
      const catalog = await response.json();
      for (const device of catalog.devices) if (device.id === "opaque/target") device.targetHostId = "different-host";
      await route.fulfill({ response, json: catalog });
    });
    await page.locator("#refresh-button").click();
    await page.waitForFunction(() => document.querySelector("#toast")?.textContent
      ?.includes("changed Ailoha selection is not bound"));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const current = await (await page.request.get(evidenceUrl)).json();
      if (current.videoResources === 0) break;
      await page.waitForTimeout(20);
    }
  } else if (mode === "fenced-read") {
    await page.route("**/api/v1/devices/**/display", (route) =>
      route.fulfill({
        status: 409, contentType: "application/json",
        body: JSON.stringify({ code: "context_owner_changed", message: "Synthetic original owner changed." }),
      }));
    await page.locator('[data-status-action="retry-stream"]').click();
    await page.waitForFunction(() => document.querySelector("#input-status")?.textContent === "Live view unavailable");
  } else if (mode === "fenced-reselect") {
    await page.route("**/api/v1/selection", (route) => route.request().method() === "POST"
      ? route.fulfill({
        status: 409, contentType: "application/json",
        body: JSON.stringify({ code: "context_owner_changed", message: "Synthetic original owner changed." }),
      }) : route.continue());
    await page.locator("#device-selector").click();
    await page.locator(".device-card").first().click();
    await page.waitForFunction(() => document.querySelector("#toast")?.textContent
      ?.includes("Synthetic original owner changed"));
  } else {
    if ((await page.request.post(`${evidenceUrl}/defer-next-video-frame`)).status() !== 204) {
      throw new Error("The synthetic recovery frame was not held.");
    }
    if (mode === "retry") {
      await page.locator('[data-status-action="retry-stream"]').click();
    } else {
      const selected = page.waitForRequest((request) =>
        request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/selection");
      await page.locator("#device-selector").click();
      await page.locator(".device-card").first().click();
      await selected;
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const evidence = await (await page.request.get(evidenceUrl)).json();
      if (evidence.calls.filter((call) => call.method === "POST"
        && call.path?.endsWith("/video/sessions")).length === 2) break;
      await page.waitForTimeout(20);
    }
    const pending = await page.evaluate(() => {
      const canvas = document.querySelector("#device-screen");
      return {
        input: document.querySelector("#input-status")?.textContent,
        painted: canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data
          .some((value, index) => index % 4 !== 3 && value > 0),
      };
    });
    if (!pending.input?.includes("Waiting for a frame") || pending.painted) {
      throw new Error("Explicitly recovered video exposed old pixels or enabled input before its new frame.");
    }
    await page.locator("#device-screen").focus();
    await page.keyboard.press("Enter");
    const beforeFrame = await (await page.request.get(evidenceUrl)).json();
    if (beforeFrame.calls.some((call) => call.path?.endsWith("/input/actions/key"))) {
      throw new Error("A key escaped before the explicitly recovered frame.");
    }
    if ((await page.request.post(`${evidenceUrl}/rotation-frame`)).status() !== 204) {
      throw new Error("The synthetic fresh frame could not be released.");
    }
    await page.waitForFunction(() => document.querySelector("#input-status")?.textContent === "Geometry-bound input ready");
  }

  const evidence = await (await page.request.get(evidenceUrl)).json();
  const posts = evidence.calls.filter((call) =>
    call.method === "POST" && call.path?.endsWith("/video/sessions")).length;
  const deletes = evidence.calls.filter((call) => call.method === "DELETE").length;
  const deviceInput = evidence.calls.filter((call) => call.path?.includes("/input/actions/")).length;
  const expectedSupersededRead = mode === "reselect" && evidence.errors.length === 1
    && evidence.errors[0].code === "context_read_superseded"
    && evidence.errors[0].status === 409;
  if (intercepted !== 1 || deviceInput !== 0 || (evidence.errors.length !== 0 && !expectedSupersededRead)
    || posts !== (["retry", "reselect"].includes(mode) ? 2 : 1)
    || deletes !== 1
    || selectionPosts !== (["reselect", "fenced-reselect"].includes(mode) ? 1 : 0)) {
    throw new Error("Recovery changed the original intent or did not retire the stale original resource.");
  }
  return { synthetic: true, mode, originalRotates: intercepted, posts, deletes, selectionPosts, deviceInput };
}
