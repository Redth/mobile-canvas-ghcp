import { randomUUID } from "node:crypto";
import { AilohaProtocolError, TARGET_HOST_PROFILE } from "./index.mjs";
import { ARTIFACT_FEATURE_GATES, artifactApiGate, artifactFeatureError } from "./artifact-features.mjs";
import { projectFileListing } from "./artifact-file-projection.mjs";
import { projectDeviceLogs, projectDeviceCrashes, projectDeviceCrashReport } from "./artifact-diagnostics-projection.mjs";
import { artifactApiInput, artifactFilePath, artifactQueryLimit, artifactQueryText } from "./artifact-read-input.mjs";
import { captureCreateInput, loadMobileCatalog, resolveCreateChoice } from "./mobile-catalog.mjs";
import { isOpaqueId } from "./protocol.mjs";
import { releaseOperationReceipt, submitOperationReceipt, waitForOperationReceipt } from "./operation-receipts.mjs";
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
const READ_ARTIFACT_FEATURES = Object.freeze({
  mobile_device_file_list: ["target.files", "queryTargetFiles"],
  mobile_device_log: ["target.diagnostics", "queryTargetLogs"],
  mobile_device_crashes: ["target.diagnostics", "queryTargetCrashes"],
  mobile_device_crash_report: ["target.diagnostics", "getTargetCrashDetail"],
});
const LOG_LEVELS = Object.freeze({
  verbose: "trace", debug: "debug", info: "info", warning: "warning", error: "error", fatal: "critical",
});

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
  #confirmDestructive;
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
    scope, owner, client, media, selectionStore, confirmDestructive, saveScreenshot,
    videoState = {}, operationState = new Map(), onEvent = () => {}, onError = () => {},
  }) {
    this.#scope = publicSnapshot({ sessionId: scope.sessionId, viewId: scope.viewId });
    this.#client = client;
    this.#media = media;
    this.#selectionStore = selectionStore;
    this.#confirmDestructive = confirmDestructive;
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

  #options() { return { signal: this.#lifetime.signal }; }

  async #record(targetId, surfaceId) {
    this.#requireOpen();
    const [target, providers, capabilities] = await Promise.all([
      this.#client.getTarget(targetId, this.#options()),
      this.#client.listProviders(this.#options()),
      this.#client.getTargetCapabilities(targetId, this.#options()),
    ]);
    const provider = providers.find((entry) => entry.providerId === target.providerId);
    if (!provider) throw new MobileAilohaError("provider_unavailable", "Ailoha target provider is not in the current inventory.");
    const surface = target.surfaces.length === 1 && surfaceId === undefined
      ? target.surfaces[0] : target.surfaces.find((entry) => entry.surfaceId === surfaceId);
    const supported = Object.fromEntries(Object.entries(LIFECYCLE).map(([name, [operation]]) => [
      name, hasOperation(capabilities, operation, "target.lifecycle")
        && (!(name === "erase" || name === "delete") || typeof this.#confirmDestructive === "function"),
    ]));
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
          && (!(name === "erase" || name === "delete") || typeof this.#confirmDestructive === "function"),
      ]));
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
      const apps = await this.#client.listTargetApps(invocation.targetId, options);
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

  async lifecycle(action, deviceId, input = {}) {
    const specification = LIFECYCLE[action];
    if (!specification) unsupported(action);
    if (action === "erase" || action === "delete") {
      const descriptor = Object.getOwnPropertyDescriptor(input, "confirm");
      if (!descriptor || descriptor.value !== true) {
        throw new MobileAilohaError("confirmation_required", "This action requires an own literal confirm: true.");
      }
      if (!this.#confirmDestructive) unsupported("Scoped destructive consent");
    }
    const [method, expectedState] = specification;
    const key = JSON.stringify([this.#owner.hostId, deviceId, action]);
    let receipt = this.#operationState.get(key);
    if (receipt) this.#requireInvocationOwner(receipt.invocation);
    if (!receipt) {
      const { invocation, capabilities, contextSnapshot } = await this.#capture(deviceId);
      if (!hasOperation(capabilities, method, "target.lifecycle")) unsupported(action);
      if (this.#operationState.size >= 64 && !this.#operationState.has(key)) {
        throw new MobileAilohaError("operation_receipt_limit", "The bounded lifecycle receipt pool is full.", 429);
      }
      let options = this.#options();
      if (action === "erase" || action === "delete") {
        if (await this.#confirmDestructive(publicSnapshot({ action, invocation })) !== true) {
          throw new MobileAilohaError("consent_denied", "The captured destructive operation was not approved.", 403);
        }
        options = { ...options, confirmed: true };
      }
      this.#requireOpen();
      this.#requireInvocationOwner(invocation);
      receipt = submitOperationReceipt({
        state: this.#operationState, key, kind: method, invocation,
        requireCurrent: () => {
          this.#requireInvocationOwner(invocation);
          this.#requireSnapshot(contextSnapshot);
        },
        submit: () => this.#client[method](invocation.targetId, options),
      });
    }
    this.#requireOpen();
    this.#requireInvocationOwner(receipt.invocation);
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
          && !(error instanceof MobileAilohaError && error.status < 500)
          && !(error instanceof AilohaProtocolError && error.status >= 400 && error.status < 500)
          && !(error?.name === "TargetHostTransportError" && error.status >= 400 && error.status < 500);
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

  async invokeAction(name, input = {}) {
    if (Object.hasOwn(READ_ARTIFACT_FEATURES, name)) return this.readArtifact(name, input);
    if (Object.hasOwn(ARTIFACT_FEATURE_GATES, name)) throw artifactFeatureError(name);
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
      case "erase_device": return this.lifecycle("erase", input.deviceId, input);
      case "delete_device": return this.lifecycle("delete", input.deviceId, input);
      case "tap_device": return this.input("tap", input.deviceId, input);
      case "long_press_device": return this.input("tap", input.deviceId, { ...input, duration: input.duration ?? 1 });
      case "swipe_device": return this.input("swipe", input.deviceId, input);
      case "take_screenshot": {
        if (!this.#saveScreenshot) unsupported("Persistent screenshot artifacts");
        const { invocation, bytes } = await this.screenshot(input.deviceId);
        return this.#saveScreenshot(bytes, input, invocation);
      }
      default: unsupported(name);
    }
  }

  async request(path, { method = "GET", body } = {}) {
    try {
      this.#requireOpen();
      const artifactGate = artifactApiGate(method, path);
      if (artifactGate) {
        if (method !== "GET") requestBody(body);
        if (Object.hasOwn(READ_ARTIFACT_FEATURES, artifactGate)) {
          const deviceId = decodeURIComponent(/^\/api\/v1\/devices\/([^/]+)/.exec(path)[1]);
          return json(await this.readArtifact(artifactGate, { deviceId, ...artifactApiInput(artifactGate, path) }));
        }
        throw artifactFeatureError(artifactGate);
      }
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
        }, { selectCreated: true }));
      }
      if (method === "GET" && path === "/api/v1/selection") return json(await this.getSelected());
      if (method === "POST" && path === "/api/v1/selection") return json(await this.select(input.deviceId, input));
      if (method === "POST" && path === "/api/v1/canvas/detach") {
        this.#detached = true;
        this.#generation += 1;
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
      if (method === "GET" && operation === "screenshot") {
        const { bytes } = await this.screenshot(deviceId);
        return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
      }
      if (method === "DELETE" && operation === "") return json(await this.lifecycle("delete", deviceId, input));
      if (method === "POST" && Object.hasOwn(LIFECYCLE, operation)) return json(await this.lifecycle(operation, deviceId, input));
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
