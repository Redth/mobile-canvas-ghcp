async (page) => {
  const { url, evidenceUrl } = await page.evaluate(() => window.ailohaBrowserTestOptions);
  let continueRotate;
  let rotateCaptured;
  const rotateReady = new Promise((resolve) => { rotateCaptured = resolve; });
  let rejectSelection;
  let selectionCaptured;
  const selectionReady = new Promise((resolve) => { selectionCaptured = resolve; });
  let selectionReads = 0;
  await page.route("**/api/v1/devices/**/input/rotate", async (route) => {
    const accepted = await route.fetch();
    if (accepted.status() !== 200) throw new Error("Synthetic original rotation was not accepted.");
    await new Promise((resolve) => {
      continueRotate = resolve;
      rotateCaptured();
    });
    await route.fulfill({ response: accepted });
  });
  await page.route("**/api/v1/selection", async (route) => {
    if (route.request().method() !== "GET" || !continueRotate) return route.continue();
    selectionReads++;
    if (selectionReads !== 1) return route.continue();
    await new Promise((resolve) => {
      rejectSelection = async () => {
        await route.fulfill({
          status: 409, contentType: "application/json",
          body: JSON.stringify({
            code: "context_owner_changed",
            message: "Original private owner incarnation changed after the fresh frame.",
          }),
        });
        resolve();
      };
      selectionCaptured();
    });
  });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#stream-mode")?.textContent === "ALHV H.264"
    && document.querySelector("#geometry")?.value.includes("revision 14"));
  await page.locator('[data-action="rotate"]').click();
  await Promise.race([rotateReady, page.waitForTimeout(5000).then(() => { throw new Error("Rotation was not captured."); })]);
  await page.locator("#refresh-button").click();
  await Promise.race([selectionReady, page.waitForTimeout(5000).then(() => {
    throw new Error("Same-ID refresh did not read original canonical selection.");
  })]);
  continueRotate();
  await page.waitForFunction(() => document.querySelector("#geometry")?.value.includes("revision 15")
    && document.querySelector("#input-status")?.textContent?.includes("Waiting for a frame"));
  const deadline = Date.now() + 5000;
  let beforePaint;
  do {
    beforePaint = await (await page.request.get(evidenceUrl)).json();
    if (beforePaint.calls.filter((call) =>
      call.method === "POST" && call.path?.endsWith("/video/sessions")).length === 2) break;
    await page.waitForTimeout(20);
  } while (Date.now() < deadline);
  if ((await page.request.post(`${evidenceUrl}/rotation-frame`)).status() !== 204) {
    throw new Error("The held replacement frame could not be released.");
  }
  await page.waitForFunction(() => document.querySelector("#input-status")?.textContent
    === "Geometry-bound input ready" && document.querySelector("#device-screen")?.width === 64
    && document.querySelector("#device-screen")?.height === 96);
  await rejectSelection();
  await page.waitForFunction(() => document.querySelector("#input-status")?.textContent !== "Geometry-bound input ready");
  const deadlineCleanup = Date.now() + 5000;
  let afterFence;
  do {
    afterFence = await (await page.request.get(evidenceUrl)).json();
    if (afterFence.videoResources === 0) break;
    await page.waitForTimeout(20);
  } while (Date.now() < deadlineCleanup);
  const view = await page.evaluate(() => {
    const canvas = document.querySelector("#device-screen");
    return {
      input: document.querySelector("#input-status")?.textContent,
      painted: canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data
        .some((value, index) => index % 4 !== 3 && value > 0),
    };
  });
  await page.locator("#device-screen").focus();
  await page.keyboard.press("Enter");
  const calls = (await (await page.request.get(evidenceUrl)).json()).calls;
  const posts = calls.filter((call) => call.method === "POST" && call.path?.endsWith("/video/sessions"));
  const deletes = calls.filter((call) => call.method === "DELETE");
  if (selectionReads < 1 || view.painted || view.input === "Geometry-bound input ready"
    || posts.length !== 2 || deletes.length !== 2 || afterFence.videoResources !== 0
    || deletes[0].path === deletes[1].path
    || calls.filter((call) => call.method === "PATCH" && call.path?.endsWith("/presentation")).length !== 1
    || calls.some((call) => call.path?.includes("/input/actions/"))) {
    throw new Error("Late owner fence retained a fresh-but-stale view or replayed the original operation.");
  }
  return { synthetic: true, originalRotations: 1, selectionReads, videoPosts: posts.length,
    ownedDeletes: deletes.length, remainingVideos: afterFence.videoResources, stalePainted: view.painted };
}
