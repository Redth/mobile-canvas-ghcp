async (page) => {
  const { url, evidenceUrl, fixtureRoot, secondRoot } = await page.evaluate(() => window.ailohaBrowserTestOptions);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const evidence = async () => {
    const value = await (await fetch(evidenceUrl, { signal: AbortSignal.timeout(5000) })).json();
    assert(value.synthetic === true && !value.error, "Only the original synthetic fixture host may be inspected.");
    return value;
  };
  const control = async (input) => {
    const response = await fetch(`${evidenceUrl}/control`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input), signal: AbortSignal.timeout(5000),
    });
    assert(response.status === 204, "The original synthetic root/mode control failed.");
  };
  const waitFor = async (condition) => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const value = await evidence();
      if (condition(value)) return value;
      await page.waitForTimeout(10);
    }
    throw new Error("The synthetic workspace renderer did not reach its expected captured state.");
  };
  const status = (value) => page.waitForFunction((expected) => {
    const message = document.querySelector(".workspace-inspection-status")?.textContent ?? "";
    return message.includes(expected);
  }, value);
  const posts = (value) => value.calls.filter((call) => call.method === "POST" && call.path?.endsWith("/video/sessions")).length;
  const deletes = (value) => value.calls.filter((call) => call.method === "DELETE").length;
  const inspect = async (expectedStatus) => {
    const generation = (await evidence()).workspace.generation;
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    if (expectedStatus) await page.waitForFunction(({ generation, expectedStatus }) => {
      const element = document.querySelector("#workspace-inspection");
      return Number(element.dataset.generation) > generation && element.dataset.status === expectedStatus;
    }, { generation, expectedStatus });
  };
  const guidance = async (applications) => {
    let steps = 0;
    let skills = 0;
    for (const application of applications) {
      const card = page.locator(".workspace-app-card").filter({
        has: page.locator(".workspace-evidence-fields dd").filter({ hasText: application.applicationId }),
      });
      const details = card.locator(".workspace-app-details");
      if (!await details.evaluate((element) => element.open)) await details.locator("summary").click();
      assert(await details.locator("button, a").count() === 0, "Scanner guidance became an installation command or action.");
      assert(await details.locator(".workspace-review-guidance").count() === (application.missingSteps.length ? 1 : 0),
        "Missing-step guidance was inferred or discarded for this role.");
      assert(await details.locator(".workspace-skill-guidance").count() === (application.recommendedSkillIds.length ? 1 : 0),
        "Scanner skill IDs were inferred or discarded.");
      for (const step of application.missingSteps) {
        const text = await details.locator(".workspace-review-guidance").textContent();
        assert(text.includes(step.code) && text.includes(step.description) && text.includes("Approval and workspace mutation required; no changes are applied"),
          "Scanner missing-step explanation or approval/mutation qualification is absent.");
        steps += 1;
      }
      for (const id of application.recommendedSkillIds) {
        const text = await details.locator(".workspace-skill-guidance").textContent();
        assert(text.includes(id) && text.includes("Informational IDs only; availability and installation are not verified"),
          "Scanner skill ID was omitted or represented as verified installation guidance.");
        skills += 1;
      }
    }
    return { steps, skills, readOnly: true };
  };
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on("pageerror", onError);
  try {
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector("#stream-mode")?.textContent === "ALHV H.264");
    await status("Supply workspaceRoot");
    assert((await page.locator("#workspace-inspection button").count()) === 1, "GitHub shared renderer invented a root picker or install action.");
    const initial = await evidence();
    assert(initial.inspectionCalls.length === 0, "Workspace inspection ran automatically or inferred an ambient root.");
    await control({ type: "root", root: "first" });
    await status("ready for a bounded static scan");
    assert(await page.locator(".workspace-inspection-root").textContent() === fixtureRoot, "The explicit root is not displayed.");
    const capturedContext = JSON.stringify((await evidence()).context);
    const deviceCalls = (await evidence()).calls.length;
    await inspect("complete");
    await status("Static scan complete");
    assert(await page.locator(".workspace-app-card").count() === 8, "The complete canonical app candidates were not rendered.");
    const copy = await page.locator("#workspace-inspection").textContent();
    for (const required of [
      "maui", "expo", "react-native", "PhoneApp", "DesktopApp", "SharedLibrary", "swiftpm",
      "Declared; installation not verified", "Observed syntax; execution not verified",
      "Observed guard syntax; release stripping not verified", "Not evaluated", "Application selection is not supported",
    ]) assert(copy.includes(required), `Missing conservative app evidence: ${required}`);
    const identities = await page.locator(".workspace-app-card").evaluateAll((cards) => cards.map((card) => card.dataset.applicationId));
    assert(new Set(identities).size === 8, "Distinct native targets were collapsed by package/bundle identity.");
    const expo = page.locator(".workspace-app-card").filter({ hasText: "expo/package.json" });
    await expo.locator("summary").click();
    assert((await expo.textContent()).includes("ExpoWrapper") && await expo.locator(".workspace-native-wrapper").count() === 2,
      "Owned Android/iOS wrapper identities were not available as local evidence.");
    for (const card of await page.locator(".workspace-app-card").all()) {
      if (!await card.locator("details").evaluate((details) => details.open)) await card.locator("summary").click();
    }
    const canonicalGuidance = await guidance((await evidence()).workspace.inspection.applications);
    assert(canonicalGuidance.steps === 2 && canonicalGuidance.skills === 6, "Canonical fixture guidance was not fully rendered.");
    assert((await evidence()).calls.length === deviceCalls, "Viewing app evidence invoked a target, agent or runtime action.");
    assert(JSON.stringify((await evidence()).context) === capturedContext, "Viewing app details changed the captured target-only context/revision.");

    await control({ type: "mode", mode: "incomplete" });
    await inspect("incomplete");
    await status("Incomplete scan");
    assert(await page.locator(".workspace-app-card").count() === 9, "Incomplete candidates were replaced with a success-shaped empty state.");
    await page.locator(".workspace-scan-details > summary").click();
    assert((await page.locator(".workspace-scan-details").textContent()).includes("malformed-json"), "Incomplete diagnostics were hidden or discarded.");
    const incompleteGuidance = await guidance((await evidence()).workspace.inspection.applications);
    assert(incompleteGuidance.steps === 2, "Incomplete scan lost its scanner-provided review explanations.");

    await control({ type: "mode", mode: "unknown-schema" });
    await inspect("error");
    await status("workspace_inspection_schema_unsupported");
    assert(await page.locator(".workspace-app-card").count() === 0, "Unknown schema retained misleading app cards.");
    await control({ type: "mode", mode: "empty" });
    await inspect("complete");
    await status("Static scan complete");
    assert((await page.locator("#workspace-inspection").textContent()).includes("No application candidates found"), "Complete empty scan is not explicit.");

    await control({ type: "mode", mode: "xss" });
    await inspect("complete");
    await status("Static scan complete");
    await guidance((await evidence()).workspace.inspection.applications);
    const safe = await page.locator("#workspace-inspection").evaluate((element) => ({
      containsText: element.textContent.includes('<img src=x onerror="window.workspaceXss=true">'),
      injectedElements: element.querySelectorAll("img, script, iframe").length,
      executed: window.workspaceXss === true,
      guidanceDescriptionText: element.querySelector(".workspace-review-guidance")?.textContent.includes('<img src=x onerror="window.workspaceXss=true">'),
      skillIdText: [...element.querySelectorAll(".workspace-skill-guidance")].some((guidance) => guidance.textContent.includes('skill-<img src=x onerror="window.workspaceXss=true">')),
    }));
    assert(safe.containsText && safe.guidanceDescriptionText && safe.skillIdText && safe.injectedElements === 0 && !safe.executed,
      "Application/file/diagnostic/guidance text was omitted or interpreted as HTML.");

    await control({ type: "mode", mode: "complete", delayMs: 1000 });
    const beforeRootChange = (await evidence()).inspectionCalls.length;
    await inspect();
    await waitFor((value) => value.inspectionCalls.length > beforeRootChange);
    await control({ type: "root", root: "second" });
    await status("ready for a bounded static scan");
    await page.waitForTimeout(1100);
    assert(await page.locator(".workspace-inspection-root").textContent() === secondRoot, "An old-root result retargeted the displayed explicit root.");
    assert(await page.locator(".workspace-app-card").count() === 0, "An old-root result painted app cards after retirement.");
    assert(JSON.stringify((await evidence()).context) === capturedContext, "Changing the workspace root changed device selection or its context revision.");
    await control({ type: "mode", mode: "complete" });
    await inspect("complete");
    await status("Static scan complete");
    assert((await evidence()).workspace.inspection.workspace.root === secondRoot, "New cards do not belong to the explicit new root.");

    await control({ type: "mode", mode: "complete", delayMs: 1000 });
    const beforeCancel = (await evidence()).inspectionCalls.length;
    await inspect();
    await waitFor((value) => value.inspectionCalls.length > beforeCancel);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await status("Inspection cancelled");
    await page.waitForTimeout(1100);
    assert(await page.locator(".workspace-app-card").count() === 0, "A cancelled result later adopted app evidence.");
    const beforeHide = await evidence();
    assert(posts(beforeHide) === 1 && deletes(beforeHide) === 0, "App details/root/cancellation restarted the ALHV video resource.");
    const beforeHiddenScan = beforeHide.inspectionCalls.length;
    await inspect();
    await waitFor((value) => value.inspectionCalls.length > beforeHiddenScan);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const hidden = await waitFor((value) => value.leases === 0 && value.videoResources === 0 && value.workspace.status === "suspended");
    assert(await page.locator("#workspace-inspection").isHidden(), "Hidden inspection is still presented as current evidence.");
    await page.waitForTimeout(1100);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor((value) => value.leases === 1 && value.videoResources === 1);
    await status("ready for a bounded static scan");
    const resumed = await evidence();
    assert(posts(resumed) === 2 && deletes(resumed) === 1, "Workspace hide/resume broke owned media cleanup.");
    assert(await page.locator(".workspace-app-card").count() === 0, "A hidden scan repainted stale app cards after resume.");
    assert(!resumed.calls.some((call) => call.path === "/api/v1/host/stop"), "Workspace cleanup stopped the shared host.");
    assert(errors.length === 0, `Full renderer errors: ${errors.join("; ")}`);
    await page.setViewportSize({ width: 1200, height: 800 });
    await control({ type: "mode", mode: "complete" });
    await inspect("complete");
    await status("Static scan complete");
    return {
      syntheticSdkHooks: true, canonicalFixtureOutput: true, fullSharedRenderer: true,
      candidateCount: 8, uniqueApplicationIds: identities.length, ownedWrappers: 2,
      explicitRootShown: true, rootChangeRetiredOldResult: true, cancellationRetiredOldResult: true,
      hideResumeRetiredOldResult: true, contextAndTargetUnchangedByCards: true,
      incompleteDiagnostics: true, unknownSchemaRejected: true, emptyScanExplicit: true, xssTextSafe: safe,
      canonicalGuidance, incompleteGuidance,
      initialVideoPosts: posts(initial), initialVideoDeletes: deletes(initial),
      beforeHideVideoPosts: posts(beforeHide), beforeHideVideoDeletes: deletes(beforeHide),
      afterResumeVideoPosts: posts(resumed), afterResumeVideoDeletes: deletes(resumed), errors,
    };
  } finally {
    page.off("pageerror", onError);
  }
}
