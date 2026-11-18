async (page) => {
  const { url, evidenceUrl } = await page.evaluate(() => window.ailohaBrowserTestOptions);
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#stream-mode")?.textContent === "ALHV H.264"
    && document.querySelector("#geometry")?.value.includes("revision 14"));
  let oldFrameStatus;
  await page.route("**/api/v1/devices/**/input/rotate", async (route) => {
    oldFrameStatus = (await page.request.post(`${evidenceUrl}/old-frame`)).status();
    await page.waitForTimeout(200);
    await route.continue();
  });
  await page.locator('[data-action="rotate"]').click();
  await page.waitForFunction(() => document.querySelector("#geometry")?.value.includes("revision 15"));
  const deadline = Date.now() + 5000;
  let evidence;
  let lifecycle;
  do {
    evidence = await (await page.request.get(evidenceUrl)).json();
    lifecycle = evidence.calls.filter((call) =>
      (call.method === "POST" && call.path?.endsWith("/video/sessions"))
      || (call.method === "DELETE" && call.path?.includes("/video/sessions/")));
    if (lifecycle.length >= 3) break;
    await page.waitForTimeout(20);
  } while (Date.now() < deadline);
  const before = await page.evaluate(() => {
    const canvas = document.querySelector("#device-screen");
    return {
      input: document.querySelector("#input-status")?.textContent,
      painted: canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data
        .some((value, index) => index % 4 !== 3 && value > 0),
      toast: document.querySelector("#toast")?.textContent,
    };
  });
  if (oldFrameStatus !== 409 || !before.input?.includes("Waiting for a frame") || before.painted
    || before.toast?.includes("Video presentation must synchronously confirm consumption.")
    || lifecycle.length !== 3 || lifecycle[0].method !== "POST"
    || lifecycle[1].method !== "DELETE" || lifecycle[2].method !== "POST"
    || lifecycle[1].path !== `${lifecycle[0].path}/${lifecycle[1].path.split("/").at(-1)}`) {
    throw new Error(`Old stream remained decodable during rotation or replacement lifecycle failed: ${JSON.stringify({
      oldFrameStatus, before, lifecycle: lifecycle.map(({ method }) => method),
    })}`);
  }
  if ((await page.request.post(`${evidenceUrl}/rotation-frame`)).status() !== 204) {
    throw new Error("The owned replacement frame was not released.");
  }
  await page.waitForFunction(() => document.querySelector("#input-status")?.textContent
    === "Geometry-bound input ready" && document.querySelector("#device-screen")?.width === 64
    && document.querySelector("#device-screen")?.height === 96);
  const after = await page.evaluate(() => {
    const canvas = document.querySelector("#device-screen");
    return {
      painted: canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data
        .some((value, index) => index % 4 !== 3 && value > 0),
      toast: document.querySelector("#toast")?.textContent,
    };
  });
  if (!after.painted || after.toast?.includes("Video presentation must synchronously confirm consumption.")) {
    throw new Error("Fresh owned frame did not paint cleanly after continuous-old-frame rotation.");
  }
  return { synthetic: true, oldFrameStatus, videoLifecycle: lifecycle.map(({ method }) => method),
    before, after };
}
