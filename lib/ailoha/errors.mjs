const messages = {
  invalid_connection: "Ailoha requires an explicit, valid host-side loopback connection.",
  invalid_options: "Invalid Ailoha client request options.",
  invalid_identifier: "Invalid Ailoha opaque identifier.",
  invalid_request: "Invalid Ailoha mutation request.",
  confirmation_required: "An explicit caller confirmation signal is required for this destructive action.",
  incompatible_profile: "The selected host does not implement the Ailoha Target Host v1 profile.",
  host_identity_mismatch: "The authenticated Ailoha host does not match the selected host identity.",
  target_identity_mismatch: "The Ailoha response does not match the requested target identity.",
  operation_identity_mismatch: "The Ailoha response does not match the requested operation.",
  operation_failed: "The Ailoha operation failed.",
  operation_cancelled: "The Ailoha operation was authoritatively cancelled.",
  invalid_response: "Ailoha returned a malformed or unexpected protocol response.",
  credential_exposure: "Ailoha returned protected connection data instead of a public resource.",
  redirect_rejected: "Ailoha redirects are not permitted.",
  response_too_large: "The Ailoha response exceeded the configured size limit.",
  request_too_large: "The Ailoha mutation request exceeded the size limit.",
  timeout: "The Ailoha request exceeded the configured timeout.",
  cancelled: "The Ailoha request was cancelled.",
  transport_error: "The selected Ailoha host could not complete the HTTP request.",
  client_disposed: "The Ailoha client has been disposed.",
  request_limit: "The Ailoha client has reached its concurrent request limit.",
  http_error: "The Ailoha host refused the request.",
};

export class AilohaProtocolError extends Error {
  constructor(code, { status, problem, operationId, operation, transportCode } = {}) {
    super(messages[code] ?? messages.invalid_response);
    this.name = "AilohaProtocolError";
    this.code = Object.hasOwn(messages, code) ? code : "invalid_response";
    if (status !== undefined) this.status = status;
    if (problem !== undefined) this.problem = problem;
    if (operationId !== undefined) this.operationId = operationId;
    if (operation !== undefined) this.operation = operation;
    if (transportCode !== undefined) this.transportCode = transportCode;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.problem === undefined ? {} : { problem: this.problem }),
      ...(this.operationId === undefined ? {} : { operationId: this.operationId }),
      ...(this.operation === undefined ? {} : { operation: this.operation }),
      ...(this.transportCode === undefined ? {} : { transportCode: this.transportCode }),
    };
  }
}

const secretKeys = new Set([
  "authorization",
  "controlcredential",
  "credential",
  "credentials",
  "accesstoken",
  "bootstraptoken",
  "password",
  "cookie",
  "setcookie",
]);

function secretKey(key) {
  return secretKeys.has(key.replace(/[-_]/g, "").toLowerCase());
}

export function credentialForms(credential) {
  return [...new Set([credential, encodeURIComponent(credential)])]
    .sort((left, right) => right.length - left.length)
    .map((form) => {
      // Percent escapes are case-insensitive; the opaque credential itself is not.
      const pattern = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/%[0-9a-f]{2}/gi, (escape) => `%${[...escape.slice(1)].map((digit) =>
          /[a-f]/i.test(digit) ? `[${digit.toLowerCase()}${digit.toUpperCase()}]` : digit).join("")}`);
      return { match: new RegExp(pattern), redact: new RegExp(pattern, "g") };
    });
}

export function containsCredential(text, forms) {
  return forms.some((form) => form.match.test(text));
}

export function assertPublicResource(value, forms) {
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const entry = pending.pop();
    if (entry.depth > 64) throw new AilohaProtocolError("invalid_response");
    if (typeof entry.value === "string" && containsCredential(entry.value, forms)) {
      throw new AilohaProtocolError("credential_exposure");
    }
    if (typeof entry.value === "number" && !Number.isFinite(entry.value)) {
      throw new AilohaProtocolError("invalid_response");
    }
    if (entry.value === null || typeof entry.value !== "object") continue;
    for (const [key, child] of Object.entries(entry.value)) {
      if (!Array.isArray(entry.value) && (secretKey(key) || containsCredential(key, forms))) {
        throw new AilohaProtocolError("credential_exposure");
      }
      pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
}

export function redactProblem(value, forms, depth = 0) {
  if (depth > 64 || (typeof value === "number" && !Number.isFinite(value))) {
    throw new AilohaProtocolError("invalid_response");
  }
  if (typeof value === "string") {
    return forms.reduce((text, form) => text.replace(form.redact, "[REDACTED]"), value);
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((child) => redactProblem(child, forms, depth + 1)));
  }
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [
    redactProblem(key, forms, depth + 1),
    secretKey(key) ? "[REDACTED]" : redactProblem(child, forms, depth + 1),
  ])));
}
