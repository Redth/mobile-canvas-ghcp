export type SocketChannel = "video" | "events";

export interface AutomationActivity {
  kind: string;
  deviceId: string;
  x?: number;
  y?: number;
  endX?: number;
  endY?: number;
  duration?: number;
  detail?: string;
}

export interface WorkspaceInspectionState {
  schema: string;
  scope: { sessionId: string; viewId: string };
  generation: number;
  root: string | null;
  exclusions: readonly string[];
  status: string;
  inspection: unknown;
  error: { code: string; message: string; status?: number } | null;
}

export interface SemanticInspectionState {
  schema: string;
  scope: { sessionId: string; viewId: string };
  generation: number;
  status: string;
  selection: unknown;
  appAvailable: boolean;
  lens: string;
  operation: string | null;
  result: unknown;
  error: { code: string; message: string; status?: number } | null;
}

export type WebviewMessage =
  | { type: "ready" }
  | {
      type: "api";
      id: string;
      path: string;
      method?: string;
      body?: string;
    }
  | { type: "api-cancel"; id: string }
  | {
      type: "socket-open";
      id: string;
      channel: SocketChannel;
      query?: string;
    }
  | { type: "socket-close"; id: string }
  | { type: "socket-send"; id: string; requestId: string; data: string }
  | { type: "save"; id: string; suggestedName: string; bytes: ArrayBuffer }
  | { type: "copy"; id: string; text: string }
  | { type: "view-title"; title: string; description?: string };

export type ExtensionMessage =
  | { type: "context"; sessionId: string; instanceId: string }
  | { type: "workspace-inspection"; state: WorkspaceInspectionState }
  | { type: "semantic-inspection"; state: SemanticInspectionState }
  | {
      type: "api-result";
      id: string;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: ArrayBuffer | null;
    }
  | { type: "api-error"; id: string; message: string }
  | { type: "socket-opened"; id: string; protocol?: string }
  | { type: "socket-message"; id: string; data: string | ArrayBuffer }
  | { type: "socket-error"; id: string; message: string }
  | { type: "socket-closed"; id: string; code: number; reason: string }
  | { type: "operation-result"; id: string; cancelled?: boolean }
  | { type: "operation-error"; id: string; message: string }
  | { type: "refresh" }
  | { type: "automation"; activity: AutomationActivity }
  | { type: "visibility"; visible: boolean }
  | { type: "fatal"; message: string };
