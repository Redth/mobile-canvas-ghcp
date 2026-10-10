import { AilohaProtocolError } from "./index.mjs";
import { MobileAilohaError } from "./mobile-projection.mjs";

export function releaseOperationReceipt(state, key, receipt) {
  if (state.get(key) === receipt) state.delete(key);
}

export function submitOperationReceipt({ state, key, invocation, requireCurrent, submit }) {
  const existing = state.get(key);
  if (existing) return existing;
  requireCurrent();
  if (state.size >= 64) {
    throw new MobileAilohaError("operation_receipt_limit", "The bounded operation receipt pool is full.", 429);
  }
  const receipt = { invocation, operationId: null, submitted: null, uncertain: false, completed: null, accepted: null };
  state.set(key, receipt);
  receipt.submitted = (async () => {
    try {
      const accepted = await submit();
      receipt.operationId = accepted.operationId;
      receipt.accepted = accepted;
    } catch (error) {
      if (error instanceof AilohaProtocolError && error.status === 202 && error.operationId) {
        receipt.operationId = error.operationId;
        receipt.accepted = error.operation ?? null;
        return;
      }
      const definitive = error instanceof AilohaProtocolError
        && ((error.status >= 400 && error.status < 500)
          || ["invalid_options", "invalid_request", "invalid_identifier", "confirmation_required",
            "request_limit", "client_disposed"].includes(error.code));
      if (definitive) releaseOperationReceipt(state, key, receipt);
      else receipt.uncertain = true;
      throw error;
    }
  })();
  return receipt;
}

export async function waitForOperationReceipt({
  state, key, receipt, client, options, retainTerminal = false, outcome = "lifecycle",
}) {
  if (receipt.uncertain) {
    throw new MobileAilohaError(`${outcome}_outcome_uncertain`,
      `A previous captured ${outcome} submission has an unknown outcome without a discoverable operation receipt. It will not be submitted again.`, 502);
  }
  await receipt.submitted;
  if (receipt.terminalError) throw receipt.terminalError;
  if (receipt.completed) return receipt.completed;
  try {
    return await client.waitForOperation(receipt.operationId, options);
  } catch (error) {
    if (error instanceof AilohaProtocolError && ["failed", "cancelled"].includes(error.operation?.status)) {
      if (retainTerminal) receipt.terminalError = error;
      else releaseOperationReceipt(state, key, receipt);
    }
    throw error;
  }
}
