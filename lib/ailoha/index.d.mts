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
  | "incompatible_profile" | "host_identity_mismatch" | "target_identity_mismatch"
  | "invalid_response" | "credential_exposure" | "redirect_rejected"
  | "response_too_large" | "timeout" | "cancelled" | "transport_error"
  | "client_disposed" | "request_limit" | "http_error";

export interface ProtocolErrorResult {
  name: "AilohaProtocolError";
  code: ProtocolErrorCode;
  message: string;
  status?: number;
  problem?: ProblemDetails;
}

export class AilohaProtocolError extends Error {
  private constructor();
  readonly name: "AilohaProtocolError";
  readonly code: ProtocolErrorCode;
  readonly status?: number;
  readonly problem?: ProblemDetails;
  toJSON(): ProtocolErrorResult;
}

export interface TargetHostClient {
  readonly connection: PublicConnection;
  getHostStatus(options?: RequestOptions): Promise<HostStatus>;
  listProviders(options?: RequestOptions): Promise<Provider[]>;
  listTargets(options?: TargetListOptions): Promise<Target[]>;
  getTarget(targetId: string, options?: RequestOptions): Promise<Target>;
  getTargetCapabilities(targetId: string, options?: RequestOptions): Promise<Capability[]>;
  listTargetSurfaces(targetId: string, options?: RequestOptions): Promise<Surface[]>;
  toJSON(): PublicConnection;
  dispose(): void;
}

export function connectTargetHost(
  connection: TargetHostConnection,
  options?: ClientOptions,
): Promise<TargetHostClient>;
