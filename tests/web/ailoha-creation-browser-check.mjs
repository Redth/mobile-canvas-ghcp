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
  await page.locator("#device-screen").click();
  const screen = await page.locator("#device-screen").boundingBox();
  verify(screen?.width > 0 && screen?.height > 0, "The painted device screen is not usable");
  await page.mouse.move(screen.x + screen.width / 4, screen.y + screen.height / 2);
  await page.mouse.down();
  await page.mouse.move(screen.x + 3 * screen.width / 4, screen.y + screen.height / 2, { steps: 5 });
  await page.mouse.up();
  value = await waitFor((value) => value.calls.filter((call) => call.path?.includes("/input/actions/")).length === 2);
  const inputCalls = value.calls.filter((call) => call.path?.includes("/input/actions/"));
  const tap = JSON.parse(inputCalls.find((call) => call.path.endsWith("/tap")).body);
  const gesture = JSON.parse(inputCalls.find((call) => call.path.endsWith("/gesture")).body);
  verify(tap.x === 24 && tap.y === 16 && tap.geometryRevision === 14,
    "The renderer scaled logical tap coordinates using encoded pixels");
  verify(gesture.geometryRevision === 14 && gesture.actions[0].x === 12 && gesture.actions.at(-1).x === 36
    && gesture.actions.every((action) => action.y === undefined || action.y === 16),
  "The renderer lost captured logical swipe geometry");
  const combined = options.combined === true;
  const workspace = page.locator("#workspace-inspection");
  const semantic = page.locator("#semantic-inspection");
  let combinedEvidence = null;
  async function workspaceControl(input) {
    await control("workspace-control", input);
    if (input.root && options.host === "vscode") {
      await workspace.getByRole("button", { name: "Choose workspace", exact: true }).click();
    }
  }
  async function inspectWorkspace(status = "complete") {
    const generation = (await evidence()).workspace.generation;
    await workspace.getByRole("button", { name: "Inspect", exact: true }).click();
    await page.waitForFunction(({ generation, status }) => {
      const element = document.querySelector("#workspace-inspection");
      return Number(element.dataset.generation) > generation && element.dataset.status === status;
    }, { generation, status });
  }
  async function semanticChoice(lens, operation, text) {
    const lensControl = semantic.getByLabel("Inspection lens");
    if (await lensControl.inputValue() !== lens) await lensControl.selectOption(lens);
    const operationControl = semantic.getByLabel("Inspection operation");
    if (await operationControl.inputValue() !== operation) await operationControl.selectOption(operation);
    await page.waitForFunction(() => document.querySelector("#semantic-inspection .semantic-inspection-actions button")?.disabled === false);
    if (text !== undefined) await semantic.getByLabel("Text", { exact: true }).fill(text);
  }
  async function semanticRead(lens, operation, text) {
    await semanticChoice(lens, operation, text);
    await semantic.getByRole("button", { name: "Inspect", exact: true }).click();
    const observed = await waitFor((value) => value.semantic.status === "complete"
      && value.semantic.lens === lens && value.semantic.operation === operation);
    await page.waitForFunction(() => document.querySelector("#semantic-inspection .semantic-inspection-output")?.textContent.length > 0);
    verify(observed.semantic.result.route.owner === (lens === "app" ? "agent" : "target-host"),
      "Canonical inspection fell back to the wrong owner");
    return observed.semantic;
  }
  async function pendingSemantic() {
    const calls = (await evidence()).semanticCalls.length;
    await semanticChoice("system", "query", "wait");
    await semantic.getByRole("button", { name: "Inspect", exact: true }).click();
    await waitFor((value) => value.semanticCalls.length > calls && value.semantic.status === "reading");
  }
  if (combined) {
    const initial = await evidence();
    verify(initial.workspaceCalls.length === 0 && initial.semanticCalls.length === 0,
      "The combined renderer scanned or invoked a semantic tool automatically");
    const beforeContext = JSON.stringify(initial.context);
    const beforeDeviceCalls = initial.calls.length;
    await workspaceControl({ root: "first", mode: "complete" });
    await inspectWorkspace();
    verify(await workspace.locator(".workspace-app-card").count() === 8, "The canonical workspace cards are incomplete");
    for (const card of await workspace.locator(".workspace-app-card").all()) {
      await card.locator("summary").click();
      verify(await card.locator(".workspace-app-details button, .workspace-app-details a").count() === 0,
        "Workspace evidence became an installation or agent-binding action");
    }
    const fields = await workspace.textContent();
    verify(fields.includes("Declared; installation not verified") && fields.includes("Application selection is not supported"),
      "The workspace evidence lost its conservative qualifiers");
    verify((await evidence()).calls.length === beforeDeviceCalls
      && JSON.stringify((await evidence()).context) === beforeContext,
    "Inspecting or expanding workspace cards changed target/native context or device controls");
    await workspaceControl({ mode: "incomplete" });
    await inspectWorkspace("incomplete");
    verify(await workspace.locator(".workspace-app-card").count() === 9, "An incomplete scan became empty success");
    await workspaceControl({ mode: "complete" });
    await inspectWorkspace();

    const systemTree = await semanticRead("system", "tree");
    verify(systemTree.result.route.targetId === "opaque/target" && systemTree.result.route.executionContext.revision === initial.context[0].revision,
      "System inspection lost the captured target/context identity");
    await semanticRead("system", "query", "OK");
    const safe = await semantic.locator(".semantic-inspection-output").evaluate((element) => ({
      literal: element.textContent.includes("<script>alert(1)</script>"),
      executableNodes: element.querySelectorAll("script, iframe").length,
    }));
    verify(safe.literal && safe.executableNodes === 0, "Canonical element text was interpreted as executable HTML");
    await semanticChoice("app", "tree");
    verify((await semantic.locator(".semantic-inspection-status").textContent()).includes("no explicitly selected verified native instance"),
      "App inspection inferred a native instance from workspace evidence");
    const beforeNative = (await evidence()).semanticCalls.length;
    await control("instance-control", { nativeInstance: true });
    await api("/api/v1/semantic/inspection");
    await page.waitForFunction(() => !document.querySelector(".semantic-inspection-status")?.textContent.includes("App unavailable"));
    const nativeContext = JSON.stringify((await evidence()).context);
    const appTree = await semanticRead("app", "tree");
    await semanticRead("app", "query", "OK");
    const appStatus = await semanticRead("app", "status");
    verify(appTree.result.route.runtimeInstanceId === "owned-runtime" && appStatus.result.status.running === true
      && appStatus.result.route.executionContext.observed.runtimeInstanceEvidence === "verified-native-instance",
    "Explicit synthetic native-instance provenance was lost");
    verify(JSON.stringify((await evidence()).context) === nativeContext,
      "Read-only App tools wrote a binding or context revision");
    verify((await evidence()).semanticCalls.length === beforeNative + 3, "App reads replayed or added unrequested tools");
    verify(videoPosts(await evidence()) === 1, "Workspace/semantic inspection recreated the live resource");
    combinedEvidence = { cards: 8, incompleteCards: 9, safe, systemOwner: "target-host", appOwner: "agent",
      explicitNativeInstanceOnly: true, readonlyContext: true };
    await pendingSemantic();
  }
  const catalog = await api("/api/v1/catalog");
  verify(catalog.creationSupport.supported === true, "Installed catalog mapping did not advertise wired creation");
  const createdEvidence = [];
  async function fillCreate(platform, name) {
    await page.locator("#create-button").click();
    await page.locator("#create-dialog").waitFor({ state: "visible" });
    if (platform === "android") await page.locator('#create-platform [role="radio"][aria-label="Android Emulators"]').click();
    else {
      const ios = page.locator('#create-platform [role="radio"][aria-label="iOS Simulators"]');
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
    const beforeState = await evidence();
    const before = createPosts(beforeState).length;
    const beforeVideos = videoPosts(beforeState);
    await page.locator("#create-submit").click();
    await page.locator("#create-dialog").waitFor({ state: "hidden" });
    await page.waitForFunction((name) => document.querySelector("#selector-name")?.textContent === name, name);
    const selected = await api("/api/v1/selection");
    value = await waitFor((value) => videoPosts(value) >= beforeVideos + 1 && value.videoResources === 1 && value.errors.length === 0);
    await page.waitForTimeout(500);
    value = await evidence();
    verify(videoPosts(value) === beforeVideos + 1, "The creation result and its selection echo recreated the same owned video session");
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
    if (combined) {
      verify((await evidence()).semantic.result === null && await semantic.locator(".semantic-element").count() === 0,
        "Creation left old target semantic results on the new device");
      verify(await workspace.locator(".workspace-app-card").count() === 0,
        "Creation preserved workspace evidence retired by the captured selection intent");
    }
  }
  if (combined) {
    const currentTree = await semanticRead("system", "tree");
    verify(currentTree.result.route.targetId === createdEvidence.at(-1).id,
      "The new target did not own the next canonical System read");
    await workspaceControl({ mode: "complete" });
    await inspectWorkspace();
    const rootCalls = (await evidence()).workspaceCalls.length;
    await workspaceControl({ mode: "complete", delayMs: 1000 });
    await workspace.getByRole("button", { name: "Inspect", exact: true }).click();
    await waitFor((value) => value.workspaceCalls.length > rootCalls);
    await workspaceControl({ root: "second", mode: "complete" });
    await page.waitForTimeout(1100);
    verify((await evidence()).workspace.root === options.secondRoot
      && await workspace.locator(".workspace-app-card").count() === 0, "A retired old-root result painted current cards");
    await inspectWorkspace();
  }
  await control("creation-hold");
  await fillCreate("ios", "Owned late result");
  await page.locator("#create-submit").click();
  await waitFor((value) => createPosts(value).length === 3);
  await page.locator("#create-cancel").click();
  await page.locator("#device-selector").click();
  await page.getByRole("option", { name: /Synthetic device/ }).click();
  await page.waitForFunction(() => document.querySelector("#selector-name")?.textContent === "Synthetic device");
  await control("creation-release");
  await page.waitForFunction(() => document.querySelector("#toast")?.textContent.includes("current selection unchanged"));
  verify((await api("/api/v1/selection")).device.id === "opaque/target", "A late creation result overwrote the user's new selection");
  value = await evidence();
  verify(createPosts(value).length === 3 && !value.calls.some((call) => call.method === "POST" && /\/actions\/start$/.test(call.path ?? "")),
    "Creation recovery replayed create or issued a separate boot");
  if (combined) {
    await workspaceControl({ mode: "complete", delayMs: 1000 });
    const beforeScan = (await evidence()).workspaceCalls.length;
    await workspace.getByRole("button", { name: "Inspect", exact: true }).click();
    await waitFor((value) => value.workspaceCalls.length > beforeScan);
    await pendingSemantic();
  }
  if (options.host === "vscode") await control("visibility", { visible: false });
  else await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor((value) => value.leases === 0 && value.videoResources === 0);
  value = await evidence();
  if (combined) {
    verify(value.workspace.status === "suspended" && value.semantic.status === "suspended"
      && value.workspace.inspection === null && value.semantic.result === null,
    "Hiding the combined view retained pending workspace/semantic evidence");
    verify(await workspace.isHidden() && await semantic.isHidden(), "Hidden evidence is still presented");
    verify(value.semanticCalls.every((call) => ["app_tree", "app_query", "app_status"].includes(call.name)),
      "The readonly semantic workflow invoked mutation tools");
    combinedEvidence.workspacePickerUsed = options.host !== "vscode" || value.workspacePicks >= 2;
    verify(combinedEvidence.workspacePickerUsed, "VS Code did not use its compiled explicit-folder picker adapter");
    combinedEvidence.pendingReadsRetired = true;
    combinedEvidence.semanticCalls = value.semanticCalls.length;
  }
  verify(value.errors.length === 0 && !value.calls.some((call) => call.path === "/api/v1/host/stop"),
    "The owned renderer leaked resources or stopped a shared host");
  return {
    host: options.host, synthetic: true, realWebCodecs: painted, initialResizeVideoPosts: 1,
    createPosts: createPosts(value).length, separateBootPosts: 0, createdEvidence,
    tap, gesture,
    combinedEvidence,
    staleSelectionPreserved: true, leasesAfterHide: value.leases, videosAfterHide: value.videoResources, errors: value.errors,
  };
}
