import { MobileAilohaError } from "./mobile-projection.mjs";
import { isOpaqueId } from "./protocol.mjs";

const ERRORS = new Set([
  "AgentCandidatesRequestInvalid", "AgentCandidatesBrokerUnavailable", "AgentCandidatesBrokerInvalid",
  "AgentCandidatesInventoryInvalid", "AgentCandidatesAmbiguous", "AgentCandidatesLimitExceeded",
]);

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function targetId(value) {
  return isOpaqueId(value) && value.length <= 128 && value.trim().length > 0
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

// JSON.parse collapses duplicate keys, including escaped aliases. Inspect the
// already syntax-checked wire text before adopting any identity or error.
function hasBoundedUniqueProperties(raw) {
  const stack = [];
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "{" || character === "[") {
      if (stack.length === 3) return false;
      stack.push(character === "{" ? new Set() : null);
    } else if (character === "}" || character === "]") {
      stack.pop();
    } else if (character === '"') {
      const start = index;
      index += 1;
      while (index < raw.length && raw[index] !== '"') {
        index += raw[index] === "\\" ? 2 : 1;
      }
      let next = index + 1;
      while (next < raw.length && " \t\r\n".includes(raw[next])) next += 1;
      if (raw[next] === ":") {
        const key = JSON.parse(raw.slice(start, index + 1));
        const keys = stack.at(-1);
        if (!keys || keys.has(key)) return false;
        keys.add(key);
      }
    }
  }
  return true;
}

export function parseAgentCandidates(raw, { targetHostId, targetId: selectedTargetId }) {
  const invalid = () => {
    throw new MobileAilohaError("semantic_candidates_invalid",
      "Canonical candidate inventory did not preserve its bounded schema, exact target and known native-instance evidence.", 502);
  };
  let value;
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 512 * 1024) invalid();
    value = JSON.parse(raw);
    if (!hasBoundedUniqueProperties(raw)) invalid();
  } catch {
    invalid();
  }
  if (!exactKeys(value, ["schema", "ok", "targetHostId", "targetId", "candidates", "error"])
    || !["ailoha.agent.candidates/v1", "ailoha.agent.candidates/v2"].includes(value.schema)
    || typeof value.ok !== "boolean") invalid();
  const pairMatches = targetId(targetHostId) && targetId(selectedTargetId)
    && value.targetHostId === targetHostId && value.targetId === selectedTargetId;
  if (!value.ok) {
    if (value.schema !== "ailoha.agent.candidates/v1" || value.candidates !== null
      || !exactKeys(value.error, ["code", "message"]) || !ERRORS.has(value.error.code)
      || typeof value.error.message !== "string" || !value.error.message || value.error.message.length > 2048
      || (!pairMatches && !(value.error.code === "AgentCandidatesRequestInvalid"
        && value.targetHostId === null && value.targetId === null))) invalid();
    return value;
  }
  if (!pairMatches || value.error !== null || !Array.isArray(value.candidates) || value.candidates.length > 256) invalid();
  const ids = new Set();
  const runtimes = new Set();
  let hasV3 = false;
  for (const candidate of value.candidates) {
    if (!exactKeys(candidate, ["agentId", "runtimeInstanceId", "registrationVersion", "targetHostId", "targetId"])
      || ![2, 3].includes(candidate.registrationVersion) || typeof candidate.runtimeInstanceId !== "string"
      || !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.runtimeInstanceId)
      || candidate.agentId !== `agent-${candidate.runtimeInstanceId}`
      || candidate.targetHostId !== targetHostId || candidate.targetId !== selectedTargetId
      || ids.has(candidate.agentId) || runtimes.has(candidate.runtimeInstanceId)) invalid();
    ids.add(candidate.agentId);
    runtimes.add(candidate.runtimeInstanceId);
    hasV3 ||= candidate.registrationVersion === 3;
  }
  if (value.schema !== `ailoha.agent.candidates/v${hasV3 ? 2 : 1}`) invalid();
  return value;
}
