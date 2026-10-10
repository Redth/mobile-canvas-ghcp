import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { AilohaProtocolError, TARGET_HOST_PROFILE } from "./index.mjs";
import { createAilohaDeviceFeatures } from "./device-features.mjs";
import { captureCreateInput, loadMobileCatalog, resolveCreateChoice } from "./mobile-catalog.mjs";
import { isOpaqueId } from "./protocol.mjs";
import {
  isDefinitivePreAcceptanceRejection,
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
const FEATURES = Object.freeze({
  hardware_get: ["getTargetHardware", "target.hardware"],
  battery_set: ["updateTargetBattery", "target.battery"],
  network_set: ["updateTargetNetwork", "target.network"],
  location_set: ["updateTargetLocation", "target.location"],
  calls: ["getTargetTelephony", "target.telephony"],
  call: ["controlTargetCall", "target.telephony"],
  clipboard_get: ["getTargetClipboard", "target.clipboard"],
  clipboard_set: ["updateTargetClipboard", "target.clipboard"],
  settings_get: ["getTargetSettings", "target.settings"],
  settings_set: ["updateTargetSettings", "target.settings"],
  location_clear: ["clearTargetLocation", "target.location"],
  sms_send: ["simulateTargetSms", "target.telephony"],
  biometric: ["simulateTargetBiometricResult", "target.biometrics"],
  notification_push: ["sendTargetPushNotification", "target.push"],
  permission_list: ["listTargetPermissions", "target.permissions"],
  permission_set: ["updateTargetPermission", "target.permissions"],
});
const FEATURE_FIELDS = Object.freeze({
  hardware_get: [], battery_set: ["level", "state"], network_set: ["profile", "latencyMs"],
  location_set: ["latitude", "longitude"], clipboard_get: [], clipboard_set: ["text"], settings_get: [],
  calls: [], call: ["action", "number"],
  settings_set: ["appearance", "fontScale", "contentSize", "increaseContrast"],
  location_clear: [], sms_send: ["from", "body"], biometric: ["action", "fingerId"],
  notification_push: ["bundleId", "payload"],
  permission_list: ["bundleId"], permission_set: ["bundleId", "permission", "action"],
});
const PUT_FEATURES = new Set(["battery_set", "network_set", "location_set", "clipboard_set", "permission_set"]);
const NATIVE_FIDELITY_FEATURES = new Set(["calls", "call", "permission_list", "permission_set"]);

function captureFeatureInput(name, deviceId, input) {
  const fields = FEATURE_FIELDS[name];
  if (!fields || !input || typeof input !== "object" || Array.isArray(input)
    || (Object.hasOwn(input, "deviceId") && input.deviceId !== deviceId)
    || Object.keys(input).some((field) => field !== "deviceId" && !fields.includes(field))) {
    throw new MobileAilohaError("invalid_request", "This device feature has invalid or mismatched arguments.", 400);
  }
  const captured = Object.fromEntries(fields.filter((field) => input[field] != null)
    .map((field) => [field, input[field]]));
  if (name === "battery_set") {
    if (!Object.keys(captured).length
      || (captured.level !== undefined && (!Number.isSafeInteger(captured.level)
        || captured.level < 0 || captured.level > 100))
      || (captured.state !== undefined
        && (typeof captured.state !== "string"
          || !["charging", "discharging", "full"].includes(captured.state.trim().toLowerCase())))) {
      throw new MobileAilohaError("invalid_request", "Battery requires a charge percentage or supported state.", 400);
    }
    if (captured.state !== undefined) captured.state = captured.state.trim().toLowerCase();
  }
  if (name === "network_set") {
    if (!Object.keys(captured).length
      || (captured.profile !== undefined && typeof captured.profile !== "string")
      || (captured.latencyMs !== undefined && (!Number.isSafeInteger(captured.latencyMs)
        || captured.latencyMs < 0 || captured.latencyMs > 60_000))) {
      throw new MobileAilohaError("invalid_request", "Network requires a profile or supported latency.", 400);
    }
    if (captured.profile !== undefined) captured.profile = captured.profile.trim().toLowerCase();
  }
  if (name === "location_set" && (!Number.isFinite(captured.latitude)
    || captured.latitude < -90 || captured.latitude > 90
    || !Number.isFinite(captured.longitude) || captured.longitude < -180 || captured.longitude > 180)) {
    throw new MobileAilohaError("invalid_request", "Location requires valid latitude and longitude.", 400);
  }
  if (name === "clipboard_set" && (typeof captured.text !== "string"
    || Buffer.byteLength(captured.text) > 60 * 1024)) {
    throw new MobileAilohaError("invalid_request", "Clipboard requires bounded text.", 400);
  }
  if (name === "call") {
    const action = typeof captured.action === "string" ? captured.action.trim().toLowerCase() : null;
    if (captured.number === null) captured.number = undefined;
    const number = typeof captured.number === "string" ? captured.number.trim() : null;
    if (!["place", "accept", "hold", "cancel"].includes(action)
      || (captured.number !== undefined && (!number || captured.number.length > 64))
      || (action === "place" && !number)) {
      throw new MobileAilohaError("invalid_request", "Call control requires a valid action and number for place.", 400);
    }
    captured.action = action;
    if (captured.number !== undefined) captured.number = number;
  }
  if (name === "permission_list" || name === "permission_set") {
    if (typeof captured.bundleId !== "string" || !isOpaqueId(captured.bundleId.trim())
      || Buffer.byteLength(captured.bundleId) > 512
      || (name === "permission_set" && (typeof captured.permission !== "string"
        || !isOpaqueId(captured.permission.trim())
        || Buffer.byteLength(captured.permission) > 512
        || (captured.action !== undefined
          && (typeof captured.action !== "string"
            || !["grant", "revoke", "reset"].includes(captured.action.trim().toLowerCase())))))) {
      throw new MobileAilohaError("invalid_request", "Permission requires a native app package, name and supported action.", 400);
    }
    captured.bundleId = captured.bundleId.trim();
    if (name === "permission_set") {
      captured.permission = captured.permission.trim();
      captured.action = captured.action === undefined ? "grant" : captured.action.trim().toLowerCase();
    }
  }
  if (name === "settings_set") {
    if (!Object.keys(captured).length || (captured.appearance !== undefined
      && (typeof captured.appearance !== "string"
        || !["light", "dark"].includes(captured.appearance.trim().toLowerCase())))
      || (captured.fontScale !== undefined && (typeof captured.fontScale !== "number"
        || !Number.isFinite(captured.fontScale) || captured.fontScale <= 0 || captured.fontScale > 10))
      || (captured.contentSize !== undefined && typeof captured.contentSize !== "string")
      || (captured.increaseContrast !== undefined && typeof captured.increaseContrast !== "boolean")) {
      throw new MobileAilohaError("invalid_request", "Name valid device settings to change.", 400);
    }
    if (captured.appearance !== undefined) captured.appearance = captured.appearance.trim().toLowerCase();
  }
  if (name === "sms_send" && (typeof captured.from !== "string" || captured.from.length < 1 || captured.from.length > 64
    || typeof captured.body !== "string" || captured.body.length < 1 || captured.body.length > 4096)) {
    throw new MobileAilohaError("invalid_request", "SMS requires a sender (1..64) and body (1..4096).", 400);
  }
  if (name === "biometric" && (!["match", "nomatch"].includes(captured.action)
    || (captured.fingerId !== undefined && (!Number.isSafeInteger(captured.fingerId) || captured.fingerId < 0)))) {
    throw new MobileAilohaError("invalid_request", "Biometric action and optional finger must be valid.", 400);
  }
  if (name === "notification_push") {
    if (!isOpaqueId(captured.bundleId) || typeof captured.payload !== "string"
      || Buffer.byteLength(captured.payload) > 4096) {
      throw new MobileAilohaError("invalid_request", "Push requires an installed app package and bounded APNs JSON.", 400);
    }
    let payload;
    try { payload = JSON.parse(captured.payload); }
    catch { throw new MobileAilohaError("invalid_request", "APNs payload must be JSON.", 400); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Object.hasOwn(payload, "aps")
      || Buffer.byteLength(JSON.stringify(payload)) > 4096) {
      throw new MobileAilohaError("invalid_request", "APNs payload must be an object containing aps within 4096 bytes.", 400);
    }
    captured.payload = payload;
  }
  return publicSnapshot(captured);
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

export function unavailableUiContract() {
  throw new MobileAilohaError("ui_contract_unavailable",
    "The canonical System tree does not preserve the legacy raw payload, nullable frame and complete query evidence; UI compatibility is unavailable.", 501);
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
  #features;
  #featureState;
  #reveal;
  #revealState;
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
    scope, owner, client, media, features, featureState = new Map(), reveal, revealState = new Map(),
    selectionStore, confirmDestructive, saveScreenshot,
    videoState = {}, operationState = new Map(), onEvent = () => {}, onError = () => {},
  }) {
    this.#scope = publicSnapshot({ sessionId: scope.sessionId, viewId: scope.viewId });
    this.#client = client;
    this.#media = media;
    this.#features = features;
    this.#featureState = featureState;
    this.#reveal = reveal;
    this.#revealState = revealState;
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
    supported.reveal = Boolean(this.#reveal && hasOperation(capabilities, "revealTarget", "target.lifecycle"));
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
      supported.reveal = Boolean(this.#reveal && hasOperation(capabilities, "revealTarget", "target.lifecycle"));
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
      this.#creationPreparations.delete(key);
    }
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

  async #capture(deviceId, needSurface = false, observed, signal) {
    const generation = this.#generation;
    const contextSnapshot = await this.#selectionStore.readSnapshot();
    this.#requireSnapshot(contextSnapshot);
    const { selection } = contextSnapshot;
    if (selection && selection.targetHostId !== this.#owner.hostId) {
      throw new MobileAilohaError("host_selection_mismatch", "The named context belongs to another Target Host.");
    }
    const surfaceId = selection?.targetId === deviceId ? selection.surfaceId : observed?.surfaceId;
    const record = await this.#record(deviceId, surfaceId, this.#options(signal));
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

  async #verifyFeatureTarget(invocation, signal) {
    const target = await this.#client.getTarget(invocation.targetId, this.#options(signal));
    this.#requireInvocationOwner(invocation);
    if (target.providerId !== invocation.providerId
      || target.nativeIdentity?.nativeId !== invocation.nativeIdentity.nativeId
      || target.nativeIdentity?.platform !== invocation.nativeIdentity.platform
      || target.nativeIdentity?.isVirtual !== true) {
      throw new MobileAilohaError("operation_owner_mismatch",
        "The feature target changed its captured provider or native deployment identity.", 502);
    }
  }

  async reveal(deviceId, { selectRevealed = false } = {}) {
    const key = JSON.stringify([this.#owner.hostId, deviceId, "reveal"]);
    const previous = this.#revealState.get(key);
    if (previous) {
      this.#requireInvocationOwner(previous.invocation);
      if (previous.completed) return this.#confirmReveal(key, previous);
      throw new MobileAilohaError("reveal_outcome_uncertain",
        "The original reveal was submitted; it will not be rebound or replayed.", 409);
    }
    const { invocation, capabilities, contextSnapshot, provider, device } = await this.#capture(deviceId);
    if (!this.#reveal || !hasOperation(capabilities, "revealTarget", "target.lifecycle")
      || !device.isAvailable || device.targetStatus !== "running") unsupported("Reveal");
    await this.#selectionStore.readSnapshot();
    this.#requireSnapshot(contextSnapshot);
    this.#requireInvocationOwner(invocation);
    if (invocation.selectionGeneration !== this.#generation) {
      throw new MobileAilohaError("selection_superseded", "The view changed before reveal was submitted.");
    }
    if (this.#revealState.size >= 64) {
      throw new MobileAilohaError("reveal_receipt_limit", "The bounded reveal intent pool is full.", 429);
    }
    const competing = this.#revealState.get(key);
    if (competing) {
      this.#requireInvocationOwner(competing.invocation);
      if (competing.completed) return this.#confirmReveal(key, competing);
      throw new MobileAilohaError("reveal_outcome_uncertain",
        "The original reveal was submitted; it will not be rebound or replayed.", 409);
    }
    const receipt = { invocation, contextSnapshot, provider, supported: device.capabilities, selectRevealed, selectionOwner: this, completed: null, confirming: null };
    this.#revealState.set(key, receipt);
    try {
      receipt.completed = publicSnapshot(await this.#reveal.reveal(invocation));
    } catch (error) {
      if (isDefinitivePreAcceptanceRejection(error)) releaseOperationReceipt(this.#revealState, key, receipt);
      throw error;
    }
    return this.#confirmReveal(key, receipt);
  }

  async #confirmReveal(key, receipt) {
    const pending = receipt.confirming ??= this.#completeReveal(key, receipt);
    try { return await pending; }
    finally { if (receipt.confirming === pending) receipt.confirming = null; }
  }

  async #completeReveal(key, receipt) {
    const { invocation, contextSnapshot, provider, supported, completed, selectRevealed } = receipt;
    this.#requireInvocationOwner(invocation);
    const result = projectMobileTarget({
      hostId: invocation.targetHostId, target: completed, provider,
      supported: { ...supported, reveal: true }, surfaceId: invocation.surfaceId,
    });
    await this.#selectionStore.readSnapshot();
    this.#requireSnapshot(contextSnapshot);
    this.#requireInvocationOwner(invocation);
    if (receipt.selectionOwner === this && invocation.selectionGeneration !== this.#generation) {
      throw new MobileAilohaError("selection_superseded", "The view changed during reveal; its result was not rebound.");
    }
    if (selectRevealed) {
      await this.#selectCreated({ target: completed, device: result }, receipt);
    }
    releaseOperationReceipt(this.#revealState, key, receipt);
    return result;
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

  async deviceFeature(name, deviceId, input = {}, { signal } = {}) {
    this.#requireOpen();
      const specification = FEATURES[name];
      if (!specification || !this.#features) unsupported(name);
      const capturedInput = captureFeatureInput(name, deviceId, input);
      const requireCaller = () => {
        if (signal?.aborted) {
          throw new MobileAilohaError("request_cancelled", "Feature request was cancelled before dispatch.", 400);
        }
      };
      const nativeNetwork = name === "network_set" && capturedInput.profile !== undefined;
      if (nativeNetwork && this.#features.supportsNativeFidelity !== true) unsupported(name);
      if (NATIVE_FIDELITY_FEATURES.has(name) && this.#features.supportsNativeFidelity !== true) unsupported(name);
      if (PUT_FEATURES.has(name) && !nativeNetwork && this.#features.supportsPut !== true) unsupported(name);
      const requiredOperation = nativeNetwork
        ? ["applyTargetNativeNetworkProfile", "target.network"] : specification;
      const key = JSON.stringify([this.#owner.hostId, deviceId, name, capturedInput]);
      let receipt = this.#featureState.get(key);
      if (receipt) this.#requireInvocationOwner(receipt.invocation);
      if (!receipt) {
        requireCaller();
        const captured = await this.#capture(deviceId, false, undefined, signal);
        requireCaller();
        const { invocation, device, capabilities, provider, contextSnapshot } = captured;
        this.#requireSnapshot(contextSnapshot);
        if (!device.isAvailable || device.targetStatus !== "running") unsupported(name);
        if (!invocation.nativeIdentity || !["ios", "android"].includes(invocation.nativeIdentity.platform)
          || !invocation.nativeIdentity.nativeId || invocation.nativeIdentity.isVirtual !== true) unsupported(name);
        if (!hasOperation(capabilities, ...requiredOperation)
          || !hasOperation(provider.capabilities, ...requiredOperation)) unsupported(name);
        if (name === "biometric" && invocation.nativeIdentity.platform !== "ios"
          && this.#features.supportsNativeFidelity !== true) unsupported(name);
        if (name === "network_set" && !nativeNetwork && invocation.nativeIdentity.platform !== "android") unsupported(name);
        if (name === "network_set" && nativeNetwork
          && invocation.nativeIdentity.platform === "ios" && capturedInput.latencyMs !== undefined) unsupported(name);
        if (["call", "calls"].includes(name) && invocation.nativeIdentity.platform !== "android") unsupported(name);
        if (["battery_set", "network_set"].includes(name)
          && (!hasOperation(capabilities, "getTargetHardware", "target.hardware")
            || !hasOperation(provider.capabilities, "getTargetHardware", "target.hardware"))) unsupported(name);
        if (name === "clipboard_set"
          && (!hasOperation(capabilities, "getTargetClipboard", "target.clipboard")
            || !hasOperation(provider.capabilities, "getTargetClipboard", "target.clipboard"))) unsupported(name);
        if ((name === "notification_push" || name.startsWith("permission_"))
          && ((name === "notification_push" && invocation.nativeIdentity.platform !== "ios")
            || !hasOperation(capabilities, "listTargetApps", "target.apps")
            || !hasOperation(provider.capabilities, "listTargetApps", "target.apps"))) unsupported(name);
        this.#requireInvocationOwner(invocation);
        if (["hardware_get", "clipboard_get", "settings_get", "calls"].includes(name)) {
          this.#requireSnapshot(contextSnapshot);
          const method = { hardware_get: "hardware", clipboard_get: "clipboard",
            settings_get: "settings", calls: "calls" }[name];
          const result = await this.#features[method](invocation);
          await this.#verifyFeatureTarget(invocation);
          this.#requireSnapshot(contextSnapshot);
          return result;
        }
        if (name === "permission_list") {
          const appId = await this.#features.resolveApp(invocation, capturedInput.bundleId, signal);
          await this.#verifyFeatureTarget(invocation);
          this.#requireSnapshot(contextSnapshot);
          const result = await this.#features.permissions(invocation, appId, capturedInput.bundleId);
          await this.#verifyFeatureTarget(invocation);
          this.#requireSnapshot(contextSnapshot);
          return result;
        }
        let body;
        switch (name) {
          case "settings_set":
          case "location_set": body = capturedInput; break;
          case "battery_set":
            body = {
              ...(capturedInput.level === undefined ? {} : { level: capturedInput.level / 100 }),
              ...(capturedInput.state === undefined ? {} : { state: capturedInput.state }),
            };
            break;
          case "network_set":
            body = nativeNetwork ? capturedInput : { latencyMs: capturedInput.latencyMs };
            break;
          case "clipboard_set": body = { contentType: "text/plain", text: capturedInput.text }; break;
          case "sms_send": body = { phoneNumber: capturedInput.from, message: capturedInput.body }; break;
          case "call":
            body = { action: capturedInput.action,
              ...(capturedInput.number === undefined ? {} : { phoneNumber: capturedInput.number }) };
            break;
          case "biometric":
            body = {
              result: capturedInput.action === "match" ? "success" : "failure",
              ...(this.#features.supportsNativeFidelity === true && capturedInput.fingerId !== undefined
                ? { fingerId: capturedInput.fingerId } : {}),
            };
            break;
        }
        const submittedBody = name === "notification_push"
          ? { appId: await this.#features.resolveApp(invocation, capturedInput.bundleId, signal),
            payload: capturedInput.payload }
          : name === "permission_set"
            ? { appId: await this.#features.resolveApp(invocation, capturedInput.bundleId, signal),
              permission: capturedInput.permission,
              status: { grant: "granted", revoke: "denied", reset: "unknown" }[capturedInput.action] }
            : body;
        await this.#verifyFeatureTarget(invocation, signal);
        this.#requireSnapshot(contextSnapshot);
        this.#requireInvocationOwner(invocation);
        requireCaller();
        receipt = this.#featureState.get(key);
        if (receipt) this.#requireInvocationOwner(receipt.invocation);
        if (!receipt && (name === "sms_send" || name === "biometric" || name === "call"
          || name === "notification_push" || nativeNetwork)) {
          receipt = submitOperationReceipt({
            state: this.#featureState, key, kind: requiredOperation[0], invocation,
            requireCurrent: () => {
              this.#requireInvocationOwner(invocation);
              this.#requireSnapshot(contextSnapshot);
            },
            submit: () => this.#features.submit(invocation,
              nativeNetwork ? "network/profiles/native"
                : name === "sms_send" ? "telephony/sms"
                : name === "call" ? "telephony/calls/actions"
                : name === "biometric" ? "biometrics/results" : "push/notifications",
              requiredOperation[0], submittedBody),
          });
          if (receipt.invocation === invocation) receipt.deadline = performance.now() + 60_000;
        } else if (!receipt) {
          if (this.#featureState.size >= 64) {
            throw new MobileAilohaError("operation_receipt_limit", "The bounded feature receipt pool is full.", 429);
          }
          receipt = { invocation, uncertain: false, deadline: performance.now() + 60_000 };
          this.#featureState.set(key, receipt);
          receipt.submitted = (async () => {
            try {
              if (name === "settings_set") await this.#features.patchSettings(invocation, body);
              else if (name === "battery_set") await this.#features.updateBattery(invocation, body);
              else if (name === "network_set") await this.#features.updateNetwork(invocation, body);
              else if (name === "location_set") await this.#features.updateLocation(invocation, body);
              else if (name === "clipboard_set") await this.#features.updateClipboard(invocation, body);
              else if (name === "permission_set") {
                receipt.affectedPermissions = await this.#features.updatePermission(invocation, submittedBody);
              }
              else await this.#features.clearLocation(invocation);
              receipt.completed = true;
            } catch (error) {
              if (isDefinitivePreAcceptanceRejection(error) && error.status !== 499) {
                releaseOperationReceipt(this.#featureState, key, receipt);
              }
              else receipt.uncertain = true;
              throw error;
            }
          })();
        }
      }
      this.#requireInvocationOwner(receipt.invocation);
      if (name === "sms_send" || name === "biometric" || name === "call"
        || name === "notification_push" || nativeNetwork) {
        const remaining = Math.max(0, receipt.deadline - performance.now());
        if (remaining === 0) throw new MobileAilohaError("feature_deadline_expired", "The captured feature operation exceeded its original deadline.", 504);
        const operation = await waitForOperationReceipt({
          state: this.#featureState, key, receipt, client: this.#client,
          options: { ...this.#options(), timeoutMs: Math.max(1, Math.ceil(remaining)) },
          retainTerminal: true, outcome: "feature",
          requireOwner: () => this.#requireInvocationOwner(receipt.invocation),
        });
        this.#requireInvocationOwner(receipt.invocation);
        if (operation.kind !== requiredOperation[0] || operation.status !== "succeeded"
          || (operation.targetId !== undefined && operation.targetId !== receipt.invocation.targetId)
          || (operation.providerId !== undefined && operation.providerId !== receipt.invocation.providerId)) {
          throw new MobileAilohaError("operation_owner_mismatch", "Feature completion changed its captured target/provider.", 502);
        }
        receipt.completed = operation;
        if (name === "biometric" && this.#features.supportsNativeFidelity === true
          && (operation.result?.action === undefined
            || (receipt.invocation.nativeIdentity.platform === "android"
              && operation.result.confirmed === undefined))) unsupported(name);
        if (name === "biometric" && this.#features.supportsNativeFidelity === true
          && (operation.result?.action !== capturedInput.action
            || (receipt.invocation.nativeIdentity.platform === "android"
              && typeof operation.result.confirmed !== "boolean")
            || (receipt.invocation.nativeIdentity.platform === "ios"
              && operation.result.confirmed !== undefined
              && operation.result.confirmed !== null))) {
          throw new MobileAilohaError("invalid_feature_response", "Native scan completion omitted its platform confirmation evidence.", 502);
        }
        if (nativeNetwork) {
          const resultContext = operation.result?.["x-ailoha-target-host"];
          if (operation.result?.networkIsIndicatorOnly === undefined) unsupported(name);
          if (typeof operation.result.networkIsIndicatorOnly !== "boolean"
            || resultContext?.targetId !== receipt.invocation.targetId
            || (resultContext.providerId !== undefined
              && resultContext.providerId !== receipt.invocation.providerId)) {
            throw new MobileAilohaError("invalid_feature_response", "Native network completion omitted its original indicator and target evidence.", 502);
          }
          await this.#verifyFeatureTarget(receipt.invocation);
          const readRemaining = Math.max(0, receipt.deadline - performance.now());
          if (readRemaining === 0) throw new MobileAilohaError("feature_deadline_expired", "The native profile readback exceeded its original deadline.", 504);
          const hardware = await this.#features.hardware(receipt.invocation,
            Math.max(1, Math.ceil(Math.min(readRemaining, 15_000))));
          await this.#verifyFeatureTarget(receipt.invocation);
          if (hardware.networkIsIndicatorOnly !== operation.result.networkIsIndicatorOnly) {
            throw new MobileAilohaError("invalid_feature_response",
              "Native profile completion disagreed with the captured hardware indicator.", 502);
          }
          releaseOperationReceipt(this.#featureState, key, receipt);
          return hardware;
        }
        if (name === "call") {
          const calls = this.#features.callResult(receipt.invocation, operation.result);
          await this.#verifyFeatureTarget(receipt.invocation);
          releaseOperationReceipt(this.#featureState, key, receipt);
          return calls;
        }
        await this.#verifyFeatureTarget(receipt.invocation);
        releaseOperationReceipt(this.#featureState, key, receipt);
        return name === "sms_send"
          ? publicSnapshot({ success: true, operation: "sms-send", deviceId })
          : name === "notification_push"
            ? publicSnapshot({ success: true, operation: "notification-push", deviceId: null })
          : publicSnapshot({ schemaVersion: "1.0", deviceId,
            platform: receipt.invocation.nativeIdentity.platform, action: capturedInput.action,
            confirmed: receipt.invocation.nativeIdentity.platform === "android" ? operation.result.confirmed : false });
      }
      if (receipt.uncertain) {
        throw new MobileAilohaError("feature_outcome_uncertain", "The captured feature mutation has an unknown outcome; it will not be submitted again.", 502);
      }
      await receipt.submitted;
      this.#requireInvocationOwner(receipt.invocation);
      await this.#verifyFeatureTarget(receipt.invocation);
      if (name === "location_clear") {
        releaseOperationReceipt(this.#featureState, key, receipt);
        return publicSnapshot({ success: true, operation: "location-clear", deviceId: null });
      }
      if (name === "location_set") {
        releaseOperationReceipt(this.#featureState, key, receipt);
        return publicSnapshot({ success: true, operation: "location-set", deviceId: null });
      }
      if (name === "permission_set") {
        const result = publicSnapshot({
          schemaVersion: "1.0", success: true, deviceId, bundleId: capturedInput.bundleId,
          permission: capturedInput.permission, action: capturedInput.action,
          permissions: receipt.affectedPermissions,
        });
        releaseOperationReceipt(this.#featureState, key, receipt);
        return result;
      }
      const remaining = Math.max(0, receipt.deadline - performance.now());
      if (remaining === 0) {
        throw new MobileAilohaError("feature_deadline_expired", "The captured feature readback exceeded its original deadline.", 504);
      }
      const timeoutMs = Math.max(1, Math.ceil(Math.min(remaining, 15_000)));
      const result = name === "settings_set"
        ? await this.#features.settings(receipt.invocation, timeoutMs)
        : name === "clipboard_set"
          ? await this.#features.clipboard(receipt.invocation, timeoutMs)
          : await this.#features.hardware(receipt.invocation, timeoutMs);
      await this.#verifyFeatureTarget(receipt.invocation);
      releaseOperationReceipt(this.#featureState, key, receipt);
      return result;
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
    const feature = (featureName) => this.deviceFeature(featureName, input.deviceId, input, options);
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
      case "reveal_device": return this.reveal(input.deviceId, { selectRevealed: true });
      case "ui_dump": case "ui_find": case "ui_tap":
        return unavailableUiContract();
      case "erase_device": return this.lifecycle("erase", input.deviceId, input, options);
      case "delete_device": return this.lifecycle("delete", input.deviceId, input, options);
      case "tap_device": return this.input("tap", input.deviceId, input);
      case "long_press_device": return this.input("tap", input.deviceId, { ...input, duration: input.duration ?? 1 });
      case "swipe_device": return this.input("swipe", input.deviceId, input);
      case "take_screenshot": {
        if (!this.#saveScreenshot) unsupported("Persistent screenshot artifacts");
        const { invocation, bytes } = await this.screenshot(input.deviceId);
        return this.#saveScreenshot(bytes, input, invocation);
      }
      case "get_hardware": return feature("hardware_get");
      case "set_battery": return feature("battery_set");
      case "set_network": return feature("network_set");
      case "set_location": return feature("location_set");
      case "get_clipboard": return feature("clipboard_get");
      case "set_clipboard": return feature("clipboard_set");
      case "get_settings": return feature("settings_get");
      case "set_settings": return feature("settings_set");
      case "clear_location": return feature("location_clear");
      case "send_sms": return feature("sms_send");
      case "get_calls": return feature("calls");
      case "send_call": return feature("call");
      case "send_biometric": return feature("biometric");
      case "push_notification": return feature("notification_push");
      case "list_permissions": return feature("permission_list");
      case "set_permission": return feature("permission_set");
      default: unsupported(name);
    }
  }

  async request(path, { method = "GET", body, signal } = {}) {
    try {
      this.#requireOpen();
      if (method === "GET"
        && /^\/api\/v1\/devices\/[^/]+\/ui\?raw=(?:true|false)$/.test(path)) {
        unavailableUiContract();
      }
      const permissionQuery = method === "GET"
        ? /^(\/api\/v1\/devices\/[^/]+\/permissions)\?bundleId=([^&#?]+)$/.exec(path) : null;
      const routePath = permissionQuery ? permissionQuery[1] : path;
      if (!routePath.startsWith("/api/v1/") || /[\\?#]/.test(routePath)) {
        throw new MobileAilohaError("invalid_request", "Mobile Canvas accepts only named compatibility API paths.", 400);
      }
      const input = requestBody(body);
      if (permissionQuery) {
        try { input.bundleId = decodeURIComponent(permissionQuery[2]); }
        catch { throw new MobileAilohaError("invalid_request", "Native package must be URL-encoded.", 400); }
      }
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
      const match = /^\/api\/v1\/devices\/([^/]+)(?:\/(.*))?$/.exec(routePath);
      if (!match) unsupported(path);
      let deviceId;
      try { deviceId = decodeURIComponent(match[1]); }
      catch { throw new MobileAilohaError("invalid_request", "Device selector must be a valid escaped opaque ID.", 400); }
      const operation = match[2] ?? "";
      if (operation === "ui" || operation === "ui/find" || operation === "ui/tap") {
        unavailableUiContract();
      }
      if (method === "GET" && operation === "") return json(await this.getDevice(deviceId));
      if (method === "GET" && operation === "display") return json(await this.display(deviceId));
      if (method === "GET" && operation === "screenshot") {
        const { bytes } = await this.screenshot(deviceId);
        return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
      }
      if (method === "DELETE" && operation === "") return json(await this.lifecycle("delete", deviceId, input, { signal }));
      if (method === "POST" && operation === "reveal") return json(await this.reveal(deviceId, { selectRevealed: true }));
      if (method === "POST" && Object.hasOwn(LIFECYCLE, operation)) return json(await this.lifecycle(operation, deviceId, input, { signal }));
      if (method === "POST" && operation.startsWith("input/")) return json(await this.input(operation.slice(6), deviceId, input));
      const feature = {
        "GET hardware": "hardware_get", "GET clipboard": "clipboard_get", "GET settings": "settings_get",
        "POST hardware/battery": "battery_set", "POST hardware/network": "network_set",
        "POST hardware/location": "location_set", "POST clipboard": "clipboard_set",
        "POST settings": "settings_set", "DELETE hardware/location": "location_clear",
        "POST sms": "sms_send", "POST biometric": "biometric",
        "POST notifications": "notification_push",
        "GET calls": "calls", "POST calls": "call",
        "GET permissions": "permission_list", "POST permissions": "permission_set",
      }[`${method} ${operation}`];
      if (feature) return json(await this.deviceFeature(feature, deviceId, input, { signal }));
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
