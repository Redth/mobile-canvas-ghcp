import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createAilohaDeviceFeatures } from "./device-features.mjs";
import { AilohaProtocolError, TARGET_HOST_PROFILE } from "./index.mjs";
import { ARTIFACT_FEATURE_GATES, artifactApiGate, artifactFeatureError } from "./artifact-features.mjs";
import { projectFileListing } from "./artifact-file-projection.mjs";
import { projectDeviceLogs, projectDeviceCrashes, projectDeviceCrashReport } from "./artifact-diagnostics-projection.mjs";
import { artifactApiInput, artifactFilePath, artifactQueryLimit, artifactQueryText } from "./artifact-read-input.mjs";
import { parseNativeStageOutcome, parseNativeDispatchOutcome } from "./artifact-stage-protocol.mjs";
import { parseGuardedFileOutcome } from "./guarded-file-protocol.mjs";
import { captureCreateInput, loadMobileCatalog, resolveCreateChoice } from "./mobile-catalog.mjs";
import { appLaunchResult, isOpaqueId } from "./protocol.mjs";
import { localAppPackage } from "./staged-apps.mjs";
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
const READ_ARTIFACT_FEATURES = Object.freeze({
  mobile_device_file_list: ["target.files", "queryTargetFiles"],
  mobile_device_log: ["target.diagnostics", "queryTargetLogs"],
  mobile_device_crashes: ["target.diagnostics", "queryTargetCrashes"],
  mobile_device_crash_report: ["target.diagnostics", "getTargetCrashDetail"],
});
const STAGED_ARTIFACT_FEATURES = Object.freeze({
  mobile_device_file_push: ["target.files", "importStagedTargetFile"],
  mobile_device_media_add: ["target.media", "importStagedTargetMediaBatch"],
});
const GUARDED_FILE_FEATURES = Object.freeze({
  mobile_device_file_pull: ["target.files", "exportTargetFile", "export"],
  mobile_device_file_delete: ["target.files", "deleteTargetFileWithOptions", "delete"],
  mobile_device_file_mkdir: ["target.files", "createTargetDirectory", "mkdir"],
});
const MAX_GUARDED_FILE_BYTES = 512 * 1024 * 1024;
const LOG_LEVELS = Object.freeze({
  verbose: "trace", debug: "debug", info: "info", warning: "warning", error: "error", fatal: "critical",
});

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
      ...operationMetadata,
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

export function unavailableUiContract() {
  throw new MobileAilohaError("ui_contract_unavailable",
    "The verified native System UI contract is unavailable in this published Ailoha runtime; App inspection is not a substitute.", 501);
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
  #features;
  #featureState;
  #reveal;
  #revealState;
  #systemUi;
  #systemUiState;
  #controls;
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
  #artifactState;
  #artifactFlights = new Map();
  #runCli;
  #creationPreparations = new Map();
  #disposed = false;
  #detached = false;
  #closing;

  constructor({
    scope, owner, client, media, features, featureState = new Map(), reveal, systemUi, controls,
    selectionStore, confirmDestructive, saveScreenshot,
    videoState = {}, operationState = new Map(), revealState = new Map(), systemUiState = new Map(),
    onEvent = () => {}, onError = () => {},
    stagedApps, fencedApps, allowHostPackage,
    artifactState = new Map(), runCli,
  }) {
    this.#scope = publicSnapshot({ sessionId: scope.sessionId, viewId: scope.viewId });
    this.#client = client;
    this.#media = media;
    this.#features = features;
    this.#featureState = featureState;
    this.#reveal = reveal;
    this.#revealState = revealState;
    this.#systemUi = systemUi;
    this.#systemUiState = systemUiState;
    this.#controls = controls;
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
    this.#artifactState = artifactState;
    this.#runCli = runCli;
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
    Object.assign(supported, appSupport(capabilities, target.nativeIdentity?.platform,
      this.#consent.supported, await this.#canStageApps(options), this.#fencedApps));
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
    const stagedInstall = await this.#canStageApps(options);
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
      supported.reveal = Boolean(this.#reveal && hasOperation(capabilities, "revealTarget", "target.lifecycle"));
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

  async readArtifact(identity, input) {
    const feature = READ_ARTIFACT_FEATURES[identity];
    if (!feature) throw artifactFeatureError(identity);
    if (!input || typeof input !== "object" || Array.isArray(input) || !isOpaqueId(input.deviceId)) {
      throw new MobileAilohaError("invalid_request", "Artifact reads require a captured device identifier.", 400);
    }
    const bundleId = input.bundleId;
    if (bundleId !== undefined && bundleId !== null
      && (typeof bundleId !== "string" || !isOpaqueId(bundleId))) {
      throw new MobileAilohaError("invalid_request", "An installed app selector must be an opaque identifier.", 400);
    }
    let limit;
    let text;
    let level;
    let since;
    switch (identity) {
      case "mobile_device_file_list":
        artifactFilePath(input.path, bundleId?.trim() ? "captured-app" : undefined);
        break;
      case "mobile_device_log": {
        limit = artifactQueryLimit(input.limit, 200, 10_000);
        text = artifactQueryText(input.text);
        level = input.level;
        if (level !== undefined && level !== null && level !== ""
          && (typeof level !== "string" || !Object.hasOwn(LOG_LEVELS, level.toLowerCase()))) {
          throw new MobileAilohaError("invalid_request", "Unknown legacy log level.", 400);
        }
        const seconds = input.seconds ?? 300;
        if (!Number.isSafeInteger(seconds)) {
          throw new MobileAilohaError("invalid_request", "Log lookback seconds must be an integer.", 400);
        }
        if (seconds < 0 || seconds > 10_000_000) unsupported("Legacy log lookback interval");
        since = new Date(Date.now() - seconds * 1000).toISOString();
        break;
      }
      case "mobile_device_crashes":
        limit = artifactQueryLimit(input.limit, 25, 500);
        text = artifactQueryText(input.text);
        break;
      case "mobile_device_crash_report":
        if (!isOpaqueId(input.crashId) || !input.crashId.trim()) {
          throw new MobileAilohaError("invalid_request", "Crash detail requires a captured report identifier.", 400);
        }
        break;
    }
    const { invocation, capabilities, contextSnapshot, device, target } = await this.#capture(input.deviceId);
    if (!device.isAvailable || !["ios", "android"].includes(device.platform)
      || !target.nativeIdentity?.nativeId || target.nativeIdentity.nativeId !== device.nativeId) {
      unsupported("Native mobile target identity");
    }
    if (!hasOperation(capabilities, feature[1], feature[0])) unsupported(identity);
    const original = () => {
      this.#requireSnapshot(contextSnapshot);
      this.#requireInvocationOwner(invocation);
    };
    const options = this.#options();
    const recheck = async () => {
      await this.#selectionStore.readSnapshot();
      original();
      const current = await this.#client.getTarget(invocation.targetId, options);
      original();
      const native = current.nativeIdentity;
      const captured = invocation.nativeIdentity;
      if (current.providerId !== invocation.providerId
        || !native || !captured || Object.keys(native).length !== Object.keys(captured).length
        || Object.entries(captured).some(([key, value]) => native[key] !== value)) {
        throw new MobileAilohaError("artifact_owner_mismatch",
          "The native target identity changed while the captured artifact read was in flight.", 502);
      }
      await this.#selectionStore.readSnapshot();
      original();
    };
    const ownedEntries = (entries) => {
      if (!Array.isArray(entries) || entries.some((entry) => {
        const context = entry?.["x-ailoha-target-host"];
        return context?.targetId !== invocation.targetId || context.providerId !== invocation.providerId;
      })) {
        throw new MobileAilohaError("artifact_owner_mismatch", "Ailoha returned artifact data for another target or provider.", 502);
      }
    };
    const appPackage = async (bundleId) => {
      if (bundleId === undefined || bundleId === null) return undefined;
      if (bundleId.trim() === "") return undefined;
      if (!hasOperation(capabilities, "listTargetApps", "target.apps")) unsupported("Installed app resolution");
      original();
      const apps = await this.#client.listTargetAppReferences(invocation.targetId, options);
      await recheck();
      ownedEntries(apps);
      const matches = apps.filter((app) => app.appId === bundleId || app.packageId === bundleId);
      if (matches.length !== 1 || !isOpaqueId(matches[0].packageId)) {
        unsupported("Unambiguous installed app package resolution");
      }
      return matches[0].packageId;
    };
    let result;
    switch (identity) {
      case "mobile_device_file_list": {
        const packageId = await appPackage(input.bundleId);
        const path = artifactFilePath(input.path, packageId);
        await recheck();
        const listing = await this.#client.queryTargetFiles(invocation.targetId, path, options);
        await recheck();
        ownedEntries(listing?.files);
        result = projectFileListing({
          deviceId: invocation.targetId, platform: device.platform, bundleId: packageId, listing,
        });
        break;
      }
      case "mobile_device_log": {
        const packageId = await appPackage(input.bundleId);
        await recheck();
        const logs = await this.#client.queryTargetLogs(invocation.targetId, {
          ...(packageId ? { appId: packageId } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(level ? { level: LOG_LEVELS[level.toLowerCase()] } : {}),
          limit: String(limit), since,
        }, options);
        await recheck();
        ownedEntries(logs?.entries);
        result = projectDeviceLogs({ deviceId: invocation.targetId, platform: device.platform, result: logs });
        break;
      }
      case "mobile_device_crashes": {
        await recheck();
        const crashes = await this.#client.queryTargetCrashes(invocation.targetId, {
          ...(text !== undefined ? { text } : {}), limit: String(limit),
        }, options);
        await recheck();
        ownedEntries(crashes?.crashes);
        result = projectDeviceCrashes({ deviceId: invocation.targetId, platform: device.platform, result: crashes });
        break;
      }
      case "mobile_device_crash_report": {
        await recheck();
        const detail = await this.#client.getTargetCrashDetail(invocation.targetId, input.crashId.trim(), options);
        await recheck();
        ownedEntries([detail]);
        if (detail?.crashId !== input.crashId.trim()) {
          throw new MobileAilohaError("artifact_owner_mismatch", "Ailoha returned a different crash report.", 502);
        }
        result = projectDeviceCrashReport({ deviceId: invocation.targetId, result: detail });
        break;
      }
      default: throw artifactFeatureError(identity);
    }
    this.#requireInvocationOwner(invocation);
    return result;
  }

  async stageArtifact(identity, input, options = {}) {
    const file = identity === "mobile_device_file_push";
    const paths = file ? undefined : input?.paths;
    const captured = Object.freeze(file
      ? {
        deviceId: input?.deviceId, input: input?.input,
        path: input?.path, bundleId: input?.bundleId,
      }
      : {
        deviceId: input?.deviceId,
        paths: Array.isArray(paths) ? Object.freeze([...paths]) : paths,
      });
    const key = JSON.stringify([this.#owner.hostId, captured.deviceId, identity,
      file ? captured.bundleId ?? null : null, file ? captured.path ?? null : null]);
    if (this.#artifactFlights.has(key)) {
      throw new MobileAilohaError("artifact_operation_in_progress",
        "This target destination already has a staged operation in progress.", 409);
    }
    const running = this.#stageArtifactOnce(identity, captured, options);
    this.#artifactFlights.set(key, running);
    try {
      return await running;
    } finally {
      if (this.#artifactFlights.get(key) === running) this.#artifactFlights.delete(key);
    }
  }

  async guardedFile(identity, input, { signal } = {}) {
    const feature = GUARDED_FILE_FEATURES[identity];
    if (!feature || typeof this.#runCli !== "function") throw artifactFeatureError(identity);
    if (!input || typeof input !== "object" || Array.isArray(input)
      || !isOpaqueId(input.deviceId) || typeof input.path !== "string" || !input.path.trim()
      || (input.bundleId != null && (!isOpaqueId(input.bundleId) || !input.bundleId.trim()))
      || (feature[2] === "delete" && input.recursive !== undefined && typeof input.recursive !== "boolean")
      || (feature[2] === "export" && (typeof input.output !== "string"
        || !input.output.trim() || input.output.length > 4096 || /[\0\r\n]/.test(input.output)))) {
      throw new MobileAilohaError("invalid_request", "Guarded file input needs a device path and bounded host destination where applicable.", 400);
    }
    const captured = Object.freeze({
      deviceId: input.deviceId, path: input.path, bundleId: input.bundleId ?? null,
      recursive: feature[2] === "delete" ? input.recursive ?? false : false,
      output: feature[2] === "export" ? input.output : null,
    });
    artifactFilePath(captured.path, captured.bundleId ? "captured-app" : undefined);
    const outputPath = captured.output ? resolve(captured.output) : null;
    let destinationPath = null;
    if (outputPath) {
      let directory = false;
      try { directory = statSync(outputPath).isDirectory(); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      destinationPath = directory ? join(outputPath, basename(captured.path.replace(/\/+$/, ""))) : outputPath;
    }
    const key = JSON.stringify(["guarded", this.#owner.hostId, identity, captured.deviceId,
      captured.bundleId, captured.path]);
    if (this.#artifactFlights.has(key)) {
      throw new MobileAilohaError("artifact_operation_in_progress",
        "An original guarded file operation is already in progress.", 409);
    }
    const running = this.#guardedFileOnce(identity, feature, captured, destinationPath, key, signal);
    this.#artifactFlights.set(key, running);
    try { return await running; }
    finally { if (this.#artifactFlights.get(key) === running) this.#artifactFlights.delete(key); }
  }

  async #guardedFileOnce(identity, feature, input, destinationPath, key, signal) {
    const operationSignal = this.#options(signal).signal;
    requireNotCancelled(operationSignal);
    let pending = this.#artifactState.get(key);
    if (!pending?.attempted) this.#requireOpen();
    if (pending && !isDeepStrictEqual(pending.input, input)) {
      throw new MobileAilohaError("artifact_conflicting_receipt",
        "The original file attempt still owns this path and its captured options.", 409);
    }
    if (pending) this.#requireInvocationOwner(pending.invocation);
    if (!pending) {
      const { invocation, contextSnapshot, capabilities, device, target } = await this.#capture(input.deviceId);
      if (!contextSnapshot.contextProjection || !contextSnapshot.contextOwner
        || contextSnapshot.selection?.targetId !== invocation.targetId
        || contextSnapshot.selection?.targetHostId !== invocation.targetHostId) {
        throw new MobileAilohaError("context_not_bound", "Native file admission requires the selected original named view.", 409);
      }
      if (!device.isAvailable || !["ios", "android"].includes(device.platform)
        || !target.nativeIdentity?.nativeId || target.nativeIdentity.nativeId !== device.nativeId
        || !hasOperation(capabilities, feature[1], feature[0])) unsupported(identity);
      let packageId;
      if (input.bundleId) {
        if (!hasOperation(capabilities, "listTargetApps", "target.apps")) unsupported("Installed app resolution");
        const apps = await this.#client.listTargetAppReferences(invocation.targetId, this.#options(signal));
        await this.#selectionStore.readSnapshot(this.#options(signal));
        this.#requireSnapshot(contextSnapshot);
        this.#requireInvocationOwner(invocation);
        const matches = apps.filter((app) => (app.appId === input.bundleId || app.packageId === input.bundleId)
          && app["x-ailoha-target-host"]?.targetId === invocation.targetId
          && app["x-ailoha-target-host"]?.providerId === invocation.providerId);
        if (matches.length !== 1 || !isOpaqueId(matches[0].packageId)) unsupported("Installed app package resolution");
        packageId = matches[0].packageId;
      }
      const path = artifactFilePath(input.path, packageId);
      if (path === "/" || path.endsWith("/")) {
        throw new MobileAilohaError("invalid_request", "A guarded file operation needs a named path.", 400);
      }
      if (this.#artifactState.size >= 64) {
        throw new MobileAilohaError("artifact_receipt_limit", "The original file receipt pool is full.", 429);
      }
      const expected = {
        invocation, kind: feature[2], path, appId: null, recursive: input.recursive,
        destinationPath, overwrite: feature[2] === "export",
        maximumBytes: MAX_GUARDED_FILE_BYTES,
      };
      pending = { input, invocation, contextSnapshot, expected, platform: device.platform,
        prepared: null, prepareUnknown: false, attempted: false };
      this.#artifactState.set(key, pending);
      await this.#selectionStore.readSnapshot(this.#options(signal));
      this.#requireSnapshot(contextSnapshot);
      this.#requireInvocationOwner(invocation);
      try {
        const output = await this.#runCli(this.#guardedCommand(invocation, "prepare", [
          invocation.targetId, "--kind", feature[2], "--path", path,
          ...(input.recursive ? ["--recursive"] : []),
          ...(destinationPath ? ["--destination", resolve(input.output), "--overwrite"] : []),
          "--maximum-bytes", String(MAX_GUARDED_FILE_BYTES),
        ]), { signal: this.#options(signal).signal });
        pending.prepared = parseGuardedFileOutcome(output, expected);
      } catch (error) {
        pending.prepareUnknown = true;
        throw error;
      }
    }
    const { invocation, expected } = pending;
    this.#requireInvocationOwner(invocation);
    if (pending.prepareUnknown || pending.prepared?.status !== "prepared") {
      throw new MobileAilohaError("guarded_file_prepare_unknown",
        "The original file preparation has no confirmed receipt and will not be replayed.", 502);
    }
    if (!pending.attempted) {
      let approval;
      let consumed = false;
      let submissionBudget = 60_000;
      try {
        await this.#selectionStore.readSnapshot(this.#options(signal));
        this.#requireSnapshot(pending.contextSnapshot);
        this.#requireInvocationOwner(invocation);
        const current = await this.#client.getTarget(invocation.targetId, this.#options(signal));
        await this.#selectionStore.readSnapshot(this.#options(signal));
        this.#requireSnapshot(pending.contextSnapshot);
        this.#requireInvocationOwner(invocation);
        if (current.providerId !== invocation.providerId
          || !isDeepStrictEqual(current.nativeIdentity ?? null, invocation.nativeIdentity ?? null)) {
          throw new MobileAilohaError("artifact_owner_mismatch",
            "The original native target changed before guarded file admission.", 502);
        }
        if (feature[2] !== "mkdir") {
          approval = this.beginDestructiveApproval(
            feature[2] === "delete" ? "file_delete" : "file_pull", invocation,
            { subject: feature[2] === "delete" ? expected.path : expected.destinationPath, signal });
          await approval.approved;
          await approval.run(() => this.#selectionStore.readSnapshot({ signal: approval.signal }));
          approval.requireCurrent();
          this.#requireSnapshot(pending.contextSnapshot);
          submissionBudget = approval.remainingTimeoutMs(60_000);
          approval.consume(invocation);
          consumed = true;
        }
        requireNotCancelled(signal);
        this.#requireSnapshot(pending.contextSnapshot);
        pending.attempted = true;
        try {
          const output = await this.#runCli(this.#guardedCommand(invocation, "continue", [
            "--guarded", pending.prepared.receiptJson, "--confirm",
          ]), { signal: approval?.signal ?? this.#options(signal).signal,
            timeoutMs: submissionBudget });
          pending.continued = parseGuardedFileOutcome(output, expected);
        } finally {
          if (consumed) approval.submitted({ operationId: pending.continued?.operationId,
            uncertain: !pending.continued });
        }
      } finally {
        if (!consumed || !pending.attempted) approval?.dispose();
      }
    }
    if (pending.continued?.status === "rejected") {
      throw new MobileAilohaError(pending.continued.errorCode ?? "guarded_file_acceptance_unknown",
        "The original guarded file submission was rejected.", 502);
    }
    requireNotCancelled(operationSignal);
    const output = await this.#runCli(this.#guardedCommand(invocation, "recover", [
      "--guarded", pending.prepared.receiptJson,
    ]), { signal: operationSignal, timeoutMs: 10 * 60_000 });
    requireNotCancelled(operationSignal);
    const result = parseGuardedFileOutcome(output, expected);
    const admittedOperationId = pending.continued?.operation?.operationId ?? pending.continued?.operationId;
    if (admittedOperationId && (result.operationId !== admittedOperationId
      || result.operation?.operationId !== admittedOperationId)) {
      throw new MobileAilohaError("guarded_file_operation_mismatch",
        "Readback does not belong to the original admitted file operation.", 502);
    }
    if (!["succeeded", "downloaded"].includes(result.status)) {
      throw new MobileAilohaError(result.errorCode ?? "guarded_file_readback_unconfirmed",
        `The original file attempt remains ${result.status}; primary=${result.primaryFailureCode ?? "none"}, cleanup=${result.cleanupFailureCode ?? "none"}.`, 502);
    }
    const projected = result.status === "downloaded"
      ? { schemaVersion: "1.0", success: true, deviceId: invocation.targetId,
        devicePath: result.devicePath, hostPath: result.receipt.destinationPath,
        size: result.downloadedBytes, operation: "pull" }
      : { schemaVersion: "1.0", success: true, deviceId: invocation.targetId,
        platform: pending.platform, path: result.mutation.path,
        operation: expected.kind === "delete" ? "delete" : "mkdir" };
    this.#requireInvocationOwner(invocation);
    this.#artifactState.delete(key);
    return publicSnapshot(projected);
  }

  #guardedCommand(invocation, action, args) {
    const context = invocation.executionContext;
    return [
      "target", "--context", context.contextRef, "--context-epoch", context.scopeEpoch,
      ...(action === "prepare" ? ["--context-revision", context.revision] : []),
      "--target-host", invocation.targetHostId, "native-file", action, ...args, "--json",
    ];
  }
  async #stageArtifactOnce(identity, input, { signal } = {}) {
    const feature = STAGED_ARTIFACT_FEATURES[identity];
    if (!feature || typeof this.#runCli !== "function") throw artifactFeatureError(identity);
    if (!input || typeof input !== "object" || Array.isArray(input) || !isOpaqueId(input.deviceId)) {
      throw new MobileAilohaError("invalid_request", "A staged artifact needs a captured device identifier.", 400);
    }
    const file = identity === "mobile_device_file_push";
    const requestedPaths = file ? [input.input] : input.paths;
    if (Array.isArray(requestedPaths) && !file && requestedPaths.length > 16) {
      throw new MobileAilohaError("artifact_media_batch_limit",
        "Native media staging supports at most 16 host paths; this batch cannot be represented faithfully.", 501);
    }
    if (!Array.isArray(requestedPaths) || requestedPaths.length < 1 || requestedPaths.length > (file ? 1 : 16)
      || requestedPaths.some((path) => typeof path !== "string" || !path || path.length > 4096 || /[\0\r\n]/.test(path))
      || Buffer.byteLength(JSON.stringify(requestedPaths)) > 32 * 1024) {
      throw new MobileAilohaError("invalid_request", "Staging requires one file or 1..16 bounded host paths.", 400);
    }
    const sourcePaths = requestedPaths.map((path) => resolve(path));
    if (sourcePaths.some((path) => path.length > 4096)
      || Buffer.byteLength(JSON.stringify(sourcePaths)) > 32 * 1024) {
      throw new MobileAilohaError("invalid_request", "Resolved host paths exceed the native staging limit.", 400);
    }
    if (file && (typeof input.path !== "string" || !input.path.trim()
      || (input.bundleId != null && (!isOpaqueId(input.bundleId) || !input.bundleId.trim())))) {
      throw new MobileAilohaError("invalid_request", "File push requires a destination and optional installed app selector.", 400);
    }
    requireNotCancelled(signal);
    const key = JSON.stringify([this.#owner.hostId, input.deviceId, identity, file ? input.bundleId ?? null : null,
      file ? input.path : null]);
    let pending = this.#artifactState.get(key);
    let ownsSubmission = false;
    if (pending && !isDeepStrictEqual(requestedPaths, pending.requestedPaths)) {
      throw new MobileAilohaError("artifact_conflicting_receipt",
        "The original target still owns a staged artifact or device attempt for this destination.", 409);
    }
    if (pending) this.#requireInvocationOwner(pending.invocation);
    if (!pending) {
      const { invocation, capabilities, contextSnapshot, device } = await this.#capture(input.deviceId);
      if (!contextSnapshot.contextProjection || !contextSnapshot.contextOwner
        || contextSnapshot.selection?.targetId !== invocation.targetId
        || contextSnapshot.selection?.targetHostId !== invocation.targetHostId) {
        throw new MobileAilohaError("context_not_bound", "Native staging requires the selected original named view and process owner.", 409);
      }
      if (!device.isAvailable || !["ios", "android"].includes(device.platform)
        || !hasOperation(capabilities, feature[1], feature[0])) unsupported(identity);
      let packageId;
      if (file && input.bundleId) {
        if (!hasOperation(capabilities, "listTargetApps", "target.apps")) unsupported("Installed app resolution");
        const apps = await this.#client.listTargetAppReferences(invocation.targetId, this.#options(signal));
        await this.#selectionStore.readSnapshot(this.#options(signal));
        this.#requireSnapshot(contextSnapshot);
        this.#requireInvocationOwner(invocation);
        const matches = apps.filter((app) => (app.appId === input.bundleId || app.packageId === input.bundleId)
          && app["x-ailoha-target-host"]?.targetId === invocation.targetId
          && app["x-ailoha-target-host"]?.providerId === invocation.providerId);
        if (matches.length !== 1 || !isOpaqueId(matches[0].packageId)) unsupported("Installed app package resolution");
        packageId = matches[0].packageId;
      }
      const destination = file ? artifactFilePath(input.path, packageId) : "batch";
      if (file && destination === "/") {
        throw new MobileAilohaError("invalid_request", "A file destination must name a file or directory.", 400);
      }
      if (this.#artifactState.size >= 64) {
        throw new MobileAilohaError("artifact_receipt_limit", "The bounded staged artifact receipt pool is full.", 429);
      }
      pending = {
        invocation, contextSnapshot, platform: device.platform, sourcePaths: [...sourcePaths],
        requestedPaths: [...requestedPaths],
        kind: file ? "file" : "media", destination, stage: null, accepted: null,
        attempted: false, stageUnknown: false, operationId: null, completed: null, cleaned: false,
      };
      this.#artifactState.set(key, pending);
      try {
        await this.#selectionStore.readSnapshot(this.#options(signal));
        this.#requireSnapshot(contextSnapshot);
        this.#requireInvocationOwner(invocation);
        const result = await this.#runCli(this.#stageCommand(invocation, "stage", [
          invocation.targetId, "--sources", JSON.stringify(sourcePaths),
          "--kind", pending.kind, "--destination", destination,
        ]), { signal: this.#options(signal).signal, timeoutMs: 10 * 60_000 });
        pending.stage = parseNativeStageOutcome(result, pending);
      } catch (error) {
        pending.stageUnknown = true;
        throw error;
      }
    }
    const { invocation } = pending;
    this.#requireInvocationOwner(invocation);
    if (pending.stageUnknown) {
      throw new MobileAilohaError("artifact_acceptance_unknown",
        "The original host staging attempt has no confirmed receipt; it will not be uploaded again.", 502);
    }
    if (pending.abandoned) {
      await this.#cleanupStagedArtifact(pending);
      if (pending.abandoned.code === "consent_denied") this.#artifactState.delete(key);
      throw pending.abandoned;
    }
    if (pending.stage?.status !== "ready" && !pending.attempted) {
      const confirmed = await this.#runCli(this.#stageCommand(invocation, "confirm",
        ["--staged", pending.stage.receiptJson]), { signal: this.#options(signal).signal });
      pending.stage = parseNativeStageOutcome(confirmed, pending);
    }
    if (pending.stage.status !== "ready") {
      throw new MobileAilohaError("artifact_readback_unconfirmed",
        `The original host has not confirmed the staged artifact (${pending.stage.errorCode ?? pending.stage.status}); retry GET only.`, 502);
    }
    if (!pending.attempted) {
      let approval;
      let consumed = false;
      let submissionBudget = 60_000;
      try {
        await this.#selectionStore.readSnapshot(this.#options(signal));
        this.#requireSnapshot(pending.contextSnapshot);
        this.#requireInvocationOwner(invocation);
        const current = await this.#client.getTarget(invocation.targetId, this.#options(signal));
        await this.#selectionStore.readSnapshot(this.#options(signal));
        this.#requireSnapshot(pending.contextSnapshot);
        this.#requireInvocationOwner(invocation);
        if (current.providerId !== invocation.providerId
          || !isDeepStrictEqual(current.nativeIdentity ?? null, invocation.nativeIdentity ?? null)) {
          throw new MobileAilohaError("artifact_owner_mismatch", "The original native target changed before staging continuation.", 502);
        }
        if (file) {
          approval = this.beginDestructiveApproval("file_push", invocation,
            { subject: pending.destination, signal });
          await approval.approved;
          await approval.run(() => this.#selectionStore.readSnapshot({ signal: approval.signal }));
          approval.requireCurrent();
          this.#requireSnapshot(pending.contextSnapshot);
          submissionBudget = approval.remainingTimeoutMs(60_000);
          approval.consume(invocation);
          consumed = true;
        }
        requireNotCancelled(signal);
        this.#requireSnapshot(pending.contextSnapshot);
        pending.attempted = true;
        ownsSubmission = true;
        let output;
        try {
          output = await this.#runCli(this.#stageCommand(invocation, "continue", [
            "--staged", pending.stage.receiptJson, ...(file ? ["--overwrite"] : []), "--confirm",
          ]), {
            signal: approval?.signal ?? this.#options(signal).signal,
            timeoutMs: submissionBudget,
          });
          pending.accepted = parseNativeDispatchOutcome(output, { ...pending, action: "continue" });
          pending.operationId = pending.accepted.operation?.operationId ?? null;
        } catch (error) {
          pending.stageUnknown = true;
          throw error;
        } finally {
          if (consumed) {
            try { approval.submitted({ operationId: pending.operationId, uncertain: pending.stageUnknown }); }
            catch (error) {
              if (!pending.operationId) throw error;
              pending.approvalError = error;
            }
          }
        }
      } catch (error) {
        if (!pending.attempted) {
          pending.abandoned = error;
          try {
            await this.#cleanupStagedArtifact(pending);
            if (error.code === "consent_denied") this.#artifactState.delete(key);
          } catch (cleanupError) {
            throw new MobileAilohaError("artifact_cleanup_unconfirmed",
              `Staged artifact cleanup after ${error.code ?? "admission failure"} is unconfirmed (${cleanupError.code ?? "native cleanup failed"}).`, 502);
          }
        }
        throw error;
      } finally {
        if (!consumed || !pending.attempted) approval?.dispose();
      }
    }
    if (pending.stageUnknown || pending.accepted?.status !== "accepted" || !pending.operationId) {
      throw new MobileAilohaError("device_acceptance_unknown",
        "The captured device operation has no confirmed acceptance; it will not be submitted again.", 502);
    }
    if (ownsSubmission && pending.approvalError) throw pending.approvalError;
    if (!pending.completed) {
      const operation = await this.#client.waitForOperation(pending.operationId, {
        ...this.#options(signal), timeoutMs: 60_000,
      });
      this.#requireInvocationOwner(invocation);
      if (operation.operationId !== pending.operationId
        || operation.kind !== (file ? "importStagedTargetFile" : "importStagedTargetMediaBatch")
        || operation.destructive !== true
        || operation.targetId !== invocation.targetId || operation.providerId !== invocation.providerId
        || (operation.artifactIds !== undefined && !isDeepStrictEqual(operation.artifactIds,
          pending.stage.receipt.artifacts.map((entry) => entry.artifact.artifactId)))
        || !["succeeded", "failed", "cancelled"].includes(operation.status)) {
        throw new MobileAilohaError("artifact_operation_mismatch", "The completed device operation does not match its captured target.", 502);
      }
      pending.completed = operation;
      if (operation.status !== "succeeded") {
        pending.terminalError = new MobileAilohaError("artifact_operation_failed",
          `The original device import ended ${operation.status}; no copy or media addition is reported.`, 502);
      }
    }
    if (pending.terminalError) {
      await this.#cleanupStagedArtifact(pending);
      throw pending.terminalError;
    }
    const output = file
      ? {
        schemaVersion: "1.0", success: true, deviceId: invocation.targetId,
        devicePath: pending.platform === "android"
          ? (input.bundleId?.trim() ? input.path.trim().replace(/^\/+/, "") || "." : input.path.trim())
          : input.path,
        hostPath: pending.sourcePaths[0], size: pending.stage.receipt.artifacts[0].artifact.size, operation: "push",
      }
      : {
        schemaVersion: "1.0", deviceId: invocation.targetId, platform: pending.platform,
        added: [...pending.sourcePaths],
      };
    if (!file) {
      const added = pending.completed.result?.addedArtifactIds;
      const staged = pending.stage.receipt.artifacts.map((item) => item.artifact.artifactId);
      if (!Array.isArray(added) || !isDeepStrictEqual(added, staged)) {
        throw new MobileAilohaError("artifact_operation_mismatch", "The native media batch did not confirm every staged host path.", 502);
      }
    }
    await this.#cleanupStagedArtifact(pending);
    await this.#selectionStore.readSnapshot(this.#options(signal));
    this.#requireSnapshot(pending.contextSnapshot);
    this.#requireInvocationOwner(invocation);
    this.#artifactState.delete(key);
    return publicSnapshot(output);
  }

  async #cleanupStagedArtifact(pending) {
    if (pending.cleaned) return;
    const cleanup = await this.#runCli(this.#stageCommand(pending.invocation, "cleanup",
      ["--staged", pending.stage.receiptJson, "--confirm"]),
    { timeoutMs: 10 * 60_000 });
    const result = parseNativeDispatchOutcome(cleanup, { ...pending, action: "cleanup" });
    if (result.status !== "cleaned") {
      throw new MobileAilohaError("artifact_cleanup_unconfirmed",
        `Original-host artifact cleanup is not complete (${result.errorCode ?? result.status}).`, 502);
    }
    pending.cleaned = true;
  }

  #stageCommand(invocation, action, args) {
    const context = invocation.executionContext;
    return [
      "target", "--context", context.contextRef, "--context-epoch", context.scopeEpoch,
      "--context-revision", context.revision, "--target-host", invocation.targetHostId,
      "native-stage", action, ...args, "--json",
    ];
  }

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

  async reveal(deviceId, { selectRevealed = false, signal } = {}) {
    requireNotCancelled(signal);
    const key = JSON.stringify([this.#owner.hostId, deviceId, "reveal"]);
    const previous = this.#revealState.get(key);
    if (previous) {
      this.#requireInvocationOwner(previous.invocation);
      if (previous.completed) return this.#confirmReveal(key, previous, { selectRevealed, signal });
      throw new MobileAilohaError("reveal_outcome_uncertain",
        "The original reveal was submitted; it will not be rebound or replayed.", 409);
    }
    const { invocation, capabilities, contextSnapshot, provider, device } = await this.#capture(deviceId);
    if (!this.#reveal || !hasOperation(capabilities, "revealTarget", "target.lifecycle")
      || !device.isAvailable || device.targetStatus !== "running") unsupported("Reveal");
    await this.#selectionStore.readSnapshot();
    this.#requireSnapshot(contextSnapshot);
    this.#requireInvocationOwner(invocation);
    requireNotCancelled(signal);
    if (invocation.selectionGeneration !== this.#generation) {
      throw new MobileAilohaError("selection_superseded", "The view changed before reveal was submitted.");
    }
    if (this.#revealState.size >= 64) {
      throw new MobileAilohaError("reveal_receipt_limit", "The bounded reveal intent pool is full.", 429);
    }
    const competing = this.#revealState.get(key);
    if (competing) {
      this.#requireInvocationOwner(competing.invocation);
      if (competing.completed) return this.#confirmReveal(key, competing, { selectRevealed, signal });
      throw new MobileAilohaError("reveal_outcome_uncertain",
        "The original reveal was submitted; it will not be rebound or replayed.", 409);
    }
    const receipt = {
      invocation, contextSnapshot, provider, supported: device.capabilities, selectRevealed,
      selectionOwner: this, callers: new Set(), completed: null, confirming: null,
    };
    this.#revealState.set(key, receipt);
    try {
      receipt.completed = publicSnapshot(await this.#reveal.reveal(invocation));
    } catch (error) {
      if (definitiveOperationRejection(error)) releaseOperationReceipt(this.#revealState, key, receipt);
      throw error;
    }
    return this.#confirmReveal(key, receipt, { selectRevealed, signal });
  }

  async #confirmReveal(key, receipt, { selectRevealed, signal }) {
    requireNotCancelled(signal);
    const caller = { selectCreated: selectRevealed && receipt.selectRevealed };
    receipt.callers.add(caller);
    const abort = () => receipt.callers.delete(caller);
    signal?.addEventListener("abort", abort, { once: true });
    if (!receipt.confirming) {
      const confirmation = this.#completeReveal(key, receipt);
      receipt.confirming = confirmation;
      const clear = () => { if (receipt.confirming === confirmation) receipt.confirming = null; };
      confirmation.then(clear, clear);
    }
    const pending = receipt.confirming;
    try {
      const result = await (signal ? waitForCreationCaller(pending, signal) : pending);
      requireNotCancelled(signal);
      if (this.#revealState.get(key) === receipt) {
        if (receipt.confirming === pending) receipt.confirming = null;
        return await this.#confirmReveal(key, receipt, { selectRevealed, signal });
      }
      return result;
    }
    finally {
      signal?.removeEventListener("abort", abort);
      receipt.callers.delete(caller);
    }
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
    if (receipt.callers.size) releaseOperationReceipt(this.#revealState, key, receipt);
    return result;
  }

  async #captureSystemUi(deviceId, operation) {
    if (!this.#systemUi) unavailableUiContract();
    const captured = await this.#capture(deviceId, true);
    const { invocation, target, capabilities, device } = captured;
    if (!device.isAvailable || device.targetStatus !== "running"
      || !hasOperation(capabilities, operation, "surface.ui")
      || !hasOperation(requireSurface(target, invocation.surfaceId).capabilities, operation, "surface.ui")) {
      unsupported("Native System UI");
    }
    this.#requireInvocationOwner(invocation);
    this.#requireSnapshot(captured.contextSnapshot);
    return captured;
  }

  async #confirmSystemUiOwner(captured) {
    const { invocation, contextSnapshot, target, provider, capabilities } = captured;
    const currentSnapshot = await this.#selectionStore.readSnapshot();
    this.#requireSnapshot(contextSnapshot);
    if (!isDeepStrictEqual(currentSnapshot.selection, contextSnapshot.selection)) {
      throw new MobileAilohaError("selection_superseded", "The named System UI selection changed after capture.");
    }
    this.#requireInvocationOwner(invocation);
    if (invocation.selectionGeneration !== this.#generation) {
      throw new MobileAilohaError("selection_superseded", "The System UI owner changed before dispatch.");
    }
    const current = await this.#record(invocation.targetId, invocation.surfaceId);
    const latestSnapshot = await this.#selectionStore.readSnapshot();
    this.#requireSnapshot(contextSnapshot);
    this.#requireInvocationOwner(invocation);
    if (invocation.selectionGeneration !== this.#generation
      || !isDeepStrictEqual(latestSnapshot.selection, contextSnapshot.selection)
      || current.target.providerId !== invocation.providerId
      || current.target.targetTypeId !== target.targetTypeId
      || current.provider.state !== provider.state
      || !isDeepStrictEqual(current.capabilities, capabilities)
      || !isDeepStrictEqual(current.target.nativeIdentity, target.nativeIdentity)
      || !isDeepStrictEqual(requireSurface(current.target, invocation.surfaceId),
        requireSurface(target, invocation.surfaceId))) {
      throw new MobileAilohaError("system_ui_owner_changed", "The captured native target or System surface changed.", 409);
    }
  }

  async uiDump(deviceId, includeRaw = false) {
    const captured = await this.#captureSystemUi(deviceId, "getSystemUiSnapshot");
    const { uiRevision, ...snapshot } = await this.#systemUi.snapshot(captured.invocation, includeRaw);
    await this.#confirmSystemUiOwner(captured);
    if (!uiRevision) throw new MobileAilohaError("invalid_system_ui_response", "System UI revision was not reported.", 502);
    return publicSnapshot(snapshot);
  }

  async uiFind(deviceId, query = {}) {
    if (!this.#systemUi) unavailableUiContract();
    const terms = this.#systemUi.validateQuery(query);
    const captured = await this.#captureSystemUi(deviceId, "querySystemUi");
    const { uiRevision, ...result } = await this.#systemUi.find(captured.invocation, terms);
    await this.#confirmSystemUiOwner(captured);
    if (!uiRevision) throw new MobileAilohaError("invalid_system_ui_response", "System UI revision was not reported.", 502);
    return publicSnapshot(result);
  }

  async uiTap(deviceId, query = {}, { signal } = {}) {
    requireNotCancelled(signal);
    if (!this.#systemUi) unavailableUiContract();
    const terms = this.#systemUi.validateQuery(query, 1);
    const key = JSON.stringify([this.#owner.hostId, deviceId, "system-ui-tap", terms]);
    const previous = this.#systemUiState.get(key);
    if (previous) {
      this.#requireInvocationOwner(previous.captured.invocation);
      if (previous.completed) return this.#confirmSystemUiTap(key, previous, signal);
      throw new MobileAilohaError("ui_tap_outcome_uncertain", "The original native UI tap may have been accepted; it will not be replayed.", 409);
    }
    const captured = await this.#captureSystemUi(deviceId, "tapSystemUiMatch");
    if (!hasOperation(captured.capabilities, "getSystemUiSnapshot", "surface.ui")
      || !hasOperation(requireSurface(captured.target, captured.invocation.surfaceId).capabilities,
        "getSystemUiSnapshot", "surface.ui")) unsupported("Native System UI revision");
    const snapshot = await this.#systemUi.snapshot(captured.invocation);
    await this.#confirmSystemUiOwner(captured);
    requireNotCancelled(signal);
    if (this.#systemUiState.size >= 64) {
      throw new MobileAilohaError("ui_tap_receipt_limit", "The native UI tap intent pool is full.", 429);
    }
    const competing = this.#systemUiState.get(key);
    if (competing) {
      this.#requireInvocationOwner(competing.captured.invocation);
      if (competing.completed) return this.#confirmSystemUiTap(key, competing, signal);
      throw new MobileAilohaError("ui_tap_outcome_uncertain", "The original native UI tap may have been accepted; it will not be replayed.", 409);
    }
    const receipt = { captured, completed: null, confirming: null };
    this.#systemUiState.set(key, receipt);
    try {
      receipt.completed = await this.#systemUi.tap(captured.invocation, terms, snapshot.uiRevision);
    } catch (error) {
      if (definitiveOperationRejection(error)) releaseOperationReceipt(this.#systemUiState, key, receipt);
      throw error;
    }
    return this.#confirmSystemUiTap(key, receipt, signal);
  }

  async #confirmSystemUiTap(key, receipt, signal) {
    requireNotCancelled(signal);
    if (!receipt.confirming) {
      const confirmation = this.#confirmSystemUiOwner(receipt.captured).then(() => receipt.completed);
      receipt.confirming = confirmation;
      const clear = () => { if (receipt.confirming === confirmation) receipt.confirming = null; };
      confirmation.then(clear, clear);
    }
    const pending = receipt.confirming;
    const result = await (signal ? waitForCreationCaller(pending, signal) : pending);
    requireNotCancelled(signal);
    releaseOperationReceipt(this.#systemUiState, key, receipt);
    return result;
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

  async #canStageApps(options = this.#options()) {
    if (!this.#stagedApps || !this.supportsDestructiveApproval
      || typeof this.#allowHostPackage !== "function") return false;
    requireNotCancelled(options.signal);
    const status = await this.#client.getHostStatus(options);
    requireNotCancelled(options.signal);
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

  async #fencedAppAction(deviceId, bundleId, action, { operation, mode, signal } = {}) {
    const feature = action === "uninstall" ? "appUninstall" : "appOpSet";
    const kind = action === "uninstall" ? "uninstallFencedTargetApp" : "updateFencedTargetAppOp";
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
    const captured = await this.#capturedApp(deviceId, feature, bundleId);
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
        appId: app.appId, packageId: bundleId, version: app.version, buildNumber: app.buildNumber,
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
    if (!progress.receipt) {
      this.#requireSnapshot(progress.contextSnapshot);
      const pending = progress.pending ??= this.#submitFencedAppAction(key, progress, signal);
      try { await pending; }
      finally { if (progress.pending === pending) progress.pending = null; }
    }
    if (progress.completed) {
      requireNotCancelled(signal);
      releaseOperationReceipt(this.#operationState, `${key}:submission`, progress.receipt);
      releaseOperationReceipt(this.#operationState, key, progress);
      return progress.completed;
    }
    if (!progress.confirming) {
      const confirmation = this.#confirmFencedAppAction(key, progress);
      progress.confirming = confirmation;
      const clear = () => { if (progress.confirming === confirmation) progress.confirming = null; };
      confirmation.then(clear, clear);
    }
    const pending = progress.confirming;
    const result = await (signal ? waitForCreationCaller(pending, signal) : pending);
    requireNotCancelled(signal);
    releaseOperationReceipt(this.#operationState, `${key}:submission`, progress.receipt);
    releaseOperationReceipt(this.#operationState, key, progress);
    return result;
  }

  async #submitFencedAppAction(key, progress, signal) {
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
  }

  async #confirmFencedAppAction(key, progress) {
    const { invocation, appAction, action, kind } = progress;
    const submissionKey = `${key}:submission`;
    let completed;
    try {
      completed = await waitForOperationReceipt({
        state: this.#operationState, key: submissionKey, receipt: progress.receipt,
        client: this.#client, options: { ...this.#options(), timeoutMs: 60_000 },
        retainTerminal: true, outcome: "app_action",
        requireOwner: () => this.#requireInvocationOwner(invocation),
      });
      if (completed.kind !== kind || completed.destructive !== (action === "uninstall")
        || completed.targetId !== invocation.targetId
        || (completed.providerId !== undefined && completed.providerId !== invocation.providerId)
        || (completed.result?.appId !== undefined && completed.result.appId !== appAction.appId)) {
        throw new MobileAilohaError("operation_owner_mismatch",
          "The completed app action changed its captured kind, destructive state, provider, target or native app.", 502);
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
      progress.completed = result;
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
    if (typeof operation !== "string" || !operation.trim()
      || typeof mode !== "string" || !["allow", "deny", "ignore", "default"].includes(mode.trim().toLowerCase())) {
      throw new MobileAilohaError("invalid_request", "A named app operation and a supported mode are required.", 400);
    }
    return this.#fencedAppAction(deviceId, requireAppId(bundleId), "app-op", {
      operation: operation.trim().toUpperCase(),
      mode: mode.trim().toLowerCase() === "ignore" ? "ignored" : mode.trim().toLowerCase(),
      signal,
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

  async deviceFeature(name, deviceId, input = {}, { signal } = {}) {
    this.#requireOpen();
      const specification = FEATURES[name];
      if (!specification || !this.#features) unsupported(name);
      const capturedInput = captureFeatureInput(name, deviceId, input);
      const callerSignal = this.#options(signal).signal;
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
        requireNotCancelled(callerSignal);
        const captured = await this.#capture(deviceId, false, undefined, callerSignal);
        requireNotCancelled(callerSignal);
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
          const appId = await this.#features.resolveApp(invocation, capturedInput.bundleId, callerSignal);
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
          ? { appId: await this.#features.resolveApp(invocation, capturedInput.bundleId, callerSignal),
            payload: capturedInput.payload }
          : name === "permission_set"
            ? { appId: await this.#features.resolveApp(invocation, capturedInput.bundleId, callerSignal),
              permission: capturedInput.permission,
              status: { grant: "granted", revoke: "denied", reset: "unknown" }[capturedInput.action] }
            : body;
        await this.#verifyFeatureTarget(invocation, callerSignal);
        this.#requireSnapshot(contextSnapshot);
        this.#requireInvocationOwner(invocation);
        requireNotCancelled(callerSignal);
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
        if (receipt.result !== undefined) {
          requireNotCancelled(callerSignal);
          releaseOperationReceipt(this.#featureState, key, receipt);
          return receipt.result;
        }
        if (!receipt.confirming) {
          const confirmation = (async () => {
            const remaining = Math.max(0, receipt.deadline - performance.now());
            if (remaining === 0) throw new MobileAilohaError("feature_deadline_expired", "The captured feature operation exceeded its original deadline.", 504);
            const operation = await waitForOperationReceipt({
              state: this.#featureState, key, receipt, client: this.#client,
              options: { ...this.#options(), timeoutMs: Math.max(1, Math.ceil(remaining)) },
              retainTerminal: true, outcome: "feature",
              requireOwner: () => this.#requireInvocationOwner(receipt.invocation),
            });
            this.#requireInvocationOwner(receipt.invocation);
            if (operation.operationId !== receipt.operationId
              || operation.destructive !== false
              || operation.kind !== requiredOperation[0] || operation.status !== "succeeded"
              || (operation.targetId !== undefined && operation.targetId !== receipt.invocation.targetId)
              || (operation.providerId !== undefined && operation.providerId !== receipt.invocation.providerId)) {
              throw new MobileAilohaError("operation_owner_mismatch", "Feature completion changed its captured operation or target/provider.", 502);
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
              receipt.result = hardware;
              return hardware;
            }
            if (name === "call") {
              const calls = this.#features.callResult(receipt.invocation, operation.result);
              await this.#verifyFeatureTarget(receipt.invocation);
              receipt.result = calls;
              return calls;
            }
            await this.#verifyFeatureTarget(receipt.invocation);
            receipt.result = name === "sms_send"
              ? publicSnapshot({ success: true, operation: "sms-send", deviceId })
              : name === "notification_push"
                ? publicSnapshot({ success: true, operation: "notification-push", deviceId: null })
              : publicSnapshot({ schemaVersion: "1.0", deviceId,
                platform: receipt.invocation.nativeIdentity.platform, action: capturedInput.action,
                confirmed: receipt.invocation.nativeIdentity.platform === "android" ? operation.result.confirmed : false });
            return receipt.result;
          })();
          receipt.confirming = confirmation;
          const clear = () => { if (receipt.confirming === confirmation) receipt.confirming = null; };
          confirmation.then(clear, clear);
        }
        const result = await (callerSignal
          ? waitForCreationCaller(receipt.confirming, callerSignal) : receipt.confirming);
        requireNotCancelled(callerSignal);
        releaseOperationReceipt(this.#featureState, key, receipt);
        return result;
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
    const feature = (featureName) => this.deviceFeature(featureName, input.deviceId, input, options);
    if (Object.hasOwn(READ_ARTIFACT_FEATURES, name)) return this.readArtifact(name, input);
    if (Object.hasOwn(STAGED_ARTIFACT_FEATURES, name)) return this.stageArtifact(name, input, options);
    if (Object.hasOwn(GUARDED_FILE_FEATURES, name)) {
      return this.guardedFile(name, input, options);
    }
    if (Object.hasOwn(ARTIFACT_FEATURE_GATES, name)) throw artifactFeatureError(name);
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
      case "reveal_device": return this.reveal(input.deviceId, { selectRevealed: true, signal: options.signal });
      case "ui_dump": return this.uiDump(input.deviceId, input.includeRaw ?? false);
      case "ui_find": return this.uiFind(input.deviceId, input);
      case "ui_tap": return this.uiTap(input.deviceId, input, options);
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
      const artifactGate = artifactApiGate(method, path);
      if (artifactGate) {
        if (Object.hasOwn(READ_ARTIFACT_FEATURES, artifactGate)) {
          const deviceId = decodeURIComponent(/^\/api\/v1\/devices\/([^/]+)/.exec(path)[1]);
          return json(await this.readArtifact(artifactGate, { deviceId, ...artifactApiInput(artifactGate, path) }));
        }
        const input = requestBody(body);
        if (Object.hasOwn(STAGED_ARTIFACT_FEATURES, artifactGate)) {
          const deviceId = decodeURIComponent(/^\/api\/v1\/devices\/([^/]+)/.exec(path)[1]);
          return json(await this.stageArtifact(artifactGate, {
            deviceId,
            ...(artifactGate === "mobile_device_file_push"
              ? { input: input.hostPath, path: input.devicePath, bundleId: input.bundleId }
              : { paths: input.hostPaths }),
          }, { signal }));
        }
        if (Object.hasOwn(GUARDED_FILE_FEATURES, artifactGate)) {
          const deviceId = decodeURIComponent(/^\/api\/v1\/devices\/([^/]+)/.exec(path)[1]);
          return json(await this.guardedFile(artifactGate, artifactGate === "mobile_device_file_pull"
            ? { deviceId, path: input.devicePath, output: input.hostPath, bundleId: input.bundleId }
            : { deviceId, path: input.path, bundleId: input.bundleId, recursive: input.recursive },
          { signal }));
        }
        throw artifactFeatureError(artifactGate);
      }
      if (!path.startsWith("/api/v1/") || /[\\#]/.test(path)) {
        throw new MobileAilohaError("invalid_request", "Mobile Canvas accepts only named compatibility API paths.", 400);
      }
      const queryIndex = path.indexOf("?");
      const route = queryIndex < 0 ? path : path.slice(0, queryIndex);
      const query = new URLSearchParams(queryIndex < 0 ? "" : path.slice(queryIndex + 1));
      const queryFields = method === "GET" && /^\/api\/v1\/devices\/[^/]+\/ui$/.test(route) ? ["raw"]
        : method === "GET" && /^\/api\/v1\/devices\/[^/]+\/permissions$/.test(route) ? ["bundleId"]
          : /^\/api\/v1\/devices\/[^/]+\/apps$/.test(route) ? ["text", "system", "limit"]
            : /^\/api\/v1\/devices\/[^/]+\/app-ops$/.test(route) ? ["bundleId"]
              : /^\/api\/v1\/devices\/[^/]+\/apps\/[^/]+\/uninstall$/.test(route) ? ["confirm"] : [];
      if (queryIndex >= 0 && (!queryFields.length
        || [...query.keys()].some((key) => !queryFields.includes(key))
        || [...query.keys()].some((key) => query.getAll(key).length !== 1))) {
        throw new MobileAilohaError("invalid_request", "Unsupported compatibility query.", 400);
      }
      const raw = query.get("raw");
      if (raw !== null && !["true", "false"].includes(raw)) {
        throw new MobileAilohaError("invalid_request", "The System UI raw filter must be a boolean.", 400);
      }
      const includeRaw = raw === "true";
      const input = requestBody(body);
      if (method === "GET" && queryFields.length === 1 && queryFields[0] === "bundleId"
        && route.endsWith("/permissions")) input.bundleId = query.get("bundleId");
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
      const match = /^\/api\/v1\/devices\/([^/]+)(?:\/(.*))?$/.exec(route);
      if (!match) unsupported(path);
      let deviceId;
      try { deviceId = decodeURIComponent(match[1]); }
      catch { throw new MobileAilohaError("invalid_request", "Device selector must be a valid escaped opaque ID.", 400); }
      const operation = match[2] ?? "";
      if (method === "GET" && operation === "ui") return json(await this.uiDump(deviceId, includeRaw));
      if (method === "POST" && operation === "ui/find") return json(await this.uiFind(deviceId, input));
      if (method === "POST" && operation === "ui/tap") return json(await this.uiTap(deviceId, input, { signal }));
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
      if (method === "GET" && operation === "presentation") return json(await this.presentation(deviceId));
      if (method === "POST" && operation === "presentation") return json(await this.presentation(deviceId, input));
      if (method === "GET" && operation === "screenshot") {
        const { bytes } = await this.screenshot(deviceId);
        return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
      }
      if (method === "DELETE" && operation === "") return json(await this.lifecycle("delete", deviceId, input, { signal }));
      if (method === "POST" && operation === "reveal") return json(await this.reveal(deviceId, { selectRevealed: true, signal }));
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
