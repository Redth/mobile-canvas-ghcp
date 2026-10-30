import { AilohaProtocolError } from "./index.mjs";
import { MobileAilohaError } from "./mobile-projection.mjs";
import { isOpaqueId } from "./protocol.mjs";

export function definitiveHttpStatus(status) {
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 499;
}

export function definitiveOperationRejection(error) {
  return error instanceof AilohaProtocolError
    && !error.operationId && !error.operation
    && !["client_disposed", "timeout", "cancelled", "transport_error"].includes(error.code)
    && error.status !== 408 && error.status !== 499
    && (definitiveHttpStatus(error.status)
      || ["invalid_options", "invalid_request", "invalid_identifier", "confirmation_required",
        "request_limit"].includes(error.code));
}

export function releaseOperationReceipt(state, key, receipt) {
  if (state.get(key) === receipt) state.delete(key);
}

export function isDefinitivePreAcceptanceRejection(error) {
  return error instanceof AilohaProtocolError && !error.operationId && !error.operation
    && !["timeout", "cancelled", "transport_error"].includes(error.code)
    && definitiveOperationRejection(error);
}

export function normalizeTypedHttpRejection(error) {
  if (error?.name === "TargetHostTransportError"
    && !error.operationId && !error.operation
    && !error.response?.operationId && !error.response?.operation
    && Number.isInteger(error.status) && error.status >= 400 && error.status < 500
    && (error.response === undefined || error.response.status === error.status)
    && !["RequestTimeout", "RequestAborted"].includes(error.code)) {
    return new AilohaProtocolError("http_error", { status: error.status });
  }
  return error;
}

export function submitOperationReceipt({ state, key, kind, invocation, requireCurrent, submit }) {
  const existing = state.get(key);
  if (existing) return existing;
  requireCurrent();
  if (state.size >= 64) {
    throw new MobileAilohaError("operation_receipt_limit", "The bounded operation receipt pool is full.", 429);
  }
  const receipt = { kind, invocation, operationId: null, submitted: null, uncertain: false, completed: null, accepted: null };
  state.set(key, receipt);
  receipt.submitted = (async () => {
    try {
      const accepted = await submit();
      receipt.operationId = accepted.operationId;
      receipt.accepted = accepted;
    } catch (error) {
      if (error instanceof AilohaProtocolError && error.status === 202 && error.operationId) {
        receipt.operationId = error.operationId;
        return;
      }
      if (error instanceof MobileAilohaError
        && ["app_action_accepted_mismatch", "app_action_owner_mismatch",
          "app_action_attempt_already_submitted", "app_action_accepted_record_unavailable",
          "app_action_delivery_unknown"].includes(error.code)
        && isOpaqueId(error.operationId)) {
        receipt.operationId = error.operationId;
        receipt.recoverableSubmissionError = true;
        throw error;
      }
      const definitive = definitiveOperationRejection(error);
      const rejectedStage = error instanceof MobileAilohaError
        && ["install_rejected", "cleanup_rejected", "context_snapshot_superseded",
          "app_action_rejected", "app_action_stale"].includes(error.code);
      if (definitive || rejectedStage) releaseOperationReceipt(state, key, receipt);
      else receipt.uncertain = true;
      throw error;
    }
  })();
  return receipt;
}

export async function waitForOperationReceipt({
  state, key, receipt, client, options, retainTerminal = false, outcome = "lifecycle", requireOwner = () => {},
}) {
  requireOwner();
  if (receipt.uncertain) {
    throw new MobileAilohaError(`${outcome}_outcome_uncertain`,
      `A previous captured ${outcome} submission has an unknown outcome without a discoverable operation receipt. It will not be submitted again.`, 502);
  }
  if (!receipt.recoverableSubmissionError || !receipt.operationId) await receipt.submitted;
  requireOwner();
  if (receipt.terminalError) throw receipt.terminalError;
  if (receipt.completed) return receipt.completed;
  try {
    return await client.waitForOperation(receipt.operationId, options);
  } catch (error) {
    const operation = error.operation;
    const targetId = receipt.invocation.targetId ?? receipt.accepted?.targetId;
    const matches = operation?.operationId === receipt.operationId
      && (receipt.kind === undefined || operation.kind === receipt.kind)
      && (operation.providerId === undefined || operation.providerId === receipt.invocation.providerId)
      && (targetId === undefined || operation.targetId === undefined || operation.targetId === targetId);
    if (error instanceof AilohaProtocolError && ["operation_failed", "operation_cancelled"].includes(error.code)
      && matches && ["failed", "cancelled"].includes(operation?.status)) {
      if (retainTerminal) receipt.terminalError = error;
      else releaseOperationReceipt(state, key, receipt);
    }
    throw error;
  }
}
