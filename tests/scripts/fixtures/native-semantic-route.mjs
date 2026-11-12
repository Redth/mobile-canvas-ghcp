export const privateRouteMarker = "private-native-route-marker";

// Native success routes omit nullable fields, unlike the full stderr _meta DTO.
export function nativeSemanticOutput(output, request = {}, registrationVersion = 3) {
  const original = output.route;
  const app = original.owner === "agent";
  return {
    ...output,
    route: {
      ...original,
      operation: { app_tree: "get-ui-tree", app_query: "query-elements", app_status: "get-status" }[request.name] ?? "query-elements",
      reason: "explicit-preference",
      description: app ? "The caller required the app agent." : "The caller required the Target Host.",
      agentId: app ? original.agentId : null,
      runtimeInstanceId: app ? original.runtimeInstanceId : null,
      legacyAgentId: app ? "legacy-native" : null,
      agentRegistrationVersion: app ? registrationVersion : null,
      correlation: app ? "matched" : "not-requested",
      executionContext: {
        ...original.executionContext,
        capturedAt: "2026-10-26T14:03:25.712933+00:00",
        selection: {
          targetHostId: original.targetHostId, targetId: original.targetId,
          ...(original.surfaceId ? { surfaceId: original.surfaceId } : {}),
          ...(app ? { agentId: original.agentId, runtimeInstanceId: original.runtimeInstanceId } : {}),
        },
        observed: { ...Object.fromEntries(Object.entries(original.executionContext.observed ?? {})
          .filter(([, value]) => value !== null)), geometryRevision: "1",
        runtimeInstanceEvidence: app ? "verified-native-instance" : "unsupported" },
        provenance: { targetHostId: "explicit", targetId: "explicit", surfaceId: "explicit",
          applicationId: "absent", agentId: app ? "context" : "not-requested",
          runtimeInstanceId: app ? "context" : "not-requested" },
      },
    },
  };
}

export function withPrivateRouteBlobs(output) {
  const route = output.route;
  const context = route.executionContext;
  return { ...output, route: { ...route,
    connectionRef: { serviceId: privateRouteMarker }, ownerStamp: { incarnation: privateRouteMarker },
    unknownRouteBlob: { detail: privateRouteMarker },
    executionContext: { ...context,
      scope: { ...context.scope, unknownScopeBlob: privateRouteMarker },
      selection: { ...context.selection, unknownSelectionBlob: { detail: privateRouteMarker } },
      observed: { ...context.observed, privateEvidence: privateRouteMarker },
      provenance: { ...context.provenance, privateEvidence: privateRouteMarker },
      owner: { processStartedAt: privateRouteMarker }, connectionRef: { serviceId: privateRouteMarker },
      unknownContextBlob: { detail: privateRouteMarker },
    },
  } };
}
