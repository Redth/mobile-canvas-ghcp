import {
  AilohaProtocolError,
  connectTargetHost,
  type Operation,
  type OperationStatus,
  type CatalogDescriptor,
  type RuntimeDescriptor,
  type TargetTypeDescriptor,
  type TemplateDescriptor,
  type ProviderDiagnostics,
  type SucceededOperation,
  type TargetHostConnection,
} from "../../lib/ailoha/index.mjs";

async function exercise(connection: TargetHostConnection, signal: AbortSignal) {
  const client = await connectTargetHost(connection, { signal, timeoutMs: 1000 });
  try {
    const catalogs: CatalogDescriptor[] = await client.listProviderCatalogs("provider/opaque", { signal });
    const runtimes: RuntimeDescriptor[] = await client.listProviderRuntimes("provider/opaque", { signal });
    const types: TargetTypeDescriptor[] = await client.listProviderTargetTypes("provider/opaque", { signal });
    const templates: TemplateDescriptor[] = await client.listProviderTemplates("provider/opaque", { signal });
    const diagnostics: ProviderDiagnostics = await client.getProviderDiagnostics("provider/opaque", { signal });
    void [catalogs, runtimes, types, templates, diagnostics];
    // @ts-expect-error Catalog lookup requires an explicit provider identity.
    await client.listProviderRuntimes();
    // @ts-expect-error Provider catalog reads do not accept mutation options.
    await client.listProviderTargetTypes("provider/opaque", { confirmed: true });
    // @ts-expect-error Runtime metadata is JSON, not arbitrary executable values.
    const invalidRuntime: RuntimeDescriptor = { runtimeId: "runtime", providerId: "provider", name: "", platform: "ios", version: "", metadata: { callback: () => {} } };
    void invalidRuntime;
    const created: Operation = await client.createTarget({
      providerId: "provider/opaque",
      targetTypeId: "type/opaque",
      runtimeId: "runtime/opaque",
      templateId: "template/opaque",
      name: "",
      labels: { fixture: "true" },
      configuration: { nested: { enabled: false }, values: [null, 1, "opaque"] },
      start: false,
    }, { signal });
    const accepted: Operation = await client.startTarget("target/opaque", {
      signal, request: { reason: "", options: { enabled: false }, requestId: "request/opaque" },
    });
    await client.stopTarget("target/opaque", { signal });
    await client.rebootTarget("target/opaque", { request: {} });
    await client.resetTarget("target/opaque", { confirmed: true, signal, request: { reason: "reset" } });
    await client.deleteTarget("target/opaque", { confirmed: true, signal });
    const operations: Operation[] = await client.listOperations({ signal, targetId: "target/opaque", status: "cancelling" });
    const operation: Operation = await client.getOperation(created.operationId, { signal });
    const cancellation: Operation = await client.cancelOperation(accepted.operationId, { signal });
    const status: OperationStatus = cancellation.status;
    const completed: SucceededOperation = await client.waitForOperation(operation.operationId, {
      signal, timeoutMs: 1000, pollIntervalMs: 1,
    });
    const succeeded: "succeeded" = completed.status;
    void [operations, status, succeeded, completed.result];

    // @ts-expect-error Reset requires an explicit confirmation signal.
    await client.resetTarget("target/opaque");
    // @ts-expect-error Delete requires an explicit confirmation signal.
    await client.deleteTarget("target/opaque", { signal });
    // @ts-expect-error False is not confirmation.
    await client.resetTarget("target/opaque", { confirmed: false });
    // @ts-expect-error Confirmation is not a server request field.
    await client.resetTarget("target/opaque", { confirmed: true, request: { confirmed: true } });
    // @ts-expect-error Create requires a target type.
    await client.createTarget({ providerId: "provider/opaque" });
    // @ts-expect-error Create start is boolean, not a truthy number.
    await client.createTarget({ providerId: "provider/opaque", targetTypeId: "type/opaque", start: 1 });
    // @ts-expect-error Provider configuration contains JSON values only.
    await client.createTarget({ providerId: "provider/opaque", targetTypeId: "type/opaque", configuration: { value: 1n } });
    // @ts-expect-error Cancellation does not accept a request body.
    await client.cancelOperation(created.operationId, { request: {} });
    // @ts-expect-error Accepted is not an operation status.
    await client.listOperations({ status: "accepted" });
    // @ts-expect-error A submitted operation is not necessarily succeeded.
    const premature: SucceededOperation = created;
    void premature;
  } catch (error) {
    if (error instanceof AilohaProtocolError) {
      const operationId: string | undefined = error.operationId;
      const operation: Operation | undefined = error.operation;
      const result = error.toJSON();
      void [operationId, operation, result.operationId, result.operation, result.problem];
    } else {
      throw error;
    }
  } finally {
    client.dispose();
  }
}

void exercise;
