import { MobileAilohaError, publicSnapshot } from "./mobile-projection.mjs";

const stores = new Map();
const IDENTITY = /^(0|[1-9][0-9]{0,127})$/;

function readResult(output, scope, processId) {
  let result;
  try { result = JSON.parse(output); }
  catch { throw new MobileAilohaError("context_invalid_response", "The canonical Ailoha context command did not return JSON.", 502); }
  if (!result || typeof result.ok !== "boolean" || !Object.hasOwn(result, "context") || !Object.hasOwn(result, "error")) {
    throw new MobileAilohaError("context_invalid_response", "The canonical Ailoha context result has an invalid shape.", 502);
  }
  if (!result.ok) {
    const code = result.error?.code;
    const error = new MobileAilohaError(
      typeof code === "string" && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(code) ? code : "context_command_failed",
      "The canonical Ailoha execution context rejected this captured intent. No stale selection retry was attempted.",
    );
    const current = result.error?.current;
    if (typeof current?.contextRef === "string" && typeof current.scopeEpoch === "string"
      && typeof current.revision === "string" && IDENTITY.test(current.revision)
      && ["open", "closed", "detached"].includes(current.state)) {
      error.contextIdentity = publicSnapshot({
        contextRef: current.contextRef, scopeEpoch: current.scopeEpoch, revision: current.revision, state: current.state,
      });
    }
    throw error;
  }
  const context = result.context;
  if (result.error !== null || context?.schema !== "ailoha.execution-context/v1" || context.version !== 1
    || typeof context.contextRef !== "string" || !context.contextRef.startsWith("ctx-")
    || typeof context.scopeEpoch !== "string" || !context.scopeEpoch
    || typeof context.revision !== "string" || !IDENTITY.test(context.revision)
    || context.scope?.sessionId !== scope.sessionId || context.scope?.viewId !== scope.viewId
    || context.owner?.processId !== processId || typeof context.owner.processStartedAt !== "string"
    || !["open", "closed", "detached"].includes(context.state)
    || !Object.hasOwn(context, "selection") || !Object.hasOwn(context, "observed")) {
    throw new MobileAilohaError("context_identity_mismatch", "Ailoha returned a different execution-context owner or scope.", 502);
  }
  return publicSnapshot(context);
}

export function createAilohaContextStore({ scope, ownerProcessId = process.pid, runCli, contextRef, scopeEpoch }) {
  const capturedScope = publicSnapshot(scope);
  let document = null;
  let opening = null;
  let generation = 0;

  const identity = (context) => Object.freeze({ scopeEpoch: context.scopeEpoch, revision: context.revision });
  const projection = (context) => ({
    contextRef: context.contextRef, scopeEpoch: context.scopeEpoch, revision: context.revision, ownerProcessId,
  });
  const command = async (args) => readResult(await runCli([...args, "--json"]), capturedScope, ownerProcessId);

  async function readDocument() {
    const ref = document?.contextRef ?? contextRef;
    const epoch = document?.scopeEpoch ?? scopeEpoch;
    if (!ref || !epoch) {
      throw new MobileAilohaError("context_not_bound", "Explicitly bind this trusted view before reading its Ailoha context.");
    }
    const version = generation;
    const result = await command(["context", "get", ref, "--scope-epoch", epoch]);
    if (result.contextRef !== ref || result.scopeEpoch !== epoch) {
      throw new MobileAilohaError("context_identity_mismatch", "The named context read returned another reference or epoch.", 502);
    }
    if (version !== generation || (document?.scopeEpoch === result.scopeEpoch
      && BigInt(result.revision) < BigInt(document.revision))) {
      throw new MobileAilohaError("context_read_superseded", "A context change retired this pending read.");
    }
    document = result;
    return document;
  }

  function requireOpenDocument() {
    if (!document || document.state !== "open") {
      throw new MobileAilohaError("context_retired", "This Ailoha view authority is not open; only explicit trusted view binding may reopen it.");
    }
    return document;
  }

  async function openDocument(expected) {
    if (!opening) {
      const version = ++generation;
      opening = command(["context", "open", "--request-json", JSON.stringify({
        scope: capturedScope, ownerProcessId, ...(expected ? { expected } : {}),
      })]).then((result) => {
        if (version !== generation) throw new MobileAilohaError("context_open_superseded", "A newer view authority superseded this open.");
        document = result;
        return result;
      });
    }
    const pending = opening;
    try { return await pending; }
    finally { if (opening === pending) opening = null; }
  }

  async function readSnapshot() {
    const context = await readDocument();
    let selection = null;
    if (context.state === "open" && context.selection !== null) {
      const captured = context.selection;
      if (!captured || typeof captured !== "object" || captured.applicationId != null || captured.agentId != null
        || captured.runtimeInstanceId != null) {
        throw new MobileAilohaError("semantic_context_unsupported", "The target-only Ailoha opt-in cannot adopt app-agent or instance selection.");
      }
      if (captured.targetHostId != null || captured.targetId != null || captured.surfaceId != null) {
        if (typeof captured.targetHostId !== "string" || typeof captured.targetId !== "string") {
          throw new MobileAilohaError("context_selection_incomplete", "The named Ailoha target context is incomplete.");
        }
        selection = {
          targetHostId: captured.targetHostId,
          targetId: captured.targetId,
          ...(captured.surfaceId != null ? { surfaceId: captured.surfaceId } : {}),
        };
      }
    }
    return publicSnapshot({
      selection, state: context.state, identity: identity(context),
      ...(context.state === "open" ? { contextProjection: projection(context) } : {}),
    });
  }

  return Object.freeze({
    get identity() { return document ? identity(document) : undefined; },
    get state() { return document?.state; },
    get contextProjection() {
      return document?.state === "open" ? publicSnapshot(projection(document)) : undefined;
    },
    readSnapshot,
    isCurrentSnapshot(snapshot) {
      const current = document;
      return current?.state === "open" && snapshot.state === current.state
        && snapshot.contextProjection?.contextRef === current.contextRef
        && snapshot.contextProjection?.ownerProcessId === ownerProcessId
        && snapshot.identity?.scopeEpoch === current.scopeEpoch && snapshot.identity?.revision === current.revision;
    },
    assertBinding(ref, epoch) {
      const actualRef = document?.contextRef ?? contextRef;
      const actualEpoch = document?.scopeEpoch ?? scopeEpoch;
      if ((ref !== undefined && ref !== actualRef) || (epoch !== undefined && epoch !== actualEpoch)) {
        throw new MobileAilohaError("context_binding_mismatch", "The explicit named context differs from the cached live view binding.");
      }
    },
    async binding({ allowCreate = true, allowReopen = true } = {}) {
      let context;
      if (!document && !contextRef) {
        if (!allowCreate) throw new MobileAilohaError("context_not_bound", "A named Ailoha context is required; startup cannot infer a view.");
        context = await openDocument();
      } else context = await readDocument();
      if (context.state !== "open") {
        if (!allowReopen) throw new MobileAilohaError("context_retired", "The named Ailoha view is retired; background binding cannot reopen it.");
        context = await openDocument(identity(context));
      }
      return publicSnapshot({ contextRef: context.contextRef, scopeEpoch: context.scopeEpoch, scope: capturedScope, ownerProcessId });
    },
    async read() {
      return (await readSnapshot()).selection;
    },
    async set(selection, expected) {
      const context = requireOpenDocument();
      const version = ++generation;
      const captured = expected ?? identity(context);
      const result = await command(["context", "select", "--request-json", JSON.stringify({
        contextRef: context.contextRef,
        expected: captured,
        selection: {
          workspaceId: null, applicationId: null, targetHostId: selection.targetHostId,
          targetId: selection.targetId, surfaceId: selection.surfaceId ?? null,
          agentId: null, runtimeInstanceId: null,
        },
      })]);
      if (version !== generation || (document?.scopeEpoch === result.scopeEpoch
        && BigInt(result.revision) < BigInt(document.revision))) {
        throw new MobileAilohaError("context_write_superseded", "A newer view context superseded this selection result.");
      }
      if (result.contextRef !== context.contextRef || result.scopeEpoch !== captured.scopeEpoch) {
        throw new MobileAilohaError("context_identity_mismatch", "The selection result changed its captured view authority.", 502);
      }
      document = result;
    },
    async clear() {
      if (document?.state === "detached" || document?.state === "closed") return;
      const context = requireOpenDocument();
      const version = ++generation;
      const result = await command(["context", "detach", "--request-json", JSON.stringify({
        contextRef: context.contextRef, expected: identity(context),
      })]);
      if (version !== generation) throw new MobileAilohaError("context_write_superseded", "A newer authority intent superseded this detach.");
      if (result.contextRef !== context.contextRef || result.scopeEpoch !== context.scopeEpoch || result.state !== "detached") {
        throw new MobileAilohaError("context_identity_mismatch", "Ailoha did not tombstone the captured view authority.", 502);
      }
      document = result;
    },
  });
}

export function getAilohaContextStore(options) {
  const key = JSON.stringify([options.scope.sessionId, options.scope.viewId, options.ownerProcessId ?? process.pid]);
  let store = stores.get(key);
  if (!store) {
    store = createAilohaContextStore(options);
    stores.set(key, store);
  } else store.assertBinding(options.contextRef, options.scopeEpoch);
  return store;
}
