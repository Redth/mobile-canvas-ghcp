import { pathToFileURL } from "node:url";
import type * as vscode from "vscode";
import type { AilohaCanvasHost } from "./hostBridge";
import type { WorkspaceRootError } from "./workspaceRoots";
import { createDestructivePrompt, type DestructivePrompt } from "./destructiveConsent";

interface RuntimeResolution {
  command: string;
  source: string;
}

interface RuntimeModule {
  resolveCommand(): Promise<RuntimeResolution>;
}

export interface AilohaContextBinding {
  contextRef: string;
  scopeEpoch: string;
  scope: { sessionId: string; viewId: string };
  ownerProcessId: number;
}

interface AilohaRuntimeModule {
  createRuntimeCanvasHost(options: {
    scope: { sessionId: string; viewId: string };
    onError(error: { code: string; message: string }): void;
    validateWorkspaceRoot?(path: string): WorkspaceRootError | undefined;
    allowHostPackage?(): boolean;
    confirmDestructive: DestructivePrompt;
  }): AilohaCanvasHost;
  getRuntimeContextBinding(scope: { sessionId: string; viewId: string }): Promise<AilohaContextBinding>;
}

let resolution: Promise<RuntimeResolution> | undefined;

export async function resolveMobileCanvas(
  context: vscode.ExtensionContext,
): Promise<RuntimeResolution> {
  resolution ??= import(
    pathToFileURL(context.asAbsolutePath("dist/lib/runtime.mjs")).href
  ).then((module) => (module as RuntimeModule).resolveCommand());
  const current = resolution;
  try {
    return await current;
  } catch (error) {
    if (resolution === current) {
      resolution = undefined;
    }
    throw error;
  }
}

export async function resolveAilohaCanvasHost(
  context: vscode.ExtensionContext,
  scope: { sessionId: string; viewId: string },
  onError: (error: { code: string; message: string }) => void,
  validateWorkspaceRoot?: (path: string) => WorkspaceRootError | undefined,
  allowHostPackage?: () => boolean,
): Promise<AilohaCanvasHost> {
  const module: AilohaRuntimeModule = await import(
    pathToFileURL(context.asAbsolutePath("dist/lib/ailoha/runtime-backend.mjs")).href
  );
  return module.createRuntimeCanvasHost({
    scope, onError, validateWorkspaceRoot, allowHostPackage, confirmDestructive: createDestructivePrompt(),
  });
}

export async function resolveAilohaContextBinding(
  context: vscode.ExtensionContext,
  scope: { sessionId: string; viewId: string },
): Promise<AilohaContextBinding> {
  const module: AilohaRuntimeModule = await import(
    pathToFileURL(context.asAbsolutePath("dist/lib/ailoha/runtime-backend.mjs")).href
  );
  return module.getRuntimeContextBinding(scope);
}
