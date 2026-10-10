import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AilohaProtocolError, TARGET_HOST_PROFILE } from "./index.mjs";
import { captureCreateInput, loadMobileCatalog, resolveCreateChoice } from "./mobile-catalog.mjs";
import { isOpaqueId } from "./protocol.mjs";
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

export function mobileErrorResult(error) {
  const operationMetadata = {
    ...(isOpaqueId(error?.operationId) ? { operationId: error.operationId } : {}),
    ...(error?.operation ? { operation: error.operation } : {}),
    ...(isOpaqueId(error?.createdTargetId) ? { createdTargetId: error.createdTargetId } : {}),
  };
  if (error instanceof MobileAilohaError) {
    return {
      code: error.code, message: error.message, status: error.status,
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

function unsupported(operation) {
  throw new MobileAilohaError(
    "capability_not_supported",
    `${operation} is not supported by this Ailoha opt-in or the selected target's advertised capabilities.`,
    501,
  );
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

function capturedInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Object.getOwnPropertySymbols(input).length
    || Object.getOwnPropertyNames(input).some((key) =>
      !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), "value"))) {
    throw new MobileAilohaError("invalid_request", "Control input must be a plain JSON object.", 400);
  }
  const snapshot = publicSnapshot(input);
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 64 * 1024) {
    throw new MobileAilohaError("invalid_request", "Control input exceeds its bounded JSON contract.", 400);
  }
  return snapshot;
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

function requireNotCancelled(signal) {
  if (signal?.aborted) throw new AilohaProtocolError("cancelled");
}

function waitForCreationCaller(promise, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(new AilohaProtocolError("cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

// The media and selectionStore arguments are Mobile Canvas-owned adapters, not an upstream SDK schema.
export class AilohaMobileBackend {
  #scope;
  #owner;
  #client;
  #media;
  #controls;
  #selectionStore;
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
    scope, owner, client, media, controls, selectionStore, confirmDestructive, saveScreenshot,
    videoState = {}, operationState = new Map(), onEvent = () => {}, onError = () => {},
  }) {
    this.#scope = publicSnapshot({ sessionId: scope.sessionId, viewId: scope.viewId });
    this.#client = client;
    this.#media = media;
    this.#controls = controls;
    this.#selectionStore = selectionStore;
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
    if (surface && this.#media) Object.assign(supported, this.#media.supported(capabilities, surface));
    if (this.#controls) Object.assign(supported, this.#controls.supported(capabilities, surface));
    const device = projectMobileTarget({ hostId: this.#owner.hostId, target, provider, supported, surfaceId });
    return { target, provider, capabilities, device };
  }

  async #inventory(snapshot, options = this.#options()) {
    this.#requireOpen();
    requireNotCancelled(options.signal);
    snapshot ??= await this.#selectionStore.readSnapshot(options);
    this.#requireSnapshot(snapshot);
    const { selection } = snapshot;
    if (selection && selection.targetHostId !== this.#owner.hostId) {
      throw new MobileAilohaError("host_selection_mismatch", "This view context now belongs to another Ailoha Target Host.");
    }
    const [targets, providers] = await Promise.all([
      this.#client.listTargets(options),
      this.#client.listProviders(options),
    ]);
    requireNotCancelled(options.signal);
    const devices = [];
    for (const target of targets) {
      const provider = providers.find((entry) => entry.providerId === target.providerId);
      if (!provider) throw new MobileAilohaError("provider_unavailable", "An Ailoha target has no matching inventory provider.");
      const capabilities = ["unavailable", "disabled"].includes(provider.state)
        ? [] : await this.#client.getTargetCapabilities(target.targetId, options);
      requireNotCancelled(options.signal);
      const supported = Object.fromEntries(Object.entries(LIFECYCLE).map(([name, [operation]]) => [
        name, hasOperation(capabilities, operation, "target.lifecycle")
          && (!(name === "erase" || name === "delete") || this.#consent.supported),
      ]));
      const selectedSurfaceId = selection?.targetHostId === this.#owner.hostId && selection.targetId === target.targetId
        ? selection.surfaceId : undefined;
      const surface = selectedSurfaceId !== undefined
        ? target.surfaces.find((entry) => entry.surfaceId === selectedSurfaceId)
        : target.surfaces.length === 1 ? target.surfaces[0] : undefined;
      if (surface && this.#media) {
        Object.assign(supported, this.#media.supported(capabilities, surface));
      }
      if (this.#controls) Object.assign(supported, this.#controls.supported(capabilities, surface));
      devices.push(projectMobileTarget({ hostId: this.#owner.hostId, target, provider, supported, surfaceId: selectedSurfaceId }));
    }
    this.#requireSnapshot(snapshot);
    return { devices, providers };
  }

  async listDevices() { return (await this.#inventory()).devices; }

  async catalog() {
    return this.#catalog(await this.#selectionStore.readSnapshot());
  }

  async #catalog(snapshot, options = this.#options()) {
    const { devices, providers } = await this.#inventory(snapshot, options);
    const result = await loadMobileCatalog({
      hostId: this.#owner.hostId, client: this.#client, providers, devices, options,
    });
    requireNotCancelled(options.signal);
    this.#requireSnapshot(snapshot);
    return result;
  }

  async create(input, { selectCreated = false, signal } = {}) {
    this.#requireOpen();
    const callerSignal = this.#options(signal).signal;
    requireNotCancelled(callerSignal);
    const captured = captureCreateInput(input);
    // Compatibility choices already capture the host/provider; a replacement owner cannot rekey this intent.
    const key = JSON.stringify(["create", captured.platform, captured.name, captured.runtimeId, captured.deviceTypeId]);
    let receipt = this.#operationState.get(key);
    if (receipt) this.#requireInvocationOwner(receipt.invocation);
    let preparation;
    if (!receipt) {
      preparation = this.#creationPreparations.get(key);
      if (!preparation) {
        if (this.#creationPreparations.size + this.#operationState.size >= 64) {
          throw new MobileAilohaError("operation_receipt_limit", "The bounded creation intent/operation pool is full.", 429);
        }
        preparation = { controller: new AbortController(), callers: new Set(), promise: null, receipt: null };
        this.#creationPreparations.set(key, preparation);
      }
    }
    const caller = { selectCreated };
    let callers = receipt ? receipt.callers ??= new Set() : preparation.callers;
    callers.add(caller);
    let counted = false;
    const removeCaller = () => {
      callers.delete(caller);
      if (!callers.size) {
        if (preparation && callers === preparation.callers) preparation.controller.abort();
        if (receipt && callers === receipt.callers) receipt.submissionController?.abort();
      }
      if (preparation && !preparation.receipt && !preparation.callers.size
        && this.#creationPreparations.get(key) === preparation) this.#creationPreparations.delete(key);
    };
    callerSignal.addEventListener("abort", removeCaller, { once: true });
    try {
      if (!receipt) {
        if (!preparation.promise) {
          preparation.promise = this.#prepareCreation(key, captured, selectCreated, preparation);
          const release = () => {
            if (this.#creationPreparations.get(key) === preparation) this.#creationPreparations.delete(key);
          };
          preparation.promise.then(release, release);
        }
        receipt = await waitForCreationCaller(preparation.promise, callerSignal);
        if (receipt.callers !== callers) {
          callers.delete(caller);
          callers = receipt.callers ??= new Set();
          callers.add(caller);
        }
      }
      requireNotCancelled(callerSignal);
      this.#requireInvocationOwner(receipt.invocation);
      if (captured.platform !== undefined && captured.platform !== receipt.invocation.platform) {
        throw new MobileAilohaError("incompatible_catalog_choice", "The creation retry cannot replace its captured platform.", 400);
      }
      receipt.users += 1;
      counted = true;
      let pending = receipt.confirming;
      if (!pending) {
        receipt.confirmingSettled = false;
        pending = this.#completeCreation(key, receipt);
        receipt.confirming = pending;
        pending.then(() => {
          if (receipt.confirming !== pending) return;
          receipt.confirmingSettled = true;
          if (!receipt.callers.size) receipt.confirming = null;
        }, () => {
          if (receipt.confirming === pending) receipt.confirming = null;
        });
      }
      const result = await waitForCreationCaller(pending, callerSignal);
      requireNotCancelled(callerSignal);
      receipt.verified = true;
      return result;
    } catch (error) {
      receipt ??= preparation?.receipt;
      const operation = error.operation ?? receipt?.completed ?? receipt?.accepted;
      if (receipt?.operationId) error.operationId = receipt.operationId;
      if (operation) error.operation = operation;
      if (receipt && error.code !== "operation_owner_mismatch" && operation?.operationId === receipt.operationId
        && operation.kind === "createTarget" && operation.providerId === receipt.invocation.providerId
        && isOpaqueId(operation.targetId)) error.createdTargetId = operation.targetId;
      throw error;
    } finally {
      callerSignal.removeEventListener("abort", removeCaller);
      removeCaller();
      if (counted) receipt.users -= 1;
      if (receipt?.verified && receipt.users === 0 && !receipt.callers.size) {
        releaseOperationReceipt(this.#operationState, key, receipt);
      } else if (receipt?.confirmingSettled && !receipt.callers.size) receipt.confirming = null;
    }
  }

  async #prepareCreation(key, captured, selectCreated, preparation) {
    const options = this.#options(preparation.controller.signal);
    const connectionRef = this.#owner.connectionRef;
    const generation = this.#generation;
    requireNotCancelled(options.signal);
    const snapshot = await this.#selectionStore.readSnapshot(options);
    requireNotCancelled(options.signal);
    this.#requireSnapshot(snapshot);
    const choice = resolveCreateChoice(await this.#catalog(snapshot, options), captured);
    const invocation = { ...publicSnapshot({
      scope: this.#scope, targetHostId: this.#owner.hostId, platform: choice.platform,
      ...choice.request, selectionGeneration: generation,
      ...(snapshot.contextProjection ? { executionContext: snapshot.contextProjection } : {}),
    }) };
    Object.defineProperty(invocation, "connectionRef", { value: connectionRef });
    Object.freeze(invocation);
    // Revalidate, but never replace the original selection/identity captured before catalog reads.
    await this.#selectionStore.readSnapshot(options);
    requireNotCancelled(options.signal);
    this.#requireOpen();
    this.#requireInvocationOwner(invocation);
    const receipt = submitOperationReceipt({
      state: this.#operationState, key, kind: "createTarget", invocation,
      requireCurrent: () => {
        requireNotCancelled(options.signal);
        this.#requireSnapshot(snapshot);
        if (generation !== this.#generation) {
          throw new MobileAilohaError("selection_superseded", "The view changed before creation could be submitted.");
        }
      },
      submit: () => this.#client.createTarget(choice.request, options),
    });
    preparation.receipt = receipt;
    this.#requireInvocationOwner(receipt.invocation);
    if (receipt.invocation === invocation) {
      Object.assign(receipt, {
        request: choice.request, contextSnapshot: snapshot, selectionOwner: this, selectCreated, users: 0,
        callers: preparation.callers, submissionController: preparation.controller,
      });
    }
    if (this.#creationPreparations.get(key) === preparation) this.#creationPreparations.delete(key);
    // Observe fast submission failures before asynchronous preparation hands off the receipt.
    await receipt.submitted;
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
    if (![...receipt.callers].some((caller) => caller.selectCreated)) return false;
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
          receipt = { kind: method, invocation, operationId: null, submitted: null, uncertain: false, completed: null, accepted: null };
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
              captured.accepted = accepted;
            } catch (error) {
              if (!invoked) {
                releaseOperationReceipt(this.#operationState, key, captured);
                throw error;
              }
              if (error instanceof AilohaProtocolError && error.status === 202 && error.operationId) {
                captured.operationId = error.operationId;
                return;
              }
              if (definitiveOperationRejection(error)) releaseOperationReceipt(this.#operationState, key, captured);
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
    if (!["tap", "swipe", "key", "button", "text", "rotate"].includes(kind)) unsupported(`Input ${kind}`);
    input = capturedInput(input);
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
    const geometric = kind === "tap" || kind === "swipe";
    const geometry = geometric ? assertObservedGeometry(invocation, observed) : invocation.geometry;
    if (!geometric && ["surfaceId", "geometryRevision", "coordinate"].some((key) => Object.hasOwn(input, key))) {
      assertObservedGeometry(invocation, observed);
    }
    if (invocation.selectionGeneration !== this.#generation) {
      throw new MobileAilohaError("stale_selection", "A canvas selection changed before this input could be dispatched.");
    }
    if (!device.capabilities[kind] || (geometric ? !this.#media : !this.#controls)) unsupported(`Input ${kind}`);
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
    } else if (kind === "key") {
      payload = input.keyCode;
    } else if (kind === "button") {
      payload = input.button;
    } else if (kind === "text") {
      payload = input.text;
    } else if (kind === "rotate") {
      payload = input.orientation;
    }
    if (geometric) await this.#media[kind](invocation, publicSnapshot(payload));
    else {
      if (kind === "rotate") this.#observations.delete(deviceId);
      await this.#controls[kind](invocation, payload, () => {
        this.#requireSnapshot(contextSnapshot);
        if (invocation.selectionGeneration !== this.#generation) {
          throw new MobileAilohaError("selection_superseded", "The view changed before focused text could be dispatched.");
        }
      });
    }
    return publicSnapshot({ success: true, operation: kind, deviceId, context: invocation });
  }

  async presentation(deviceId, input) {
    if (input !== undefined) input = capturedInput(input);
    const { invocation, capabilities, device, contextSnapshot } = await this.#capture(deviceId);
    if (!device.capabilities.presentation || !this.#controls
      || (input !== undefined && !hasOperation(capabilities, "updateTargetSettings", "target.settings"))) {
      unsupported("Status-bar presentation");
    }
    this.#requireSnapshot(contextSnapshot);
    return this.#controls.presentation(invocation, input);
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
      case "create_device": return this.create(input, { selectCreated: true, signal: options.signal });
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
      case "type_text": return { ...await this.input("text", input.deviceId, input), operation: "type-text" };
      case "press_key": return { ...await this.input("key", input.deviceId, input), operation: "press-key" };
      case "press_button": return { ...await this.input("button", input.deviceId, input), operation: "press-button" };
      case "rotate_device": return this.input("rotate", input.deviceId, input);
      case "presentation_get": return this.presentation(input.deviceId);
      case "presentation_set": return this.presentation(input.deviceId, Object.fromEntries(
        Object.entries(input).filter(([key]) => key !== "deviceId")));
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
      if (!path.startsWith("/api/v1/") || /[\\?#]/.test(path)) {
        throw new MobileAilohaError("invalid_request", "Mobile Canvas accepts only named compatibility API paths.", 400);
      }
      const input = requestBody(body);
      if (method === "GET" && path === "/api/v1/status") return json(await this.ready());
      if (method === "GET" && path === "/api/v1/catalog") return json(await this.catalog());
      if (method === "GET" && path === "/api/v1/devices") return json(await this.listDevices());
      if (method === "POST" && path === "/api/v1/devices") {
        return json(await this.create({
          ...input, ...(!Object.hasOwn(input, "platform") ? { platform: "ios" } : {}),
        }, { selectCreated: true, signal }));
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
      const match = /^\/api\/v1\/devices\/([^/]+)(?:\/(.*))?$/.exec(path);
      if (!match) unsupported(path);
      let deviceId;
      try { deviceId = decodeURIComponent(match[1]); }
      catch { throw new MobileAilohaError("invalid_request", "Device selector must be a valid escaped opaque ID.", 400); }
      const operation = match[2] ?? "";
      if (method === "GET" && operation === "") return json(await this.getDevice(deviceId));
      if (method === "GET" && operation === "display") return json(await this.display(deviceId));
      if (method === "GET" && operation === "presentation") return json(await this.presentation(deviceId));
      if (method === "POST" && operation === "presentation") return json(await this.presentation(deviceId, input));
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
