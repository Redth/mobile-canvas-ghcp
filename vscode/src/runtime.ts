import { pathToFileURL } from "node:url";
import type * as vscode from "vscode";

interface RuntimeResolution {
  command: string;
  source: string;
}

interface RuntimeModule {
  resolveCommand(): Promise<RuntimeResolution>;
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
