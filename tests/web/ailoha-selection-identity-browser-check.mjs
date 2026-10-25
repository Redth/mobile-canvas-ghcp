async (page) => {
  const { url, evidenceUrl, mode } = await page.evaluate(() => window.ailohaBrowserTestOptions);
  if (!["same-id", "changed-host"].includes(mode)) throw new Error("Unknown selection identity case.");
  let selectionPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/selection") {
      selectionPosts++;
    }
  });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#stream-mode")?.textContent === "ALHV H.264"
    && document.querySelector("#geometry")?.value.includes("revision 14"));
  if (mode === "changed-host") {
    await page.route("**/api/v1/catalog", async (route) => {
      const response = await route.fetch();
      const catalog = await response.json();
      for (const device of catalog.devices) if (device.id === "opaque/target") device.targetHostId = "different-host";
      await route.fulfill({ response, json: catalog });
    });
    await page.locator("#refresh-button").click();
    await page.waitForFunction(() => document.querySelector("#toast")?.textContent
      ?.includes("changed Ailoha selection is not bound"));
  } else {
    await page.locator("#device-selector").click();
    await page.locator(".device-card").first().click();
    await page.waitForFunction(() => document.querySelector("#input-status")?.textContent
      ?.includes("Waiting for a frame"));
  }
  const deadline = Date.now() + 5000;
  let evidence;
  do {
    evidence = await (await page.request.get(evidenceUrl)).json();
    if (evidence.calls.filter((call) => call.method === "DELETE").length === 1
      && (mode === "changed-host" || evidence.calls.filter((call) =>
        call.method === "POST" && call.path?.endsWith("/video/sessions")).length === 2)) break;
    await page.waitForTimeout(20);
  } while (Date.now() < deadline);
  const beforeFrame = await page.evaluate(() => {
    const canvas = document.querySelector("#device-screen");
    return {
      painted: canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data
        .some((value, index) => index % 4 !== 3 && value > 0),
      input: document.querySelector("#input-status")?.textContent,
    };
  });
  await page.locator("#device-screen").focus();
  await page.keyboard.press("Enter");
  const calls = (await (await page.request.get(evidenceUrl)).json()).calls;
  const posts = calls.filter((call) => call.method === "POST" && call.path?.endsWith("/video/sessions")).length;
  const deletes = calls.filter((call) => call.method === "DELETE").length;
  if (beforeFrame.painted || beforeFrame.input === "Geometry-bound input ready"
    || posts !== (mode === "same-id" ? 2 : 1) || deletes !== 1
    || selectionPosts !== (mode === "same-id" ? 1 : 0)
    || calls.some((call) => call.path?.endsWith("/input/actions/key"))) {
    throw new Error("Same-ID selection retained stale pixels/input or adopted a changed canonical host.");
  }
  if (mode === "same-id") {
    if ((await page.request.post(`${evidenceUrl}/rotation-frame`)).status() !== 204) {
      throw new Error("The explicit same-ID session did not hold a fresh frame.");
    }
    await page.waitForFunction(() => document.querySelector("#input-status")?.textContent
      === "Geometry-bound input ready");
    const painted = await page.evaluate(() => {
      const canvas = document.querySelector("#device-screen");
      return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data
        .some((value, index) => index % 4 !== 3 && value > 0);
    });
    if (!painted) throw new Error("Explicit same-ID recovery did not paint the new owned frame.");
  }
  return { synthetic: true, mode, posts, deletes, selectionPosts, stalePainted: beforeFrame.painted };
}
