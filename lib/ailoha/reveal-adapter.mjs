import { target as validateTarget, isOpaqueId } from "./protocol.mjs";
import { MobileAilohaError } from "./mobile-projection.mjs";
import { AilohaProtocolError } from "./errors.mjs";

export function createAilohaRevealAdapter({ transport, signal }) {
  return Object.freeze({
    async reveal(invocation) {
      if (!isOpaqueId(invocation.targetId)) {
        throw new MobileAilohaError("invalid_identifier", "Reveal requires an opaque target ID.", 400);
      }
      let response;
      try {
        response = await transport.response(
          `/api/v1/targets/${encodeURIComponent(invocation.targetId)}/actions/reveal`,
          { method: "POST", body: "{}", signal, timeoutMs: 30_000 },
        );
      } catch (error) {
        if (error?.name === "TargetHostTransportError"
          && Number.isInteger(error.status) && error.status >= 400 && error.status < 500
          && (error.response === undefined || error.response.status === error.status)
          && !["RequestTimeout", "RequestAborted"].includes(error.code)) {
          throw new AilohaProtocolError("http_error", { status: error.status });
        }
        throw error;
      }
      if (response.status >= 400 && response.status < 500) {
        throw new AilohaProtocolError("http_error", { status: response.status });
      }
      if (response.status !== 200 || response.contentType?.split(";", 1)[0] !== "application/json") {
        throw new MobileAilohaError("invalid_reveal_response", "Canonical reveal did not return a target.", 502);
      }
      validateTarget(response.body);
      const native = response.body.nativeIdentity;
      const expected = invocation.nativeIdentity;
      if (response.body.targetId !== invocation.targetId
        || response.body.providerId !== invocation.providerId
        || response.body.status !== "running"
        || !native || !expected || native.platform !== expected.platform
        || native.nativeId !== expected.nativeId || native.serial !== expected.serial
        || native.provider !== expected.provider || native.isVirtual !== expected.isVirtual
        || native.modelIdentifier !== expected.modelIdentifier || native.osVersion !== expected.osVersion) {
        throw new MobileAilohaError("reveal_owner_mismatch", "Canonical reveal returned a different native target.", 502);
      }
      return response.body;
    },
  });
}
