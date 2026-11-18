import { randomUUID } from "node:crypto";
import { AilohaMobileBackend, mobileErrorResult } from "./mobile-backend.mjs";
import { getAilohaContextStore } from "./context-adapter.mjs";
import { connectTargetHostTransport, TARGET_HOST_PROFILE } from "./index.mjs";
import { createAilohaMediaAdapter } from "./media-adapter.mjs";
import { createAilohaDeviceFeatures } from "./device-features.mjs";
import { createAilohaRevealAdapter } from "./reveal-adapter.mjs";
import { createAilohaSystemUiAdapter } from "./system-ui-adapter.mjs";
import { createAilohaControlAdapter } from "./control-adapter.mjs";
import { createAilohaCanvasHost } from "./canvas-host.mjs";
import { captureConnectionRef, MobileAilohaError } from "./mobile-projection.mjs";
import { createVerifiedAilohaCli, hasVerifiedRecordingRecovery, loadAilohaRuntimeSdk } from "./runtime-sdk.mjs";
import { createFencedAppCli } from "./fenced-apps.mjs";
import { createStagedAppCli } from "./staged-apps.mjs";
import { saveAilohaScreenshot } from "./screenshot-artifact.mjs";
import { AilohaRecordingCoordinator } from "./recording-coordinator.mjs";
import { recordingOutputPath } from "./recording-artifact.mjs";
import { createWorkspaceInspectionController } from "./workspace-inspection.mjs";
import { createSemanticInspectionController } from "./semantic-inspection.mjs";
import { callSemanticTool, readNativeAgentCandidates } from "./semantic-mcp.mjs";

const LOST_HOST_CODES = new Set(["RuntimeHostNotFound", "RuntimeHostChanged"]);

export async function createRuntimeMobileBackend({
  scope,
  onEvent,
  onError,
  confirmDestructive,
  allowHostPackage = () => true,
  contextRef,
  scopeEpoch,
  ownerProcessId = process.pid,
  runtime = loadAilohaRuntimeSdk,
  videoState,
  operationState,
  featureState,
  featureOptions,
  revealState,
  systemUiState,
  artifactState,
  recordingState = {},
  allowContextReopen = true,
  finalizeRecordings = false,
  leaseConsumerId = `mobile-canvas-${randomUUID()}`,
  onProgress = () => {},
}) {
  const progress = (stage) => { try { onProgress(stage); } catch { /* presentation only */ } };
  progress("runtime");
  const { sdk, pin } = await runtime();
  const runCli = createVerifiedAilohaCli({ sdk, pin });
  const recordingAvailable = await hasVerifiedRecordingRecovery(runCli);
  progress("context");
  const selectionStore = getAilohaContextStore({ scope, ownerProcessId, runCli, contextRef, scopeEpoch });
  const explicitOpen = contextRef === undefined && allowContextReopen;
  await selectionStore.binding({ allowCreate: explicitOpen, allowReopen: explicitOpen });
  let snapshot = await selectionStore.readSnapshot();
  const requireSnapshot = () => {
    if (!selectionStore.isCurrentSnapshot(snapshot)) {
      throw new MobileAilohaError("context_snapshot_superseded", "The canonical view changed during runtime acquisition.");
    }
  };
  requireSnapshot();
  progress("host");
  const ensure = (selection) => sdk.ensureTargetHost({
    expectedVersion: pin.version,
    consumerId: leaseConsumerId,
    scope,
    ...(selection ? { targetHostId: selection.targetHostId } : {}),
    allowStart: true,
    timeoutMs: 30_000,
  });
  let lease;
  try { lease = await ensure(snapshot.selection); }
  catch (error) {
    // The view still names a Target Host that has exited or been replaced. An explicit open gives
    // the view a fresh authority (so no intent captured against the old host can reach the new one)
    // and starts a host without a pinned identity; the caller then selects again.
    if (!explicitOpen || !snapshot.selection || !LOST_HOST_CODES.has(error?.code)) throw error;
    await selectionStore.replace();
    snapshot = await selectionStore.readSnapshot();
    requireSnapshot();
    if (snapshot.selection) throw error;
    // Sessions and uncertain creations belonged to the host that is gone, so they cannot block or
    // be recovered on the replacement.
    delete videoState?.createUncertain;
    delete videoState?.invocation;
    lease = await ensure(null);
  }
  progress("connecting");
  let client;
  try {
    const connectionRef = captureConnectionRef(lease.connectionRef);
    requireSnapshot();
    const transport = await sdk.openTargetHostTransport(lease.leaseId);
    client = await connectTargetHostTransport(transport, {
      hostId: lease.targetHost.targetHostId, profile: TARGET_HOST_PROFILE, timeoutMs: 15_000,
    });
    requireSnapshot();
    const controller = new AbortController();
    const owner = Object.freeze({
      hostId: lease.targetHost.targetHostId,
      connectionRef,
      registerCleanup: (callback) => sdk.registerRuntimeCleanup(lease.leaseId, callback),
      async release() {
        controller.abort();
        const result = await sdk.releaseRuntimeLease(lease.leaseId);
        if (result.hostDisposition !== "retained" || result.leaseId !== lease.leaseId) {
          throw new MobileAilohaError("runtime_release_invalid", "Ailoha lease release did not retain the shared host.", 502);
        }
      },
    });
    return new AilohaMobileBackend({
      scope, client, owner,
      media: createAilohaMediaAdapter({ transport, client, signal: controller.signal }),
      features: createAilohaDeviceFeatures({
        allowPut: featureOptions?.allowPut === true,
        allowNativeFidelity: featureOptions?.allowNativeFidelity === true,
        transport, signal: controller.signal,
      }), featureState,
      reveal: createAilohaRevealAdapter({ transport, signal: controller.signal }),
      systemUi: createAilohaSystemUiAdapter({ transport, signal: controller.signal }),
      controls: createAilohaControlAdapter({ transport, signal: controller.signal }),
      selectionStore, onEvent, onError, confirmDestructive, videoState, operationState,
      revealState,
      systemUiState,
      allowHostPackage,
      fencedApps: createFencedAppCli({ runCli }),
      stagedApps: createStagedAppCli({ runCli }),
      artifactState, runCli,
      saveScreenshot: saveAilohaScreenshot,
      recording: recordingState.coordinator ??= new AilohaRecordingCoordinator({
        run: runCli, output: recordingOutputPath,
      }),
      recordingAvailable,
      finalizeRecordings,
    });
  } catch (error) {
    client?.dispose();
    await sdk.releaseRuntimeLease(lease.leaseId);
    throw error;
  }
}

export function createRuntimeSemanticInspection(options) {
  return createSemanticInspectionController({
    scope: options.scope, onError: options.onError,
    async readSnapshot(request) {
      const { sdk, pin } = await (options.runtime ?? loadAilohaRuntimeSdk)();
      const runCli = createVerifiedAilohaCli({ sdk, pin });
      const store = getAilohaContextStore({
        scope: options.scope, ownerProcessId: options.ownerProcessId ?? process.pid, runCli,
        contextRef: options.contextRef, scopeEpoch: options.scopeEpoch,
      });
      return store.readSnapshot(request);
    },
    async bindNativeInstance(binding, snapshot, request) {
      const { sdk, pin } = await (options.runtime ?? loadAilohaRuntimeSdk)();
      const store = getAilohaContextStore({
        scope: options.scope, ownerProcessId: options.ownerProcessId ?? process.pid,
        runCli: createVerifiedAilohaCli({ sdk, pin }),
        contextRef: options.contextRef, scopeEpoch: options.scopeEpoch,
      });
      return store.bindNativeInstance(binding, snapshot, request);
    },
    async readCandidates(snapshot, request) {
      const { sdk, pin } = await (options.runtime ?? loadAilohaRuntimeSdk)();
      return readNativeAgentCandidates({ runCli: createVerifiedAilohaCli({ sdk, pin }), snapshot, ...request });
    },
    async callTool(request) {
      const { sdk, pin } = await (options.runtime ?? loadAilohaRuntimeSdk)();
      return callSemanticTool({ ...request, sdk, pin });
    },
  });
}

export function createRuntimeCanvasHost(options) {
  const leaseConsumerId = `mobile-canvas-canvas-${randomUUID()}`;
  const videoState = {};
  const operationState = new Map();
  const featureState = new Map();
  const revealState = new Map();
  const systemUiState = new Map();
  const artifactState = new Map();
  const recordingState = {};
  const workspaceInspection = createWorkspaceInspectionController({
    scope: options.scope,
    validateRoot: options.validateWorkspaceRoot,
    onError: options.onError,
    async runCli(args, request) {
      request.signal.throwIfAborted();
      const { sdk, pin } = await (options.runtime ?? loadAilohaRuntimeSdk)();
      request.signal.throwIfAborted();
      return createVerifiedAilohaCli({ sdk, pin })(args, request);
    },
  });
  const semanticInspection = createRuntimeSemanticInspection(options);
  return createAilohaCanvasHost({
    ...options,
    workspaceInspection,
    semanticInspection,
    async createBackend(context) {
      try {
        return await createRuntimeMobileBackend({
          ...options, ...context, videoState, operationState, featureState, revealState, systemUiState,
          artifactState, recordingState, leaseConsumerId,
          allowContextReopen: context.reason !== "resume",
          finalizeRecordings: true,
        });
      }
      catch (error) {
        const result = mobileErrorResult(error);
        const failure = new MobileAilohaError(result.code, result.message, result.status);
        if (result.contextIdentity) failure.contextIdentity = result.contextIdentity;
        throw failure;
      }
    },
  });
}

export async function getRuntimeContextBinding(scope) {
  const { sdk, pin } = await loadAilohaRuntimeSdk();
  const runCli = createVerifiedAilohaCli({ sdk, pin });
  return getAilohaContextStore({ scope, runCli }).binding({ allowCreate: false, allowReopen: false });
}
