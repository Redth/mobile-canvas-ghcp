export const exchangeOutcome = (changes = {}) => ({
  requestId: "a".repeat(32), commitAttempted: true, admitted: true,
  completed: false, effectMayBeUnknown: true, errorCode: "transport-failed", ...changes,
});

export function nativeInvocationMetadata(snapshot, scope, exchange = exchangeOutcome()) {
  return {
    "ailoha.executionContext": {
      contextRef: snapshot.contextProjection.contextRef, scope: { ...scope },
      scopeEpoch: snapshot.identity.scopeEpoch, revision: snapshot.identity.revision,
      capturedAt: "2026-10-25T22:30:00+00:00",
      selection: { workspaceId: null, applicationId: null, targetHostId: snapshot.selection.targetHostId,
        targetId: snapshot.selection.targetId, surfaceId: snapshot.selection.surfaceId ?? null,
        agentId: snapshot.selection.agentId ?? null, runtimeInstanceId: snapshot.selection.runtimeInstanceId ?? null },
      observed: { hostInstanceId: snapshot.contextProjection.hostInstanceId ?? null, geometryRevision: null,
        coordinateSpace: null, applicationEvidence: null,
        runtimeInstanceEvidence: snapshot.contextProjection.runtimeInstanceEvidence },
      provenance: { targetHostId: "explicit", targetId: "explicit", surfaceId: "explicit",
        applicationId: "absent", agentId: "context", runtimeInstanceId: "context" },
    },
    ...(exchange ? { "ailoha.agentExchange": exchange } : {}),
  };
}
