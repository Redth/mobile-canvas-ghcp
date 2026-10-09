import { request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import {
  AilohaProtocolError,
  assertPublicResource,
  containsCredential,
  credentialForms,
  redactProblem,
} from "./errors.mjs";
import {
  TARGET_HOST_PROFILE,
  capabilities,
  hostStatus,
  isOpaqueId,
  problemDetails,
  providers,
  surfaces,
  target,
  targets,
  targetStates,
} from "./protocol.mjs";

export { AilohaProtocolError, TARGET_HOST_PROFILE };

const defaultTimeoutMs = 15_000;
const defaultMaxResponseBytes = 2 * 1024 * 1024;
const maximumTimeoutMs = 60_000;
const maximumResponseBytes = 8 * 1024 * 1024;
const concurrentRequestLimit = 8;

function optionsRecord(value, allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new AilohaProtocolError("invalid_options");
  }
}

function signalOption(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new AilohaProtocolError("invalid_options");
  }
  return signal;
}

function boundedInteger(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new AilohaProtocolError("invalid_options");
  }
  return value;
}

function connectionInfo(connection) {
  if (connection === null || typeof connection !== "object" || Array.isArray(connection)
    || Object.keys(connection).some((key) =>
      !["origin", "hostId", "profile", "controlCredential"].includes(key))) {
    throw new AilohaProtocolError("invalid_connection");
  }
  const { origin, hostId, profile, controlCredential } = connection;
  if (!isOpaqueId(hostId) || typeof origin !== "string" || typeof controlCredential !== "string"
    || !/^[\x21-\x7e]{1,4096}$/.test(controlCredential)) {
    throw new AilohaProtocolError("invalid_connection");
  }
  if (profile !== TARGET_HOST_PROFILE) {
    throw new AilohaProtocolError("incompatible_profile");
  }
  // Literal, canonical loopback authorities avoid DNS, proxy and URL-normalization surprises.
  const authority = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})$/.exec(origin);
  if (!authority || Number(authority[1]) > 65535) {
    throw new AilohaProtocolError("invalid_connection");
  }
  const forms = credentialForms(controlCredential);
  if ([origin, hostId, profile].some((value) => containsCredential(value, forms))) {
    throw new AilohaProtocolError("invalid_connection");
  }
  return {
    connection: Object.freeze({ origin, hostId, profile: TARGET_HOST_PROFILE }),
    controlCredential,
    forms,
  };
}

class TargetHostClient {
  #connection;
  #credential;
  #forms;
  #timeoutMs;
  #maxResponseBytes;
  #requests = new Set();
  #disposed = false;

  constructor(connection, options) {
    const captured = connectionInfo(connection);
    this.#connection = captured.connection;
    this.#credential = captured.controlCredential;
    this.#forms = captured.forms;
    optionsRecord(options, ["timeoutMs", "maxResponseBytes", "signal"]);
    signalOption(options.signal);
    this.#timeoutMs = boundedInteger(
      options.timeoutMs === undefined ? defaultTimeoutMs : options.timeoutMs,
      maximumTimeoutMs,
    );
    this.#maxResponseBytes = boundedInteger(
      options.maxResponseBytes === undefined ? defaultMaxResponseBytes : options.maxResponseBytes,
      maximumResponseBytes,
    );
  }

  get connection() {
    return this.#connection;
  }

  toJSON() {
    return this.#connection;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const cancel of this.#requests) cancel("client_disposed");
    this.#credential = "";
    this.#forms = [];
  }

  async getHostStatus(options = {}) {
    const status = await this.#read("/api/v1/host/status", hostStatus, this.#signal(options));
    if (status.hostId !== this.#connection.hostId) {
      throw new AilohaProtocolError("host_identity_mismatch", { status: 200 });
    }
    return status;
  }

  async listProviders(options = {}) {
    return this.#read("/api/v1/providers", providers, this.#signal(options));
  }

  async listTargets(options = {}) {
    optionsRecord(options, ["signal", "providerId", "status"]);
    const { providerId, status, signal } = options;
    const query = new URLSearchParams();
    if (providerId !== undefined) {
      this.#identifier(providerId);
      query.set("providerId", providerId);
    }
    if (status !== undefined) {
      if (!targetStates.includes(status)) throw new AilohaProtocolError("invalid_options");
      query.set("status", status);
    }
    const suffix = query.size ? `?${query}` : "";
    return this.#read(`/api/v1/targets${suffix}`, (value) => {
      targets(value);
      if (value.some((entry) =>
        (providerId !== undefined && entry.providerId !== providerId)
        || (status !== undefined && entry.status !== status))) {
        throw new AilohaProtocolError("invalid_response");
      }
      return value;
    }, signalOption(signal));
  }

  async getTarget(targetId, options = {}) {
    const result = await this.#read(this.#targetRoute(targetId), target, this.#signal(options));
    if (result.targetId !== targetId) {
      throw new AilohaProtocolError("target_identity_mismatch", { status: 200 });
    }
    return result;
  }

  async getTargetCapabilities(targetId, options = {}) {
    return this.#read(`${this.#targetRoute(targetId)}/capabilities`, capabilities, this.#signal(options));
  }

  async listTargetSurfaces(targetId, options = {}) {
    return this.#read(`${this.#targetRoute(targetId)}/surfaces`, surfaces, this.#signal(options));
  }

  #signal(options) {
    optionsRecord(options, ["signal"]);
    return signalOption(options.signal);
  }

  #identifier(identifier) {
    if (!isOpaqueId(identifier) || containsCredential(identifier, this.#forms)) {
      throw new AilohaProtocolError("invalid_identifier");
    }
    return identifier;
  }

  #targetRoute(targetId) {
    return `/api/v1/targets/${encodeURIComponent(this.#identifier(targetId))}`;
  }

  #read(path, validate, signal) {
    if (this.#disposed) return Promise.reject(new AilohaProtocolError("client_disposed"));
    if (signal?.aborted) return Promise.reject(new AilohaProtocolError("cancelled"));
    if (this.#requests.size >= concurrentRequestLimit) {
      return Promise.reject(new AilohaProtocolError("request_limit"));
    }
    const url = new URL(path, this.#connection.origin);
    if (url.origin !== new URL(this.#connection.origin).origin
      || containsCredential(url.href, this.#forms)) {
      return Promise.reject(new AilohaProtocolError("invalid_identifier"));
    }

    return new Promise((resolve, reject) => {
      const deadline = performance.now() + this.#timeoutMs;
      let request;
      let response;
      let timer;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#requests.delete(fail);
      };
      const fail = (code, status, problem) => {
        if (settled) return;
        settled = true;
        cleanup();
        response?.destroy();
        request?.destroy();
        reject(new AilohaProtocolError(code, { status, problem }));
      };
      const onAbort = () => fail("cancelled");
      this.#requests.add(fail);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => fail("timeout"), this.#timeoutMs);

      try {
        request = httpRequest(url, {
          method: "GET",
          agent: false,
          maxHeaderSize: 16 * 1024,
          headers: {
            Authorization: `Bearer ${this.#credential}`,
            Origin: this.#connection.origin,
            Accept: "application/json, application/problem+json",
            "Accept-Encoding": "identity",
          },
        }, (incoming) => {
          response = incoming;
          const status = incoming.statusCode;
          if (status >= 300 && status < 400) {
            fail("redirect_rejected", status);
            return;
          }
          const success = status === 200;
          if (status >= 200 && status < 300 && !success) {
            fail("invalid_response", status);
            return;
          }
          const mediaType = incoming.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
          if (mediaType !== (success ? "application/json" : "application/problem+json")
            || (incoming.headers["content-encoding"] !== undefined
              && incoming.headers["content-encoding"].toLowerCase() !== "identity")) {
            fail("invalid_response", status);
            return;
          }
          const declaredLength = incoming.headers["content-length"];
          if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength)
            || !Number.isSafeInteger(Number(declaredLength)))) {
            fail("invalid_response", status);
            return;
          }
          if (declaredLength !== undefined && Number(declaredLength) > this.#maxResponseBytes) {
            fail("response_too_large", status);
            return;
          }
          const chunks = [];
          let received = 0;
          incoming.on("data", (chunk) => {
            if (settled) return;
            received += chunk.length;
            if (received > this.#maxResponseBytes) {
              fail("response_too_large", status);
              return;
            }
            chunks.push(chunk);
          });
          incoming.once("aborted", () => fail("transport_error", status));
          incoming.once("error", () => fail("transport_error", status));
          incoming.once("end", () => {
            if (settled) return;
            if (performance.now() >= deadline) {
              fail("timeout");
              return;
            }
            let value;
            try {
              const text = new TextDecoder("utf-8", { fatal: true })
                .decode(Buffer.concat(chunks, received));
              value = JSON.parse(text);
            } catch (error) {
              if (error instanceof SyntaxError || error instanceof TypeError) {
                fail("invalid_response", status);
                return;
              }
              throw error;
            }
            try {
              if (!success) {
                problemDetails(value, status);
                fail("http_error", status, redactProblem(value, this.#forms));
                return;
              }
              assertPublicResource(value, this.#forms);
              const result = validate(value);
              if (performance.now() >= deadline) {
                fail("timeout");
                return;
              }
              settled = true;
              cleanup();
              resolve(result);
            } catch (error) {
              if (error instanceof AilohaProtocolError) {
                fail(error.code, status);
                return;
              }
              throw error;
            }
          });
        });
        request.once("error", () => fail("transport_error"));
        request.end();
      } catch (error) {
        // Node transport exceptions can contain request headers; never retain their cause.
        fail("transport_error");
        return;
      }
    });
  }
}

export async function connectTargetHost(connection, options = {}) {
  const client = new TargetHostClient(connection, options);
  try {
    await client.getHostStatus({ signal: options.signal });
    return client;
  } catch (error) {
    client.dispose();
    throw error;
  }
}
