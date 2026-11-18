async (page) => {
  const { url, evidenceUrl, mode } = await page.evaluate(() => window.ailohaBrowserTestOptions);
  if (!["uncertain", "unsettled"].includes(mode)) throw new Error("Unknown synthetic rotation rejection mode.");
  let intercepted = 0;
  if (mode === "uncertain") {
    await page.route("**/api/v1/devices/**/input/rotate", (route) => {
      intercepted += 1;
      return route.fulfill({
        status: 408,
        contentType: "application/json",
        body: JSON.stringify({ code: "request_timeout", message: "Synthetic submission outcome unknown." }),
      });
    });
  } else {
    await page.route("**/api/v1/devices/**/input/rotate", (route) => {
      intercepted += 1;
      return route.continue();
    });
    await page.route("**/api/v1/devices/**/display", (route) => {
      if (intercepted === 0) return route.continue();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          backend: "ailoha", surfaceId: "opaque/surface", geometryRevision: 14,
          coordinate: "window", orientation: "landscape", pointWidth: 48, pointHeight: 32,
        }),
      });
    });
  }
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#stream-mode")?.textContent === "ALHV H.264");
  await page.locator('[data-action="rotate"]').click();
  await page.waitForFunction((expected) => document.querySelector("#input-status")?.textContent === expected,
    mode === "uncertain" ? "Rotate failed" : "Rotated geometry unavailable");
  const oldPixelsVisible = await page.evaluate(() => {
    const canvas = document.querySelector("#device-screen");
    return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data
      .some((value, index) => index % 4 !== 3 && value > 0);
  });
  await page.locator("#device-screen").focus();
  await page.keyboard.press("Enter");
  const evidence = await (await page.request.get(evidenceUrl)).json();
  const posts = evidence.calls.filter((call) =>
    call.method === "POST" && call.path?.endsWith("/video/sessions")).length;
  const nativeRotations = evidence.calls.filter((call) =>
    call.method === "PATCH" && call.path?.endsWith("/presentation")).length;
  const inputs = evidence.calls.filter((call) => call.path?.includes("/input/actions/")).length;
  if (oldPixelsVisible || intercepted !== 1 || posts !== 1 || inputs !== 0 || evidence.errors.length !== 0
    || nativeRotations !== (mode === "uncertain" ? 0 : 1)) {
    throw new Error("An uncertain or unsettled rotation created a video, replayed input, or changed the original outcome.");
  }
  return { synthetic: true, mode, intercepted, nativeRotations, videoPosts: posts, inputs };
}
