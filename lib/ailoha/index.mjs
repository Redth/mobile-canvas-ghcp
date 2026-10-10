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
  appLaunchRequest,
  appOp,
  appOps,
  capabilities,
  catalogs,
  createRequest,
  hostStatus,
  installedApp,
  installedApps,
  isOpaqueId,
  lifecycleRequest,
  operation,
  operations,
  operationStates,
  problemDetails,
  providerDiagnostics,
  providers,
  runtimes,
  surfaces,
  target,
  targets,
  targetTypes,
  targetStates,
  templates,
} from "./protocol.mjs";
import {
  artifactReadQuery, targetInstalledApps, targetFileListing, targetLogListing,
  targetCrashListing, targetCrashDetail,
} from "./artifact-read-protocol.mjs";

export { AilohaProtocolError, TARGET_HOST_PROFILE };

const defaultTimeoutMs = 15_000;
const defaultMaxResponseBytes = 2 * 1024 * 1024;
const maximumTimeoutMs = 60_000;
const maximumResponseBytes = 8 * 1024 * 1024;
const concurrentRequestLimit = 8;
const maximumRequestBytes = 64 * 1024;
const operationProblemKeys = ["problem", "cancellationProblem", "cleanupProblem"];

function mutationBody(value, validate, forms) {
  let bytes = 0;
  const count = (size) => {
    bytes += size;
    if (bytes > maximumRequestBytes) throw new AilohaProtocolError("request_too_large");
  };
  const capture = (entry, depth) => {
    if (depth > 64) throw new AilohaProtocolError("invalid_request");
    if (typeof entry === "string") {
      if (entry.length > maximumRequestBytes) throw new AilohaProtocolError("request_too_large");
      count(Buffer.byteLength(JSON.stringify(entry)));
      return entry;
    }
    if (entry === null || typeof entry === "boolean"
      || (typeof entry === "number" && Number.isFinite(entry))) {
      count(Buffer.byteLength(JSON.stringify(entry)));
      return entry;
    }
    if (typeof entry !== "object"
      || (!Array.isArray(entry) && ![Object.prototype, null].includes(Object.getPrototypeOf(entry)))
      || Object.getOwnPropertySymbols(entry).length) {
      throw new AilohaProtocolError("invalid_request");
    }
    const keys = Object.keys(entry);
    if (Object.getOwnPropertyNames(entry).length !== keys.length + (Array.isArray(entry) ? 1 : 0)) {
      throw new AilohaProtocolError("invalid_request");
    }
    count(2 + Math.max(0, keys.length - 1));
    if (Array.isArray(entry)
      && (keys.length !== entry.length || keys.some((key, index) => key !== String(index)))) {
      throw new AilohaProtocolError("invalid_request");
    }
    const entries = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!Object.hasOwn(descriptor, "value")) throw new AilohaProtocolError("invalid_request");
      if (!Array.isArray(entry)) {
        capture(key, depth);
        count(1);
      }
      return [key, capture(descriptor.value, depth + 1)];
    });
    return Array.isArray(entry) ? entries.map(([, child]) => child) : Object.fromEntries(entries);
  };
  const captured = capture(value, 0);
  try {
    validate(captured);
  } catch (error) {
    if (error instanceof AilohaProtocolError && error.code === "invalid_response") {
      throw new AilohaProtocolError("invalid_request");
    }
    throw error;
  }
  assertPublicResource(captured, forms);
  return Buffer.from(JSON.stringify(captured));
}

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
  #transport;

  constructor(connection, options, transport) {
    if (transport === undefined) {
      const captured = connectionInfo(connection);
      this.#connection = captured.connection;
      this.#credential = captured.controlCredential;
      this.#forms = captured.forms;
    } else {
      const response = transport?.response;
      if (!isOpaqueId(connection.hostId) || connection.profile !== TARGET_HOST_PROFILE
        || typeof response !== "function") throw new AilohaProtocolError("invalid_connection");
      this.#connection = Object.freeze({ hostId: connection.hostId, profile: connection.profile });
      this.#credential = "";
      this.#forms = [];
      this.#transport = Object.freeze({ response: response.bind(transport) });
    }
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

  async listProviderCatalogs(providerId, options = {}) {
    return this.#providerCollection(providerId, "catalogs", catalogs, options);
  }

  async listProviderRuntimes(providerId, options = {}) {
    return this.#providerCollection(providerId, "runtimes", runtimes, options);
  }

  async listProviderTargetTypes(providerId, options = {}) {
    return this.#providerCollection(providerId, "target-types", targetTypes, options);
  }

  async listProviderTemplates(providerId, options = {}) {
    return this.#providerCollection(providerId, "templates", templates, options);
  }

  async getProviderDiagnostics(providerId, options = {}) {
    const path = `/api/v1/providers/${encodeURIComponent(this.#identifier(providerId))}/diagnostics`;
    return this.#read(path, (value) => {
      providerDiagnostics(value);
      if (value.providerId !== providerId) {
        throw new AilohaProtocolError("provider_identity_mismatch", { status: 200 });
      }
      return value;
    }, this.#signal(options));
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

  async listTargetApps(targetId, { includeSystem = false, signal } = {}) {
    if (typeof includeSystem !== "boolean") throw new AilohaProtocolError("invalid_options");
    const path = `${this.#targetRoute(targetId)}/apps?includeSystem=${includeSystem}`;
    return this.#read(path, (value) => {
      installedApps(value);
      if (value.some((entry) => entry["x-ailoha-target-host"]?.targetId !== undefined
        && entry["x-ailoha-target-host"].targetId !== targetId)) {
        throw new AilohaProtocolError("target_identity_mismatch", { status: 200 });
      }
      return value;
    }, signalOption(signal));
  }

  async listTargetAppReferences(targetId, options = {}) {
    return this.#read(`${this.#targetRoute(targetId)}/apps?includeSystem=true`,
      (value) => targetInstalledApps(value, targetId), this.#signal(options));
  }

  async getTargetApp(targetId, appId, options = {}) {
    const path = `${this.#targetRoute(targetId)}/apps/${encodeURIComponent(this.#identifier(appId))}`;
    return this.#read(path, (value) => {
      installedApp(value);
      if (value.appId !== appId
        || (value["x-ailoha-target-host"]?.targetId !== undefined
          && value["x-ailoha-target-host"].targetId !== targetId)) {
        throw new AilohaProtocolError("app_identity_mismatch", { status: 200 });
      }
      return value;
    }, this.#signal(options));
  }

  async launchTargetApp(targetId, appId, request = {}, options = {}) {
    const body = mutationBody(request, appLaunchRequest, this.#forms);
    const path = `${this.#targetRoute(targetId)}/apps/${encodeURIComponent(this.#identifier(appId))}/actions/launch`;
    return this.#submit(path, "POST", {
      kind: "launchTargetApp", destructive: false, targetId,
      ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
    }, this.#signal(options), body);
  }

  async terminateTargetApp(targetId, appId, options = {}) {
    const path = `${this.#targetRoute(targetId)}/apps/${encodeURIComponent(this.#identifier(appId))}/actions/terminate`;
    return this.#submit(path, "POST", { kind: "terminateTargetApp", destructive: false, targetId }, this.#signal(options));
  }

  async uninstallTargetApp(targetId, appId, options = {}) {
    optionsRecord(options, ["signal", "confirmed"]);
    this.#confirmation(options);
    const path = `${this.#targetRoute(targetId)}/apps/${encodeURIComponent(this.#identifier(appId))}`;
    return this.#submit(path, "DELETE", { kind: "uninstallTargetApp", destructive: true, targetId }, signalOption(options.signal));
  }

  async listTargetAppOps(targetId, appId, options = {}) {
    const path = `${this.#targetRoute(targetId)}/app-ops?appId=${encodeURIComponent(this.#identifier(appId))}`;
    return this.#read(path, (value) => {
      appOps(value);
      if (value.some((entry) => entry.appId !== undefined && entry.appId !== appId)) {
        throw new AilohaProtocolError("app_identity_mismatch", { status: 200 });
      }
      return value;
    }, this.#signal(options));
  }

  async updateTargetAppOp(targetId, appId, appOpId, mode, options = {}) {
    if (!["allow", "deny", "ignored", "default"].includes(mode)) throw new AilohaProtocolError("invalid_request");
    const path = `${this.#targetRoute(targetId)}/app-ops/${encodeURIComponent(this.#identifier(appOpId))}`;
    const body = mutationBody({ appId: this.#identifier(appId), mode }, (value) => {
      if (value.appId !== appId || value.mode !== mode) throw new AilohaProtocolError("invalid_request");
    }, this.#forms);
    return this.#request(path, (value) => {
      appOp(value);
      if (value.appOpId !== appOpId || value.appId !== appId) {
        throw new AilohaProtocolError("app_identity_mismatch", { status: 200 });
      }
      return value;
    }, this.#signal(options), { method: "PUT", body });
  }

  async queryTargetFiles(targetId, path, options = {}) {
    if (typeof path !== "string" || !path || path.length > 4096) throw new AilohaProtocolError("invalid_options");
    return this.#read(`${this.#targetRoute(targetId)}/files/listing?${new URLSearchParams({ path })}`,
      (value) => targetFileListing(value, targetId), this.#signal(options));
  }

  async queryTargetLogs(targetId, query, options = {}) {
    const captured = artifactReadQuery(query, ["appId", "text", "level", "limit", "since", "until"], 10_000);
    return this.#read(`${this.#targetRoute(targetId)}/logs/query?${new URLSearchParams(captured)}`,
      (value) => targetLogListing(value, targetId), this.#signal(options));
  }

  async queryTargetCrashes(targetId, query, options = {}) {
    const captured = artifactReadQuery(query, ["appId", "text", "limit"], 500);
    return this.#read(`${this.#targetRoute(targetId)}/crashes/query?${new URLSearchParams(captured)}`,
      (value) => targetCrashListing(value, targetId), this.#signal(options));
  }

  async getTargetCrashDetail(targetId, crashId, options = {}) {
    return this.#read(`${this.#targetRoute(targetId)}/crashes/${encodeURIComponent(this.#identifier(crashId))}/detail`,
      (value) => targetCrashDetail(value, targetId, crashId), this.#signal(options));
  }

  async listTargetSurfaces(targetId, options = {}) {
    return this.#read(`${this.#targetRoute(targetId)}/surfaces`, surfaces, this.#signal(options));
  }

  async createTarget(request, options = {}) {
    const signal = this.#signal(options);
    const body = mutationBody(request, createRequest, this.#forms);
    const captured = JSON.parse(body.toString("utf8"));
    return this.#submit("/api/v1/targets", "POST", {
      kind: "createTarget", destructive: true, providerId: captured.providerId,
    }, signal, body);
  }

  async startTarget(targetId, options = {}) {
    return this.#lifecycle(targetId, "start", options);
  }

  async stopTarget(targetId, options = {}) {
    return this.#lifecycle(targetId, "stop", options);
  }

  async rebootTarget(targetId, options = {}) {
    return this.#lifecycle(targetId, "reboot", options);
  }

  async resetTarget(targetId, options = {}) {
    return this.#lifecycle(targetId, "reset", options);
  }

  async deleteTarget(targetId, options = {}) {
    optionsRecord(options, ["signal", "confirmed", "timeoutMs"]);
    this.#confirmation(options);
    return this.#submit(this.#targetRoute(targetId), "DELETE", {
      kind: "deleteTarget", destructive: true, targetId,
    }, signalOption(options.signal), undefined,
    options.timeoutMs === undefined ? this.#timeoutMs : boundedInteger(options.timeoutMs, this.#timeoutMs));
  }

  async listOperations(options = {}) {
    optionsRecord(options, ["signal", "targetId", "status"]);
    const { targetId, status, signal } = options;
    const query = new URLSearchParams();
    if (targetId !== undefined) query.set("targetId", this.#identifier(targetId));
    if (status !== undefined) {
      if (!operationStates.includes(status)) throw new AilohaProtocolError("invalid_options");
      query.set("status", status);
    }
    return this.#request(`/api/v1/operations${query.size ? `?${query}` : ""}`, (value) => {
      operations(value);
      if (value.some((entry) => (targetId !== undefined && entry.targetId !== targetId)
        || (status !== undefined && entry.status !== status))) {
        throw new AilohaProtocolError("invalid_response");
      }
      return value;
    }, signalOption(signal), { sanitize: (value) => this.#operationResources(value) });
  }

  async getOperation(operationId, options = {}) {
    const path = this.#operationRoute(operationId);
    return this.#request(path, (value) => this.#matchingOperation(value, operationId),
      this.#signal(options), {
        operationId, sanitize: (value) => this.#operationResources(value),
      });
  }

  async cancelOperation(operationId, options = {}) {
    const path = this.#operationRoute(operationId);
    return this.#submit(path, "DELETE", { operationId }, this.#signal(options));
  }

  async waitForOperation(operationId, options = {}) {
    const path = this.#operationRoute(operationId);
    optionsRecord(options, ["signal", "timeoutMs", "pollIntervalMs"]);
    const signal = signalOption(options.signal);
    const timeoutMs = boundedInteger(
      options.timeoutMs === undefined ? this.#timeoutMs : options.timeoutMs, maximumTimeoutMs,
    );
    const pollIntervalMs = boundedInteger(
      options.pollIntervalMs === undefined ? 1000 : options.pollIntervalMs, maximumTimeoutMs,
    );
    const context = { operationId };
    if (this.#disposed) throw new AilohaProtocolError("client_disposed", context);
    if (signal?.aborted) throw new AilohaProtocolError("cancelled", context);
    if (this.#requests.size >= concurrentRequestLimit) {
      throw new AilohaProtocolError("request_limit", context);
    }
    return new Promise((resolve, reject) => {
      const deadline = performance.now() + timeoutMs;
      const controller = new AbortController();
      let latest;
      let pollTimer;
      let deadlineTimer;
      let settled = false;
      const cleanup = () => {
        clearTimeout(pollTimer);
        clearTimeout(deadlineTimer);
        signal?.removeEventListener("abort", onAbort);
        this.#requests.delete(cancel);
      };
      const fail = (code, status, problem) => {
        if (settled) return;
        settled = true;
        cleanup();
        controller.abort();
        reject(new AilohaProtocolError(code, {
          status, problem: problem ?? latest?.problem, operationId, operation: latest,
        }));
      };
      const cancel = (code) => fail(code);
      const onAbort = () => cancel("cancelled");
      const poll = async () => {
        try {
          const remaining = deadline - performance.now();
          if (remaining <= 0) {
            fail("timeout");
            return;
          }
          const result = await this.#request(path,
            (value) => this.#matchingOperation(value, operationId), controller.signal, {
              timeoutMs: Math.min(this.#timeoutMs, remaining),
              reserved: true,
              operationId,
              sanitize: (value) => this.#operationResources(value),
            });
          if (settled) return;
          latest = result;
          if (performance.now() >= deadline) {
            fail("timeout");
          } else if (result.status === "succeeded") {
            settled = true;
            cleanup();
            resolve(result);
          } else if (result.status === "failed" || result.status === "cancelled") {
            fail(result.status === "failed" ? "operation_failed" : "operation_cancelled");
          } else if (pollIntervalMs < deadline - performance.now()) {
            pollTimer = setTimeout(poll, pollIntervalMs);
          }
        } catch (error) {
          if (settled) return;
          if (error instanceof AilohaProtocolError) {
            if (error.operation?.operationId === operationId) latest = error.operation;
            fail(error.code, error.status, error.problem);
            return;
          }
          settled = true;
          cleanup();
          controller.abort();
          reject(error);
        }
      };
      // A wait owns one admission slot, including the gaps between its bounded reads.
      this.#requests.add(cancel);
      signal?.addEventListener("abort", onAbort, { once: true });
      deadlineTimer = setTimeout(() => fail("timeout"), timeoutMs);
      void poll();
    });
  }

  #confirmation(options) {
    const confirmed = Object.getOwnPropertyDescriptor(options, "confirmed");
    if (!confirmed || !Object.hasOwn(confirmed, "value") || confirmed.value !== true) {
      throw new AilohaProtocolError("confirmation_required");
    }
  }

  #lifecycle(targetId, action, options) {
    optionsRecord(options, action === "reset"
      ? ["signal", "request", "confirmed", "timeoutMs"] : ["signal", "request", "timeoutMs"]);
    if (action === "reset") this.#confirmation(options);
    const path = `${this.#targetRoute(targetId)}/actions/${action}`;
    const { signal: requestedSignal, request } = options;
    const signal = signalOption(requestedSignal);
    const body = request === undefined ? undefined : mutationBody(request, lifecycleRequest, this.#forms);
    const captured = body === undefined ? undefined : JSON.parse(body.toString("utf8"));
    return this.#submit(path, "POST", {
      kind: `${action}Target`, destructive: action === "reset", targetId,
      ...(captured?.requestId === undefined ? {} : { requestId: captured.requestId }),
    }, signal, body,
    options.timeoutMs === undefined ? this.#timeoutMs : boundedInteger(options.timeoutMs, this.#timeoutMs));
  }

  #operationResources(value) {
    const project = (entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
      return Object.fromEntries(Object.entries(entry).filter(([key]) => !operationProblemKeys.includes(key)));
    };
    assertPublicResource(Array.isArray(value) ? value.map(project) : project(value), this.#forms);
    const problemDepth = Array.isArray(value) ? 2 : 1;
    const sanitize = (entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const sanitized = { ...entry };
      for (const key of operationProblemKeys) {
        if (Object.hasOwn(entry, key)) {
          problemDetails(entry[key], entry[key]?.status);
          sanitized[key] = redactProblem(entry[key], this.#forms, problemDepth);
        }
      }
      return sanitized;
    };
    return Array.isArray(value) ? value.map(sanitize) : sanitize(value);
  }

  #matchingOperation(value, operationId) {
    operation(value);
    if (value.operationId !== operationId) {
      throw new AilohaProtocolError("operation_identity_mismatch", {
        operationId, operation: value,
      });
    }
    return value;
  }

  #locationId(location) {
    const relative = this.#connection.origin !== undefined
      && typeof location === "string" && location.startsWith(this.#connection.origin)
      ? location.slice(this.#connection.origin.length) : location;
    const prefix = "/api/v1/operations/";
    if (typeof relative !== "string" || !relative.startsWith(prefix)
      || /[\\/?#\s]/u.test(relative.slice(prefix.length))
      || containsCredential(location, this.#forms)) {
      throw new AilohaProtocolError("operation_identity_mismatch");
    }
    let locationId;
    try {
      locationId = decodeURIComponent(relative.slice(prefix.length));
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      throw new AilohaProtocolError("operation_identity_mismatch");
    }
    if (!isOpaqueId(locationId) || containsCredential(locationId, this.#forms)) {
      throw new AilohaProtocolError("operation_identity_mismatch");
    }
    return locationId;
  }

  #submit(path, method, expected, signal, body, timeoutMs = this.#timeoutMs) {
    return this.#request(path, (value, { acceptedOperationId }) => {
      operation(value);
      for (const [key, entry] of Object.entries(expected)) {
        if ((["operationId", "kind", "destructive"].includes(key) || Object.hasOwn(value, key))
          && value[key] !== entry) {
          throw new AilohaProtocolError("operation_identity_mismatch", {
            operationId: expected.operationId ?? value.operationId, operation: value,
          });
        }
      }
      if (acceptedOperationId !== value.operationId) {
        throw new AilohaProtocolError("operation_identity_mismatch", {
          operationId: value.operationId, operation: value,
        });
      }
      return value;
    }, signal, {
      method, body, timeoutMs, successStatus: 202, operationId: expected.operationId,
      sanitize: (value) => this.#operationResources(value),
      identifyOperation: (headers) => this.#locationId(headers.location),
    });
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

  #providerCollection(providerId, suffix, validate, options) {
    const path = `/api/v1/providers/${encodeURIComponent(this.#identifier(providerId))}/${suffix}`;
    return this.#read(path, (value) => {
      validate(value);
      if (value.some((entry) => entry.providerId !== providerId)) {
        throw new AilohaProtocolError("provider_identity_mismatch", { status: 200 });
      }
      return value;
    }, this.#signal(options));
  }

  #operationRoute(operationId) {
    if (this.#disposed) throw new AilohaProtocolError("client_disposed");
    return `/api/v1/operations/${encodeURIComponent(this.#identifier(operationId))}`;
  }

  #read(path, validate, signal) {
    return this.#request(path, validate, signal);
  }

  #request(path, validate, signal, {
    method = "GET", body, successStatus = 200, timeoutMs = this.#timeoutMs,
    sanitize = (value) => {
      assertPublicResource(value, this.#forms);
      return value;
    },
    operationId, reserved = false, identifyOperation,
  } = {}) {
    const context = { operationId };
    if (this.#disposed) return Promise.reject(new AilohaProtocolError("client_disposed", context));
    if (signal?.aborted) return Promise.reject(new AilohaProtocolError("cancelled", context));
    if (!reserved && this.#requests.size >= concurrentRequestLimit) {
      return Promise.reject(new AilohaProtocolError("request_limit", context));
    }
    if (this.#transport) {
      return this.#requestTransport(path, validate, signal, {
        method, body, successStatus, timeoutMs, sanitize, operationId, reserved, identifyOperation,
      });
    }
    const url = new URL(path, this.#connection.origin);
    if (url.origin !== new URL(this.#connection.origin).origin
      || containsCredential(url.href, this.#forms)) {
      return Promise.reject(new AilohaProtocolError("invalid_identifier"));
    }

    return new Promise((resolve, reject) => {
      const deadline = performance.now() + timeoutMs;
      let request;
      let response;
      let timer;
      let acceptedOperationId;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (!reserved) this.#requests.delete(fail);
      };
      const fail = (code, status, problem, acceptedOperation) => {
        if (settled) return;
        settled = true;
        cleanup();
        response?.destroy();
        request?.destroy();
        reject(new AilohaProtocolError(code, {
          status: status ?? (acceptedOperationId !== undefined ? successStatus : undefined), problem,
          operationId: operationId ?? acceptedOperationId ?? acceptedOperation?.operationId,
          operation: acceptedOperation,
        }));
      };
      const onAbort = () => fail("cancelled");
      if (!reserved) this.#requests.add(fail);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => fail("timeout"), timeoutMs);

      try {
        request = httpRequest(url, {
          method,
          agent: false,
          maxHeaderSize: 16 * 1024,
          headers: {
            Authorization: `Bearer ${this.#credential}`,
            Origin: this.#connection.origin,
            Accept: "application/json, application/problem+json",
            "Accept-Encoding": "identity",
            ...(body === undefined ? {} : {
              "Content-Type": "application/json",
              "Content-Length": body.length,
            }),
          },
        }, (incoming) => {
          response = incoming;
          const status = incoming.statusCode;
          if (status >= 300 && status < 400) {
            fail("redirect_rejected", status);
            return;
          }
          const success = status === successStatus;
          if (status >= 200 && status < 300 && !success) {
            fail("invalid_response", status);
            return;
          }
          if (success && identifyOperation) {
            try {
              acceptedOperationId = identifyOperation(incoming.headers);
            } catch (error) {
              if (error instanceof AilohaProtocolError) {
                fail(error.code, status);
                return;
              }
              throw error;
            }
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
              const publicValue = sanitize(value);
              const result = validate(publicValue, {
                status, headers: incoming.headers, acceptedOperationId,
              });
              if (performance.now() >= deadline) {
                const knownOperation = operationId !== undefined || acceptedOperationId !== undefined
                  ? result : undefined;
                fail("timeout", undefined, knownOperation?.problem, knownOperation);
                return;
              }
              settled = true;
              cleanup();
              resolve(result);
            } catch (error) {
              if (error instanceof AilohaProtocolError) {
                fail(error.code, status, error.problem, error.operation);
                return;
              }
              throw error;
            }
          });
        });
        request.once("error", () => fail("transport_error"));
        request.end(body);
      } catch (error) {
        // Node transport exceptions can contain request headers; never retain their cause.
        fail("transport_error");
        return;
      }
    });
  }

  #requestTransport(path, validate, signal, {
    method, body, successStatus, timeoutMs, sanitize, operationId, reserved, identifyOperation,
  }) {
    return new Promise((resolve, reject) => {
      const deadline = performance.now() + timeoutMs;
      const controller = new AbortController();
      let acceptedOperationId;
      let settled = false;
      let cancellationCode;
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (!reserved) this.#requests.delete(cancel);
      };
      const fail = (code, status, problem, operation, transportCode) => {
        if (settled) return;
        settled = true;
        cleanup();
        controller.abort();
        reject(new AilohaProtocolError(code, {
          status, problem, operationId: operationId ?? acceptedOperationId ?? operation?.operationId,
          operation, transportCode,
        }));
      };
      const cancel = (code) => {
        if (settled || cancellationCode) return;
        cancellationCode = code;
        controller.abort();
      };
      const onAbort = () => cancel("cancelled");
      const expire = () => {
        if (settled) return;
        const remaining = deadline - performance.now();
        if (remaining > 0) {
          timer = setTimeout(expire, Math.ceil(remaining));
          return;
        }
        cancel("timeout");
        fail(cancellationCode);
      };
      timer = setTimeout(expire, Math.ceil(timeoutMs));
      if (!reserved) this.#requests.add(cancel);
      signal?.addEventListener("abort", onAbort, { once: true });
      const metadata = (response) => {
        if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
          throw new AilohaProtocolError("invalid_response");
        }
        const status = response.status;
        if (status >= 300 && status < 400) throw new AilohaProtocolError("redirect_rejected", { status });
        if (status >= 200 && status < 300 && status !== successStatus) {
          throw new AilohaProtocolError("invalid_response", { status });
        }
        if (status === successStatus && identifyOperation) {
          acceptedOperationId = identifyOperation({ location: response.location });
        }
        return status;
      };
      const complete = async () => {
        try {
          const remaining = deadline - performance.now();
          if (remaining <= 0) {
            expire();
            return;
          }
          const response = await this.#transport.response(path, {
            method, ...(body === undefined ? {} : { body }),
            signal: controller.signal, timeoutMs: Math.max(1, Math.ceil(remaining)),
          });
          if (settled) return;
          const status = metadata(response);
          if (performance.now() >= deadline) cancel("timeout");
          if (cancellationCode) {
            fail(cancellationCode, status);
            return;
          }
          if (status !== successStatus || response.contentType?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
            throw new AilohaProtocolError("invalid_response", { status });
          }
          const encoded = JSON.stringify(response.body);
          if (encoded === undefined || Buffer.byteLength(encoded) > this.#maxResponseBytes) {
            throw new AilohaProtocolError("response_too_large", { status });
          }
          const value = sanitize(response.body);
          const result = validate(value, { status, headers: { location: response.location }, acceptedOperationId });
          if (performance.now() >= deadline) {
            cancel("timeout");
            const knownOperation = operationId !== undefined || acceptedOperationId !== undefined ? result : undefined;
            fail(cancellationCode, status, knownOperation?.problem, knownOperation);
            return;
          }
          settled = true;
          cleanup();
          resolve(result);
        } catch (error) {
          if (settled) return;
          if (performance.now() >= deadline) cancel("timeout");
          if (error instanceof AilohaProtocolError) {
            fail(cancellationCode ?? error.code, error.status, error.problem, error.operation);
            return;
          }
          // Only the factory's typed, sanitized metadata is a recovery source.
          if (error?.name === "TargetHostTransportError") {
            try {
              const status = error.response ? metadata(error.response)
                : Number.isInteger(error.status) && error.status >= 100 ? error.status : undefined;
              let problem;
              if (error.problem) {
                problemDetails(error.problem, status);
                problem = redactProblem(error.problem, this.#forms);
              }
              const code = cancellationCode ?? (status >= 400 ? "http_error" : "transport_error");
              const transportCode = typeof error.code === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(error.code)
                ? error.code : undefined;
              fail(code, status, problem, undefined, transportCode);
            } catch (invalid) {
              fail(invalid instanceof AilohaProtocolError ? invalid.code : "invalid_response");
            }
            return;
          }
          fail(cancellationCode ?? "transport_error");
        }
      };
      void complete();
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

export async function connectTargetHostTransport(transport, options) {
  optionsRecord(options, ["hostId", "profile", "signal", "timeoutMs", "maxResponseBytes"]);
  const { hostId, profile = TARGET_HOST_PROFILE, ...clientOptions } = options;
  const client = new TargetHostClient({ hostId, profile }, clientOptions, transport);
  try {
    await client.getHostStatus({ signal: options.signal });
    return client;
  } catch (error) {
    client.dispose();
    throw error;
  }
}
