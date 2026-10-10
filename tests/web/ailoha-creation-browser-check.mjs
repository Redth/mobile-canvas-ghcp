async (page) => {
  const options = await page.evaluate(() => window.ailohaBrowserTestOptions);
  const verify = (condition, message) => { if (!condition) throw new Error(message); };
  const evidence = async () => {
    const response = await fetch(options.evidenceUrl, { signal: AbortSignal.timeout(5000) });
    const value = await response.json();
    verify(value.synthetic === true && value.host === options.host, "Only the explicitly owned synthetic host may be controlled");
    return value;
  };
  const control = async (path, body) => {
    await evidence();
    const response = await fetch(`${options.controlOrigin}/test/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    verify(response.ok, `Owned fixture control failed: ${path}`);
  };
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const value = await evidence();
      if (predicate(value)) return value;
      await page.waitForTimeout(20);
    }
    throw new Error("The real renderer did not reach its expected owned creation state");
  };
  const api = async (path) => page.evaluate(async (path) => {
    const response = window.mobileCanvasTransport
      ? await window.mobileCanvasTransport.api(path) : await fetch(path, { credentials: "include" });
    if (!response.ok) throw new Error(`Owned renderer API failed: ${response.status}`);
    return response.json();
  }, path);
  const videoPosts = (value) => value.calls.filter((call) => call.method === "POST" && call.path?.endsWith("/video/sessions")).length;
  const createPosts = (value) => value.calls.filter((call) => call.method === "POST" && call.path === "/api/v1/targets");
  await evidence();
  await page.goto(options.url);
  await page.waitForFunction(() => document.querySelector("#stream-mode")?.textContent === "ALHV H.264");
  await page.waitForFunction(() => document.querySelector("#create-button")?.disabled === false);
  for (const width of [1200, 700, 1000, 900]) {
    await page.setViewportSize({ width, height: 700 });
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(500);
  let value = await evidence();
  verify(videoPosts(value) === 1 && value.videoResources === 1 && value.errors.length === 0,
    "Create-capable inventory caused a video recreation during resize/idle");
  const painted = await page.evaluate(() => {
    const canvas = document.querySelector("#device-screen");
    return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data
      .some((value, index) => index % 4 !== 3 && value > 0);
  });
  verify(painted, "The complete shared renderer did not decode and paint actual WebCodecs frames");
  const catalog = await api("/api/v1/catalog");
  verify(catalog.creationSupport.supported === true, "Installed catalog mapping did not advertise wired creation");
  const createdEvidence = [];
  async function fillCreate(platform, name) {
    await page.locator("#create-button").click();
    await page.locator("#create-dialog").waitFor({ state: "visible" });
    if (platform === "android") await page.locator('#create-platform [role="radio"][aria-label="Android"]').click();
    else {
      const ios = page.locator('#create-platform [role="radio"][aria-label="iOS"]');
      if (await ios.count()) await ios.click();
    }
    const runtime = catalog.runtimes.find((entry) => entry.platform === platform
      && entry.isCreatable && entry.catalogSelection.runtimeId === "shared/runtime:%2F opaque");
    const type = catalog.deviceTypes.find((entry) => entry.platform === platform && entry.isCreatable
      && entry.catalogSelection.providerId === runtime.catalogSelection.providerId
      && entry.targetTypeId === "shared/type:%2F opaque");
    verify(runtime && type, "No exact supported synthetic catalog pair");
    await page.locator("#create-name").fill(name);
    await page.locator("#create-runtime").selectOption(runtime.id);
    const typeValues = await page.locator("#create-device-type option").evaluateAll((entries) => entries.map((entry) => entry.value));
    verify(typeValues.length === 1 && typeValues[0] === type.id, "The UI offered an unsupported cross-provider/runtime device type");
    await page.locator("#create-device-type").selectOption(type.id);
    verify(await page.locator("#create-submit").isEnabled(), "A wired compatible choice left creation disabled");
    return { runtime, type };
  }
  for (const platform of ["ios", "android"]) {
    const name = `Owned browser ${platform}`;
    const pair = await fillCreate(platform, name);
    const before = createPosts(await evidence()).length;
    await page.locator("#create-submit").click();
    await page.locator("#create-dialog").waitFor({ state: "hidden" });
    await page.waitForFunction((name) => document.querySelector("#device-name")?.textContent === name, name);
    const selected = await api("/api/v1/selection");
    value = await waitFor((value) => value.videoResources === 1 && value.errors.length === 0);
    const requests = createPosts(value);
    verify(requests.length === before + 1, "One create submission emitted more than one create POST");
    const input = JSON.parse(requests.at(-1).body);
    verify(input.providerId === pair.runtime.catalogSelection.providerId
      && input.runtimeId === pair.runtime.catalogSelection.runtimeId && input.targetTypeId === pair.type.targetTypeId
      && input.start === true && Object.keys(input).length === 5, "Creation did not use the exact canonical create+boot request shape");
    verify(selected.device.name === name && selected.device.platform === platform && selected.device.state === "booted"
      && selected.device.nativeId !== selected.device.id, "Creation did not select its authoritative native deployment record");
    if (platform === "ios") verify(selected.device.udid === selected.device.nativeId, "iOS UDID was replaced with an opaque target ID");
    else verify(selected.device.serial?.startsWith("emulator-"), "Android serial was lost");
    createdEvidence.push({ platform, input, id: selected.device.id, nativeId: selected.device.nativeId });
  }
  await control("creation-hold");
  await fillCreate("ios", "Owned late result");
  await page.locator("#create-submit").click();
  await waitFor((value) => createPosts(value).length === 3);
  await page.locator("#create-cancel").click();
  await page.getByRole("button", { name: /Synthetic device/ }).click();
  await page.waitForFunction(() => document.querySelector("#device-name")?.textContent === "Synthetic device");
  await control("creation-release");
  await page.waitForFunction(() => document.querySelector("#toast")?.textContent.includes("current selection unchanged"));
  verify((await api("/api/v1/selection")).device.id === "opaque/target", "A late creation result overwrote the user's new selection");
  value = await evidence();
  verify(createPosts(value).length === 3 && !value.calls.some((call) => call.method === "POST" && /\/actions\/start$/.test(call.path ?? "")),
    "Creation recovery replayed create or issued a separate boot");
  if (options.host === "vscode") await control("visibility", { visible: false });
  else await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor((value) => value.leases === 0 && value.videoResources === 0);
  value = await evidence();
  verify(value.errors.length === 0 && !value.calls.some((call) => call.path === "/api/v1/host/stop"),
    "The owned renderer leaked resources or stopped a shared host");
  return {
    host: options.host, synthetic: true, realWebCodecs: painted, initialResizeVideoPosts: 1,
    createPosts: createPosts(value).length, separateBootPosts: 0, createdEvidence,
    staleSelectionPreserved: true, leasesAfterHide: value.leases, videosAfterHide: value.videoResources, errors: value.errors,
  };
}
