import { AilohaMobileBackend, mobileErrorResult } from "./mobile-backend.mjs";
import { getAilohaContextStore } from "./context-adapter.mjs";
import { connectTargetHostTransport, TARGET_HOST_PROFILE } from "./index.mjs";
import { createAilohaMediaAdapter } from "./media-adapter.mjs";
import { createAilohaCanvasHost } from "./canvas-host.mjs";
import { MobileAilohaError } from "./mobile-projection.mjs";
import { createVerifiedAilohaCli, loadAilohaRuntimeSdk } from "./runtime-sdk.mjs";
import { saveAilohaScreenshot } from "./screenshot-artifact.mjs";
import { createWorkspaceInspectionController } from "./workspace-inspection.mjs";

export async function createRuntimeMobileBackend({
  scope,
  onEvent,
  onError,
  confirmDestructive,
  contextRef,
  scopeEpoch,
  ownerProcessId = process.pid,
  runtime = loadAilohaRuntimeSdk,
  videoState,
  operationState,
  allowContextReopen = true,
}) {
  const { sdk, pin } = await runtime();
  const runCli = createVerifiedAilohaCli({ sdk, pin });
  const selectionStore = getAilohaContextStore({ scope, ownerProcessId, runCli, contextRef, scopeEpoch });
  await selectionStore.binding({
    allowCreate: contextRef === undefined && allowContextReopen,
    allowReopen: contextRef === undefined && allowContextReopen,
  });
  const snapshot = await selectionStore.readSnapshot();
  const requireSnapshot = () => {
    if (!selectionStore.isCurrentSnapshot(snapshot)) {
      throw new MobileAilohaError("context_snapshot_superseded", "The canonical view changed during runtime acquisition.");
    }
  };
  requireSnapshot();
  const { selection } = snapshot;
  const lease = await sdk.ensureTargetHost({
    expectedVersion: pin.version,
    consumerId: "mobile-canvas",
    scope,
    ...(selection ? { targetHostId: selection.targetHostId } : {}),
    allowStart: true,
    timeoutMs: 30_000,
  });
  let client;
  try {
    requireSnapshot();
    const transport = await sdk.openTargetHostTransport(lease.leaseId);
    client = await connectTargetHostTransport(transport, {
      hostId: lease.targetHost.targetHostId, profile: TARGET_HOST_PROFILE, timeoutMs: 15_000,
    });
    requireSnapshot();
    const controller = new AbortController();
    const owner = {
      hostId: lease.targetHost.targetHostId,
      registerCleanup: (callback) => sdk.registerRuntimeCleanup(lease.leaseId, callback),
      async release() {
        controller.abort();
        const result = await sdk.releaseRuntimeLease(lease.leaseId);
        if (result.hostDisposition !== "retained" || result.leaseId !== lease.leaseId) {
          throw new MobileAilohaError("runtime_release_invalid", "Ailoha lease release did not retain the shared host.", 502);
        }
      },
    };
    return new AilohaMobileBackend({
      scope, client, owner,
      media: createAilohaMediaAdapter({ transport, client, signal: controller.signal }),
      selectionStore, onEvent, onError, confirmDestructive, videoState, operationState,
      saveScreenshot: saveAilohaScreenshot,
    });
  } catch (error) {
    client?.dispose();
    await sdk.releaseRuntimeLease(lease.leaseId);
    throw error;
  }
}

export function createRuntimeCanvasHost(options) {
  const videoState = {};
  const operationState = new Map();
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
  return createAilohaCanvasHost({
    ...options,
    workspaceInspection,
    async createBackend(context) {
      try {
        return await createRuntimeMobileBackend({
          ...options, ...context, videoState, operationState, allowContextReopen: context.reason !== "resume",
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
