import { target as validateTarget, isOpaqueId } from "./protocol.mjs";
import { MobileAilohaError } from "./mobile-projection.mjs";

export function createAilohaRevealAdapter({ transport, signal }) {
  return Object.freeze({
    async reveal(invocation) {
      if (!isOpaqueId(invocation.targetId)) {
        throw new MobileAilohaError("invalid_identifier", "Reveal requires an opaque target ID.", 400);
      }
      const response = await transport.response(
        `/api/v1/targets/${encodeURIComponent(invocation.targetId)}/actions/reveal`,
        { method: "POST", body: "{}", signal, timeoutMs: 30_000 },
      );
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
