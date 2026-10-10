import { isAbsolute, normalize } from "node:path";
import { MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";
import { mobileErrorResult } from "./mobile-backend.mjs";

export const WORKSPACE_INSPECTION_SCHEMA = "ailoha.workspace.inspection/v1";
export const WORKSPACE_VIEW_SCHEMA = "mobile-canvas.workspace-view/v1";
export const WORKSPACE_INSPECTION_MAX_BYTES = 2 * 1024 * 1024;
const LIMIT_NAMES = [
  "maxDepth", "maxCandidateFiles", "maxFileBytes", "maxTotalBytes", "maxEnumerationEntries",
  "maxIgnoreRules", "maxIgnoreEvaluations", "maxSourceTokens", "maxManifestDepth", "maxDiagnostics",
];
const COUNTER_NAMES = [
  "enumerationEntriesVisited", "ignoreRuleEvaluations", "candidateFilesConsidered",
  "candidateFilesRead", "bytesRead", "skippedEntries",
];

function invalid(message = "The canonical Ailoha workspace inspection has an invalid shape.") {
  throw new MobileAilohaError("workspace_inspection_invalid", message, 502);
}

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value;
}

function text(value, maximum = 4096) {
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) invalid();
  return value;
}

function identifier(value) {
  if (!text(value, 256)) invalid();
  return value;
}

function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function boolean(value) {
  if (typeof value !== "boolean") invalid();
  return value;
}

function nullable(value, convert = text) {
  return value === null ? null : convert(value);
}

function array(value, convert, maximum = 5000) {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  return value.map((entry) => convert(entry));
}

function state(value, choices) {
  if (!choices.includes(value)) invalid();
  return value;
}

function relativePath(value) {
  text(value);
  if (isAbsolute(value) || /^[A-Za-z]:|^[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)/.test(value)) invalid();
  return value;
}

function location(value) {
  object(value);
  return { line: nullable(value.line, integer), field: nullable(value.field) };
}

function nativeTarget(value) {
  if (value == null) return null;
  object(value);
  return {
    targetId: identifier(value.targetId), name: nullable(value.name),
    productType: nullable(value.productType), bundleId: nullable(value.bundleId),
  };
}

function evidenceState(value) {
  object(value);
  return {
    state: state(value.state, ["observed", "not-observed", "unknown"]),
    evidenceIds: array(value.evidenceIds, identifier),
  };
}

function application(value) {
  object(value);
  const instrumentation = object(value.instrumentation);
  const dependency = object(instrumentation.dependency);
  if (instrumentation.liveConnection?.state !== "not-evaluated"
    || instrumentation.correlation?.state !== "not-evaluated" || value.liveCapabilityEvidence !== null) {
    invalid("Static workspace inspection must not claim live capabilities or application/device correlation.");
  }
  return {
    applicationId: identifier(value.applicationId),
    relativeRoot: relativePath(value.relativeRoot),
    primaryManifest: relativePath(value.primaryManifest),
    framework: identifier(value.framework),
    variant: nullable(value.variant),
    role: state(value.role, ["application", "library", "unknown"]),
    nativeTarget: nativeTarget(value.nativeTarget),
    targetPlatforms: array(value.targetPlatforms, identifier),
    nativeWrappers: array(value.nativeWrappers, (wrapper) => {
      object(wrapper);
      return {
        relativeRoot: relativePath(wrapper.relativeRoot), primaryManifest: relativePath(wrapper.primaryManifest),
        evidenceIds: array(wrapper.evidenceIds, identifier),
        applicationId: wrapper.applicationId == null ? null : identifier(wrapper.applicationId),
        nativeTarget: nativeTarget(wrapper.nativeTarget),
      };
    }),
    evidence: array(value.evidence, (entry) => {
      object(entry);
      return {
        evidenceId: identifier(entry.evidenceId), kind: identifier(entry.kind), path: relativePath(entry.path),
        location: location(entry.location), observation: text(entry.observation),
      };
    }),
    instrumentation: {
      dependency: {
        state: state(dependency.state, ["declared", "not-observed", "unknown"]),
        packageId: text(dependency.packageId),
        declarations: array(dependency.declarations, (entry) => {
          object(entry);
          return {
            path: relativePath(entry.path), location: location(entry.location),
            versionExpression: nullable(entry.versionExpression), conditional: boolean(entry.conditional),
          };
        }),
        evidenceIds: array(dependency.evidenceIds, identifier),
      },
      startup: evidenceState(instrumentation.startup),
      debugGuard: evidenceState(instrumentation.debugGuard),
      liveConnection: { state: "not-evaluated" },
      correlation: { state: "not-evaluated" },
    },
    liveCapabilityEvidence: null,
    launchProfiles: array(value.launchProfiles, (profile) => {
      object(profile);
      if (profile.requiresWorkspaceTrust !== true || profile.evaluated !== false) invalid();
      return {
        name: text(profile.name), source: relativePath(profile.source), location: location(profile.location),
        requiresWorkspaceTrust: true, evaluated: false,
      };
    }),
    recommendedSkillIds: array(value.recommendedSkillIds, identifier),
    missingSteps: array(value.missingSteps, (step) => {
      object(step);
      if (step.requiresApproval !== true || step.requiresMutation !== true) invalid();
      return {
        code: identifier(step.code), description: text(step.description), evidenceIds: array(step.evidenceIds, identifier),
        requiresApproval: true, requiresMutation: true,
      };
    }),
  };
}

export function projectWorkspaceInspection(output, root) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > WORKSPACE_INSPECTION_MAX_BYTES) {
    throw new MobileAilohaError("workspace_inspection_output_limit", "Workspace inspection exceeded the consumer's 2 MiB output limit.", 502);
  }
  let value;
  try { value = JSON.parse(output); }
  catch { invalid("The canonical workspace command did not return JSON."); }
  object(value);
  if (value.schema !== WORKSPACE_INSPECTION_SCHEMA) {
    throw new MobileAilohaError("workspace_inspection_schema_unsupported", "This host supports only ailoha.workspace.inspection/v1.", 502);
  }
  const workspace = object(value.workspace);
  const scan = object(value.scan);
  const complete = boolean(scan.complete);
  const result = {
    schema: WORKSPACE_INSPECTION_SCHEMA,
    workspace: {
      workspaceId: nullable(workspace.workspaceId, identifier), root: nullable(workspace.root),
      repositoryMarker: text(workspace.repositoryMarker),
    },
    scan: {
      complete,
      limits: Object.fromEntries(LIMIT_NAMES.map((name) => [name, integer(object(scan.limits)[name])])),
      ...Object.fromEntries(COUNTER_NAMES.map((name) => [name, integer(scan[name])])),
      skipped: array(scan.skipped, (entry) => {
        object(entry);
        return { path: relativePath(entry.path), reason: text(entry.reason) };
      }, 200),
    },
    applications: array(value.applications, application),
    coverage: array(value.coverage, (entry) => {
      object(entry);
      return { framework: identifier(entry.framework), level: identifier(entry.level), observation: text(entry.observation) };
    }),
    diagnostics: array(value.diagnostics, (entry) => {
      object(entry);
      return {
        code: identifier(entry.code), severity: identifier(entry.severity), path: relativePath(entry.path),
        location: location(entry.location), message: text(entry.message),
      };
    }, 200),
  };
  if (result.workspace.root === null) {
    if (complete || result.workspace.workspaceId !== null || result.applications.length !== 0) invalid();
  } else if (!isAbsolute(result.workspace.root) || normalize(result.workspace.root) !== normalize(root)) {
    throw new MobileAilohaError("workspace_inspection_root_mismatch", "The scanner returned a different root from the explicitly bound workspace.", 502);
  }
  if (new Set(result.applications.map((entry) => entry.applicationId)).size !== result.applications.length) invalid();
  return publicSnapshot(result);
}

function rootInput(path, exclusions) {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new MobileAilohaError("workspace_root_required", "Choose an explicit absolute local workspace root; no ambient or parent root is inferred.", 400);
  }
  if (!Array.isArray(exclusions) || exclusions.length > 64
    || exclusions.some((entry) => typeof entry !== "string" || !entry || entry.length > 1024 || /[\u0000-\u001f\u007f]/.test(entry))) {
    throw new MobileAilohaError("workspace_exclusions_invalid", "Workspace exclusions must be at most 64 bounded, non-empty patterns.", 400);
  }
  return { path: normalize(path), exclusions: [...exclusions] };
}

export function createWorkspaceInspectionController({
  scope, runCli, validateRoot = () => undefined, onError = () => {}, timeoutMs = 30_000,
}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid inspection deadline.");
  const capturedScope = publicSnapshot({ sessionId: scope.sessionId, viewId: scope.viewId });
  const listeners = new Set();
  let root = null;
  let exclusions = [];
  let generation = 0;
  let visible = true;
  let active = null;
  let tail = Promise.resolve();
  let snapshot;

  function publish(status, inspection = null, error = null) {
    snapshot = publicSnapshot({
      schema: WORKSPACE_VIEW_SCHEMA, scope: capturedScope, generation, root, exclusions,
      status, inspection, error,
    });
    for (const listener of listeners) {
      try { listener(snapshot); }
      catch (error) { onError(mobileErrorResult(error)); }
    }
    return snapshot;
  }

  function retire() {
    generation += 1;
    active?.controller.abort();
    active = null;
  }

  function authorize(path) {
    const failure = validateRoot(path);
    if (failure) throw new MobileAilohaError(failure.code, failure.message, 403);
  }

  function assertGeneration(expected) {
    if (expected !== undefined && expected !== generation) {
      throw new MobileAilohaError("workspace_view_changed", "The displayed workspace view changed. Read its current explicit root before inspecting or cancelling.", 409);
    }
  }

  publish("not-selected");
  const api = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bindRoot(path, patterns = []) {
      if (!visible) throw new MobileAilohaError("workspace_view_retired", "Reopen this view before choosing an inspection root.", 409);
      const selected = rootInput(path, patterns);
      authorize(selected.path);
      retire();
      root = selected.path;
      exclusions = selected.exclusions;
      return publish("ready");
    },
    clearRoot(error = null) {
      retire();
      root = null;
      exclusions = [];
      const failure = error ? { ...error, status: error.status ?? 403 } : null;
      if (failure) onError(failure);
      return publish(visible ? error ? "error" : "not-selected" : "suspended", null, failure);
    },
    invalidate() {
      retire();
      return publish(visible ? root ? "ready" : "not-selected" : "suspended");
    },
    cancel(expectedGeneration) {
      assertGeneration(expectedGeneration);
      retire();
      return publish(visible ? "cancelled" : "suspended");
    },
    setVisible(value) {
      if (visible === value) return snapshot;
      retire();
      visible = value;
      return publish(visible ? root ? "ready" : "not-selected" : "suspended");
    },
    async request(method, body) {
      if (method === "GET" && body === undefined) return snapshot;
      if (body !== undefined && (typeof body !== "string" || body.length > 1024)) {
        throw new MobileAilohaError("workspace_request_invalid", "Workspace inspection requests must be bounded JSON.", 400);
      }
      let value;
      try { value = JSON.parse(body ?? "{}"); }
      catch { throw new MobileAilohaError("workspace_request_invalid", "Workspace inspection requests must be bounded JSON.", 400); }
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => key !== "generation")) {
        throw new MobileAilohaError("workspace_root_authority_required", "Renderer requests may capture only the view generation, not supply or enlarge a trusted root.", 403);
      }
      if (!Number.isSafeInteger(value.generation) || value.generation < 0) {
        throw new MobileAilohaError("workspace_generation_required", "Inspect or cancel only the explicit workspace generation displayed in this view.", 400);
      }
      if (method === "POST") return api.inspect(value.generation);
      if (method === "DELETE") return api.cancel(value.generation);
      throw new MobileAilohaError("workspace_request_unsupported", "Use the named read-only inspection methods.", 400);
    },
    async inspect(expectedGeneration) {
      assertGeneration(expectedGeneration);
      if (!visible) throw new MobileAilohaError("workspace_view_retired", "Reopen this view before inspecting its workspace.", 409);
      if (root === null) throw new MobileAilohaError("workspace_root_required", "Choose an explicit workspace root before inspecting.", 400);
      if (active) return active.promise;
      const capturedRoot = root;
      const capturedExclusions = [...exclusions];
      const entry = { generation: ++generation, controller: new AbortController(), promise: null };
      active = entry;
      const current = () => visible && active === entry && generation === entry.generation && root === capturedRoot;
      const signal = entry.controller.signal;
      const work = tail.then(async () => {
        signal.throwIfAborted();
        if (!current()) throw new MobileAilohaError("workspace_inspection_superseded", "A newer view or root retired this inspection.", 409);
        authorize(capturedRoot);
        const args = ["workspace", "inspect", "--path", capturedRoot, "--json"];
        for (const exclusion of capturedExclusions) args.push("--exclude", exclusion);
        return runCli(args, { signal });
      });
      // Wait for the actual one-shot invocation to settle before another can start, including
      // when a retired caller has already received its cancellation/deadline result.
      tail = work.then(() => undefined, () => undefined);
      let timer;
      let abort;
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(signal.reason ?? new MobileAilohaError("workspace_inspection_cancelled", "Workspace inspection was cancelled.", 409));
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => entry.controller.abort(new MobileAilohaError(
          "workspace_inspection_timeout", "Workspace inspection exceeded its 30-second deadline.", 504,
        )), timeoutMs);
      });
      entry.promise = (async () => {
        try {
          const output = await Promise.race([work, cancelled]);
          if (!current()) return snapshot;
          authorize(capturedRoot);
          const inspection = projectWorkspaceInspection(output, capturedRoot);
          return publish(inspection.scan.complete ? "complete" : "incomplete", inspection);
        } catch (error) {
          if (!current()) return snapshot;
          const failure = mobileErrorResult(error);
          onError(failure);
          return publish("error", null, { code: failure.code, message: failure.message, status: failure.status });
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          if (active === entry) active = null;
        }
      })();
      publish("scanning");
      return entry.promise;
    },
  };
  return Object.freeze(api);
}
