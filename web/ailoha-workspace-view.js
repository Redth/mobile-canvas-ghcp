const VIEW_SCHEMA = "mobile-canvas.workspace-view/v1";
const STATUSES = ["not-selected", "ready", "scanning", "complete", "incomplete", "error", "cancelled", "suspended"];

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function detailList(entries) {
  const list = node("dl", "workspace-evidence-fields");
  for (const [label, value] of entries) list.append(node("dt", "", label), node("dd", "", value));
  return list;
}

function source(path, location) {
  return `${path}${location?.line != null ? `:${location.line}` : ""}${location?.field ? ` (${location.field})` : ""}`;
}

function targetDetails(target) {
  return detailList([
    ["Native target", target.targetId],
    ["Name", target.name ?? "Not resolved"],
    ["Product type", target.productType ?? "Unknown"],
    ["Bundle ID", target.bundleId ?? "Unknown; no safe common literal"],
  ]);
}

function observation(value, kind) {
  if (value === "unknown") return "Unknown";
  if (value === "not-observed") return "Not observed in inspected files";
  return kind === "dependency" ? "Declared; installation not verified"
    : kind === "startup" ? "Observed syntax; execution not verified"
      : "Observed guard syntax; release stripping not verified";
}

function applicationCard(application) {
  const card = node("article", "workspace-app-card");
  card.dataset.applicationId = application.applicationId;
  card.append(node("h3", "", application.nativeTarget?.name ?? application.primaryManifest));
  card.append(node("p", "workspace-app-meta", [
    application.framework, application.variant, application.role,
    application.targetPlatforms.length ? application.targetPlatforms.join(", ") : "Platforms unknown",
  ].filter(Boolean).join(" / ")));
  const instrumentation = application.instrumentation;
  card.append(detailList([
    ["Dependency", observation(instrumentation.dependency.state, "dependency")],
    ["Startup", observation(instrumentation.startup.state, "startup")],
    ["Debug guard", observation(instrumentation.debugGuard.state, "debug")],
    ["Live connection", "Not evaluated"],
  ]));
  const details = node("details", "workspace-app-details");
  details.append(node("summary", "", "Project details"));
  details.append(detailList([
    ["Application ID", application.applicationId],
    ["Relative root", application.relativeRoot],
    ["Manifest", application.primaryManifest],
    ["Agent package", instrumentation.dependency.packageId],
    ["Correlation", "Not evaluated; no device/application association"],
    ["Live capabilities", "Not checked"],
  ]));
  if (application.nativeTarget) details.append(targetDetails(application.nativeTarget));
  for (const wrapper of application.nativeWrappers) {
    const wrapperSection = node("section", "workspace-native-wrapper");
    wrapperSection.append(node("h4", "", "Owned native wrapper"));
    wrapperSection.append(detailList([
      ["Manifest", wrapper.primaryManifest],
      ["Relative root", wrapper.relativeRoot],
      ["Application ID", wrapper.applicationId ?? "Not emitted by this schema snapshot"],
    ]));
    if (wrapper.nativeTarget) wrapperSection.append(targetDetails(wrapper.nativeTarget));
    details.append(wrapperSection);
  }
  const evidence = node("ul", "workspace-evidence-list");
  for (const declaration of instrumentation.dependency.declarations) {
    const entry = node("li");
    entry.append(node("code", "", source(declaration.path, declaration.location)));
    entry.append(node("span", "", `${declaration.versionExpression ?? "Version unknown"}${declaration.conditional ? "; conditional applicability" : ""}`));
    evidence.append(entry);
  }
  for (const item of application.evidence) {
    const entry = node("li");
    entry.append(node("strong", "", item.kind), node("code", "", source(item.path, item.location)), node("span", "", item.observation));
    evidence.append(entry);
  }
  details.append(evidence);
  for (const profile of application.launchProfiles) {
    details.append(node("p", "", `Launch profile: ${profile.name} (${source(profile.source, profile.location)}). Not evaluated; workspace trust required.`));
  }
  if (application.missingSteps.length) {
    const guidance = node("section", "workspace-review-guidance");
    guidance.append(node("h4", "", "Setup review suggestions"));
    guidance.append(node("p", "workspace-inspection-note", "Scanner-provided suggestions. Approval and workspace mutation required; no changes are applied."));
    const steps = node("ul", "workspace-evidence-list");
    for (const step of application.missingSteps) {
      const entry = node("li");
      entry.append(node("strong", "", step.code), node("span", "", step.description));
      steps.append(entry);
    }
    guidance.append(steps);
    details.append(guidance);
  }
  if (application.recommendedSkillIds.length) {
    const guidance = node("section", "workspace-skill-guidance");
    guidance.append(node("h4", "", "Review skill IDs"));
    guidance.append(node("p", "workspace-inspection-note", "Informational IDs only; availability and installation are not verified."));
    const skills = node("ul", "workspace-evidence-list");
    for (const id of application.recommendedSkillIds) {
      const entry = node("li");
      entry.append(node("code", "", id));
      skills.append(entry);
    }
    guidance.append(skills);
    details.append(guidance);
  }
  card.append(details);
  return card;
}

function scanDetails(inspection) {
  const details = node("details", "workspace-scan-details");
  details.append(node("summary", "", "Coverage, scan limits and diagnostics"));
  const scan = inspection.scan;
  details.append(detailList([
    ["Candidate files", `${scan.candidateFilesRead} read / ${scan.candidateFilesConsidered} considered`],
    ["Bytes read", scan.bytesRead],
    ["Entries visited", scan.enumerationEntriesVisited],
    ["Skipped entries", scan.skippedEntries],
    ...Object.entries(scan.limits),
  ]));
  for (const coverage of inspection.coverage) {
    details.append(node("p", "", `${coverage.framework}: ${coverage.level}. ${coverage.observation}`));
  }
  for (const diagnostic of inspection.diagnostics) {
    const entry = node("p", "workspace-scan-diagnostic");
    entry.append(node("strong", "", `${diagnostic.severity}: ${diagnostic.code}`));
    entry.append(node("code", "", source(diagnostic.path, diagnostic.location)));
    entry.append(node("span", "", diagnostic.message));
    details.append(entry);
  }
  for (const skipped of scan.skipped) details.append(node("p", "", `${skipped.path}: ${skipped.reason}`));
  return details;
}

function validateSnapshot(value) {
  if (!value || value.schema !== VIEW_SCHEMA || !Number.isSafeInteger(value.generation) || value.generation < 0
    || typeof value.scope?.sessionId !== "string" || typeof value.scope.viewId !== "string"
    || (value.root !== null && typeof value.root !== "string") || !Array.isArray(value.exclusions)
    || value.exclusions.some((entry) => typeof entry !== "string") || !STATUSES.includes(value.status)
    || (value.error !== null && (typeof value.error?.code !== "string" || typeof value.error.message !== "string"))
    || (value.inspection !== null && (value.inspection?.schema !== "ailoha.workspace.inspection/v1"
      || !Array.isArray(value.inspection.applications) || typeof value.inspection.scan?.complete !== "boolean"
      || !Array.isArray(value.inspection.coverage) || !Array.isArray(value.inspection.diagnostics)))) {
    throw new Error("Invalid workspace inspection response. No application or live capability evidence was adopted.");
  }
}

export function createWorkspaceInspectionView({ element, request, chooseRoot = false, preferenceId }) {
  const panel = createInspectionPanel({ element, kind: "workspace", title: "Workspace", preferenceId });
  let snapshot = null;
  let visible = !document.hidden;
  let epoch = 0;
  let enabled = false;
  let retiredGeneration = -1;

  function render(value) {
    const workspace = element.closest(".workspace");
    element.hidden = !enabled || !visible;
    element.dataset.generation = String(value.generation);
    element.dataset.status = value.status;
    workspace?.classList.toggle("has-workspace-inspection", enabled && visible);
    const root = node("code", "workspace-inspection-root", value.root ?? (chooseRoot ? "No folder open" : "No project selected"));
    const noFolder = value.error?.code === "workspace_root_not_selected";
    const actions = node("div", "workspace-inspection-actions");
    function button(label, path, method, disabled = false) {
      const control = node("button", "button", label);
      control.type = "button";
      control.disabled = disabled;
      control.addEventListener("click", () => { void perform(path, method, value.generation); });
      actions.append(control);
    }
    if (chooseRoot) {
      const empty = value.error?.code === "workspace_root_not_selected";
      button(empty ? "Open folder" : "Choose project", empty ? "/api/v1/workspace/open" : "/api/v1/workspace/root",
        "POST", value.status === "suspended");
    }
    button(value.status === "scanning" ? "Inspecting..." : "Inspect", "/api/v1/workspace/inspection", "POST",
      !value.root || value.status === "scanning" || value.status === "suspended");
    if (value.status === "scanning") button("Cancel", "/api/v1/workspace/inspection", "DELETE");
    const status = node("p", "workspace-inspection-status");
    status.dataset.tone = value.error && !noFolder ? "danger" : value.status === "incomplete" ? "attention" : "neutral";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = noFolder ? "Open a local folder to see project details."
      : value.error ? `${value.error.code}: ${value.error.message}` : {
      "not-selected": chooseRoot ? "Choose a project folder."
        : "Choose a project when opening this canvas.",
      ready: "Read project files to see app and setup details.",
      scanning: "Reading project files...",
      complete: "Project details updated.",
      incomplete: "Incomplete scan. Missing evidence remains unknown.",
      cancelled: "Inspection cancelled. No retired application evidence is displayed.",
      suspended: "Inspection retired while this view is hidden or detached.",
      error: "Workspace inspection failed. Choose a root or retry explicitly.",
    }[value.status];
    const notice = node("p", "workspace-inspection-note",
      "Optional project details from files. Running app inspection is separate.");
    const content = [root, actions, status, notice];
    element.setAttribute("aria-busy", String(value.status === "scanning"));
    if (value.exclusions.length) content.push(node("p", "workspace-inspection-note", `Excluded: ${value.exclusions.join(", ")}`));
    if (!value.inspection) { panel.render(content, noFolder ? { ...value, status: "not-selected" } : value); return; }
    const inspection = value.inspection;
    const apps = node("div", "workspace-app-cards");
    for (const application of inspection.applications) apps.append(applicationCard(application));
    if (!inspection.applications.length) apps.append(node("p", "", inspection.scan.complete
      ? "No apps found in the inspected project files."
      : "No candidates returned by an incomplete scan; absence is not established."));
    content.push(apps, scanDetails(inspection));
    panel.render(content, value);
  }

  function acceptState(value) {
    validateSnapshot(value);
    if (snapshot && (value.scope.sessionId !== snapshot.scope.sessionId || value.scope.viewId !== snapshot.scope.viewId
      || value.generation < snapshot.generation)) return;
    if (value.status !== "suspended" && value.generation <= retiredGeneration) return;
    if (!visible && value.status !== "suspended") return;
    if (snapshot && value.root !== snapshot.root) epoch += 1;
    snapshot = value;
    enabled = true;
    render(value);
  }

  async function perform(path, method = "GET", generation) {
    const captured = ++epoch;
    try {
      const value = await request(path, {
        method,
        ...(path === "/api/v1/workspace/inspection" && method !== "GET" ? { body: JSON.stringify({ generation }) } : {}),
      });
      if (visible && captured === epoch) acceptState(value);
    } catch (error) {
      if (!visible || captured !== epoch) return;
      enabled = true;
      render({
        ...(snapshot ?? { root: null, exclusions: [] }), inspection: null, status: "error",
        error: { code: "workspace_request_failed", message: error instanceof Error ? error.message : "Workspace inspection failed." },
      });
    }
  }

  return Object.freeze({
    acceptState,
    load: () => perform("/api/v1/workspace/inspection"),
    setVisible(value) {
      if (visible === value) return;
      epoch += 1;
      if (!value && snapshot) retiredGeneration = Math.max(retiredGeneration, snapshot.generation);
      visible = value;
      if (snapshot) {
        const rootError = snapshot.root === null ? snapshot.error : null;
        snapshot = { ...snapshot, status: value ? snapshot.root ? "ready" : rootError ? "error" : "not-selected" : "suspended",
          inspection: null, error: rootError };
        render(snapshot);
      }
    },
  });
}
import { createInspectionPanel } from "./inspection-panel.js";
