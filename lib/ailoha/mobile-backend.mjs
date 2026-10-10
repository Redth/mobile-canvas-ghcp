import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AilohaProtocolError, TARGET_HOST_PROFILE } from "./index.mjs";
import { captureCreateInput, loadMobileCatalog, resolveCreateChoice } from "./mobile-catalog.mjs";
import { appLaunchResult, isOpaqueId } from "./protocol.mjs";
import { localAppPackage } from "./staged-apps.mjs";
import {
  definitiveHttpStatus, definitiveOperationRejection,
  releaseOperationReceipt, submitOperationReceipt, waitForOperationReceipt,
} from "./operation-receipts.mjs";
import { ScopedDestructiveConsent } from "./destructive-consent.mjs";
import {
  assertLogicalPoint,
  assertObservedGeometry,
  captureConnectionRef,
  captureInvocation,
  hasOperation,
  immutableSnapshot,
  MobileAilohaError,
  projectMobileTarget,
  projectSurfaceGeometry,
  publicSnapshot,
  requireSurface,
  sameConnectionRef,
} from "./mobile-projection.mjs";

const LIFECYCLE = Object.freeze({
  boot: ["startTarget", "running"],
  shutdown: ["stopTarget", "stopped"],
  restart: ["rebootTarget", "running"],
  erase: ["resetTarget"],
  delete: ["deleteTarget"],
});
const PNG_MAGIC = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const APP_FEATURES = Object.freeze({
  appList: ["listTargetApps", "target.apps"],
  appInstall: ["installStagedTargetApp", "target.apps"],
  appLaunch: ["launchTargetApp", "target.apps"],
  appTerminate: ["terminateTargetApp", "target.apps"],
  appUninstall: ["uninstallFencedTargetApp", "target.apps"],
  appOpList: ["listTargetAppOps", "target.app-ops"],
  appOpSet: ["updateFencedTargetAppOp", "target.app-ops"],
});

function appSupport(capabilities, platform, consent, stagedInstall = false, fencedApps) {
  return Object.fromEntries(Object.entries(APP_FEATURES).map(([name, [operation, feature]]) => [
    name, ["ios", "android"].includes(platform)
      && (!name.startsWith("appOp") || platform === "android")
      && (name !== "appInstall" || stagedInstall)
      && (!["appUninstall", "appOpSet"].includes(name)
        || (consent && typeof fencedApps?.capture === "function"
          && typeof fencedApps?.[name === "appUninstall" ? "uninstall" : "setAppOp"] === "function"
          && (name !== "appOpSet" || typeof fencedApps?.readback === "function")
          && hasOperation(capabilities, "captureFencedTargetAppAction", "target.apps")))
      && (["appList", "appInstall"].includes(name) || hasOperation(capabilities, "listTargetApps", "target.apps"))
      && hasOperation(capabilities, operation, feature),
  ]));
}

function compareAppNames(left, right) {
  const first = left.toUpperCase();
  const second = right.toUpperCase();
  return first < second ? -1 : first > second ? 1 : 0;
}

function requireAppId(bundleId) {
  if (typeof bundleId !== "string" || !bundleId.trim() || !isOpaqueId(bundleId)) {
    throw new MobileAilohaError("invalid_request", "A native bundle or package identifier is required.", 400);
  }
  return bundleId;
}

function requireCallerSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new MobileAilohaError("invalid_request", "The captured caller cancellation signal is invalid.", 400);
  }
}

function requireCallerActive(signal) {
  if (signal?.aborted) {
    throw new MobileAilohaError("app_action_cancelled", "The captured app action caller cancelled before submission.", 409);
  }
}

function sameAppOwner(left, right) {
  return left.targetHostId === right.targetHostId && left.targetId === right.targetId
    && left.providerId === right.providerId
    && left.nativeIdentity?.platform === right.nativeIdentity?.platform
    && left.nativeIdentity?.nativeId === right.nativeIdentity?.nativeId;
}

function appFailure(error, invocation, kind, operationId) {
  const mapped = mobileErrorResult(error);
  const failure = new MobileAilohaError(mapped.code, mapped.message, mapped.status);
  if (invocation.executionContext) failure.contextIdentity = invocation.executionContext;
  if (isOpaqueId(operationId ?? mapped.operationId)) failure.operationId = operationId ?? mapped.operationId;
  failure.operation = publicSnapshot({
    kind,
    targetHostId: invocation.targetHostId, targetId: invocation.targetId,
    providerId: invocation.providerId, appId: invocation.appId,
    ...(failure.operationId ? { operationId: failure.operationId } : {}),
    ...(["queued", "running", "succeeded", "failed", "cancelling", "cancelled"]
      .includes(error?.operation?.status) ? { status: error.operation.status } : {}),
  });
  return failure;
}

export function mobileErrorResult(error) {
  const operationMetadata = {
    ...(isOpaqueId(error?.operationId) ? { operationId: error.operationId } : {}),
    ...(error?.operation ? { operation: error.operation } : {}),
    ...(isOpaqueId(error?.createdTargetId) ? { createdTargetId: error.createdTargetId } : {}),
  };
  if (error instanceof MobileAilohaError) {
    return {
      code: error.code, message: error.message, status: error.status,
      ...(error.cleanupProblem ? { cleanupProblem: error.cleanupProblem } : {}),
      ...(error.contextIdentity ? { contextIdentity: error.contextIdentity } : {}),
      ...(error.problem ? { problem: error.problem } : {}),
      ...(error.upstreamStatus !== undefined ? { upstreamStatus: error.upstreamStatus } : {}),
      ...operationMetadata,
    };
  }
  if (error instanceof AilohaProtocolError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status >= 400 && error.status <= 599 ? error.status : 502,
      ...(error.status !== undefined ? { upstreamStatus: error.status } : {}),
      ...(error.problem ? { problem: error.problem } : {}),
      ...operationMetadata,
    };
  }
  if (error?.name === "TargetHostTransportError") {
    return {
      code: typeof error.code === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(error.code)
        ? error.code : "ailoha_transport_failed",
      message: "The captured official Ailoha transport could not complete this operation.",
      status: Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502,
      ...(Number.isInteger(error.status) && error.status >= 100 ? { upstreamStatus: error.status } : {}),
    };
  }
  if (error?.name === "RuntimeDeliveryError") {
    const code = typeof error.code === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(error.code)
      ? error.code : "ailoha_runtime_unavailable";
    return {
      code,
      message: `The official Ailoha runtime is unavailable (${code}); the legacy engine was not started.`,
      status: 503,
    };
  }
  return { code: "ailoha_operation_failed", message: "The owned Ailoha operation failed.", status: 502 };
}

function unsupported(operation, invocation, kind = operation) {
  const error = new MobileAilohaError(
    "capability_not_supported",
    `${operation} is not supported by this Ailoha opt-in or the selected target's advertised capabilities.`,
    501,
  );
  throw invocation ? appFailure(error, invocation, kind) : error;
}

function requestBody(body) {
  if (body === undefined || body === "") return {};
  if (typeof body !== "string" || Buffer.byteLength(body) > 64 * 1024) {
    throw new MobileAilohaError("invalid_request", "Mobile Canvas request body exceeds its bounded JSON contract.", 400);
  }
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new MobileAilohaError("invalid_request", "Mobile Canvas request body must be JSON.", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MobileAilohaError("invalid_request", "Mobile Canvas request body must be a JSON object.", 400);
  }
  return publicSnapshot(value);
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function duration(value, fallback) {
  const captured = value ?? fallback;
  if (typeof captured !== "number" || !Number.isFinite(captured) || captured < 0 || captured > 30) {
    throw new MobileAilohaError("invalid_request", "Gesture duration must be a finite number in 0..30 seconds.", 400);
  }
  return captured;
}

// The media and selectionStore arguments are Mobile Canvas-owned adapters, not an upstream SDK schema.
export class AilohaMobileBackend {
  #scope;
  #owner;
  #client;
  #media;
  #selectionStore;
  #stagedApps;
  #fencedApps;
  #allowHostPackage;
  #consent;
  #unsubscribeContext;
  #events;
  #reportError;
  #saveScreenshot;
  #generation = 0;
  #lifetime = new AbortController();
  #observations = new Map();
  #videos = new Set();
  #videoUncertain = false;
  #videoState;
  #operationState;
  #creationPreparations = new Map();
  #disposed = false;
  #detached = false;
  #closing;

  constructor({
    scope, owner, client, media, selectionStore, confirmDestructive,
    stagedApps, fencedApps, allowHostPackage, saveScreenshot,
    videoState = {}, operationState = new Map(), onEvent = () => {}, onError = () => {},
  }) {
    this.#scope = publicSnapshot({ sessionId: scope.sessionId, viewId: scope.viewId });
    this.#client = client;
    this.#media = media;
    this.#selectionStore = selectionStore;
    this.#stagedApps = stagedApps;
    this.#fencedApps = fencedApps;
    this.#allowHostPackage = allowHostPackage;
    this.#consent = new ScopedDestructiveConsent(confirmDestructive, this.#lifetime.signal);
    this.#unsubscribeContext = selectionStore.onChange?.(() => this.#consent.cancelAll(
      new MobileAilohaError("context_snapshot_superseded", "The canonical context changed while destructive approval was pending."),
    ));
    this.#events = onEvent;
    this.#reportError = onError;
    this.#saveScreenshot = saveScreenshot;
    this.#videoState = videoState;
    this.#operationState = operationState;
    if (!owner.hostId || typeof owner.registerCleanup !== "function" || typeof owner.release !== "function"
      || typeof selectionStore.readSnapshot !== "function" || typeof selectionStore.isCurrentSnapshot !== "function"
      || typeof selectionStore.set !== "function") {
      throw new TypeError("Ailoha requires a trusted scoped owner and canonical selection adapter.");
    }
    this.#owner = Object.freeze({
      hostId: owner.hostId,
      connectionRef: captureConnectionRef(owner.connectionRef),
      registerCleanup: owner.registerCleanup.bind(owner),
      release: owner.release.bind(owner),
    });
  }

  get scope() { return this.#scope; }
  get connectionRef() { return this.#owner.connectionRef; }
  get supportsDestructiveApproval() { return this.#consent.supported; }
  cancelPendingApprovals() {
    this.#consent.cancelAll(new MobileAilohaError("consent_cancelled", "The host retired its pending destructive approval.", 409));
  }
  beginDestructiveApproval(action, invocation, options) {
    this.#requireOpen();
    this.#requireInvocationOwner(invocation);
    if (invocation.scope?.sessionId !== this.#scope.sessionId || invocation.scope?.viewId !== this.#scope.viewId) {
      throw new MobileAilohaError("consent_scope_mismatch", "Approval belongs to another captured view.");
    }
    const context = invocation.executionContext;
    if (context) this.#requireSnapshot({
      state: "open", contextProjection: context,
      contextOwner: invocation.contextOwner,
      identity: { scopeEpoch: context.scopeEpoch, revision: context.revision },
    });
    return this.#consent.begin(action, invocation, options);
  }
  get closed() {
    return this.#disposed || this.#detached || ["closed", "detached"].includes(this.#selectionStore.state);
  }

  async ready() {
    this.#requireOpen();
    const status = await this.#client.getHostStatus(this.#options());
    if (status.hostId !== this.#owner.hostId || status.profile !== TARGET_HOST_PROFILE) {
      throw new MobileAilohaError("host_identity_mismatch", "Ailoha returned a different Target Host identity or profile.");
    }
    return publicSnapshot({ backend: "ailoha", targetHostId: status.hostId, version: status.version, state: status.state });
  }

  #requireOpen() {
    if (this.closed) {
      throw new MobileAilohaError("view_closed", "This Ailoha canvas owner is closed.");
    }
  }

  #requireSnapshot(snapshot) {
    this.#requireOpen();
    if (!this.#selectionStore.isCurrentSnapshot(snapshot)) {
      throw new MobileAilohaError("context_snapshot_superseded", "The canonical view context changed after this intent was captured.");
    }
  }

  #requireInvocationOwner(invocation) {
    if (invocation?.targetHostId !== this.#owner.hostId
      || !sameConnectionRef(invocation.connectionRef, this.#owner.connectionRef)) {
      throw new MobileAilohaError("runtime_incarnation_changed",
        "The captured intent belongs to another Target Host process incarnation; it will not be rebound or replayed.");
    }
  }

  #options(signal) {
    return { signal: signal ? AbortSignal.any([this.#lifetime.signal, signal]) : this.#lifetime.signal };
  }

  async #record(targetId, surfaceId, options = this.#options()) {
    this.#requireOpen();
    const [target, providers, capabilities] = await Promise.all([
      this.#client.getTarget(targetId, options),
      this.#client.listProviders(options),
      this.#client.getTargetCapabilities(targetId, options),
    ]);
    const provider = providers.find((entry) => entry.providerId === target.providerId);
    if (!provider) throw new MobileAilohaError("provider_unavailable", "Ailoha target provider is not in the current inventory.");
    const surface = target.surfaces.length === 1 && surfaceId === undefined
      ? target.surfaces[0] : target.surfaces.find((entry) => entry.surfaceId === surfaceId);
    const supported = Object.fromEntries(Object.entries(LIFECYCLE).map(([name, [operation]]) => [
      name, hasOperation(capabilities, operation, "target.lifecycle")
        && (!(name === "erase" || name === "delete") || this.#consent.supported),
    ]));
    Object.assign(supported, appSupport(capabilities, target.nativeIdentity?.platform,
      this.#consent.supported, await this.#canStageApps(), this.#fencedApps));
    if (surface && this.#media) Object.assign(supported, this.#media.supported(capabilities, surface));
    const device = projectMobileTarget({ hostId: this.#owner.hostId, target, provider, supported, surfaceId });
    return { target, provider, capabilities, device };
  }

  async #inventory(snapshot) {
    this.#requireOpen();
    snapshot ??= await this.#selectionStore.readSnapshot();
    this.#requireSnapshot(snapshot);
    const { selection } = snapshot;
    if (selection && selection.targetHostId !== this.#owner.hostId) {
      throw new MobileAilohaError("host_selection_mismatch", "This view context now belongs to another Ailoha Target Host.");
    }
    const [targets, providers] = await Promise.all([
      this.#client.listTargets(this.#options()),
      this.#client.listProviders(this.#options()),
    ]);
    const stagedInstall = await this.#canStageApps();
    const devices = [];
    for (const target of targets) {
      const provider = providers.find((entry) => entry.providerId === target.providerId);
      if (!provider) throw new MobileAilohaError("provider_unavailable", "An Ailoha target has no matching inventory provider.");
      const capabilities = ["unavailable", "disabled"].includes(provider.state)
        ? [] : await this.#client.getTargetCapabilities(target.targetId, this.#options());
      const supported = Object.fromEntries(Object.entries(LIFECYCLE).map(([name, [operation]]) => [
        name, hasOperation(capabilities, operation, "target.lifecycle")
          && (!(name === "erase" || name === "delete") || this.#consent.supported),
      ]));
      Object.assign(supported, appSupport(capabilities, target.nativeIdentity?.platform,
        this.#consent.supported, stagedInstall, this.#fencedApps));
      const selectedSurfaceId = selection?.targetHostId === this.#owner.hostId && selection.targetId === target.targetId
        ? selection.surfaceId : undefined;
      const surface = selectedSurfaceId !== undefined
        ? target.surfaces.find((entry) => entry.surfaceId === selectedSurfaceId)
        : target.surfaces.length === 1 ? target.surfaces[0] : undefined;
      if (surface && this.#media) {
        Object.assign(supported, this.#media.supported(capabilities, surface));
      }
      devices.push(projectMobileTarget({ hostId: this.#owner.hostId, target, provider, supported, surfaceId: selectedSurfaceId }));
    }
    this.#requireSnapshot(snapshot);
    return { devices, providers };
  }

  async listDevices() { return (await this.#inventory()).devices; }

  async catalog() {
    return this.#catalog(await this.#selectionStore.readSnapshot());
  }

  async #catalog(snapshot) {
    const { devices, providers } = await this.#inventory(snapshot);
    const result = await loadMobileCatalog({
      hostId: this.#owner.hostId, client: this.#client, providers, devices, options: this.#options(),
    });
    this.#requireSnapshot(snapshot);
    return result;
  }

  async create(input, { selectCreated = false } = {}) {
    this.#requireOpen();
    const captured = captureCreateInput(input);
    // Compatibility choices already capture the host/provider; a replacement owner cannot rekey this intent.
    const key = JSON.stringify(["create", captured.platform, captured.name, captured.runtimeId, captured.deviceTypeId]);
    let receipt = this.#operationState.get(key);
    if (receipt) this.#requireInvocationOwner(receipt.invocation);
    if (!receipt) {
      let preparation = this.#creationPreparations.get(key);
      if (!preparation) {
        if (this.#creationPreparations.size + this.#operationState.size >= 64) {
          throw new MobileAilohaError("operation_receipt_limit", "The bounded creation intent/operation pool is full.", 429);
        }
        preparation = this.#prepareCreation(key, captured, selectCreated);
        this.#creationPreparations.set(key, preparation);
      }
      try { receipt = await preparation; }
      finally { if (this.#creationPreparations.get(key) === preparation) this.#creationPreparations.delete(key); }
    }
    this.#requireInvocationOwner(receipt.invocation);
    if (captured.platform !== undefined && captured.platform !== receipt.invocation.platform) {
      throw new MobileAilohaError("incompatible_catalog_choice", "The creation retry cannot replace its captured platform.", 400);
    }
    receipt.users += 1;
    const pending = receipt.confirming ??= this.#completeCreation(key, receipt);
    try {
      const result = await pending;
      receipt.verified = true;
      return result;
    } catch (error) {
      if (receipt.confirming === pending) receipt.confirming = null;
      const operation = error.operation ?? receipt.completed ?? receipt.accepted;
      if (receipt.operationId) error.operationId = receipt.operationId;
      if (operation) error.operation = operation;
      if (error.code !== "operation_owner_mismatch" && operation?.operationId === receipt.operationId
        && operation.kind === "createTarget" && operation.providerId === receipt.invocation.providerId
        && isOpaqueId(operation.targetId)) error.createdTargetId = operation.targetId;
      throw error;
    } finally {
      receipt.users -= 1;
      if (receipt.verified && receipt.users === 0) releaseOperationReceipt(this.#operationState, key, receipt);
    }
  }

  async #prepareCreation(key, captured, selectCreated) {
    const connectionRef = this.#owner.connectionRef;
    const generation = this.#generation;
    const snapshot = await this.#selectionStore.readSnapshot();
    this.#requireSnapshot(snapshot);
    const choice = resolveCreateChoice(await this.#catalog(snapshot), captured);
    const invocation = { ...publicSnapshot({
      scope: this.#scope, targetHostId: this.#owner.hostId, platform: choice.platform,
      ...choice.request, selectionGeneration: generation,
      ...(snapshot.contextProjection ? { executionContext: snapshot.contextProjection } : {}),
    }) };
    Object.defineProperty(invocation, "connectionRef", { value: connectionRef });
    Object.freeze(invocation);
    // Revalidate, but never replace the original selection/identity captured before catalog reads.
    await this.#selectionStore.readSnapshot();
    this.#requireOpen();
    this.#requireInvocationOwner(invocation);
    const receipt = submitOperationReceipt({
      state: this.#operationState, key, kind: "createTarget", invocation,
      requireCurrent: () => {
        this.#requireSnapshot(snapshot);
        if (generation !== this.#generation) {
          throw new MobileAilohaError("selection_superseded", "The view changed before creation could be submitted.");
        }
      },
      submit: () => this.#client.createTarget(choice.request, this.#options()),
    });
    this.#requireInvocationOwner(receipt.invocation);
    if (receipt.invocation === invocation) {
      Object.assign(receipt, { request: choice.request, contextSnapshot: snapshot, selectionOwner: this, selectCreated, users: 0 });
    }
    return receipt;
  }

  async #completeCreation(key, receipt) {
    const operation = await waitForOperationReceipt({
      state: this.#operationState, key, receipt, client: this.#client,
      options: { ...this.#options(), timeoutMs: 60_000 }, retainTerminal: true, outcome: "creation",
      requireOwner: () => this.#requireInvocationOwner(receipt.invocation),
    });
    this.#requireInvocationOwner(receipt.invocation);
    const { request, invocation } = receipt;
    if (operation.kind !== "createTarget" || operation.destructive !== true
      || operation.providerId !== invocation.providerId || !isOpaqueId(operation.targetId)
      || (receipt.accepted?.targetId !== undefined && receipt.accepted.targetId !== operation.targetId)
      || (operation.result?.targetId !== undefined && operation.result.targetId !== operation.targetId)) {
      throw new MobileAilohaError("operation_owner_mismatch", "Creation completion does not identify its captured provider and created target.", 502);
    }
    receipt.completed = operation;
    const record = await this.#record(operation.targetId);
    if (record.target.providerId !== invocation.providerId || record.target.targetTypeId !== invocation.targetTypeId
      || record.target.name !== request.name
      || (request.runtimeId !== undefined && record.target.runtimeId !== request.runtimeId)
      || (request.templateId !== undefined && record.target.templateId !== request.templateId)) {
      throw new MobileAilohaError("creation_target_mismatch", "The created target does not match its exact catalog choices.", 502);
    }
    if (!record.device.isAvailable) throw new MobileAilohaError("provider_unavailable", "The created target's provider is unavailable.", 503);
    if (record.target.status !== "running") {
      throw new MobileAilohaError("operation_state_mismatch", "Creation completed without confirming the required booted target.", 502);
    }
    const native = record.target.nativeIdentity;
    if (native?.platform !== invocation.platform || !native.nativeId || native.isVirtual !== true) {
      throw new MobileAilohaError("creation_native_identity_unconfirmed", "Creation did not confirm an authoritative mobile virtual-device deployment identity.", 502);
    }
    const selectionApplied = receipt.selectCreated ? await this.#selectCreated(record, receipt) : false;
    return publicSnapshot({ ...record.device, invocation, acceptedOperation: operation, selectionApplied });
  }

  async #selectCreated(record, receipt) {
    this.#requireInvocationOwner(receipt.invocation);
    await this.#selectionStore.readSnapshot();
    this.#requireOpen();
    const { contextSnapshot, invocation } = receipt;
    if ((receipt.selectionOwner === this && invocation.selectionGeneration !== this.#generation)
      || !this.#selectionStore.isCurrentSnapshot(contextSnapshot)) {
      return false;
    }
    const surface = record.target.surfaces.length ? requireSurface(record.target) : undefined;
    const generation = ++this.#generation;
    await this.#selectionStore.set(publicSnapshot({
      targetHostId: invocation.targetHostId, targetId: record.target.targetId,
      ...(surface ? { surfaceId: surface.surfaceId } : {}),
    }), contextSnapshot.identity);
    this.#requireOpen();
    if (generation !== this.#generation) {
      throw new MobileAilohaError("selection_superseded", "A newer selection superseded the created target's presentation.");
    }
    await this.closeVideos();
    this.#events({
      kind: "selection", deviceId: record.device.id,
      sessionId: this.#scope.sessionId, instanceId: this.#scope.viewId,
    });
    return true;
  }

  async getDevice(deviceId) { return (await this.#capture(deviceId)).device; }

  async getSelected() {
    this.#requireOpen();
    const snapshot = await this.#selectionStore.readSnapshot();
    this.#requireSnapshot(snapshot);
    const { selection, contextProjection: contextBinding } = snapshot;
    const context = contextBinding ? { scope: this.#scope, contextBinding } : {};
    if (!selection) return publicSnapshot({ hasSelection: false, ...context });
    if (selection.targetHostId !== this.#owner.hostId) {
      throw new MobileAilohaError("host_selection_mismatch", "The named context belongs to another Ailoha Target Host.");
    }
    const record = await this.#record(selection.targetId, selection.surfaceId);
    this.#requireSnapshot(snapshot);
    return publicSnapshot({
      hasSelection: true, device: record.device, scope: this.#scope,
      ...context,
    });
  }

  async select(deviceId, { surfaceId } = {}) {
    this.#consent.cancelAll(new MobileAilohaError("context_snapshot_superseded", "A new selection retired the pending destructive approval."));
    const generation = ++this.#generation;
    const snapshot = await this.#selectionStore.readSnapshot();
    this.#requireSnapshot(snapshot);
    const record = await this.#record(deviceId, surfaceId);
    if (record.target.surfaces.length > 1 && surfaceId === undefined) requireSurface(record.target);
    const surface = record.target.surfaces.length > 0 ? requireSurface(record.target, surfaceId) : undefined;
    const selection = publicSnapshot({
      targetHostId: this.#owner.hostId,
      targetId: record.target.targetId,
      ...(surface ? { surfaceId: surface.surfaceId } : {}),
    });
    if (generation !== this.#generation || this.#disposed) {
      throw new MobileAilohaError("selection_superseded", "A newer canvas selection superseded this intent.");
    }
    this.#requireSnapshot(snapshot);
    await this.#selectionStore.set(selection, snapshot.identity);
    if (generation !== this.#generation || this.#disposed) {
      throw new MobileAilohaError("selection_superseded", "A newer canvas selection superseded this result.");
    }
    await this.closeVideos();
    this.#events({
      kind: "selection", deviceId: record.device.id,
      sessionId: this.#scope.sessionId, instanceId: this.#scope.viewId,
    });
    return record.device;
  }

  async #capture(deviceId, needSurface = false, observed) {
    const generation = this.#generation;
    const contextSnapshot = await this.#selectionStore.readSnapshot();
    this.#requireSnapshot(contextSnapshot);
    const { selection } = contextSnapshot;
    if (selection && selection.targetHostId !== this.#owner.hostId) {
      throw new MobileAilohaError("host_selection_mismatch", "The named context belongs to another Target Host.");
    }
    const surfaceId = selection?.targetId === deviceId ? selection.surfaceId : observed?.surfaceId;
    const record = await this.#record(deviceId, surfaceId);
    if (generation !== this.#generation || this.#disposed) {
      throw new MobileAilohaError("selection_superseded", "The view owner changed before this invocation could be captured.");
    }
    this.#requireSnapshot(contextSnapshot);
    const surface = needSurface ? requireSurface(record.target, surfaceId) : undefined;
    const invocation = captureInvocation({
      scope: this.#scope, device: record.device, selectionGeneration: generation, surface,
      context: contextSnapshot.contextProjection,
      contextOwner: contextSnapshot.contextOwner,
      connectionRef: this.#owner.connectionRef,
    });
    return { ...record, invocation, contextSnapshot };
  }

  async display(deviceId) {
    const { invocation, device, contextSnapshot } = await this.#capture(deviceId, true);
    this.#requireSnapshot(contextSnapshot);
    if (!device.isAvailable) throw new MobileAilohaError("provider_unavailable", "The captured Ailoha provider is unavailable.", 503);
    this.#observations.set(deviceId, {
      geometry: invocation.geometry,
      contextIdentity: contextSnapshot.identity,
    });
    return invocation.geometry;
  }

  async #capturedApp(deviceId, feature, bundleId) {
    const captured = await this.#capture(deviceId);
    this.#requireInvocationOwner(captured.invocation);
    if (!captured.device.isAvailable) {
      throw new MobileAilohaError("provider_unavailable", "The captured Ailoha app provider is unavailable.", 503);
    }

    if (!["ios", "android"].includes(captured.device.platform)) {
      unsupported("Mobile target app management", captured.invocation, feature);
    }
    if (feature.startsWith("appOp") && captured.device.platform !== "android") {
      unsupported("Android app operations on iOS", captured.invocation, feature);
    }
    if (!captured.device.capabilities[feature]) unsupported(feature, captured.invocation);
    if (bundleId !== undefined) requireAppId(bundleId);
    return captured;
  }

  async #canStageApps() {
    if (!this.#stagedApps || !this.supportsDestructiveApproval
      || typeof this.#allowHostPackage !== "function") return false;
    const status = await this.#client.getHostStatus(this.#options());
    if (status.hostId !== this.#owner.hostId || status.profile !== TARGET_HOST_PROFILE) {
      throw new MobileAilohaError("host_identity_mismatch", "The captured app Target Host changed before staging.", 502);
    }
    return hasOperation(status.capabilities, "createArtifact", "host.artifacts");
  }

  async #currentApp(snapshot, invocation) {
    this.#requireInvocationOwner(invocation);
    const status = await this.#client.getHostStatus(this.#options());
    if (status.hostId !== invocation.targetHostId || status.profile !== TARGET_HOST_PROFILE) {
      throw new MobileAilohaError("host_identity_mismatch", "The captured app Target Host changed before dispatch.", 502);
    }
    const target = await this.#client.getTarget(invocation.targetId, this.#options());
    if (target.providerId !== invocation.providerId
      || target.nativeIdentity?.platform !== invocation.nativeIdentity?.platform
      || target.nativeIdentity?.nativeId !== invocation.nativeIdentity?.nativeId) {
      throw new MobileAilohaError("app_target_replaced", "The captured app target/provider changed before dispatch.", 409);
    }
    await this.#selectionStore.readSnapshot();
    this.#requireInvocationOwner(invocation);
    this.#requireSnapshot(snapshot);
    if (invocation.selectionGeneration !== this.#generation) {
      throw new MobileAilohaError("selection_superseded", "The view changed before app mutation dispatch.");
    }
  }

  async #resolveApp(invocation, bundleId) {
    const apps = await this.#client.listTargetApps(invocation.targetId, { includeSystem: true, ...this.#options() });
    const matches = apps.filter((entry) => entry.packageId === bundleId);
    if (matches.length !== 1) {
      throw new MobileAilohaError(
        matches.length ? "app_identity_ambiguous" : "app_not_found",
        matches.length ? "The native package identifies multiple target apps." : "The native package was not found on the captured target.",
        matches.length ? 502 : 404,
      );
    }
    return matches[0];
  }

  async listApps(deviceId, { text, includeSystem = false, limit = 100 } = {}) {
    const { invocation, device, contextSnapshot } = await this.#capturedApp(deviceId, "appList");
    if (typeof includeSystem !== "boolean") {
      throw new MobileAilohaError("invalid_request", "The system filter must be a boolean.", 400);
    }
    if (text !== undefined && text !== null && typeof text !== "string") {
      throw new MobileAilohaError("invalid_request", "The app filter must be text.", 400);
    }
    if (!Number.isSafeInteger(limit)) throw new MobileAilohaError("invalid_request", "The app limit must be an integer.", 400);
    let apps;
    try {
      apps = await this.#client.listTargetApps(invocation.targetId, { includeSystem, ...this.#options() });
      await this.#currentApp(contextSnapshot, invocation);
    } catch (error) {
      throw appFailure(error, invocation, "listTargetApps");
    }
    if (apps.some((app) => !["user", "system"].includes(app.kind)
      || !["installed", "stopped", "running"].includes(app.state))) {
      unsupported("Native app classification or stable running state in the canonical inventory", invocation, "listTargetApps");
    }
    const matched = apps.filter((app) => (includeSystem || app.kind === "user")
      && (!text?.trim() || app.packageId.toLowerCase().includes(text.toLowerCase())
        || app.name.toLowerCase().includes(text.toLowerCase())))
      .sort((left, right) => Number(left.kind === "system") - Number(right.kind === "system")
        || compareAppNames(left.name || left.packageId, right.name || right.packageId));
    return publicSnapshot({
      schemaVersion: "1.0", deviceId, platform: device.platform, total: matched.length,
      apps: matched.slice(0, Math.max(1, limit)).map((app) => ({
        bundleId: app.packageId, name: app.name || null, version: app.version || null,
        build: app.buildNumber || null, kind: app.kind, running: app.state === "running",
        processId: app.processId ?? null, path: app.path ?? null, dataContainer: app.dataContainer ?? null,
      })),
    });
  }

  async #appMutation(deviceId, bundleId, action, { captured, app, contextSnapshot, launchArguments = [] } = {}) {
    const feature = action === "launch" ? "appLaunch" : "appTerminate";
    const method = `${action}TargetApp`;
    const key = JSON.stringify([
      this.#owner.hostId, deviceId, method, bundleId,
      ...(action === "launch" ? [launchArguments] : []),
    ]);
    let receipt = this.#operationState.get(key);
    if (receipt && !sameConnectionRef(receipt.connectionRef, this.#owner.connectionRef)) {
      throw appFailure(new MobileAilohaError("runtime_incarnation_changed",
        "The original app receipt belongs to another Target Host process incarnation.", 409),
      receipt.invocation, method, receipt.operationId);
    }
    captured ??= await this.#capturedApp(deviceId, feature, bundleId);
    const { invocation } = captured;
    contextSnapshot ??= captured.contextSnapshot;
    this.#requireInvocationOwner(invocation);
    if (!hasOperation(captured.capabilities, method, "target.apps")) unsupported(action, invocation, method);
    receipt = this.#operationState.get(key);
    if (receipt && !sameConnectionRef(receipt.connectionRef, invocation.connectionRef)) {
      throw appFailure(new MobileAilohaError("runtime_incarnation_changed",
        "The original app receipt belongs to another Target Host process incarnation.", 409),
      receipt.invocation, method, receipt.operationId);
    }
    if (!receipt) {
      try {
        app ??= await this.#resolveApp(invocation, bundleId);
        await this.#currentApp(contextSnapshot, invocation);
      } catch (error) {
        throw appFailure(error, invocation, method);
      }
      receipt = this.#operationState.get(key);
      if (receipt && !sameConnectionRef(receipt.connectionRef, invocation.connectionRef)) {
        throw appFailure(new MobileAilohaError("runtime_incarnation_changed",
          "The original app receipt belongs to another Target Host process incarnation.", 409),
        receipt.invocation, method, receipt.operationId);
      }
      if (!receipt) {
        receipt = submitOperationReceipt({
          state: this.#operationState, key, kind: method,
          invocation: publicSnapshot({ ...invocation, appId: app.appId, bundleId }),
          requireCurrent: () => {
            this.#requireInvocationOwner(invocation);
            this.#requireSnapshot(contextSnapshot);
            if (invocation.selectionGeneration !== this.#generation) {
              throw new MobileAilohaError("selection_superseded", "The view changed before app mutation dispatch.");
            }
          },
          submit: () => action === "launch"
            ? this.#client.launchTargetApp(invocation.targetId, app.appId,
              launchArguments.length ? { arguments: launchArguments } : {}, this.#options())
            : this.#client.terminateTargetApp(invocation.targetId, app.appId, this.#options()),
        });
        Object.defineProperty(receipt, "connectionRef", { value: invocation.connectionRef });
      }
    }
    if (receipt.kind !== method || !sameAppOwner(receipt.invocation, invocation)
      || receipt.invocation.bundleId !== bundleId
      || (app && receipt.invocation.appId !== app.appId)) {
      throw new MobileAilohaError("operation_owner_mismatch", "The existing app receipt belongs to another app or target.", 502);
    }
    let operation;
    try {
      operation = await waitForOperationReceipt({
        state: this.#operationState, key, receipt, client: this.#client,
        options: { ...this.#options(), timeoutMs: 60_000 }, retainTerminal: true, outcome: "app",
      });
    } catch (error) {
      throw appFailure(error, receipt.invocation, method, receipt.operationId);
    }
    if (operation.kind !== method || operation.targetId !== receipt.invocation.targetId
      || (operation.providerId !== undefined && operation.providerId !== receipt.invocation.providerId)
      || (operation.result?.appId !== undefined && operation.result.appId !== receipt.invocation.appId)) {
      throw new MobileAilohaError("operation_owner_mismatch", "App completion changed its captured target/provider/action.", 502);
    }
    receipt.completed = operation;
    if (action === "launch" && operation.result !== undefined) {
      try { appLaunchResult(operation.result); }
      catch (error) { throw appFailure(error, receipt.invocation, method, receipt.operationId); }
    }
    const result = publicSnapshot({
      schemaVersion: "1.0", success: true, deviceId, bundleId, operation: action,
      processId: action === "launch" ? operation.result?.processId ?? null : null,
      detail: action === "launch" ? operation.result?.detail ?? null : null,
    });
    releaseOperationReceipt(this.#operationState, key, receipt);
    return result;
  }

  async #fencedAppAction(deviceId, bundleId, action, { operation, mode, signal, captured } = {}) {
    const feature = action === "uninstall" ? "appUninstall" : "appOpSet";
    const kind = action === "uninstall" ? "uninstallTargetApp" : "updateFencedTargetAppOp";
    const key = JSON.stringify([this.#owner.hostId, deviceId, kind, bundleId,
      ...(action === "app-op" ? [operation] : [])]);
    let progress = this.#operationState.get(key);
    if (progress) {
      if (progress.mode !== mode || !sameConnectionRef(progress.invocation.connectionRef, this.#owner.connectionRef)) {
        throw appFailure(new MobileAilohaError("operation_owner_mismatch",
          "The original app action belongs to another request or host incarnation.", 409),
        progress.invocation, kind, progress.receipt?.operationId);
      }
      return this.#resumeFencedAppAction(key, progress, signal);
    }
    captured ??= await this.#capturedApp(deviceId, feature, bundleId);
    const { invocation, contextSnapshot } = captured;
    this.#requireInvocationOwner(invocation);
    requireCallerActive(signal);
    let app;
    let appAction;
    try {
      app = await this.#resolveApp(invocation, bundleId);
      await this.#currentApp(contextSnapshot, invocation);
      requireCallerActive(signal);
      const capturedAction = await this.#fencedApps.capture(invocation, {
        appId: app.appId, packageId: bundleId,
        ...(action === "app-op" ? { operation, mode } : {}),
      }, { ...this.#options(signal), timeoutMs: 30_000 });
      if (capturedAction?.appId !== app.appId || capturedAction.packageId !== bundleId
        || (action === "app-op" && (capturedAction.operation !== operation
          || capturedAction.requestedMode !== mode))) {
        throw new MobileAilohaError("app_action_capture_mismatch",
          "The canonical app action captured a different native app or requested mode.", 502);
      }
      appAction = immutableSnapshot(capturedAction);
      await this.#currentApp(contextSnapshot, invocation);
      requireCallerActive(signal);
    } catch (error) {
      throw appFailure(error, invocation, kind);
    }
    progress = this.#operationState.get(key);
    if (progress) {
      if (progress.mode !== mode || !sameConnectionRef(progress.invocation.connectionRef, invocation.connectionRef)
        || !sameAppOwner(progress.invocation, invocation)
        || progress.appAction.appId !== appAction.appId) {
        throw appFailure(new MobileAilohaError("operation_owner_mismatch",
          "The existing app action captured another native app or host incarnation.", 409),
        progress.invocation, kind, progress.receipt?.operationId);
      }
    } else {
      if (this.#operationState.size >= 62) {
        throw new MobileAilohaError("operation_receipt_limit", "The bounded app action receipt pool is full.", 429);
      }
      progress = { invocation, contextSnapshot, appAction, kind, mode, action, receipt: null, pending: null };
      this.#operationState.set(key, progress);
    }
    return this.#resumeFencedAppAction(key, progress, signal);
  }

  async #resumeFencedAppAction(key, progress, signal) {
    this.#requireInvocationOwner(progress.invocation);
    if (!progress.receipt) this.#requireSnapshot(progress.contextSnapshot);
    const pending = progress.pending ??= this.#completeFencedAppAction(key, progress, signal);
    try { return await pending; }
    finally { if (progress.pending === pending) progress.pending = null; }
  }

  async #completeFencedAppAction(key, progress, signal) {
    const { invocation, contextSnapshot, appAction, action, kind } = progress;
    const submissionKey = `${key}:submission`;
    if (!progress.receipt) {
      let approval;
      try {
        await this.#currentApp(contextSnapshot, invocation);
        approval = this.beginDestructiveApproval(action, invocation, { signal, appAction });
        await approval.approved;
        await approval.run(async () => {
          await this.#currentApp(contextSnapshot, invocation);
          approval.requireCurrent();
          approval.consume(invocation, appAction);
          const timeoutMs = approval.remainingTimeoutMs(30_000);
          approval.requireCurrent();
          progress.receipt = submitOperationReceipt({
            state: this.#operationState, key: submissionKey, kind, invocation,
            requireCurrent: () => {
              this.#requireInvocationOwner(invocation);
              this.#requireSnapshot(contextSnapshot);
              if (invocation.selectionGeneration !== this.#generation) {
                throw new MobileAilohaError("selection_superseded", "The view changed before app action dispatch.", 409);
              }
            },
            submit: () => this.#fencedApps[action === "uninstall" ? "uninstall" : "setAppOp"](
              invocation, appAction.receipt, { signal: approval.signal, timeoutMs }),
          });
          await progress.receipt.submitted;
        });
      } catch (error) {
        if (!progress.receipt || (!progress.receipt.operationId && !progress.receipt.uncertain
          && !this.#operationState.has(submissionKey))) {
          releaseOperationReceipt(this.#operationState, key, progress);
        }
        throw appFailure(error, invocation, kind, progress.receipt?.operationId);
      } finally {
        approval?.dispose();
      }
    }
    let completed;
    try {
      completed = await waitForOperationReceipt({
        state: this.#operationState, key: submissionKey, receipt: progress.receipt,
        client: this.#client, options: { ...this.#options(signal), timeoutMs: 60_000 },
        retainTerminal: true, outcome: "app_action",
        requireOwner: () => this.#requireInvocationOwner(invocation),
      });
      if (completed.kind !== kind || completed.targetId !== invocation.targetId
        || (completed.providerId !== undefined && completed.providerId !== invocation.providerId)
        || (completed.result?.appId !== undefined && completed.result.appId !== appAction.appId)) {
        throw new MobileAilohaError("operation_owner_mismatch",
          "The completed app action changed its captured provider, target or native app.", 502);
      }
      progress.receipt.completed = completed;
      let readback;
      if (action === "app-op") {
        readback = this.#fencedApps.readback(completed, appAction);
        if (readback?.appId !== appAction.appId || readback.appOpId !== appAction.operation
          || typeof readback.uidScoped !== "boolean"
          || !["allow", "deny", "ignored", "default"].includes(readback.mode)) {
          throw new MobileAilohaError("app_action_readback_invalid",
            "The completed app operation lacks authoritative native identity, mode or UID scope.", 502);
        }
        if (readback.mode !== appAction.requestedMode) {
          throw new MobileAilohaError("app_action_readback_mismatch",
            readback.uidScoped
              ? "The whole-UID mode overrides the requested package mode; the effective mode was not changed."
              : "The effective package mode differs from the requested mode.", 409);
        }
      }
      const result = action === "uninstall"
        ? publicSnapshot({
          schemaVersion: "1.0", success: true, deviceId: invocation.targetId,
          bundleId: appAction.packageId, operation: "uninstall", processId: null, detail: null,
        })
        : publicSnapshot({
          schemaVersion: "1.0", success: true, deviceId: invocation.targetId,
          bundleId: appAction.packageId, operation: appAction.operation,
          mode: readback.mode === "ignored" ? "ignore" : readback.mode,
        });
      releaseOperationReceipt(this.#operationState, submissionKey, progress.receipt);
      releaseOperationReceipt(this.#operationState, key, progress);
      return result;
    } catch (error) {
      throw appFailure(error, invocation, kind, progress.receipt?.operationId);
    }
  }

  async launchApp(deviceId, bundleId, relaunch = false, args = []) {
    requireAppId(bundleId);
    if (typeof relaunch !== "boolean") throw new MobileAilohaError("invalid_request", "Relaunch must be a boolean.", 400);
    if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
      throw new MobileAilohaError("invalid_request", "Launch arguments must be an array of strings.", 400);
    }
    const launchArguments = [...args];
    if (!relaunch) return this.#appMutation(deviceId, bundleId, "launch", { launchArguments });
    const key = JSON.stringify([this.#owner.hostId, deviceId, "cold-relaunch", bundleId, launchArguments]);
    const retained = this.#operationState.get(key);
    if (retained && !sameConnectionRef(retained.connectionRef, this.#owner.connectionRef)) {
      throw appFailure(new MobileAilohaError("runtime_incarnation_changed",
        "The original relaunch belongs to another Target Host process incarnation.", 409),
      retained.invocation, "coldRelaunchTargetApp");
    }
    const captured = await this.#capturedApp(deviceId, "appLaunch", bundleId);
    if (!captured.device.capabilities.appTerminate) {
      unsupported("Cold app relaunch requires terminate capability", captured.invocation, "coldRelaunchTargetApp");
    }
    let progress = this.#operationState.get(key);
    if (!progress) {
      let app;
      try {
        app = await this.#resolveApp(captured.invocation, bundleId);
        await this.#currentApp(captured.contextSnapshot, captured.invocation);
      } catch (error) {
        throw appFailure(error, captured.invocation, "coldRelaunchTargetApp");
      }
      progress = this.#operationState.get(key);
      if (progress && progress.invocation.appId !== app.appId) {
        throw new MobileAilohaError("operation_owner_mismatch", "The original relaunch belongs to another native app.", 502);
      }
      if (!progress) {
        if (this.#operationState.size >= 64) {
          throw new MobileAilohaError("operation_receipt_limit", "The bounded app operation pool is full.", 429);
        }
        progress = { invocation: publicSnapshot({ ...captured.invocation, appId: app.appId, bundleId }),
          contextSnapshot: captured.contextSnapshot, terminationSucceeded: false, stopConfirmed: false };
        Object.defineProperty(progress, "connectionRef", { value: captured.invocation.connectionRef });
        this.#operationState.set(key, progress);
      }
    }
    if (!sameConnectionRef(progress.connectionRef, captured.invocation.connectionRef)) {
      throw appFailure(new MobileAilohaError("runtime_incarnation_changed",
        "The original relaunch belongs to another Target Host process incarnation.", 409),
      progress.invocation, "coldRelaunchTargetApp");
    }
    if (!sameAppOwner(progress.invocation, captured.invocation)) {
      throw new MobileAilohaError("operation_owner_mismatch", "The captured cold relaunch belongs to another target.", 502);
    }
    await this.#selectionStore.readSnapshot();
    this.#requireSnapshot(progress.contextSnapshot);
    const active = progress.pending ??= (async () => {
      if (!progress.stopConfirmed) {
        if (!progress.terminationSucceeded) {
          await this.#appMutation(deviceId, bundleId, "terminate", {
            captured, app: { appId: progress.invocation.appId }, contextSnapshot: progress.contextSnapshot,
          });
          progress.terminationSucceeded = true;
        }
        let stopped;
        try {
          stopped = await this.#client.getTargetApp(deviceId, progress.invocation.appId, this.#options());
        } catch (error) {
          throw appFailure(error, progress.invocation, "coldRelaunchTargetApp");
        }
        if (!["installed", "stopped"].includes(stopped.state) || stopped.packageId !== bundleId) {
          throw new MobileAilohaError("app_stop_unconfirmed", "Cold relaunch was not confirmed stopped; launch was not submitted.", 502);
        }
        progress.stopConfirmed = true;
      }
      if (captured.contextSnapshot.identity?.scopeEpoch !== progress.contextSnapshot.identity?.scopeEpoch) {
        throw new MobileAilohaError("context_snapshot_superseded", "The original relaunch view authority was retired before launch.", 409);
      }
      await this.#selectionStore.readSnapshot();
      this.#requireSnapshot(progress.contextSnapshot);
      const result = await this.#appMutation(deviceId, bundleId, "launch", {
        captured, app: { appId: progress.invocation.appId },
        contextSnapshot: progress.contextSnapshot, launchArguments,
      });
      releaseOperationReceipt(this.#operationState, key, progress);
      return result;
    })();
    try { return await active; }
    finally { if (progress.pending === active) progress.pending = null; }
  }

  async terminateApp(deviceId, bundleId) {
    return this.#appMutation(deviceId, requireAppId(bundleId), "terminate");
  }

  async uninstallApp(deviceId, bundleId, confirm = false, { signal } = {}) {
    if (confirm !== true) throw new MobileAilohaError("confirmation_required", "Uninstall requires confirm: true.", 400);
    requireCallerSignal(signal);
    return this.#fencedAppAction(deviceId, requireAppId(bundleId), "uninstall", { signal });
  }

  async installApp(deviceId, path, { signal } = {}) {
    if (typeof path !== "string" || !path.trim()) throw new MobileAilohaError("invalid_request", "A host package path is required.", 400);
    requireCallerSignal(signal);
    const key = JSON.stringify([this.#owner.hostId, deviceId, "staged-install", path]);
    const retained = this.#operationState.get(key);
    if (retained && !sameConnectionRef(retained.connectionRef, this.#owner.connectionRef)) {
      throw appFailure(new MobileAilohaError("runtime_incarnation_changed",
        "The original staged install belongs to another Target Host process incarnation.", 409),
      retained.invocation, "installTargetApp", retained.installReceipt?.operationId);
    }
    if (retained) return this.#resumeStagedInstall(key, retained);
    const captured = await this.#capture(deviceId);
    const prepared = this.#operationState.get(key);
    if (prepared) return this.#resumeStagedInstall(key, prepared);
    const { invocation, contextSnapshot, device, capabilities } = captured;
    this.#requireInvocationOwner(invocation);
    if (!device.isAvailable) throw new MobileAilohaError("provider_unavailable", "The captured app provider is unavailable.", 503);
    if (!["ios", "android"].includes(device.platform)
      || !hasOperation(capabilities, "installStagedTargetApp", "target.apps")
      || !await this.#canStageApps()) {
      unsupported("Canonical staged app install, artifact capability and scoped consent", invocation, "installTargetApp");
    }
    if (await this.#allowHostPackage() !== true) {
      unsupported("Local host package paths in this topology", invocation, "installTargetApp");
    }
    const sourcePath = await localAppPackage(path);
    let progress = this.#operationState.get(key);
    if (progress && (!sameConnectionRef(progress.connectionRef, invocation.connectionRef)
      || !sameAppOwner(progress.invocation, invocation) || progress.sourcePath !== sourcePath)) {
      throw appFailure(new MobileAilohaError("operation_owner_mismatch",
        "The existing staged install belongs to another package, target or host incarnation.", 409),
      progress.invocation, "installTargetApp", progress.installReceipt?.operationId);
    }
    if (!progress) {
      if (this.#operationState.size >= 62) {
        throw new MobileAilohaError("operation_receipt_limit", "The bounded app operation pool is full.", 429);
      }
      progress = { invocation, contextSnapshot, sourcePath, staged: null, stageStarted: false,
        installReceipt: null, cleanupReceipt: null, cleanupCompleted: false, completed: null, primaryError: null };
      Object.defineProperty(progress, "connectionRef", { value: invocation.connectionRef });
      Object.defineProperty(progress, "stageSignal", {
        value: signal ? AbortSignal.any([this.#lifetime.signal, signal]) : this.#lifetime.signal,
      });
      this.#operationState.set(key, progress);
    }
    return this.#resumeStagedInstall(key, progress);
  }

  async #resumeStagedInstall(key, progress) {
    this.#requireInvocationOwner(progress.invocation);
    const pending = progress.pending ??= this.#completeStagedInstall(key, progress);
    try { return await pending; }
    finally { if (progress.pending === pending) progress.pending = null; }
  }

  async #completeStagedInstall(key, progress) {
    const { invocation, contextSnapshot, sourcePath } = progress;
    const installKey = `${key}:install`;
    const cleanupKey = `${key}:cleanup`;
    try {
      this.#requireInvocationOwner(invocation);
      if (!progress.staged) {
        if (progress.stageStarted) {
          throw new MobileAilohaError("stage_outcome_uncertain",
            "The original package staging outcome is unknown and will not be retried.", 502);
        }
        await this.#currentApp(contextSnapshot, invocation);
        progress.stageStarted = true;
        try {
          progress.staged = await this.#stagedApps.stage(invocation, sourcePath, {
            signal: progress.stageSignal, timeoutMs: 11 * 60_000,
          });
        } catch (error) {
          if (["invalid_package", "package_too_large", "stage_rejected", "context_snapshot_superseded"].includes(error.code)) {
            releaseOperationReceipt(this.#operationState, key, progress);
          }
          throw error;
        }
      }
      if (!progress.completed && !progress.primaryError) {
        try {
          if (!progress.installReceipt) {
            await this.#currentApp(contextSnapshot, invocation);
            const approval = this.beginDestructiveApproval("install", invocation, {
              signal: progress.stageSignal, stagedArtifact: progress.staged,
            });
            if (!approval || typeof approval.approved?.then !== "function"
              || typeof approval.run !== "function" || typeof approval.consume !== "function"
              || typeof approval.requireCurrent !== "function" || typeof approval.remainingTimeoutMs !== "function"
              || typeof approval.signal?.throwIfAborted !== "function" || typeof approval.dispose !== "function") {
              unsupported("Scoped host-issued install approval", invocation, "installTargetApp");
            }
            try {
              await approval.approved;
              await approval.run(async () => {
                approval.requireCurrent();
                await this.#currentApp(contextSnapshot, invocation);
                approval.consume(invocation, progress.staged);
                const installTimeoutMs = approval.remainingTimeoutMs(30_000);
                approval.signal.throwIfAborted();
                progress.installReceipt = submitOperationReceipt({
                  state: this.#operationState, key: installKey, kind: "installTargetApp", invocation,
                  requireCurrent: () => {
                    this.#requireInvocationOwner(invocation);
                    this.#requireSnapshot(contextSnapshot);
                    if (invocation.selectionGeneration !== this.#generation) {
                      throw new MobileAilohaError("selection_superseded", "The view changed before install submission.", 409);
                    }
                  },
                  submit: () => this.#stagedApps.install(invocation, progress.staged, {
                    signal: approval.signal, timeoutMs: installTimeoutMs,
                  }),
                });
                await progress.installReceipt.submitted;
              });
            } finally {
              approval.dispose();
            }
          }
          const operation = await waitForOperationReceipt({
            state: this.#operationState, key: installKey, receipt: progress.installReceipt,
            client: this.#client, options: { ...this.#options(), timeoutMs: 60_000 },
            retainTerminal: true, outcome: "app_install",
            requireOwner: () => this.#requireInvocationOwner(invocation),
          });
          if (operation.kind !== "installTargetApp" || operation.targetId !== invocation.targetId
            || (operation.providerId !== undefined && operation.providerId !== invocation.providerId)) {
            throw new MobileAilohaError("operation_owner_mismatch",
              "Install completion does not identify its captured provider and target.", 502);
          }
          progress.completed = operation;
        } catch (error) {
          if (progress.installReceipt?.uncertain || (progress.installReceipt && !progress.installReceipt.operationId
            && !["install_rejected", "context_snapshot_superseded"].includes(error.code))) {
            throw appFailure(error, invocation, "installTargetApp", progress.installReceipt?.operationId);
          }
          if (progress.installReceipt?.operationId
            && !["operation_failed", "operation_cancelled"].includes(error.code)) {
            throw appFailure(error, invocation, "installTargetApp", progress.installReceipt.operationId);
          }
          progress.primaryError = appFailure(error, invocation, "installTargetApp",
            progress.installReceipt?.operationId);
        }
      }
      if (progress.staged && !progress.cleanupReceipt) {
        progress.cleanupReceipt = submitOperationReceipt({
          state: this.#operationState, key: cleanupKey, kind: "deleteArtifact", invocation,
          requireCurrent: () => this.#requireInvocationOwner(invocation),
          submit: () => this.#stagedApps.cleanup(invocation, progress.staged, {
            signal: this.#lifetime.signal, timeoutMs: 30_000,
          }),
        });
      }
      if (progress.cleanupReceipt && !progress.cleanupCompleted) {
        const cleanup = await waitForOperationReceipt({
          state: this.#operationState, key: cleanupKey, receipt: progress.cleanupReceipt,
          client: this.#client, options: { ...this.#options(), timeoutMs: 60_000 },
          retainTerminal: true, outcome: "app_stage_cleanup",
          requireOwner: () => this.#requireInvocationOwner(invocation),
        });
        if (cleanup.kind !== "deleteArtifact"
          || (cleanup.targetId !== undefined && cleanup.targetId !== invocation.targetId)) {
          throw new MobileAilohaError("operation_owner_mismatch",
            "Artifact cleanup completion does not identify the original stage.", 502);
        }
        progress.cleanupCompleted = true;
      }
      releaseOperationReceipt(this.#operationState, cleanupKey, progress.cleanupReceipt);
      releaseOperationReceipt(this.#operationState, installKey, progress.installReceipt);
      if (progress.primaryError) throw progress.primaryError;
      releaseOperationReceipt(this.#operationState, key, progress);
      return publicSnapshot({
        schemaVersion: "1.0", success: true, deviceId: invocation.targetId,
        bundleId: null, operation: "install", processId: null, detail: null,
      });
    } catch (error) {
      const failure = error instanceof MobileAilohaError && error.operation
        ? error : appFailure(error, invocation, "installTargetApp", progress.installReceipt?.operationId);
      if (progress.staged && (progress.primaryError || progress.completed)
        && this.#operationState.get(key) === progress
        && failure !== progress.primaryError) {
        failure.cleanupProblem = publicSnapshot({ code: failure.code, message: failure.message });
        if (progress.primaryError) {
          progress.primaryError.cleanupProblem = failure.cleanupProblem;
          throw progress.primaryError;
        }
      }
      throw failure;
    }
  }

  async listAppOps(deviceId, bundleId) {
    const { invocation, contextSnapshot } = await this.#capturedApp(deviceId, "appOpList", bundleId);
    let ops;
    try {
      const app = await this.#resolveApp(invocation, bundleId);
      await this.#currentApp(contextSnapshot, invocation);
      ops = await this.#client.listTargetAppOps(invocation.targetId, app.appId, this.#options());
      await this.#currentApp(contextSnapshot, invocation);
    } catch (error) {
      throw appFailure(error, invocation, "listTargetAppOps");
    }
    if (ops.some((op) => typeof op.uidScoped !== "boolean"
      || !["allow", "deny", "ignored", "default"].includes(op.mode))) {
      unsupported("Effective Android app-operation UID scope or mode", invocation, "listTargetAppOps");
    }
    return publicSnapshot({
      schemaVersion: "1.0", deviceId, platform: "android", bundleId,
      operations: ops.map((op) => ({
        name: op.appOpId, mode: op.mode === "ignored" ? "ignore" : op.mode, uidScoped: op.uidScoped,
      })), total: ops.length,
    });
  }

  async setAppOp(deviceId, bundleId, operation, mode = "allow", { signal } = {}) {
    requireCallerSignal(signal);
    const captured = await this.#capturedApp(deviceId, "appOpSet", bundleId);
    if (typeof operation !== "string" || !operation.trim()
      || typeof mode !== "string" || !["allow", "deny", "ignore", "default"].includes(mode.trim().toLowerCase())) {
      throw new MobileAilohaError("invalid_request", "A named app operation and a supported mode are required.", 400);
    }
    return this.#fencedAppAction(deviceId, requireAppId(bundleId), "app-op", {
      operation: operation.trim().toUpperCase(),
      mode: mode.trim().toLowerCase() === "ignore" ? "ignored" : mode.trim().toLowerCase(),
      signal, captured,
    });
  }
  async lifecycle(action, deviceId, input = {}, { signal } = {}) {
    const specification = LIFECYCLE[action];
    if (!specification) unsupported(action);
    if (action === "erase" || action === "delete") {
      const descriptor = Object.getOwnPropertyDescriptor(input, "confirm");
      if (!descriptor || descriptor.value !== true) {
        throw new MobileAilohaError("confirmation_required", "This action requires an own literal confirm: true.");
      }
    }
    const [method, expectedState] = specification;
    const key = JSON.stringify([this.#owner.hostId, deviceId, action]);
    let receipt = this.#operationState.get(key);
    let ownsSubmission = false;
    if (receipt) this.#requireInvocationOwner(receipt.invocation);
    if (!receipt) {
      if ((action === "erase" || action === "delete") && !this.#consent.supported) unsupported("Scoped destructive consent");
      const { invocation, capabilities, contextSnapshot } = await this.#capture(deviceId);
      if (!hasOperation(capabilities, method, "target.lifecycle")) unsupported(action);
      if (this.#operationState.size >= 64 && !this.#operationState.has(key)) {
        throw new MobileAilohaError("operation_receipt_limit", "The bounded lifecycle receipt pool is full.", 429);
      }
      let options = this.#options(signal);
      let approval;
      let submittedApproval = false;
      try {
        if (action === "erase" || action === "delete") {
          approval = this.beginDestructiveApproval(action, invocation, { signal });
          await approval.approved;
          approval.requireCurrent();
          await approval.run(() => this.#selectionStore.readSnapshot({ signal: approval.signal }));
          this.#requireSnapshot(contextSnapshot);
          const fresh = await approval.run(() => this.#record(invocation.targetId, undefined, this.#options(approval.signal)));
          approval.requireCurrent();
          await approval.run(() => this.#selectionStore.readSnapshot({ signal: approval.signal }));
          this.#requireSnapshot(contextSnapshot);
          if (fresh.target.targetId !== invocation.targetId || fresh.provider.providerId !== invocation.providerId
            || !isDeepStrictEqual(fresh.device.nativeIdentity ?? null, invocation.nativeIdentity ?? null)) {
            throw new MobileAilohaError("consent_target_changed", "The approved provider or native target identity changed before submission.");
          }
          if (!fresh.device.isAvailable) throw new MobileAilohaError("provider_unavailable", "The approved target provider is unavailable.", 503);
          if (!hasOperation(fresh.capabilities, method, "target.lifecycle")) unsupported(action);
          if (!this.#consent.supported) unsupported("Scoped destructive consent");
          options = { ...options, confirmed: true };
        }
        this.#requireOpen();
        this.#requireInvocationOwner(invocation);
        // Another invocation can submit while this one waits for scope/capability/consent reads.
        receipt = this.#operationState.get(key);
        if (!receipt) {
          this.#requireSnapshot(contextSnapshot);
          if (this.#operationState.size >= 64) {
            throw new MobileAilohaError("operation_receipt_limit", "The bounded lifecycle receipt pool is full.", 429);
          }
          approval?.consume(invocation);
          receipt = { invocation, operationId: null, submitted: null, uncertain: false, completed: null };
          this.#operationState.set(key, receipt);
          const captured = receipt;
          ownsSubmission = true;
          submittedApproval = Boolean(approval);
          captured.submitted = (async () => {
            let invoked = false;
            try {
              const submissionOptions = approval
                ? { ...options, signal: approval.signal, timeoutMs: approval.remainingTimeoutMs(15_000) } : options;
              invoked = true;
              const accepted = await this.#client[method](invocation.targetId, submissionOptions);
              captured.operationId = accepted.operationId;
            } catch (error) {
              if (!invoked) {
                if (this.#operationState.get(key) === captured) this.#operationState.delete(key);
                throw error;
              }
              if (error instanceof AilohaProtocolError && error.status === 202 && error.operationId) {
                captured.operationId = error.operationId;
                return;
              }
              const definitive = definitiveOperationRejection(error);
              if (definitive && this.#operationState.get(key) === captured) this.#operationState.delete(key);
              else captured.uncertain = true;
              throw error;
            } finally {
              try { approval?.submitted({ operationId: captured.operationId, uncertain: captured.uncertain }); }
              catch (error) {
                captured.approvalError = error;
                if (!captured.operationId) throw error;
              }
            }
          })();
        }
      } finally {
        if (!submittedApproval) approval?.dispose();
      }
    }
    this.#requireOpen();
    this.#requireInvocationOwner(receipt.invocation);
    if (receipt.uncertain) {
      throw new MobileAilohaError("lifecycle_outcome_uncertain",
        "A previous captured lifecycle submission has an uncertain result without an operation receipt. It will not be submitted again.", 502);
    }
    await receipt.submitted;
    if (ownsSubmission && receipt.approvalError) throw receipt.approvalError;
    const invocation = receipt.invocation;
    this.#requireInvocationOwner(invocation);
    const operation = await waitForOperationReceipt({
      state: this.#operationState, key, receipt, client: this.#client,
      options: { ...this.#options(), timeoutMs: 60_000 },
      requireOwner: () => this.#requireInvocationOwner(invocation),
    });
    this.#requireInvocationOwner(invocation);
    if (operation.kind !== method || (operation.targetId !== undefined && operation.targetId !== invocation.targetId)
      || (operation.providerId !== undefined && operation.providerId !== invocation.providerId)) {
      throw new MobileAilohaError("operation_owner_mismatch", "The lifecycle completion does not match its captured action/target/provider.", 502);
    }
    receipt.completed = operation;
    if (action === "delete") {
      releaseOperationReceipt(this.#operationState, key, receipt);
      return publicSnapshot({ success: true, operation: "delete", deviceId, context: invocation, acceptedOperation: operation });
    }
    const device = (await this.#record(invocation.targetId)).device;
    if (expectedState && device.targetStatus !== expectedState) {
      throw new MobileAilohaError("operation_state_mismatch", "The completed lifecycle operation has not reached its required target state.");
    }
    releaseOperationReceipt(this.#operationState, key, receipt);
    return publicSnapshot({ ...device, invocation });
  }

  async screenshot(deviceId) {
    const record = await this.#capture(deviceId, true);
    this.#requireSnapshot(record.contextSnapshot);
    if (!record.device.capabilities.screenshot || !this.#media) unsupported("Screenshot capture");
    const bytes = await this.#media.screenshot(record.invocation);
    if (!(bytes instanceof Uint8Array) || bytes.length < PNG_MAGIC.length || bytes.length > 8 * 1024 * 1024
      || PNG_MAGIC.some((byte, index) => bytes[index] !== byte)) {
      throw new MobileAilohaError("invalid_screenshot", "Ailoha screenshot must be a bounded PNG.", 502);
    }
    return { invocation: record.invocation, bytes };
  }

  async input(kind, deviceId, input) {
    if (!["tap", "swipe"].includes(kind)) unsupported(`Input ${kind}`);
    const observation = this.#observations.get(deviceId);
    const observed = publicSnapshot({
      ...observation?.geometry,
      ...Object.fromEntries(["surfaceId", "geometryRevision", "coordinate"]
        .filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]])),
    });
    const { invocation, device, contextSnapshot } = await this.#capture(deviceId, true, observed);
    this.#requireSnapshot(contextSnapshot);
    const currentIdentity = contextSnapshot.identity;
    if (observation?.contextIdentity
      && (!currentIdentity || observation.contextIdentity.scopeEpoch !== currentIdentity.scopeEpoch
        || observation.contextIdentity.revision !== currentIdentity.revision)) {
      throw new MobileAilohaError("stale_selection", "The named context changed after its display geometry was observed.");
    }
    const geometry = assertObservedGeometry(invocation, observed);
    if (invocation.selectionGeneration !== this.#generation) {
      throw new MobileAilohaError("stale_selection", "A canvas selection changed before this input could be dispatched.");
    }
    if (!this.#media || !device.capabilities[kind]) unsupported(`Input ${kind}`);
    let payload;
    if (kind === "tap") {
      assertLogicalPoint(geometry, input.x, input.y);
      const seconds = duration(input.duration, 0);
      if (seconds > 0 && !device.capabilities.longPress) unsupported("Long press");
      payload = { x: input.x, y: input.y, duration: seconds };
    } else if (kind === "swipe") {
      assertLogicalPoint(geometry, input.startX, input.startY);
      assertLogicalPoint(geometry, input.endX, input.endY);
      payload = {
        startX: input.startX, startY: input.startY, endX: input.endX, endY: input.endY,
        duration: duration(input.duration, 0.35),
      };
    } else unsupported(`Input ${kind}`);
    await this.#media[kind](invocation, publicSnapshot(payload));
    return publicSnapshot({ success: true, operation: kind, deviceId, context: invocation });
  }

  async openVideo(deviceId, onMessage, onError) {
    if (this.#videoUncertain || this.#videoState.createUncertain) {
      if (this.#videoState.invocation) this.#requireInvocationOwner(this.#videoState.invocation);
      throw new MobileAilohaError(
        "video_create_uncertain",
        "A previous video creation has an uncertain result. No automatic creation retry is allowed.",
      );
    }
    if (this.#videos.size > 0) {
      throw new MobileAilohaError("video_busy", "Close the owned video resource before creating a replacement.");
    }
    const generation = this.#generation;
    const { invocation, device, contextSnapshot } = await this.#capture(deviceId, true);
    this.#requireSnapshot(contextSnapshot);
    if (!this.#media || !device.capabilities.liveStream) unsupported("ALHV live display");
    if (this.#videos.size > 0) {
      throw new MobileAilohaError("video_busy", "An owned video creation is already in progress.");
    }
    const ticket = {
      closeRequested: false, socket: null, descriptor: null, cleanup: null, closing: null, unregister: null,
      creating: null, attaching: null, socketClosed: false,
    };
    this.#videos.add(ticket);
    const cleanup = () => ticket.closing ??= (async () => {
      ticket.closeRequested = true;
      try { await ticket.creating; }
      catch (error) { if (!ticket.descriptor) throw error; }
      if (ticket.attaching) {
        try { await ticket.attaching; }
        catch (error) { this.#reportError(mobileErrorResult(error)); }
      }
      const failures = [];
      if (ticket.socket && !ticket.socketClosed) {
        try {
          if (ticket.socket.readyState !== 3 && await ticket.socket.close() === false) throw new Error("declined");
          ticket.socketClosed = true;
        } catch { failures.push("socket"); }
      }
      if (ticket.descriptor) {
        try { await this.#media.deleteVideo(invocation, ticket.descriptor); }
        catch { failures.push("session"); }
      }
      if (failures.length) {
        throw new MobileAilohaError("video_cleanup_failed", `Owned Ailoha video cleanup failed for ${failures.join(" and ")}.`, 502);
      }
      ticket.unregister?.();
      this.#videos.delete(ticket);
    })().catch((error) => {
      ticket.closing = null;
      throw error;
    });
    ticket.cleanup = cleanup;
    ticket.creating = (async () => {
      try {
        ticket.descriptor = await this.#media.createVideo(invocation, (descriptor) => {
          ticket.descriptor = descriptor;
          ticket.unregister ??= this.#owner.registerCleanup(cleanup);
        });
      } catch (error) {
        this.#videoUncertain = ticket.descriptor === null
          && !(error instanceof MobileAilohaError && definitiveHttpStatus(error.status))
          && !(error instanceof AilohaProtocolError && definitiveHttpStatus(error.status))
          && !(error?.name === "TargetHostTransportError" && definitiveHttpStatus(error.status));
        if (this.#videoUncertain) {
          this.#videoState.createUncertain = true;
          this.#videoState.invocation = invocation;
        }
        throw error;
      }
    })();
    try {
      await ticket.creating;
      ticket.unregister ??= this.#owner.registerCleanup(cleanup);
      if (this.#disposed || generation !== this.#generation || ticket.closeRequested) {
        await cleanup();
        throw new MobileAilohaError("video_owner_retired", "The captured video owner was retired during creation.");
      }
      this.#requireSnapshot(contextSnapshot);
      ticket.attaching = this.#media.attachVideo(invocation, ticket.descriptor, {
        onMessage: (data) => {
          if (!ticket.closeRequested && !this.#disposed && generation === this.#generation
            && this.#selectionStore.isCurrentSnapshot(contextSnapshot)) return onMessage(data);
        },
        onError: (error) => {
          if (!ticket.closeRequested && !this.#disposed && generation === this.#generation
            && this.#selectionStore.isCurrentSnapshot(contextSnapshot)) onError(mobileErrorResult(error));
        },
      }).then((socket) => { ticket.socket = socket; });
      await ticket.attaching;
      if (this.#disposed || generation !== this.#generation || ticket.closeRequested) {
        await cleanup();
        throw new MobileAilohaError("video_owner_retired", "The captured video attachment was retired during connection.");
      }
      this.#requireSnapshot(contextSnapshot);
      return Object.freeze({
        context: publicSnapshot({ videoSessionId: ticket.descriptor.videoSessionId, ownerId: randomUUID() }),
        geometry: publicSnapshot({
          geometryRevision: invocation.geometry.geometryRevision,
          bounds: invocation.geometry.bounds,
          ...(invocation.geometry.scale !== null ? { pixelDensity: invocation.geometry.scale } : {}),
        }),
        ...(ticket.descriptor.source !== undefined ? { source: ticket.descriptor.source } : {}),
        ...(ticket.descriptor.sourceDetail !== undefined ? { sourceDetail: ticket.descriptor.sourceDetail } : {}),
        protocol: ticket.socket.protocol,
        async send(text) {
          if (ticket.closeRequested) throw new MobileAilohaError("video_owner_retired", "This video attachment is closed.");
          if (await ticket.socket.send(text) === false) throw new MobileAilohaError("video_send_failed", "The owned video transport declined a send.", 502);
          return true;
        },
        close: cleanup,
      });
    } catch (error) {
      if (ticket.descriptor) await cleanup();
      else this.#videos.delete(ticket);
      throw error;
    }
  }

  async closeVideos() {
    const results = await Promise.allSettled([...this.#videos].map((ticket) => ticket.cleanup()));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  async invokeAction(name, input = {}, options = {}) {
    switch (name) {
      case "list_devices": return this.listDevices();
      case "get_device_catalog": return this.catalog();
      case "create_device": return this.create(input, { selectCreated: true });
      case "get_selected_device": return this.getSelected();
      case "select_device": return this.select(input.deviceId, input);
      case "get_device": return this.getDevice(input.deviceId);
      case "get_display_geometry": return this.display(input.deviceId);
      case "boot_device": return this.lifecycle("boot", input.deviceId);
      case "shutdown_device": return this.lifecycle("shutdown", input.deviceId);
      case "restart_device": return this.lifecycle("restart", input.deviceId);
      case "erase_device": return this.lifecycle("erase", input.deviceId, input, options);
      case "delete_device": return this.lifecycle("delete", input.deviceId, input, options);
      case "tap_device": return this.input("tap", input.deviceId, input);
      case "long_press_device": return this.input("tap", input.deviceId, { ...input, duration: input.duration ?? 1 });
      case "swipe_device": return this.input("swipe", input.deviceId, input);
      case "list_apps": return this.listApps(input.deviceId, input);
      case "launch_app": return this.launchApp(input.deviceId, input.bundleId, input.relaunch ?? false, input.arguments ?? []);
      case "terminate_app": return this.terminateApp(input.deviceId, input.bundleId);
      case "install_app": return this.installApp(input.deviceId, input.path, options);
      case "uninstall_app": return this.uninstallApp(input.deviceId, input.bundleId, input.confirm ?? false, options);
      case "list_app_ops": return this.listAppOps(input.deviceId, input.bundleId);
      case "set_app_op": return this.setAppOp(input.deviceId, input.bundleId, input.operation, input.mode ?? "allow", options);
      case "take_screenshot": {
        if (!this.#saveScreenshot) unsupported("Persistent screenshot artifacts");
        const { invocation, bytes } = await this.screenshot(input.deviceId);
        return this.#saveScreenshot(bytes, input, invocation);
      }
      default: unsupported(name);
    }
  }

  async request(path, { method = "GET", body, signal } = {}) {
    try {
      this.#requireOpen();
      if (!path.startsWith("/api/v1/") || /[\\#]/.test(path)) {
        throw new MobileAilohaError("invalid_request", "Mobile Canvas accepts only named compatibility API paths.", 400);
      }
      const queryIndex = path.indexOf("?");
      const route = queryIndex < 0 ? path : path.slice(0, queryIndex);
      const query = new URLSearchParams(queryIndex < 0 ? "" : path.slice(queryIndex + 1));
      if (queryIndex >= 0 && (!/^\/api\/v1\/devices\/[^/]+\/(?:apps|app-ops|apps\/[^/]+\/uninstall)$/.test(route)
        || [...query.keys()].some((key) => !["text", "system", "limit", "bundleId", "confirm"].includes(key))
        || [...query.keys()].some((key) => query.getAll(key).length !== 1))) {
        throw new MobileAilohaError("invalid_request", "Unsupported app compatibility query.", 400);
      }
      const input = requestBody(body);
      if (method === "GET" && path === "/api/v1/status") return json(await this.ready());
      if (method === "GET" && path === "/api/v1/catalog") return json(await this.catalog());
      if (method === "GET" && path === "/api/v1/devices") return json(await this.listDevices());
      if (method === "POST" && path === "/api/v1/devices") {
        return json(await this.create({
          ...input, ...(!Object.hasOwn(input, "platform") ? { platform: "ios" } : {}),
        }, { selectCreated: true }));
      }
      if (method === "GET" && path === "/api/v1/selection") return json(await this.getSelected());
      if (method === "POST" && path === "/api/v1/selection") return json(await this.select(input.deviceId, input));
      if (method === "POST" && path === "/api/v1/canvas/detach") {
        this.#detached = true;
        this.#generation += 1;
        this.cancelPendingApprovals();
        await this.closeVideos();
        await this.#selectionStore.clear();
        await this.dispose();
        return new Response(null, { status: 204 });
      }
      const match = /^\/api\/v1\/devices\/([^/]+)(?:\/(.*))?$/.exec(route);
      if (!match) unsupported(path);
      let deviceId;
      try { deviceId = decodeURIComponent(match[1]); }
      catch { throw new MobileAilohaError("invalid_request", "Device selector must be a valid escaped opaque ID.", 400); }
      const operation = match[2] ?? "";
      if (method === "GET" && operation === "") return json(await this.getDevice(deviceId));
      if (method === "GET" && operation === "display") return json(await this.display(deviceId));
      if (method === "GET" && operation === "apps") {
        const system = query.get("system");
        if (system !== null && !["true", "false"].includes(system)) {
          throw new MobileAilohaError("invalid_request", "The system filter must be a boolean.", 400);
        }
        const limit = query.get("limit");
        if (limit !== null && !/^-?\d+$/.test(limit)) {
          throw new MobileAilohaError("invalid_request", "The app limit must be an integer.", 400);
        }
        return json(await this.listApps(deviceId, {
          text: query.get("text"), includeSystem: system === "true",
          limit: limit === null ? 100 : Number(limit),
        }));
      }
      if (method === "POST" && operation === "apps/launch") {
        return json(await this.launchApp(deviceId, input.bundleId, input.relaunch ?? false, input.arguments ?? []));
      }
      if (method === "POST" && operation === "apps/install") return json(await this.installApp(deviceId, input.path, { signal }));
      const appAction = /^apps\/([^/]+)\/(terminate|uninstall)$/.exec(operation);
      if (method === "POST" && appAction) {
        let bundleId;
        try { bundleId = decodeURIComponent(appAction[1]); }
        catch { throw new MobileAilohaError("invalid_request", "App selector must be escaped.", 400); }
        return json(appAction[2] === "terminate"
          ? await this.terminateApp(deviceId, bundleId)
          : await this.uninstallApp(deviceId, bundleId, query.get("confirm") === "true", { signal }));
      }
      if (method === "GET" && operation === "app-ops") {
        return json(await this.listAppOps(deviceId, query.get("bundleId")));
      }
      if (method === "POST" && operation === "app-ops") {
        return json(await this.setAppOp(deviceId, input.bundleId, input.operation, input.mode ?? "allow", { signal }));
      }
      if (method === "GET" && operation === "screenshot") {
        const { bytes } = await this.screenshot(deviceId);
        return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
      }
      if (method === "DELETE" && operation === "") return json(await this.lifecycle("delete", deviceId, input, { signal }));
      if (method === "POST" && Object.hasOwn(LIFECYCLE, operation)) return json(await this.lifecycle(operation, deviceId, input, { signal }));
      if (method === "POST" && operation.startsWith("input/")) return json(await this.input(operation.slice(6), deviceId, input));
      unsupported(operation || path);
    } catch (error) {
      const result = mobileErrorResult(error);
      this.#reportError(result);
      return json(result, result.status);
    }
  }

  dispose() {
    if (this.#closing) return this.#closing;
    this.#disposed = true;
    this.#generation += 1;
    this.#lifetime.abort();
    this.#consent.dispose();
    this.#unsubscribeContext?.();
    this.#closing = (async () => {
      await this.closeVideos();
      await this.#owner.release();
      this.#client.dispose();
    })().catch((error) => {
      this.#closing = undefined;
      throw error;
    });
    return this.#closing;
  }
}
