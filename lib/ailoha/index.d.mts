export const TARGET_HOST_PROFILE: "ailoha.target-host/v1";

export interface TargetHostConnection {
  origin: string;
  hostId: string;
  profile: typeof TARGET_HOST_PROFILE;
  controlCredential: string;
}

export type PublicConnection = Readonly<Omit<TargetHostConnection, "controlCredential">>;

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ClientOptions extends RequestOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface Capability {
  id: string;
  version: number;
  features?: string[];
}

export interface HostStatus {
  profile: typeof TARGET_HOST_PROFILE;
  hostId: string;
  version: string;
  state: "ready" | "degraded" | "maintenance";
  capabilities: Capability[];
}

export interface Provider {
  providerId: string;
  name: string;
  version: string;
  state: "ready" | "degraded" | "unavailable" | "disabled";
  capabilities: Capability[];
  description?: string;
}

export interface CatalogDescriptor {
  catalogId: string;
  providerId: string;
  name: string;
  kind: "runtime" | "target-type" | "template" | "application" | "media";
  revision?: string;
  metadata?: JsonObject;
}

export interface RuntimeDescriptor {
  runtimeId: string;
  providerId: string;
  name: string;
  platform: string;
  version: string;
  architecture?: string;
  state?: "available" | "installing" | "unavailable";
  metadata?: JsonObject;
}

export interface TargetTypeDescriptor {
  targetTypeId: string;
  providerId: string;
  name: string;
  kind: "simulator" | "emulator" | "physical-device" | "desktop" | "browser" | "remote";
  platform?: string;
  configSchema?: JsonObject;
  capabilities?: Capability[];
}

export interface TemplateDescriptor {
  templateId: string;
  providerId: string;
  targetTypeId: string;
  name: string;
  runtimeId?: string;
  description?: string;
  configuration?: JsonObject;
}

export interface ProviderDiagnostics {
  providerId: string;
  state: Provider["state"];
  checkedAt: string;
  checks: { name: string; status: "pass" | "warn" | "fail"; detail?: string }[];
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinate?: "window" | "screen";
  [extension: string]: unknown;
}

export interface Surface {
  surfaceId: string;
  kind: "display" | "window" | "webview" | "remote-display";
  bounds: Bounds;
  geometryRevision: number;
  capabilities: Capability[];
  name?: string;
  pixelDensity?: number;
  orientation?: "portrait" | "landscape" | "unknown";
}

export interface NativeIdentity {
  platform: string;
  nativeId: string;
  serial?: string;
  provider?: string;
  modelIdentifier?: string;
  osVersion?: string;
  isVirtual?: boolean;
}

export type TargetStatus =
  | "provisioning" | "stopped" | "starting" | "running" | "stopping"
  | "rebooting" | "resetting" | "deleting" | "error";

export interface Target {
  targetId: string;
  providerId: string;
  targetTypeId: string;
  status: TargetStatus;
  surfaces: Surface[];
  runtimeId?: string;
  templateId?: string;
  name?: string;
  createdAt?: string | null;
  updatedAt?: string;
  labels?: Record<string, string>;
  nativeIdentity?: NativeIdentity;
}

export interface TargetListOptions extends RequestOptions {
  providerId?: string;
  status?: TargetStatus;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface TargetCreateRequest {
  providerId: string;
  targetTypeId: string;
  runtimeId?: string;
  templateId?: string;
  name?: string;
  labels?: Record<string, string>;
  configuration?: JsonObject;
  start?: boolean;
}

export interface LifecycleRequest {
  reason?: string;
  options?: JsonObject;
  requestId?: string;
}

export interface LifecycleOptions extends RequestOptions {
  request?: LifecycleRequest;
  /** Optional total request budget, no greater than the configured client ceiling. */
  timeoutMs?: number;
}

/** A caller-side gate, not evidence that user consent has been obtained. */
export interface ConfirmationOptions extends RequestOptions {
  confirmed: true;
  timeoutMs?: number;
}

export interface ConfirmedLifecycleOptions extends LifecycleOptions, ConfirmationOptions {}

export type OperationStatus =
  | "queued" | "running" | "succeeded" | "failed" | "cancelling" | "cancelled";

export interface Operation {
  operationId: string;
  kind: string;
  status: OperationStatus;
  destructive: boolean;
  createdAt: string;
  targetId?: string;
  providerId?: string;
  requestId?: string;
  progress?: number;
  startedAt?: string;
  completedAt?: string;
  result?: JsonObject;
  artifactIds?: string[];
  problem?: ProblemDetails;
  cancelRequested?: boolean;
  cancellationProblem?: ProblemDetails;
  cleanupProblem?: ProblemDetails;
}

export interface OperationListOptions extends RequestOptions {
  targetId?: string;
  status?: OperationStatus;
}

export interface OperationWaitOptions extends RequestOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface SucceededOperation extends Operation {
  status: "succeeded";
}

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly errorCode?: string;
  readonly [extension: string]: unknown;
}

export type ProtocolErrorCode =
  | "invalid_connection" | "invalid_options" | "invalid_identifier"
  | "invalid_request" | "confirmation_required" | "request_too_large"
  | "incompatible_profile" | "host_identity_mismatch" | "target_identity_mismatch"
  | "provider_identity_mismatch"
  | "operation_identity_mismatch" | "operation_failed" | "operation_cancelled"
  | "invalid_response" | "credential_exposure" | "redirect_rejected"
  | "response_too_large" | "timeout" | "cancelled" | "transport_error"
  | "client_disposed" | "request_limit" | "http_error";

export interface ProtocolErrorResult {
  name: "AilohaProtocolError";
  code: ProtocolErrorCode;
  message: string;
  status?: number;
  problem?: ProblemDetails;
  operationId?: string;
  operation?: Operation;
  transportCode?: string;
}

export class AilohaProtocolError extends Error {
  private constructor();
  readonly name: "AilohaProtocolError";
  readonly code: ProtocolErrorCode;
  readonly status?: number;
  readonly problem?: ProblemDetails;
  readonly operationId?: string;
  readonly operation?: Operation;
  readonly transportCode?: string;
  toJSON(): ProtocolErrorResult;
}

export interface TargetArtifactContext {
  targetId: string;
  providerId?: string;
}

export interface TargetFileListing {
  path: string;
  nativePath?: string;
  total: number;
  files: Array<{
    name: string;
    type: "file" | "directory";
    path?: string;
    nativePath?: string;
    nativeModified?: string;
    size?: number;
    "x-ailoha-target-host"?: TargetArtifactContext;
  }>;
}

export interface TargetLogListing {
  total?: number;
  entries: Array<{
    nativeTimestamp?: string;
    nativeLevel?: string;
    nativeSource?: string;
    source: string;
    message: string;
    processId?: number | null;
    subsystem?: string | null;
    "x-ailoha-target-host"?: TargetArtifactContext;
  }>;
}

export interface TargetCrashReport {
  crashId: string;
  nativeName?: string;
  nativeTimestamp?: string;
  nativeKind?: string | null;
  appId?: string | null;
  content?: string;
  "x-ailoha-target-host"?: TargetArtifactContext;
}

export interface TargetHostClient {
  readonly connection: PublicConnection;
  getHostStatus(options?: RequestOptions): Promise<HostStatus>;
  listProviders(options?: RequestOptions): Promise<Provider[]>;
  listProviderCatalogs(providerId: string, options?: RequestOptions): Promise<CatalogDescriptor[]>;
  listProviderRuntimes(providerId: string, options?: RequestOptions): Promise<RuntimeDescriptor[]>;
  listProviderTargetTypes(providerId: string, options?: RequestOptions): Promise<TargetTypeDescriptor[]>;
  listProviderTemplates(providerId: string, options?: RequestOptions): Promise<TemplateDescriptor[]>;
  getProviderDiagnostics(providerId: string, options?: RequestOptions): Promise<ProviderDiagnostics>;
  listTargets(options?: TargetListOptions): Promise<Target[]>;
  getTarget(targetId: string, options?: RequestOptions): Promise<Target>;
  getTargetCapabilities(targetId: string, options?: RequestOptions): Promise<Capability[]>;
  listTargetApps(targetId: string, options?: RequestOptions): Promise<Array<{
    appId: string; packageId?: string | null; "x-ailoha-target-host"?: TargetArtifactContext;
  }>>;
  queryTargetFiles(targetId: string, path: string, options?: RequestOptions): Promise<TargetFileListing>;
  queryTargetLogs(targetId: string, query: {
    appId?: string; text?: string; level?: string; limit?: string; since?: string; until?: string;
  }, options?: RequestOptions): Promise<TargetLogListing>;
  queryTargetCrashes(targetId: string, query: {
    appId?: string; text?: string; limit?: string;
  }, options?: RequestOptions):
    Promise<{ total?: number; crashes: TargetCrashReport[] }>;
  getTargetCrashDetail(targetId: string, crashId: string, options?: RequestOptions): Promise<TargetCrashReport>;
  listTargetSurfaces(targetId: string, options?: RequestOptions): Promise<Surface[]>;
  createTarget(request: TargetCreateRequest, options?: RequestOptions): Promise<Operation>;
  startTarget(targetId: string, options?: LifecycleOptions): Promise<Operation>;
  stopTarget(targetId: string, options?: LifecycleOptions): Promise<Operation>;
  rebootTarget(targetId: string, options?: LifecycleOptions): Promise<Operation>;
  resetTarget(targetId: string, options: ConfirmedLifecycleOptions): Promise<Operation>;
  deleteTarget(targetId: string, options: ConfirmationOptions): Promise<Operation>;
  listOperations(options?: OperationListOptions): Promise<Operation[]>;
  getOperation(operationId: string, options?: RequestOptions): Promise<Operation>;
  cancelOperation(operationId: string, options?: RequestOptions): Promise<Operation>;
  waitForOperation(operationId: string, options?: OperationWaitOptions): Promise<SucceededOperation>;
  toJSON(): PublicConnection;
  dispose(): void;
}

export function connectTargetHost(
  connection: TargetHostConnection,
  options?: ClientOptions,
): Promise<TargetHostClient>;

export interface OwnerTransportResponse<T = unknown> {
  readonly status: number;
  readonly location: string | null;
  readonly retryAfterMs: number | null;
  readonly contentType: string | null;
  readonly body: T;
}

export interface OwnerTargetHostTransport {
  response<T = unknown>(path: string, options?: {
    method?: "GET" | "POST" | "DELETE";
    body?: string | Uint8Array;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<OwnerTransportResponse<T>>;
}

export interface OwnerTransportClient extends Omit<TargetHostClient, "connection" | "toJSON"> {
  readonly connection: Readonly<{ hostId: string; profile: typeof TARGET_HOST_PROFILE }>;
  toJSON(): Readonly<{ hostId: string; profile: typeof TARGET_HOST_PROFILE }>;
}

export function connectTargetHostTransport(
  transport: OwnerTargetHostTransport,
  options: ClientOptions & { hostId: string; profile?: typeof TARGET_HOST_PROFILE },
): Promise<OwnerTransportClient>;
